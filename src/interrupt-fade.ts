/**
 * 打断切断规划:模拟真人话音被打断时不同音上的收尾形态。
 *
 * 切在什么音上决定残响:元音与 m n l 这类周期浊音有 20-70ms 的衰减尾;
 * f s sh x h 等非周期擦音的噪声包络在 10-40ms 内衰减;塞音(b p d t g k)的
 * 闭塞段直接收口；释放爆破位于切点后的样本中。塞擦音(z c zh ch j q)按切点处
 * 的局部信号区分闭塞与擦音，不依赖音素字典身份。这也覆盖英文、假名与 [laughing]
 * 语气词等无音素级对齐的输入。
 *
 * 三类判据:相对参考电平(切点前最多 1s 的 20ms-hop RMS 的 p95,与 lipsync
 * 包络同口径)低于 -20dB 是静音;归一化自相关在基频范围内有强峰是周期;
 * 其余是噪声。参考电平是相对量——整体小音量的片子不会被整段误判成静音。
 *
 * 切点与衰减段均使用流内时间:服务端从已合成的 PCM 分类并渲染衰减段,
 * 播放端在同一采样坐标上截停并拼接。两侧对同一份样本做同一套算术,
 * 拼接处波形连续,播放位置的墙钟估计误差不影响任何一步。
 */

export type CutClass = 'periodic' | 'noise' | 'silence';

export interface CutPlan {
  cls: CutClass;
  /** 尾音时长（ms），用于播毕超时与收束等待。 */
  fadeMs: number;
  sampleRate: number;
  /** 从切点开始的 PCM16LE 衰减段:原样本乘以衰减包络。 */
  tailPcm: Uint8Array;
}

/** 分类窗:切点前 30ms + 后 10ms。衰减作用于其后,类别看切点这一刻在响什么 */
const WIN_BEFORE_MS = 30;
const WIN_AFTER_MS = 10;
/** 参考电平:切点前最多这么久的 20ms-hop RMS 取 p95(与包络提取同口径) */
const REF_LOOKBACK_MS = 1000;
const REF_HOP_MS = 20;
/** 静音门:窗内 RMS 低于参考电平的这个比例(-20dB) */
const SILENCE_RATIO = 0.1;
/** 基频搜索范围;归一化自相关峰不低于此值算周期信号(浊音 0.7-0.9,白噪 <0.2) */
const F0_MIN_HZ = 60;
const F0_MAX_HZ = 400;
const PERIODIC_MIN_CORR = 0.5;
/**
 * 衰减时长。周期音按 4 个基音周期折算——低音衰减长、高音短,再钳进人声
 * 截断的 20-70ms 观测带;擦音噪声取 20ms(10-40ms 带的中低段);静音只做
 * 防点击收口。
 */
const PERIODIC_FADE_PERIODS = 4;
const PERIODIC_FADE_MIN_MS = 20;
const PERIODIC_FADE_MAX_MS = 70;
const NOISE_FADE_MS = 20;
const DECLICK_MS = 6;
/** 衰减段末尾强制归零的长度,用于消除指数包络残值造成的阶跃。 */
const TAIL_ZERO_MS = 2;

/** Plans a cut at stream-relative `atMs`; returns null when synthesized audio has not reached it. */
export function planCut(samples: Float32Array, sampleRate: number, atMs: number): CutPlan | null {
  if (sampleRate <= 0 || samples.length === 0) return null;
  const at = Math.round((atMs / 1000) * sampleRate);
  if (at < 0 || at >= samples.length) return null;
  const { cls, periodMs } = classifyAt(samples, sampleRate, at);
  const fadeMs =
    cls === 'silence'
      ? DECLICK_MS
      : cls === 'noise'
        ? NOISE_FADE_MS
        : Math.min(PERIODIC_FADE_MAX_MS, Math.max(PERIODIC_FADE_MIN_MS, PERIODIC_FADE_PERIODS * periodMs));
  return { cls, fadeMs, sampleRate, tailPcm: renderTail(samples, sampleRate, at, cls, fadeMs) };
}

/** PCM16LE 分块 → Float32(流式段攒下的原始分块喂切断规划;分块恒偶数长) */
export function pcm16ToFloat(parts: Uint8Array[], totalBytes: number): Float32Array {
  const out = new Float32Array(totalBytes >> 1);
  let at = 0;
  for (const p of parts) {
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const n = p.byteLength >> 1;
    for (let i = 0; i < n; i++) out[at++] = view.getInt16(2 * i, true) / 32768;
  }
  return out;
}

function classifyAt(
  samples: Float32Array,
  sampleRate: number,
  at: number,
): { cls: CutClass; periodMs: number } {
  const w0 = Math.max(0, at - Math.round((WIN_BEFORE_MS / 1000) * sampleRate));
  const w1 = Math.min(samples.length, at + Math.round((WIN_AFTER_MS / 1000) * sampleRate));
  const win = samples.subarray(w0, w1);
  const ref = refLevel(samples, sampleRate, at);
  if (ref < 1e-4 || rms(win) < ref * SILENCE_RATIO) return { cls: 'silence', periodMs: 0 };
  const { corr, lag } = autocorrPeak(win, sampleRate);
  if (corr >= PERIODIC_MIN_CORR && lag > 0) return { cls: 'periodic', periodMs: (lag / sampleRate) * 1000 };
  return { cls: 'noise', periodMs: 0 };
}

function rms(win: Float32Array): number {
  if (win.length === 0) return 0;
  let acc = 0;
  for (const v of win) acc += v * v;
  return Math.sqrt(acc / win.length);
}

function refLevel(samples: Float32Array, sampleRate: number, at: number): number {
  const hop = Math.max(1, Math.round((sampleRate * REF_HOP_MS) / 1000));
  const from = Math.max(0, at - Math.round((sampleRate * REF_LOOKBACK_MS) / 1000));
  const hops: number[] = [];
  for (let s = from; s + hop <= at; s += hop) hops.push(rms(samples.subarray(s, s + hop)));
  // 切点距片头不足一个 hop 时,在已有样本内选择最小能量点。
  if (hops.length === 0) return rms(samples.subarray(from, Math.max(from + 1, at)));
  hops.sort((a, b) => a - b);
  return hops[Math.min(hops.length - 1, Math.floor(hops.length * 0.95))];
}

function autocorrPeak(win: Float32Array, sampleRate: number): { corr: number; lag: number } {
  const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX_HZ));
  const maxLag = Math.min(win.length - 8, Math.ceil(sampleRate / F0_MIN_HZ));
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i + lag < win.length; i++) {
      const a = win[i];
      const b = win[i + lag];
      dot += a * b;
      e0 += a * a;
      e1 += b * b;
    }
    const denom = Math.sqrt(e0 * e1);
    if (denom <= 0) continue;
    const r = dot / denom;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return { corr: best, lag: bestLag };
}

/**
 * 衰减包络乘在切点起的原样本上。周期与噪声走指数(τ = fade/3,原波形按比例
 * 缩放,周期性自然保留);静音使用半余弦避免点击。音频末尾不足完整衰减段时
 * 按剩余样本缩短,并保留末端归零区间。
 */
function renderTail(
  samples: Float32Array,
  sampleRate: number,
  at: number,
  cls: CutClass,
  fadeMs: number,
): Uint8Array {
  const want = Math.max(1, Math.round((fadeMs / 1000) * sampleRate));
  const n = Math.min(want, samples.length - at);
  const zero = Math.max(1, Math.round((TAIL_ZERO_MS / 1000) * sampleRate));
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const u = i / want;
    let env = cls === 'silence' ? 0.5 * (1 + Math.cos(Math.PI * Math.min(1, u))) : Math.exp(-3 * u);
    const left = n - 1 - i;
    if (left < zero) env *= left / zero;
    const v = Math.max(-1, Math.min(1, samples[at + i] * env));
    view.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return out;
}
