/**
 * 曲线的数学与类型:缓动、关键帧求值、漂移噪声,以及 pulse / sustain / gaze 资产的类型。
 * 资产本身(词表与曲线)在演出包里(`pack.ts`,数据来自 bot 的 `vtuber-pack/`)。
 *
 * 全部是**加性偏移**——0 即"不动"(相对中性位)。add 的基准是 VTS 输入
 * 参数的基线,不是 idle 动画的输出:参数被注入期间 idle 对它让位(见 mixer 的
 * AMBIENT_HEAD 注释);偏移叠加的基线由 mixer 环境漂移层提供。
 * 眼睑(EyeOpen*)的偏移语义是"相对正常睁眼":-1 全闭、0 平常、+1 瞪到最大;
 * 到绝对输入量的换算在 L4(模型档案的 wiring)。参数名用契约里的语义参数名
 * (models/contract.ts):FaceAngleX/Y/Z、MouthOpen、MouthSmile、EyeOpen*、
 * Eye*X/Y、Brow*Y、CheekPuff。
 */

/** 段缓动:u∈[0,1] → 进度。smooth 两端速度为零;back 冲过目标再回落。 */
export const EASES = {
  smooth: (u: number): number => u * u * (3 - 2 * u),
  in: (u: number): number => u * u * u,
  out: (u: number): number => 1 - (1 - u) ** 3,
  /*
   * 过冲缓动先过 smoothstep 再喂标准 easeOutBack:easeOutBack 裸用时起步斜率
   * 是均速的 4.7 倍,280ms 的转头段峰值角速度被顶到 300°/s 以上(人类头部上限
   * 约 200°/s),混音台 60Hz 采样下单帧步长 8-10°,诊断把它抓成 pulse 跳变。
   * 复合后两端速度为零、过冲形状不变,拼在 idle 上进出都平滑。
   */
  back: (u: number): number => {
    const s = u * u * (3 - 2 * u);
    const c1 = 1.70158;
    const v = s - 1;
    return 1 + (c1 + 1) * v ** 3 + c1 * v * v;
  },
} as const;

export type EaseName = keyof typeof EASES;

/** [ms, value, 段缓动名?] 关键帧;缓动作用于上一帧到本帧的段,缺省 smooth */
export type Key = [ms: number, value: number, ease?: EaseName];

export interface PulseClip {
  id: string;
  durationMs: number;
  /** 语音应让过的起势时长(手调常数) */
  speechOnsetMs: number;
  /** 每参数一条完整去-回曲线,首尾都应回 0 */
  tracks: Record<string, Key[]>;
}

export interface HoldSpec {
  v: number;
  /**
   * 爆发型分量的松弛落点:挂上后 settleMs 内从 v 平滑漂到 settleTo。
   * 眼睑这类"大值好看、常驻难看"的分量必须给(否则挂脸 20–30s 成定格)。
   */
  settleTo?: number;
  settleMs?: number;
  /** 保持位上的低频摆动(防定格);波形见 noiseKind */
  noiseAmp?: number;
  noiseHz?: number;
  phase?: number;
  /**
   * 摆动波形。缺省 `sine` 是单频正弦(呼吸式的规律起伏)。
   * `drift` 是 1/f 漂移噪声——身体摇摆的功率谱斜率实测 ≈ -1、95% 功率在
   * 1.14Hz 以下(Yamamoto et al. 2015),正弦那种规律往复读起来是机械摆。
   */
  noiseKind?: 'sine' | 'drift';
}

/**
 * 1/f 式漂移噪声:四个不可公度倍频叠加,幅度 ∝ 1/f(即谱斜率 -1)。
 * 无状态、对同一 t 可复现;最高分量 4.13×hz,hz 取 0.2 上下即落在 1.14Hz 以内。
 */
export function driftNoise(tSec: number, hz: number, phase = 0): number {
  const ratios = [1, 1.73, 2.61, 4.13];
  let v = 0;
  let norm = 0;
  for (let i = 0; i < ratios.length; i++) {
    const amp = 1 / ratios[i];
    v += amp * Math.sin(2 * Math.PI * hz * ratios[i] * tSec + phase + i * 1.7);
    norm += amp;
  }
  return v / norm;
}

export interface SustainClip {
  id: string;
  hold: Record<string, HoldSpec>;
}

export interface GazeTarget {
  id: string;
  /** 眼球目标([-1,1];满量程 = 舒适眼在头内范围,见 mixer 的 EYE_RANGE_DEG) */
  eyeX: number;
  eyeY: number;
  /** 头部跟随目标(度;实际贡献再乘跟随衰减) */
  headX: number;
  headY: number;
  /**
   * 注视点在目标内游走的半径(度),按目标内容的视角大小设置:
   * 一张脸的五官三角只有两三度,一屏弹幕能有十几度。缺省 3°。
   */
  scanRadiusDeg?: number;
}

/** 关键帧求值:段缓动取自段尾帧(缺省 smooth);越界钳到首/尾帧值 */
export function sampleKeys(keys: Key[], tMs: number): number {
  if (keys.length === 0) return 0;
  if (tMs <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (tMs >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, ease] = keys[i];
    if (tMs > t1) continue;
    const [t0, v0] = keys[i - 1];
    const u = (tMs - t0) / (t1 - t0);
    return v0 + (v1 - v0) * EASES[ease ?? 'smooth'](u);
  }
  return last[1];
}
