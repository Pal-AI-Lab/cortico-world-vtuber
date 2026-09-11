/**
 * TTS 实测语速的滚动日志。记录按声线版本隔离，读取时只取当前声线的近期样本。
 *
 * 写入方是每一片说话(module 的 synth / synthStream 收流),不只是唱歌;
 * 消费方两个:歌曲插话预算取毛速率 p95，字幕/跑飞门/锚点估计取扣掉起播引子与
 * 停顿之后的净速率 p75(见 module 的 speechRateHint)。两边都从这一份样本来。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pauseMs, type PauseCounts, type PausePriors } from './align.ts';

/**
 * v2 起样本带停顿源计数。v1 记录只有 units 与 durationMs,净速率无法把标点停顿从时长里
 * 扣掉,读取时按损坏行跳过——换版本后当前声线冷启动一次(SPEECH_RATE_MIN_SAMPLES 片)。
 */
const LOG_VERSION = 2;
const RETAINED_RECORDS = 512;
const COMPACT_AT_RECORDS = RETAINED_RECORDS * 2;

/** 一条实测样本:这一片有多少语言单元、多少停顿源、实际合成出多少毫秒音频 */
export interface SpeechRateSample {
  units: number;
  durationMs: number;
  pauses: PauseCounts;
}

/** 参与分位的近期样本条数;也是历史日志的恢复条数 */
export const SPEECH_RATE_WINDOW = 64;
/**
 * 净速率取 p75，兼顾字幕早于人声与延迟过大的不对称损失。829 条样本中，中位 305、p75 417、p90 531、p95 627ms/单元。
 * 以 15 单元计算，p90 会使典型片末条字幕延后约 3.4 秒；p75 对典型片的延后和慢片的提前约为 1.7 秒。语速同时参与积压与时长预算，不能单独为字幕取极端分位。
 */
export const SPEECH_RATE_QUANTILE = 0.75;
/**
 * 认账所需的最少样本。12 条的 p75 自己也有噪声,但回落值是别的声线上反解出来的
 * 常数,谈不上更可信;门槛低一点,新声线早一点用上自己的数。
 */
export const SPEECH_RATE_MIN_SAMPLES = 12;
/** 净速率的合理带(ms/单元);带外的是空片或撞服务端上限的跑飞,不代表语速 */
const NET_MIN_MS = 120;
const NET_MAX_MS = 1500;

/**
 * 近期样本计算净速率：（实测时长−起播引子−停顿）÷单元数。样本扣除与估计补回使用同一组先验，使引子和停顿各计一次。
 * 样本不足时 msPerUnit 返回 null，由调用方回落冷启动常量；samples 始终提供，供埋点说明样本量。
 */
export function netUnitMsQuantile(
  samples: readonly SpeechRateSample[],
  leadInMs: number,
  priors: PausePriors,
): { msPerUnit: number | null; samples: number } {
  const rates: number[] = [];
  for (const s of samples) {
    if (!(s.units > 0)) continue;
    const net = (s.durationMs - leadInMs - pauseMs(s.pauses, priors)) / s.units;
    if (net >= NET_MIN_MS && net <= NET_MAX_MS) rates.push(net);
  }
  if (rates.length < SPEECH_RATE_MIN_SAMPLES) return { msPerUnit: null, samples: rates.length };
  rates.sort((left, right) => left - right);
  const at = Math.min(rates.length - 1, Math.ceil(rates.length * SPEECH_RATE_QUANTILE) - 1);
  return { msPerUnit: rates[at], samples: rates.length };
}

interface SpeechRateRecord {
  v: typeof LOG_VERSION;
  tsMs: number;
  profileKey: string;
  units: number;
  durationMs: number;
  endPunct: number;
  midPunct: number;
  voiceTags: number;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseRecord(line: string): SpeechRateRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<SpeechRateRecord>;
  if (
    row.v !== LOG_VERSION
    || typeof row.profileKey !== 'string'
    || row.profileKey.length !== 64
    || !Number.isSafeInteger(row.tsMs)
    || !Number.isSafeInteger(row.units)
    || (row.units ?? 0) <= 0
    || !Number.isFinite(row.durationMs)
    || (row.durationMs ?? 0) <= 0
    || !isCount(row.endPunct)
    || !isCount(row.midPunct)
    || !isCount(row.voiceTags)
  ) {
    return null;
  }
  return row as SpeechRateRecord;
}

function toSample(row: SpeechRateRecord): SpeechRateSample {
  return {
    units: row.units,
    durationMs: row.durationMs,
    pauses: { endPunct: row.endPunct, midPunct: row.midPunct, voiceTags: row.voiceTags },
  };
}

/** 单进程写入的有界 JSONL；损坏行不会参与预算。 */
export class SpeechRateLog {
  private recordCount = 0;

  constructor(private readonly path: string) {}

  /**
   * 当前声线的近期样本。给出 units、durationMs 与停顿计数三个原始量而不是相除的结果——
   * 毛速率(durationMs/units)与扣引子扣停顿的净速率两个消费方都要,除法留给消费方做。
   */
  samples(profileKey: string, limit = SPEECH_RATE_WINDOW): SpeechRateSample[] {
    const records = this.readRecords();
    this.recordCount = records.length;
    return records
      .filter((row) => row.profileKey === profileKey)
      .slice(-limit)
      .map(toSample);
  }

  append(profileKey: string, sample: SpeechRateSample, tsMs = Date.now()): void {
    const row: SpeechRateRecord = {
      v: LOG_VERSION,
      tsMs,
      profileKey,
      units: sample.units,
      durationMs: sample.durationMs,
      endPunct: sample.pauses.endPunct,
      midPunct: sample.pauses.midPunct,
      voiceTags: sample.pauses.voiceTags,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, 'utf8');
    this.recordCount++;
    if (this.recordCount < COMPACT_AT_RECORDS) return;
    const retained = this.readRecords().slice(-RETAINED_RECORDS);
    writeFileSync(this.path, retained.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    this.recordCount = retained.length;
  }

  private readRecords(): SpeechRateRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map(parseRecord)
      .filter((row): row is SpeechRateRecord => row !== null);
  }
}
