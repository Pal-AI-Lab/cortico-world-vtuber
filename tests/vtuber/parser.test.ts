import { describe, it, expect } from 'vitest';
import {
  JsonScriptStream,
  ScriptParser,
  stripUnknownTags,
  type Beat,
  type SpeechPiece,
} from '../../src/parser.ts';
import { EXAMPLE_PACK_DIR, loadPack } from '../../src/pack.ts';

const pack = loadPack(EXAMPLE_PACK_DIR);

interface Collected {
  beats: Beat[];
  speech: Array<{ beatIndex: number; piece: SpeechPiece }>;
  ended: boolean;
}

function parseAll(script: string, chunkSize = Number.POSITIVE_INFINITY): Collected {
  const out: Collected = { beats: [], speech: [], ended: false };
  const p = new ScriptParser({
    onBeat: (b) => out.beats.push(b),
    onSpeech: (beatIndex, piece) => out.speech.push({ beatIndex, piece }),
    onEnd: () => {
      out.ended = true;
    },
  }, pack);
  if (chunkSize === Number.POSITIVE_INFINITY) {
    p.feed(script);
  } else {
    for (let i = 0; i < script.length; i += chunkSize) p.feed(script.slice(i, i + chunkSize));
  }
  p.end();
  return out;
}

/**
 * SENTENCE_FLUSH_MIN_CHARS 为 40 字；需要提前切片的夹具用这段达到门槛的正文起头。
 */
const LONG_BODY = '一二三四五六七八九十'.repeat(4);

describe('ScriptParser', () => {
  it('beat = 指令块 + 其后文本;短句标点不切片,标签边界照常切', () => {
    const r = parseAll('【微笑】大家好。今天天气不错!【点头】嗯嗯。');
    expect(r.beats).toHaveLength(2);
    expect(r.beats[0].commands.map((c) => c.kind === 'perform' && c.entry.clipId)).toEqual(['smile']);
    expect(r.speech.map((s) => s.piece.text)).toEqual(['大家好。今天天气不错!', '嗯嗯。']);
    expect(r.speech.map((s) => s.beatIndex)).toEqual([0, 1]);
  });

  it('正文满 40 字后在句末流中切片,短句累计且流末尾段仍发出', () => {
    const out: Collected = { beats: [], speech: [], ended: false };
    const p = new ScriptParser({
      onBeat: (b) => out.beats.push(b),
      onSpeech: (beatIndex, piece) => out.speech.push({ beatIndex, piece }),
      onEnd: () => {
        out.ended = true;
      },
    }, pack);
    const first = `一二三。${LONG_BODY}。”`;

    p.feed(`${first}后`);
    expect(out.ended).toBe(false);
    expect(out.speech.map((s) => s.piece.text)).toEqual([first]);

    p.feed('续。');
    expect(out.speech).toHaveLength(1);
    p.end();
    expect(out.speech.map((s) => s.piece.text)).toEqual([first, '后续。']);
    expect(out.speech.map((s) => s.beatIndex)).toEqual([0, 0]);
    expect(out.ended).toBe(true);
  });

  /*
 * 未满 40 字时句末标点不自动切片；遇到下一指令块的起始标签或流结束时仍会输出缓冲。
 */
  it.each(['。', '！', '？', '!', '?', '…'])('未满 40 字的句末标点 %s 不切片,流末整句发出', (punct) => {
    const short = `一二三四五六七八九十${punct}`;
    const r = parseAll(`${short}后续`);
    expect(r.speech.map((s) => s.piece.text)).toEqual([`${short}后续`]);
  });

  it.each(['。', '！', '？', '!', '?', '…'])('句末标点 %s 触发达标片', (punct) => {
    const r = parseAll(`${LONG_BODY}${punct}后续`);
    expect(r.speech.map((s) => s.piece.text)).toEqual([`${LONG_BODY}${punct}`, '后续']);
  });

  it('连续省略号与闭引号留在前片,任意 fragment 产出一致', () => {
    const script = `${LONG_BODY}……」后半句。`;
    const whole = parseAll(script);
    const chars = parseAll(script, 1);
    expect(whole.speech.map((s) => s.piece.text)).toEqual([`${LONG_BODY}……」`, '后半句。']);
    expect(chars.speech).toEqual(whole.speech);
    expect(whole.speech.map((s) => s.piece.text).join('')).toBe(script);
  });

  it('自动切片后锚点归属下一片的文本坐标重新起算', () => {
    // 标签化作的那个空格也计入门槛:四字 + 空格 + 35 字 + 句号 = 41 字
    const tail = '一二三四五六七八九十'.repeat(3) + '一二三四五';
    const r = parseAll(`一二三四<点头>${tail}。后半<点头>收尾。`);
    expect(r.speech.map((s) => s.piece.text)).toEqual([`一二三四 ${tail}。`, '后半 收尾。']);
    expect(r.speech[0].piece.anchors.map((a) => a.charOffset)).toEqual([4]);
    expect(r.speech[1].piece.anchors.map((a) => a.charOffset)).toEqual([2]);
  });

  it('逐字符喂入与整段喂入产出一致', () => {
    const script = '开场白没标签。【歪头,问号特效】这是什么?\n【Reset】\n结束了。';
    const whole = parseAll(script);
    const chars = parseAll(script, 1);
    expect(chars.beats.map((b) => [b.index, b.commands.length, b.atLineStart])).toEqual(
      whole.beats.map((b) => [b.index, b.commands.length, b.atLineStart]),
    );
    expect(chars.speech).toEqual(whole.speech);
  });

  it('脚本以文本开头时补无标签 beat;换行标记 atLineStart', () => {
    const r = parseAll('先说话。\n【前倾】再靠近。');
    expect(r.beats).toHaveLength(2);
    expect(r.beats[0].commands).toEqual([]);
    expect(r.beats[1].atLineStart).toBe(true);
  });

  it('孤立标签行:aloneOnLine 标记(含流末尾收尾)', () => {
    const r = parseAll('【惊吓后仰,流汗特效】\n吓我一跳。');
    expect(r.beats[0].aloneOnLine).toBe(true);
    const tail = parseAll('说完了。【垂头丧气】');
    expect(tail.beats[1].aloneOnLine).toBe(true);
    expect(tail.beats[1].commands).toHaveLength(1);
  });

  it('未知词静默丢弃,认识的照常进 beat', () => {
    const r = parseAll('【点头,起飞,微笑】好。');
    const cmds = r.beats[0].commands.filter((c) => c.kind === 'perform');
    expect(cmds.map((c) => c.kind === 'perform' && c.entry.clipId)).toEqual(['nod', 'smile']);
  });

  it('空【】只断句;残缺标签整块丢弃,标签文本绝不进语音', () => {
    const r = parseAll('前半句【】后半句。【没闭合的标签');
    expect(r.speech.map((s) => s.piece.text)).toEqual(['前半句', '后半句。']);
    expect(r.speech.every((s) => !s.piece.text.includes('【'))).toBe(true);
  });

  it('省略号收尾打上 endsWithEllipsis', () => {
    const r = parseAll('这里要是不挡……【点头】完了。');
    expect(r.speech[0].piece.endsWithEllipsis).toBe(true);
    expect(r.speech[1].piece.endsWithEllipsis).toBe(false);
  });

  it('<> 非阻断标签:不切分片,原位化作一个空格,charOffset 落在空格之前', () => {
    const r = parseAll('其实我今天没怎么<看一眼弹幕>吃饭吧,<看向屏幕>你们呢?');
    expect(r.speech).toHaveLength(1);
    const piece = r.speech[0].piece;
    expect(piece.text).toBe('其实我今天没怎么 吃饭吧, 你们呢?');
    expect(piece.anchors.map((a) => a.charOffset)).toEqual([8, 13]);
    expect(piece.anchors[0].commands).toMatchObject([{ kind: 'perform', entry: { clipId: 'glance_danmaku' } }]);
    expect(piece.anchors[1].commands).toMatchObject([{ kind: 'perform', entry: { clipId: 'screen' } }]);
  });

  it('<> 全角括号也认;全未知词不留锚点但仍化作空格;逐字符喂入一致', () => {
    const script = '前半＜点头＞后半<不存在的词>收尾';
    const whole = parseAll(script);
    expect(whole.speech[0].piece.text).toBe('前半 后半 收尾');
    expect(whole.speech[0].piece.anchors).toHaveLength(1);
    expect(whole.speech[0].piece.anchors[0].charOffset).toBe(2);
    const chars = parseAll(script, 1);
    expect(chars.speech).toEqual(whole.speech);
  });

  it('<> 与【】混用:锚点归属所在分片,【】照常切片', () => {
    const r = parseAll('【微笑】第一句<点头>还在第一句。【生气】第二句。');
    expect(r.speech.map((s) => s.piece.text)).toEqual(['第一句 还在第一句。', '第二句。']);
    expect(r.speech[0].piece.anchors.map((a) => a.charOffset)).toEqual([3]);
    expect(r.speech[1].piece.anchors).toEqual([]);
  });

  it('正文裸括号不被吃:超长回吐、流末回吐、"<3"存活', () => {
    const r = parseAll('比如 3<5 这种式子照常念,最后比个心 <3');
    expect(r.speech[0].piece.text).toBe('比如 3<5 这种式子照常念,最后比个心 <3');
    expect(r.speech[0].piece.anchors).toEqual([]);
  });

  it('[] 语气词:白名单按规范写法透传进正文,大小写归一,表外剥离', () => {
    const r = parseAll('赢了[Laughing]开心,[fake-tag]但也险[sigh]。');
    expect(r.speech[0].piece.text).toBe('赢了[laughing]开心,但也险[sigh]。');
  });

  it('语气词后的 <> 锚点落在标签文本之后', () => {
    const r = parseAll('哈哈[laughing]<雀跃>好耶');
    const piece = r.speech[0].piece;
    expect(piece.text).toBe('哈哈[laughing] 好耶');
    expect(piece.anchors[0].charOffset).toBe('哈哈[laughing]'.length);
  });

  it('纯锚点片:【】后只有 <> 没有正文,空文本片携锚点', () => {
    const r = parseAll('【微笑】<点头>');
    expect(r.beats).toHaveLength(1);
    expect(r.speech).toHaveLength(1);
    expect(r.speech[0].piece.text).toBe('');
    expect(r.speech[0].piece.anchors[0].commands).toMatchObject([
      { kind: 'perform', entry: { clipId: 'nod' } },
    ]);
  });

  it('<> 里全是未知词:不产生锚点,标签位置仍化作空格', () => {
    const r = parseAll('说着说着<起飞,不存在的词>切过去。');
    expect(r.speech[0].piece.anchors).toEqual([]);
    expect(r.speech[0].piece.text).toBe('说着说着 切过去。');
  });
});

describe('stripUnknownTags', () => {
  // 词是直播实测里她真造过的:解析器静默丢弃它们,留在上下文里就成了"这么写有效"的假证据
  it('块内逐词过滤,一个不剩就整块删掉', () => {
    const r = stripUnknownTags('【惊吓后仰,喘气特效】哇!<喘不过气状>吓死我了', pack);
    expect(r.script).toBe('【惊吓后仰】哇!吓死我了');
    expect(r.dropped).toEqual(['喘气特效', '喘不过气状']);
  });

  it('把语气词写进动作括号也算没命中(<sigh> 是实测里出现过的写法)', () => {
    const r = stripUnknownTags('还跑到沼泽来了<sigh>白桦树也没找到', pack);
    expect(r.script).toBe('还跑到沼泽来了白桦树也没找到');
    expect(r.dropped).toEqual(['sigh']);
  });

  it('[] 只放行白名单并归一到规范写法', () => {
    const r = stripUnknownTags('[SIGH]累了[喘气]真的累了[laughing]', pack);
    expect(r.script).toBe('[sigh]累了真的累了[laughing]');
    expect(r.dropped).toEqual(['[喘气]']);
  });

  it('别名按她写下的样子留着;全命中时一字不改', () => {
    const src = '【凑近,微笑】嘿嘿<看向镜头>[laughing]';
    expect(stripUnknownTags(src, pack)).toEqual({ script: src, dropped: [] });
  });

  it('正文中的裸括号按原文保留', () => {
    const src = '3<5 这件事我一直没搞懂 [大概吧';
    expect(stripUnknownTags(src, pack)).toEqual({ script: src, dropped: [] });
    const long = `<${'很长的一段正文'.repeat(6)}>`;
    expect(stripUnknownTags(long, pack)).toEqual({ script: long, dropped: [] });
  });
});

describe('PerformancePack.resolveTag', () => {
  it('别名归一化;看一眼弹幕与看向…', () => {
    expect(pack.resolveTag('凑近')).toMatchObject({ kind: 'perform', entry: { clipId: 'lean_in' } });
    expect(pack.resolveTag('呆住')).toMatchObject({ kind: 'perform', entry: { clipId: 'freeze' } });
    expect(pack.resolveTag('叹气')).toMatchObject({ kind: 'perform', entry: { clipId: 'dejected' } });
    expect(pack.resolveTag('看一眼弹幕')).toMatchObject({
      kind: 'perform',
      entry: { clipId: 'glance_danmaku', channel: 'gesture', lifecycle: 'pulse' },
    });
    expect(pack.resolveTag('看向屏幕')).toMatchObject({
      kind: 'perform',
      entry: { clipId: 'screen', channel: 'gaze', lifecycle: 'state' },
    });
    // 注视词改名前叫「开始看向…」,旧 session 与她的记忆里还有
    expect(pack.resolveTag('开始看向屏幕')).toMatchObject({
      kind: 'perform',
      entry: { word: '看向屏幕', clipId: 'screen' },
    });
    expect(pack.resolveTag('看弹幕')).toBeNull();
    expect(pack.resolveTag('Reset')).toEqual({ kind: 'reset' });
    expect(pack.resolveTag('起飞')).toBeNull();
  });

  it('近义词映射到词表;强弱档使用同一 clip 的不同幅度', () => {
    expect(pack.resolveTag('笑')).toMatchObject({ kind: 'perform', entry: { clipId: 'smile' } });
    expect(pack.resolveTag('哈哈')).toMatchObject({ kind: 'perform', entry: { clipId: 'laugh' } });
    expect(pack.resolveTag('看向斜上方')).toMatchObject({ kind: 'perform', entry: { clipId: 'up' } });
    const soft = pack.resolveTag('点头');
    const hard = pack.resolveTag('用力点头');
    expect(soft).toMatchObject({ kind: 'perform', entry: { clipId: 'nod' } });
    expect(hard).toMatchObject({ kind: 'perform', entry: { clipId: 'nod', intensity: 1.35 } });
    if (soft?.kind !== 'perform') throw new Error('点头 未解析为 perform');
    expect(soft.entry.intensity).toBeUndefined();
  });
});

describe('JsonScriptStream', () => {
  function decode(fragments: string[]): string {
    let out = '';
    const s = new JsonScriptStream((t) => {
      out += t;
    });
    for (const f of fragments) s.feed(f);
    s.end();
    return out;
  }

  it('整包与逐字符分片解出同样明文', () => {
    const args = JSON.stringify({ script: '【微笑】你好\n"引号"和\\反斜杠' });
    const whole = decode([args]);
    const chars = decode([...args].map((c) => c));
    expect(whole).toBe('【微笑】你好\n"引号"和\\反斜杠');
    expect(chars).toBe(whole);
  });

  it('\\uXXXX 跨片段拼合(含代理对)', () => {
    const raw = '{"script": "a\\u597d\\ud83d\\ude00b"}';
    const cut = [raw.slice(0, 18), raw.slice(18, 21), raw.slice(21)];
    expect(decode(cut)).toBe('a好😀b');
  });

  it('闭合引号后的尾巴不再进明文', () => {
    expect(decode(['{"script":"你好"', ', "x": 1}'])).toBe('你好');
  });

  it('script 不是字符串时不越过该值误播后续字段', () => {
    for (const script of [123, null, { nested: true }]) {
      const args = JSON.stringify({ script, other: '绝不能播出' });
      expect(decode([args])).toBe('');
      expect(decode([...args])).toBe('');
    }
  });

  it('嵌套对象的同名键不冒充顶层 script', () => {
    const args = JSON.stringify({ meta: { script: '错的' }, script: '对的' });
    expect(decode([args])).toBe('对的');
    expect(decode([...args])).toBe('对的');
  });
});
