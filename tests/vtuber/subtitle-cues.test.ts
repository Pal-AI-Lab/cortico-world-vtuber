import { describe, it, expect } from 'vitest';
import type { AlignedUnit } from '../../src/align.ts';
import { segmentUnits } from '../../src/align.ts';
import {
  computeSubtitleCues,
  describeSubtitleCues,
  subtitleChunks,
  summarizeSubtitleCues,
} from '../../src/subtitle-cues.ts';

/** 等间隔铺一版对齐 units:每单元 stepSec 秒,从 startSec 起 */
function evenUnits(text: string, stepSec: number, startSec = 0): AlignedUnit[] {
  return segmentUnits(text).map((u, i) => ({
    text: u,
    start: startSec + i * stepSec,
    end: startSec + (i + 1) * stepSec,
  }));
}

const EST = { leadInMs: 500, msPerUnit: 250 };

describe('computeSubtitleCues', () => {
  it('句末标点必断,每条 cue 拿到递增的时间区间', () => {
    const text = '今天聊聊上周那盘棋。中盘被反杀了!不过结尾还行吧…';
    const cues = computeSubtitleCues(text, { units: evenUnits(text, 0.2), ...EST });
    expect(cues.map((c) => c.text)).toEqual(['今天聊聊上周那盘棋。', '中盘被反杀了!', '不过结尾还行吧…']);
    expect(cues[0].atMs).toBe(0);
    for (let i = 1; i < cues.length; i++) expect(cues[i].atMs).toBeGreaterThan(cues[i - 1].atMs);
    // 对齐时刻:第二条从第 9 个单元起(「今天聊聊上周那盘棋」9 个单元 × 200ms)
    expect(cues[1].atMs).toBe(1800);
  });

  it('speakMs 是不含垫时的发声区间:对齐时按单元真实时刻,短句 durMs 被垫高但 speakMs 不动', () => {
    const text = '今天聊聊上周那盘棋。中盘被反杀了!';
    const cues = computeSubtitleCues(text, { units: evenUnits(text, 0.2), ...EST });
    // 第一条 9 单元 × 200ms:发声区间就是 1800ms
    expect(cues[0].speakMs).toBe(1800);
    for (const c of cues) {
      expect(c.speakMs).toBeGreaterThanOrEqual(0);
      // durMs 会被最短显示时长/收尾停留垫高,speakMs 永远不超过它
      expect(c.speakMs).toBeLessThanOrEqual(c.durMs);
    }
  });

  it('超长句在逗号断,不碎成词粒度', () => {
    const text = '这句话特别长而且中间只有逗号,一直说一直说根本停不下来,直到最后才有一个句号收尾,大概就是这样了。';
    const cues = computeSubtitleCues(text, { ...EST });
    expect(cues.length).toBeGreaterThan(1);
    // 每条以标点结尾(在逗号/句号处断),且不超过一条能读的长度
    for (const c of cues) {
      expect(c.text.length).toBeLessThanOrEqual(30);
      expect(/[,。]$/.test(c.text)).toBe(true);
    }
    expect(cues.map((c) => c.text).join('')).toBe(text);
  });

  it('超过 MAX_UNITS 的全角逗号长句断在逗号上,不硬切进词中间、不留孤儿尾', () => {
    // 45 单元、三个全角逗号。软断点不认全角时这里只能每 22 单元硬切:
    // 切点落在「根本|停不下来」这种词中间,末尾还甩出一条单字的 cue「了。」
    const text = '这句话特别长而且中间只有逗号，一直说一直说根本停不下来，直到最后才有一个句号收尾，大概就是这样了。';
    expect(computeSubtitleCues(text, { ...EST }).map((c) => c.text)).toEqual([
      '这句话特别长而且中间只有逗号，',
      '一直说一直说根本停不下来，',
      '直到最后才有一个句号收尾，大概就是这样了。',
    ]);
  });

  it('无标点长串按单元数硬切,不吞字', () => {
    const text = '一二三四五六七八九十'.repeat(5); // 50 个单元,零标点
    const cues = computeSubtitleCues(text, { ...EST });
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((c) => c.text).join('')).toBe(text);
  });

  it('对齐 units 在手时按真实时刻;units 缺席但时长已知按比例;都缺席按校准估计', () => {
    const text = '前半句说完了。后半句才开始。';
    const n = segmentUnits(text).length;
    const half = segmentUnits('前半句说完了').length;

    const aligned = computeSubtitleCues(text, { units: evenUnits(text, 0.3, 1.0), ...EST });
    expect(aligned[0].atMs).toBe(1000);
    expect(aligned[1].atMs).toBe(Math.round(1000 + half * 300));

    const byDuration = computeSubtitleCues(text, { durationMs: 6000, ...EST });
    expect(byDuration[1].atMs).toBe(Math.round((half / n) * 6000));

    const byEstimate = computeSubtitleCues(text, { ...EST });
    expect(byEstimate[0].atMs).toBe(EST.leadInMs);
    expect(byEstimate[1].atMs).toBe(EST.leadInMs + half * EST.msPerUnit);
  });

  it('[] 语气词不进显示文本,但占用时间轴上的单元', () => {
    const text = '唉[sigh]今天没打好。明天再来。';
    const cues = computeSubtitleCues(text, { units: evenUnits(text, 0.2), ...EST });
    expect(cues[0].text).toBe('唉今天没打好。');
    // [sigh] 是第 2 个单元:第二句的起点包含它占的 200ms
    const firstSentenceUnits = segmentUnits('唉[sigh]今天没打好').length;
    expect(cues[1].atMs).toBe(firstSentenceUnits * 200);
  });

  it('显示区间顺延到下一条起点,长停顿不无限拖;末条有收尾停留', () => {
    const text = '第一句。第二句。';
    // 两句之间隔 5 秒(远超 GAP_HOLD):第一条不该一直挂着等
    const units = [
      ...evenUnits('第一句', 0.2, 0),
      ...evenUnits('第二句', 0.2, 5.6),
    ];
    const cues = computeSubtitleCues(text, { units, ...EST });
    const first = cues[0];
    expect(first.atMs + first.durMs).toBeLessThan(cues[1].atMs);
    // 末条 = 语音区间 + 收尾停留
    const last = cues[cues.length - 1];
    expect(last.durMs).toBeGreaterThan(600);
  });

  /*
   * 线性外推须计入标点与语音标签停顿；停顿先验由调用方传入，与预算路径共用口径。
   */
  const PRIORS = { pausePriors: { endPunctMs: 570, midPunctMs: 200, voiceTagMs: 1500 } };

  it('估计档的停顿先验:前面 chunk 的句末停顿累积进后续 cue 的起点', () => {
    const text = '前半句说完了。后半句才开始。';
    const half = segmentUnits('前半句说完了').length;
    const cues = computeSubtitleCues(text, { ...EST, ...PRIORS });
    // 第一条起点不变(前面没有停顿);第二条加上首句句末标点的 570ms
    expect(cues[0].atMs).toBe(EST.leadInMs);
    expect(cues[1].atMs).toBe(EST.leadInMs + half * EST.msPerUnit + 570);
  });

  it('语音标签的 1.5 秒也进先验;标签仍占它自己的那 1 个单元', () => {
    const text = '唉[sigh]今天没打好。明天再来。';
    const first = segmentUnits('唉[sigh]今天没打好。').length;
    const cues = computeSubtitleCues(text, { ...EST, ...PRIORS });
    expect(cues[0].text).toBe('唉今天没打好。');
    expect(cues[1].atMs).toBe(EST.leadInMs + first * EST.msPerUnit + 570 + 1500);
  });

  it('停顿先验只属估计档:对齐/时长两级真实时间源一个数都不变', () => {
    const text = '前半句说完了。后半句才开始。';
    expect(computeSubtitleCues(text, { units: evenUnits(text, 0.3), ...EST, ...PRIORS }))
      .toEqual(computeSubtitleCues(text, { units: evenUnits(text, 0.3), ...EST }));
    expect(computeSubtitleCues(text, { durationMs: 6000, ...EST, ...PRIORS }))
      .toEqual(computeSubtitleCues(text, { durationMs: 6000, ...EST }));
    // 不传先验的估计档也原样(旧口径不被隐式改动)
    const bare = computeSubtitleCues(text, { ...EST });
    expect(bare[1].atMs).toBe(EST.leadInMs + segmentUnits('前半句说完了').length * EST.msPerUnit);
  });

  it('units 只是前缀时:前缀内按真实时刻,之外从末对齐单元终点按速率外推,只补前缀外的停顿', () => {
    const text = '前半句说完了。后半句才开始。';
    const half = segmentUnits('前半句说完了').length;
    const full = evenUnits(text, 0.3, 1.0);
    // 前缀只盖到首句末单元(半句):第二条起点 = 末对齐单元终点 + 句末停顿;
    // 首句自己的终点是对齐的,speakMs 不含它句末的停顿
    const prefix = computeSubtitleCues(text, { units: full.slice(0, half), ...EST, ...PRIORS });
    expect(prefix[0].atMs).toBe(1000);
    expect(prefix[0].speakMs).toBe(half * 300);
    expect(prefix[1].atMs).toBe(1000 + half * 300 + 570);
    // 第二条的终点:从末对齐单元终点外推剩余单元,再加自己的句末停顿
    const rest = segmentUnits(text).length - half;
    expect(prefix[1].speakMs).toBe(rest * EST.msPerUnit + 570);
    // 前缀多盖一个单元(第二句首字已对齐):第二条起点是它的真实 start,停顿已在真实时刻里
    const more = computeSubtitleCues(text, { units: full.slice(0, half + 1), ...EST, ...PRIORS });
    expect(more[1].atMs).toBe(Math.round(1000 + half * 300));
    // 全量对齐与前缀恰好等于全量时相同
    expect(computeSubtitleCues(text, { units: full, ...EST, ...PRIORS }))
      .toEqual(computeSubtitleCues(text, { units: full, ...EST }));
  });

  it('subtitleChunks 与 cue 列表同序同长:剥空的纯标签 chunk 不占位', () => {
    const text = '唉[sigh]今天没打好。[laughing]明天再来。';
    const cues = computeSubtitleCues(text, { ...EST });
    const chunks = subtitleChunks(text);
    expect(chunks).toHaveLength(cues.length);
    expect(cues.map((c) => c.text)).toEqual(['唉今天没打好。', '明天再来。']);
    expect(chunks[0]).toEqual({ startUnit: 0, endUnit: segmentUnits('唉[sigh]今天没打好。').length });
    expect(chunks[1].endUnit).toBe(segmentUnits(text).length);
    expect(subtitleChunks('')).toEqual([]);
  });

  it('空文本与纯标签文本给空表;短句一条到底', () => {
    expect(computeSubtitleCues('', { ...EST })).toEqual([]);
    expect(computeSubtitleCues('  ', { ...EST })).toEqual([]);
    const one = computeSubtitleCues('好。', { ...EST });
    expect(one).toHaveLength(1);
    expect(one[0].text).toBe('好。');
    expect(one[0].durMs).toBeGreaterThanOrEqual(1000);
  });
});

/**
 * 字幕观测摘要是只读 cue 表的纯函数，不参与显示决策。
 */
describe('summarizeSubtitleCues 观测摘要', () => {
  it('按批汇总条数/字数/首条时刻/占屏跨度,发声与垫时可加总', () => {
    const text = '今天聊聊上周那盘棋。中盘被反杀了!不过结尾还行吧…';
    const cues = computeSubtitleCues(text, { units: evenUnits(text, 0.2), ...EST });
    const d = summarizeSubtitleCues(cues);

    expect(d.cues).toBe(cues.length);
    expect(d.chars).toBe(cues.reduce((n, c) => n + [...c.text].length, 0));
    expect(d.firstAtMs).toBe(cues[0].atMs);
    const last = cues[cues.length - 1];
    expect(d.spanMs).toBe(last.atMs + last.durMs - cues[0].atMs);
    expect(d.speakMs).toBe(cues.reduce((n, c) => n + c.speakMs, 0));
    expect(d.padMs).toBe(cues.reduce((n, c) => n + (c.durMs - c.speakMs), 0));
    expect(d.noSpeak).toBe(0);
  });

  it('speakMs 为 0 的条单独计数——那些条的增量跟播退化成整句直出', () => {
    const d = summarizeSubtitleCues([
      { text: '有声的', atMs: 0, durMs: 1200, speakMs: 800 },
      { text: '零发声的', atMs: 1200, durMs: 1000, speakMs: 0 },
    ]);
    expect(d.cues).toBe(2);
    expect(d.noSpeak).toBe(1);
    expect(d.speakMs).toBe(800);
    expect(d.padMs).toBe(1400);
  });

  it('空表给全零,不制造 NaN', () => {
    const d = summarizeSubtitleCues([]);
    expect(d).toEqual({ cues: 0, chars: 0, firstAtMs: 0, spanMs: 0, speakMs: 0, padMs: 0, noSpeak: 0 });
  });

  it('describeSubtitleCues 一条能读的行:时间源、条数、跨度、发声占比都在里面', () => {
    const text = '今天聊聊上周那盘棋。中盘被反杀了!';
    const cues = computeSubtitleCues(text, { units: evenUnits(text, 0.2), ...EST });
    const line = describeSubtitleCues(summarizeSubtitleCues(cues), 'align');
    expect(line).toContain('对齐');
    expect(line).toContain(`${cues.length} 条`);
    expect(line).toMatch(/跨度 \d+ms/);
    expect(line).toMatch(/发声 \d+ms/);
    expect(describeSubtitleCues(summarizeSubtitleCues([]), 'estimate')).toContain('0 条');
    expect(describeSubtitleCues(summarizeSubtitleCues([]), 'estimate')).toContain('估计');
    expect(describeSubtitleCues(summarizeSubtitleCues(computeSubtitleCues(text, { durationMs: 4000, ...EST })), 'duration'))
      .toContain('时长');
  });
});
