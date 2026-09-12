import { describe, it, expect } from 'vitest';
import { AlignerClient, countPauses, judgeAlignment, segmentUnits, type AlignedUnit } from '../../src/align.ts';
import { makeWav } from './helpers.ts';

describe('segmentUnits', () => {
  it('汉字逐字,标点与空白不成单元', () => {
    expect(segmentUnits('你好,世界!')).toEqual(['你', '好', '世', '界']);
  });

  it('拉丁按词,与汉字混排时各按各的粒度', () => {
    expect(segmentUnits('我在用 llama.cpp 跑')).toEqual(['我', '在', '用', 'llama', 'cpp', '跑']);
  });

  it('日语逐字,拗音促音长音归并到前一个字', () => {
    // きょ / っ / ちゃ 各自与前字合成一个单元,ー 依附于 ボ
    expect(segmentUnits('今日はちょっとボーッとしてた')).toEqual(
      ['今', '日', 'は', 'ちょ', 'っ', 'と', 'ボー', 'ッ', 'と', 'し', 'て', 'た'],
    );
  });

  it('连字符与撇号留在词内', () => {
    expect(segmentUnits("it's well-known")).toEqual(["it's", 'well-known']);
  });

  it('空文本与纯标点给出空单元表', () => {
    expect(segmentUnits('')).toEqual([]);
    expect(segmentUnits('…,。!?')).toEqual([]);
  });

  it('语气词整体一个单元:音频里是一段真实发声,必须有人认领', () => {
    expect(segmentUnits('赢了[laughing]开心')).toEqual(['赢', '了', '[laughing]', '开', '心']);
    expect(segmentUnits('[sigh]唉')).toEqual(['[sigh]', '唉']);
  });

  it('表外方括号内容不聚合,按普通字符切', () => {
    expect(segmentUnits('看[fake]这个')).toEqual(['看', 'fake', '这', '个']);
  });
});

describe('judgeAlignment', () => {
  /** 实测的正确对齐:单调、无反向、覆盖到尾 */
  const good: AlignedUnit[] = [
    { text: '我', start: 0.0, end: 0.08 },
    { text: '觉', start: 0.08, end: 0.16 },
    { text: '得', start: 0.16, end: 0.4 },
    { text: '我', start: 0.4, end: 0.4 },
    { text: '没', start: 0.4, end: 0.48 },
    { text: '样', start: 5.68, end: 5.76 },
    { text: '的', start: 5.76, end: 5.92 },
  ];

  it('放行正常对齐;单个零长跨度不算退化', () => {
    const v = judgeAlignment(good, 6.08);
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.coverage).toBeGreaterThan(0.95);
    expect(v.backwards).toBe(0);
  });

  it('语气词是软单元:与邻字轻微倒挂不进异常计数(8011 实测形态)', () => {
    // 实测:[laughing] 跨度落在笑声尾部,起点晚于其后第一个字
    const units: AlignedUnit[] = [
      { text: '赢', start: 2.56, end: 2.72 },
      { text: '了', start: 2.72, end: 3.04 },
      { text: '[laughing]', start: 5.36, end: 5.6 },
      { text: '不', start: 5.28, end: 5.36 },
      { text: '过', start: 5.36, end: 5.6 },
      { text: '[sigh]', start: 7.68, end: 7.68 },
      { text: '刚', start: 8.64, end: 8.8 },
      { text: '才', start: 8.8, end: 10.0 },
    ];
    const v = judgeAlignment(units, 10.24);
    expect(v.backwards).toBe(0);
    expect(v.degenerate).toBe(0);
    expect(v.ok).toBe(true);
  });

  it('拦下时序倒挂:6.08s 的音频配错逐字稿时的实测结果', () => {
    const bad: AlignedUnit[] = [
      { text: '今', start: 0.0, end: 0.16 }, { text: '天', start: 0.16, end: 0.16 },
      { text: '天', start: 0.16, end: 0.24 }, { text: '气', start: 0.16, end: 0.32 },
      { text: '真', start: 1.28, end: 1.44 }, { text: '好', start: 1.44, end: 1.52 },
      { text: '我', start: 0.32, end: 0.4 }, { text: '们', start: 0.4, end: 0.48 },
      { text: '去', start: 0.48, end: 1.84 }, { text: '公', start: 0.64, end: 0.72 },
      { text: '园', start: 1.44, end: 1.12 }, { text: '散', start: 0.56, end: 0.72 },
      { text: '步', start: 0.72, end: 0.8 }, { text: '吧', start: 1.52, end: 1.6 },
      { text: '真', start: 0.8, end: 0.96 }, { text: '的', start: 0.96, end: 1.6 },
      { text: '很', start: 0.96, end: 0.96 }, { text: '开', start: 0.96, end: 1.12 },
      { text: '心', start: 1.12, end: 2.08 },
    ];
    const v = judgeAlignment(bad, 6.08);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/时序倒挂 3 处/);
    expect(v.reasons.join()).toMatch(/覆盖率/);
  });

  it('拦下只覆盖前段的对齐(TTS 吞尾)', () => {
    const short: AlignedUnit[] = [
      { text: '你', start: 0.0, end: 0.2 },
      { text: '好', start: 0.2, end: 0.4 },
    ];
    const v = judgeAlignment(short, 6.0);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/覆盖率/);
  });

  it('起头静音再长也不成其为证据:那是 VoxCPM2 的固定形状,不是念了别的东西', () => {
    // 夹具音频长 3.04 秒，正文从 1.44 秒开始；起头静默占比较高仍可属于正常输出。
    const late: AlignedUnit[] = [
      { text: '你', start: 1.44, end: 1.52 },
      { text: '好', start: 1.52, end: 1.92 },
      { text: '错', start: 2.64, end: 2.88 },
    ];
    const v = judgeAlignment(late, 3.04);
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    // 真出问题的两类照旧拦得住:这一条尾部覆盖是好的,说明不是靠 coverage 兜的
    expect(v.coverage).toBeGreaterThan(0.9);
  });

  it('正常片放行', () => {
    expect(judgeAlignment(good, 6.08).ok).toBe(true);
  });

  it('空对齐不放行', () => {
    expect(judgeAlignment([], 3).ok).toBe(false);
  });
});

describe('AlignerClient', () => {
  it('按 segmentUnits 切好单元发出去,回来的结果带裁决', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          sample_rate: 16000,
          duration: 0.4,
          units: [
            { text: '你', start: 0.0, end: 0.2 },
            { text: '好', start: 0.2, end: 0.4 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = new AlignerClient({ url: 'http://x:1/', fetchImpl });
    const out = await client.align(makeWav(new Array(6400).fill(0.2), 16000), '你好。');

    expect(sent.units).toEqual(['你', '好']);
    expect(typeof sent.audio).toBe('string');
    expect(out.units).toHaveLength(2);
    expect(out.verdict.ok).toBe(true);
  });

  it('单元表为空时不发请求', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = new AlignerClient({ url: 'http://x:1', fetchImpl });
    const out = await client.align(new Uint8Array(0), '，。！');
    expect(called).toBe(0);
    expect(out.units).toEqual([]);
    expect(out.verdict.ok).toBe(false);
  });

  it('available 认 health 里的 aligner 标志', async () => {
    const mk = (body: unknown) =>
      new AlignerClient({
        url: 'http://x:1',
        fetchImpl: (async () =>
          new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
      });
    expect(await mk({ status: 'ok', aligner: true }).available()).toBe(true);
    expect(await mk({ status: 'ok', aligner: false }).available()).toBe(false);
  });

  it('server 报错时抛出带状态码的错误', async () => {
    const client = new AlignerClient({
      url: 'http://x:1',
      fetchImpl: (async () => new Response('aligner not loaded', { status: 500 })) as typeof fetch,
    });
    await expect(client.align(new Uint8Array(0), '你好')).rejects.toThrow(/对齐 500/);
  });
});

describe('judgeAlignment 短片段', () => {
  /** TTS 分片常常只有七八个单元,单处异常就占 13%——不该按漏字论处 */
  it('八个单元里单处反向/倒挂放行', () => {
    const short: AlignedUnit[] = [
      { text: '你', start: 0.0, end: 0.16 },
      { text: '好', start: 0.16, end: 0.32 },
      { text: '今', start: 0.32, end: 0.30 }, // 单处反向
      { text: '天', start: 0.48, end: 0.64 },
      { text: '天', start: 0.64, end: 0.80 },
      { text: '气', start: 0.72, end: 0.96 }, // 单处倒挂
      { text: '不', start: 0.96, end: 1.12 },
      { text: '错', start: 1.12, end: 1.52 },
    ];
    expect(judgeAlignment(short, 1.6).ok).toBe(true);
  });

  it('两处以上才算证据', () => {
    const two: AlignedUnit[] = [
      { text: '你', start: 0.0, end: 0.16 },
      { text: '好', start: 0.16, end: 0.10 },
      { text: '今', start: 0.32, end: 0.30 },
      { text: '天', start: 0.48, end: 1.52 },
    ];
    const v = judgeAlignment(two, 1.6);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/跨度反向 2 处/);
  });

  it('短片段里正常的起头静音不判成念了别的东西', () => {
    // 0.24s / 1.28s = 19%,比例已经不低,但绝对时长不到半个音节
    const lead: AlignedUnit[] = [
      { text: '你', start: 0.24, end: 0.5 },
      { text: '好', start: 0.5, end: 1.2 },
    ];
    expect(judgeAlignment(lead, 1.28).ok).toBe(true);
  });
});

describe('countPauses', () => {
  it('数的是 segmentUnits 丢掉的那部分:标点与语音标签', () => {
    // 单元切分把标点整个丢掉,而 VoxCPM2 把它们念成真停顿——跑飞门要自己数
    expect(segmentUnits('好了。走吧,先挖矿!')).toEqual(['好', '了', '走', '吧', '先', '挖', '矿']);
    expect(countPauses('好了。走吧,先挖矿!')).toEqual({ endPunct: 2, midPunct: 1, voiceTags: 0 });
  });

  it('省略号与破折号逐字计:「对……」是一个字带两拍拖音', () => {
    expect(countPauses('对……')).toEqual({ endPunct: 2, midPunct: 0, voiceTags: 0 });
    expect(countPauses('九块——')).toEqual({ endPunct: 0, midPunct: 2, voiceTags: 0 });
  });

  it('语音标签单数:它在单元里只算一个,实际却值一秒半', () => {
    expect(countPauses('赢了[laughing]开心[sigh]')).toEqual({ endPunct: 0, midPunct: 0, voiceTags: 2 });
  });

  it('词表里最长的标签也要数到:上限与 segmentUnits 同为 32 字符', () => {
    // Dissatisfaction-hnn 有 19 字符,按 16 数就漏掉一个 1.5 秒的停顿
    expect(countPauses('[Dissatisfaction-hnn] 哼')).toMatchObject({ voiceTags: 1 });
    expect(segmentUnits('[Dissatisfaction-hnn] 哼')).toContain('[Dissatisfaction-hnn]');
  });

  it('没有标点也没有标签时全零', () => {
    expect(countPauses('往东边走过去看看')).toEqual({ endPunct: 0, midPunct: 0, voiceTags: 0 });
  });
});
