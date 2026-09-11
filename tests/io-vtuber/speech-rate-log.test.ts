import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PauseCounts, PausePriors } from '../../src/io-vtuber/align.ts';
import {
  netUnitMsQuantile,
  SpeechRateLog,
  SPEECH_RATE_MIN_SAMPLES,
  SPEECH_RATE_QUANTILE,
  type SpeechRateSample,
} from '../../src/io-vtuber/speech-rate-log.ts';

const dirs: string[] = [];

function tempLog(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vtuber-speech-rate-'));
  dirs.push(dir);
  return { dir, path: join(dir, 'speech-rate.jsonl') };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NO_PAUSE: PauseCounts = { endPunct: 0, midPunct: 0, voiceTags: 0 };
const PRIORS: PausePriors = { endPunctMs: 570, midPunctMs: 200, voiceTagMs: 1500 };
const LEAD_IN = 500;

describe('SpeechRateLog', () => {
  it('只恢复当前声线最近的实测样本,units、durationMs 与停顿计数原样给出', () => {
    const { path } = tempLog();
    const log = new SpeechRateLog(path);
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const pauses: PauseCounts = { endPunct: 1, midPunct: 2, voiceTags: 0 };
    log.append(a, { units: 4, durationMs: 1600, pauses }, 1);
    log.append(b, { units: 2, durationMs: 1200, pauses: NO_PAUSE }, 2);
    log.append(a, { units: 3, durationMs: 1500, pauses: NO_PAUSE }, 3);

    // 相除留给消费方:唱歌预算要毛速率,估计路径要扣掉起播引子与停顿的净速率
    expect(new SpeechRateLog(path).samples(a)).toEqual([
      { units: 4, durationMs: 1600, pauses },
      { units: 3, durationMs: 1500, pauses: NO_PAUSE },
    ]);
    expect(new SpeechRateLog(path).samples(b)).toEqual([{ units: 2, durationMs: 1200, pauses: NO_PAUSE }]);
  });

  it('跳过损坏行与没有停顿计数的 v1 记录,并服从读取上限', () => {
    const { path } = tempLog();
    const key = 'c'.repeat(64);
    const v1 = JSON.stringify({ v: 1, tsMs: 0, profileKey: key, units: 2, durationMs: 900 });
    writeFileSync(path, `not-json\n{"v":2}\n${v1}\n`, 'utf8');
    const log = new SpeechRateLog(path);
    log.append(key, { units: 2, durationMs: 800, pauses: NO_PAUSE }, 1);
    log.append(key, { units: 2, durationMs: 1000, pauses: NO_PAUSE }, 2);
    log.append(key, { units: 2, durationMs: 1200, pauses: NO_PAUSE }, 3);

    expect(new SpeechRateLog(path).samples(key)).toHaveLength(3);
    expect(new SpeechRateLog(path).samples(key, 2)).toEqual([
      { units: 2, durationMs: 1000, pauses: NO_PAUSE },
      { units: 2, durationMs: 1200, pauses: NO_PAUSE },
    ]);
  });

  it('长时间运行后压缩为有界日志', () => {
    const { path } = tempLog();
    const key = 'd'.repeat(64);
    const log = new SpeechRateLog(path);
    for (let i = 0; i < 1024; i++) log.append(key, { units: 1, durationMs: i + 1, pauses: NO_PAUSE }, i + 1);

    const samples = new SpeechRateLog(path).samples(key, 600);
    expect(samples).toHaveLength(512);
    expect(samples[0]).toEqual({ units: 1, durationMs: 513, pauses: NO_PAUSE });
    expect(samples.at(-1)).toEqual({ units: 1, durationMs: 1024, pauses: NO_PAUSE });
  });
});

/*
 * 字幕估计、预算与锚点死线共用实测速率分位；夹具保留净速率分布以验证分位计算。
 */
describe('netUnitMsQuantile 实测速率分位', () => {
  const sample = (units: number, netMs: number, pauses: PauseCounts = NO_PAUSE): SpeechRateSample => ({
    units,
    durationMs: netMs * units + LEAD_IN + pauses.endPunct * PRIORS.endPunctMs + pauses.midPunct * PRIORS.midPunctMs
      + pauses.voiceTags * PRIORS.voiceTagMs,
    pauses,
  });

  it('样本不足时不认账,交回 null 由调用方回落常数', () => {
    const few = Array.from({ length: SPEECH_RATE_MIN_SAMPLES - 1 }, () => sample(10, 400));
    expect(netUnitMsQuantile(few, LEAD_IN, PRIORS)).toEqual({
      msPerUnit: null,
      samples: SPEECH_RATE_MIN_SAMPLES - 1,
    });
    expect(netUnitMsQuantile([], LEAD_IN, PRIORS).msPerUnit).toBeNull();
  });

  it('刚够门槛就认账,取的是 p75 而不是中位或尾部', () => {
    // 20 条等距净速率 150..1290(都在合理带内):p50=690、p75=990、max=1290
    const rates = Array.from({ length: 20 }, (_, i) => 150 + i * 60);
    const samples = rates.map((r) => sample(8, r));
    const got = netUnitMsQuantile(samples, LEAD_IN, PRIORS);
    expect(got.samples).toBe(20);
    expect(SPEECH_RATE_QUANTILE).toBe(0.75);
    // p75 = 升序第 15 个 = 150 + 14*60 = 990
    expect(got.msPerUnit).toBeCloseTo(990, 6);
    // 分位必须严格在中位之上(字幕早于嘴的损失更大),又必须低于最大值(别把「早」换成「晚」)
    const sorted = [...rates].sort((a, b) => a - b);
    expect(got.msPerUnit!).toBeGreaterThan(sorted[9]);
    expect(got.msPerUnit!).toBeLessThan(sorted[19]);
  });

  it('扣掉起播引子再算,不把引子算两遍', () => {
    // 同一批片:净速率恒 400,毛速率(含 500ms 引子)会随片长在 450~600 之间飘
    const samples = [4, 6, 8, 10, 12, 5, 7, 9, 11, 13, 6, 8].map((u) => sample(u, 400));
    expect(netUnitMsQuantile(samples, LEAD_IN, PRIORS).msPerUnit).toBeCloseTo(400, 6);
    // 不扣引子的话同一批样本会被系统性高估
    expect(netUnitMsQuantile(samples, 0, PRIORS).msPerUnit!).toBeGreaterThan(400);
  });

  it('按同一组先验扣掉停顿再算:估计式补回停顿时才不重复', () => {
    // 同一批片:净速率恒 300,标点数不一;停顿摊进速率会把每单元时长抬高一两成
    const pauses: PauseCounts[] = [
      { endPunct: 1, midPunct: 0, voiceTags: 0 },
      { endPunct: 2, midPunct: 1, voiceTags: 0 },
      { endPunct: 1, midPunct: 2, voiceTags: 1 },
      { endPunct: 3, midPunct: 0, voiceTags: 0 },
    ];
    const samples = [8, 12, 16, 20, 9, 13, 17, 21, 10, 14, 18, 22].map((u, i) => sample(u, 300, pauses[i % 4]));
    expect(netUnitMsQuantile(samples, LEAD_IN, PRIORS).msPerUnit).toBeCloseTo(300, 6);
    const zero: PausePriors = { endPunctMs: 0, midPunctMs: 0, voiceTagMs: 0 };
    expect(netUnitMsQuantile(samples, LEAD_IN, zero).msPerUnit!).toBeGreaterThan(330);
  });

  it('带外样本不进分位:空片与撞服务端上限的跑飞不代表语速', () => {
    const good = Array.from({ length: 12 }, () => sample(10, 400));
    const junk: SpeechRateSample[] = [
      { units: 33, durationMs: 32_000, pauses: NO_PAUSE }, // 撞上限的真跑飞:净速率 954,尚在带内
      { units: 2, durationMs: 32_000, pauses: NO_PAUSE }, // 两个字合出 32 秒:净速率 15750,带外
      { units: 10, durationMs: 520, pauses: NO_PAUSE }, // 近乎空片:净速率 2,带外
      { units: 0, durationMs: 1000, pauses: NO_PAUSE }, // 零单元:除不动
    ];
    const got = netUnitMsQuantile([...good, ...junk], LEAD_IN, PRIORS);
    expect(got.samples).toBe(13); // 12 条正常 + 那条 954 的
    expect(got.msPerUnit).toBeCloseTo(400, 6);
  });
});
