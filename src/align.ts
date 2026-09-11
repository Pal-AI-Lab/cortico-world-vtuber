/**
 * 片内时间点标注:Qwen3-ForcedAligner 将合成音频和文本映射为逐单元起止时间。
 *
 * 本模块在请求前划分对齐单元:汉字与假名逐字,拉丁按词,标点不参与。模型返回给定
 * 单元的时间范围,不推断单元边界。
 *
 * 对齐结果同时当作 TTS 的门:VoxCPM2 漏字、复读或吞尾时,逐字稿与音频对不上,对齐会退化成
 * 时序倒挂、跨度反向、覆盖率不足。判据阈值取自实测——正确逐字稿的倒挂与反向为 0、覆盖率
 * 0.97,故意喂错逐字稿则分别是 0.26 / 0.11 / 0.34。
 */
import { resolveVoiceTag } from './voice-tags.ts';

/** 逐字切的字:假名、汉字(含扩展A)、兼容汉字、谚文 */
const PER_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

/**
 * 依附前一个字、不单独成单元的假名:拗音(ゃゅょ 等)与前面的辅音合成一拍,长音符 ー 延长
 * 前一个元音,浊/半浊点是附加符号。促音 っ 不在此列——它自成一拍,是一段有时长的闭锁。
 */
const KANA_TAIL =
  /[ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶー゙-゜]/u;

/** 拉丁词内部允许的字符 */
const WORD_CHAR = /[\p{L}\p{N}\p{M}'’-]/u;

/** [] 语气词找闭括号的扫描上限,与解析器的行内标签上限同量级 */
const VOICE_TAG_SCAN = 32;

/**
 * 把一段文本切成对齐单元。返回的单元按出现顺序,拼起来等于原文去掉空白与标点。
 * VoxCPM2 语气词([laughing] 这类)整体算一个单元:音频里它是一段真实发声
 * (笑声/叹息),不给它单元的话那段音频没人认领,覆盖率判据和相邻锚点都会被带偏。
 */
export function segmentUnits(text: string): string[] {
  const cps = [...text];
  const units: string[] = [];
  let word = '';
  const flush = (): void => {
    if (word) units.push(word);
    word = '';
  };
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (ch === '[') {
      const close = cps.indexOf(']', i + 1);
      if (close > i && close - i <= VOICE_TAG_SCAN) {
        const tag = resolveVoiceTag(cps.slice(i + 1, close).join(''));
        if (tag) {
          flush();
          units.push(`[${tag}]`);
          i = close;
          continue;
        }
      }
    }
    if (KANA_TAIL.test(ch) && units.length > 0 && word === '') {
      units[units.length - 1] += ch;
    } else if (PER_CHAR.test(ch)) {
      flush();
      units.push(ch);
    } else if (WORD_CHAR.test(ch)) {
      word += ch;
    } else {
      flush();
    }
  }
  flush();
  return units;
}

/**
 * 统计句末标点、句中标点和语音标签，补充 segmentUnits 未计入的停顿。
 * 3245 片完整样本的回归为：时长 ≈ -92ms + 257ms×单元 + 569ms×句末 + 195ms×句中 + 1572ms×标签。
 * 语音标签已在 segmentUnits 中计为一个单元，此处仅补其额外停顿时长，避免重复计入。
 */
export function countPauses(text: string): PauseCounts {
  const endPunct = (text.match(/[。！？!?…]/gu) ?? []).length;
  const midPunct = (text.match(/[，、,;；：:—～~]/gu) ?? []).length;
  // 上限与 segmentUnits 的标签扫描上限同为 32:词表里最长的 Dissatisfaction-hnn 有 19 字符,
  // 按 16 数不到它,预算就少掉一个 1.5 秒的停顿。
  const voiceTags = (text.match(/\[[^\][]{1,32}\]/gu) ?? []).length;
  return { endPunct, midPunct, voiceTags };
}

/** 一段文本里的停顿源计数 */
export interface PauseCounts {
  endPunct: number;
  midPunct: number;
  voiceTags: number;
}

/** 每种停顿源的时长先验(ms/个) */
export interface PausePriors {
  endPunctMs: number;
  midPunctMs: number;
  voiceTagMs: number;
}

/** 停顿源计数 × 先验 = 这段文本里标点与语音标签占的时长(ms) */
export function pauseMs(counts: PauseCounts, priors: PausePriors): number {
  return counts.endPunct * priors.endPunctMs + counts.midPunct * priors.midPunctMs + counts.voiceTags * priors.voiceTagMs;
}

export interface AlignedUnit {
  text: string;
  /** 秒,相对本分片起点 */
  start: number;
  end: number;
}

/** 对齐是否可信;不可信时 reasons 说明是哪几项判据没过 */
export interface AlignVerdict {
  ok: boolean;
  reasons: string[];
  /** 末单元终点 / 音频时长 */
  coverage: number;
  /** end < start 的单元占比 */
  inverted: number;
  /** 起点比前一个单元早的占比 */
  backwards: number;
  /** 零长跨度占比 */
  degenerate: number;
}

/**
 * 异常比例阈值配合绝对数量下限，短片段至少出现两处异常才作为漏字证据。VoxCPM2 的正常起头静音较长，不能仅凭首单元起点相对整片的占比判定额外发声。
 */
const GATE = {
  coverage: 0.7,
  inverted: 0.02,
  backwards: 0.05,
  degenerate: 0.3,
  minAnomalies: 2,
} as const;

export function judgeAlignment(units: AlignedUnit[], durationSec: number): AlignVerdict {
  if (units.length === 0 || durationSec <= 0) {
    return { ok: false, reasons: ['没有对齐单元'], coverage: 0, inverted: 0, backwards: 0, degenerate: 0 };
  }
  let inverted = 0;
  let backwards = 0;
  let degenerate = 0;
  let prevStart = -Infinity;
  let lastEnd = 0;
  let judged = 0;
  for (const u of units) {
    lastEnd = Math.max(lastEnd, u.end);
    // 语气词只计入覆盖率,不进异常计数:实测对齐器能把邻字标准,但语气词自身
    // 跨度偏窄、可能与邻字轻微倒挂(笑声没有字面锚)。
    if (/^\[.+\]$/.test(u.text)) continue;
    judged++;
    if (u.end < u.start) inverted++;
    else if (u.end === u.start) degenerate++;
    if (u.start < prevStart) backwards++;
    prevStart = u.start;
  }
  const n = Math.max(1, judged);
  const v = {
    coverage: lastEnd / durationSec,
    inverted: inverted / n,
    backwards: backwards / n,
    degenerate: degenerate / n,
  };
  const reasons: string[] = [];
  if (v.coverage < GATE.coverage) reasons.push(`覆盖率 ${(v.coverage * 100).toFixed(0)}%`);
  if (inverted >= GATE.minAnomalies && v.inverted > GATE.inverted) {
    reasons.push(`跨度反向 ${inverted} 处`);
  }
  if (backwards >= GATE.minAnomalies && v.backwards > GATE.backwards) {
    reasons.push(`时序倒挂 ${backwards} 处`);
  }
  if (v.degenerate > GATE.degenerate) reasons.push(`零长跨度 ${(v.degenerate * 100).toFixed(0)}%`);
  return { ok: reasons.length === 0, reasons, ...v };
}

export interface AlignResult {
  units: AlignedUnit[];
  /** 音频时长(秒),由 server 按重采样后的 PCM 算 */
  duration: number;
  verdict: AlignVerdict;
}

export interface AlignerClientOptions {
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AlignerClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AlignerClientOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** server 是否带着对齐器起来了 */
  async available(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { aligner?: boolean };
      return body.aligner === true;
    } catch {
      return false;
    }
  }

  /** units 缺省按 segmentUnits 从 text 切 */
  async align(audio: Uint8Array, text: string, units?: string[]): Promise<AlignResult> {
    const list = units ?? segmentUnits(text);
    if (list.length === 0) {
      return { units: [], duration: 0, verdict: judgeAlignment([], 0) };
    }
    const res = await this.fetchImpl(`${this.url}/v1/audio/align`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: Buffer.from(audio).toString('base64'), units: list }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`对齐 ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { units: AlignedUnit[]; duration: number };
    return { units: body.units, duration: body.duration, verdict: judgeAlignment(body.units, body.duration) };
  }
}
