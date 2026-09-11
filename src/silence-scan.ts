/**
 * 检测合成音频中最长的严格连续近静默区间。笑腔、拖音、快慢变化或对齐失败本身不构成静默证据；本扫描器只报告音频静默，由调用方决定处置。
 * 使用 20ms hop 的 RMS，与包络提取及打断参考电平一致。门限取 p95×0.03（约 -30dB），并钳在 0.003（约 -50dBFS）至 0.02（约 -34dBFS）。相对项适应整体响度，下限保证纯静音可识别，上限防止响片段将真实语音判为静默。
 * 连续时长门限为 4000ms：3245 片样本的停顿先验约为句末 570ms、句中 200ms、语音标签 1500ms，门限约为其中最长典型停顿的 2.7 倍。
 * 任一 hop 达到门限即中断连续区间，不跨杂音拼接静默。流式与非流式使用同一口径。
 */

/** 20ms hop:与包络提取、打断参考电平同口径 */
export const SILENCE_HOP_MS = 20;
/** 「超大静默」的时长门(ms)。依据见文件头。 */
export const SILENCE_MIN_MS = 4000;
/** 相对门:这一片 hop-RMS 的 p95 的这个比例(≈ -30dB) */
const SILENCE_REL_RATIO = 0.03;
/** 相对门的绝对下限(≈ -50dBFS):底噪量级 */
const SILENCE_FLOOR_RMS = 0.003;
/** 相对门的绝对上限(≈ -34dBFS):不让门抬进真语音的能量带 */
const SILENCE_CEIL_RMS = 0.02;
/**
 * 流式收块时的检查节流:每攒够这么多 hop 才整片重算一次。
 * 一次检查是 O(n log n)(要排 p95),按 20ms 一块的到达节奏每块都算,32 秒的片
 * 要排 1600 次序。25 hop = 500ms 的节流把它压到 64 次,而触发要 4000ms 连续静默,
 * 最多晚 500ms 认出来,对一段本就要掐掉的死气无所谓。
 */
const EVAL_EVERY_HOPS = 25;

export interface SilenceReport {
  /** 最长连续静默段的时长(ms) */
  longestMs: number;
  /** 该段起点(ms,片内坐标) */
  startMs: number;
  /** 该段终点(ms,片内坐标) */
  endMs: number;
  /** 本次实际用的静默门(RMS) */
  thresholdRms: number;
  /** 这一片的响度参考(hop-RMS 的 p95) */
  refRms: number;
  /** 本次实际用的时长门(ms) */
  minSilenceMs: number;
  /** longestMs ≥ minSilenceMs:错误生产的签名成立 */
  triggered: boolean;
}

/**
 * 增量静默扫描器。流式路边收块边喂,非流式路一次喂完(scanSilence)。
 * 同样的样本、同样的采样率,两条路得同一个 report——门限只从这一片自己的样本
 * 统计出来,不带任何跨片状态。
 */
export class SilenceScanner {
  private readonly hop: number;
  private readonly rms: number[] = [];
  /** 未攒满一个 hop 的残留:平方和 + 样本数 */
  private carryAcc = 0;
  private carryN = 0;
  private lastEvalHops = 0;

  constructor(
    sampleRate: number,
    readonly minSilenceMs: number = SILENCE_MIN_MS,
  ) {
    this.hop = Math.max(1, Math.round((sampleRate * SILENCE_HOP_MS) / 1000));
  }

  append(samples: Float32Array): void {
    for (const s of samples) {
      this.carryAcc += s * s;
      if (++this.carryN === this.hop) {
        this.rms.push(Math.sqrt(this.carryAcc / this.hop));
        this.carryAcc = 0;
        this.carryN = 0;
      }
    }
  }

  /** 收流:计入不足一个 hop 的末段(与 StreamingEnvelope.finish 同处置) */
  finish(): void {
    if (this.carryN > 0) {
      this.rms.push(Math.sqrt(this.carryAcc / this.carryN));
      this.carryAcc = 0;
      this.carryN = 0;
    }
  }

  /**
   * 流式收块时的节流检查:攒够 EVAL_EVERY_HOPS 个新 hop 才算一次,
   * 只在签名成立时返回报告,平时返回 null。
   */
  check(): SilenceReport | null {
    if (this.rms.length - this.lastEvalHops < EVAL_EVERY_HOPS) return null;
    this.lastEvalHops = this.rms.length;
    const r = this.report();
    return r.triggered ? r : null;
  }

  /** 按当前已收到的全部 hop 重算一次;不改内部状态,随时可重复调用 */
  report(): SilenceReport {
    const n = this.rms.length;
    if (n === 0) {
      return {
        longestMs: 0,
        startMs: 0,
        endMs: 0,
        thresholdRms: SILENCE_FLOOR_RMS,
        refRms: 0,
        minSilenceMs: this.minSilenceMs,
        triggered: false,
      };
    }
    const sorted = [...this.rms].sort((a, b) => a - b);
    const refRms = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    const thresholdRms = Math.min(
      SILENCE_CEIL_RMS,
      Math.max(SILENCE_FLOOR_RMS, refRms * SILENCE_REL_RATIO),
    );
    let bestStart = 0;
    let bestLen = 0;
    let runStart = 0;
    let runLen = 0;
    for (let i = 0; i < n; i++) {
      if (this.rms[i] < thresholdRms) {
        if (runLen === 0) runStart = i;
        runLen++;
        if (runLen > bestLen) {
          bestLen = runLen;
          bestStart = runStart;
        }
      } else {
        runLen = 0;
      }
    }
    const longestMs = bestLen * SILENCE_HOP_MS;
    return {
      longestMs,
      startMs: bestStart * SILENCE_HOP_MS,
      endMs: (bestStart + bestLen) * SILENCE_HOP_MS,
      thresholdRms,
      refRms,
      minSilenceMs: this.minSilenceMs,
      triggered: longestMs >= this.minSilenceMs,
    };
  }
}

/** 整段音频的一次性扫描(非流式路与回归测试用) */
export function scanSilence(
  samples: Float32Array,
  sampleRate: number,
  minSilenceMs: number = SILENCE_MIN_MS,
): SilenceReport {
  const s = new SilenceScanner(sampleRate, minSilenceMs);
  s.append(samples);
  s.finish();
  return s.report();
}

/** 埋点文案:一行把「最长多少、从哪开始、门在哪」说全 */
export function describeSilence(r: SilenceReport): string {
  return (
    `最长 ${Math.round(r.longestMs)}ms @ 起点 ${Math.round(r.startMs)}ms`
    + `(门 ${r.minSilenceMs}ms / 静默判据 RMS<${r.thresholdRms.toFixed(4)},参考 ${r.refRms.toFixed(4)})`
  );
}

/** 同一份报告的结构化形态(运行日志 data) */
export function silenceData(r: SilenceReport): Record<string, number | boolean> {
  return {
    longestMs: Math.round(r.longestMs),
    startMs: Math.round(r.startMs),
    endMs: Math.round(r.endMs),
    minSilenceMs: r.minSilenceMs,
    thresholdRms: Number(r.thresholdRms.toFixed(4)),
    refRms: Number(r.refRms.toFixed(4)),
    triggered: r.triggered,
  };
}
