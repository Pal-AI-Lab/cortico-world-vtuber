/**
 * L3 混音台。
 *
 * 60Hz 逐帧求值。每参数一条固定混合链:
 *   param = clamp( Σ 各通道加性偏移 ) ,或被 override 抢占
 * override 仅限 lipsync(嘴)与 gaze 眼球;头部一律加性且**全时持有**
 * (环境漂移垫底,见 AMBIENT_HEAD)。眨眼与呼吸平时归模型自带 idle,
 * 眼睑被 clip 写入的帧由本层接管补眨。
 *
 * 混音台只接收 cue 并输出全量 IR 快照，不解释台本结构。
 */
import {
  driftNoise,
  sampleKeys,
  type GazeTarget,
  type SustainClip,
} from './clips.ts';
import type { PerformancePack } from './pack.ts';
import type { PerfDiagnostics } from './diagnostics.ts';
import type { StateCue } from './states.ts';

export interface GestureCue {
  clipId: string;
  startTs: number;
  intensity: number;
}

export interface IRParam {
  value: number;
  mode: 'add' | 'set';
}

/** 全量快照:所有受控参数当前值,L3 之后无增量语义 */
export type IRFrame = Record<string, IRParam>;

/**
 * Sidechain ducking：pulse 活跃时同参数 State 贡献压至 30%。
 * 进入与恢复均使用斜坡；压入时间常数需覆盖偶发的 30ms 长帧。
 */
const DUCK_LEVEL = 0.3;
/** 一阶时间常数;≈3τ 走完。压下去 ~270ms,松开 ~1s */
const DUCK_ATTACK_TAU_MS = 90;
const DUCK_RECOVER_TAU_MS = 350;

const MOUTH_GAIN = 0.9;

/** 头部跟随注视:滞后且幅度衰减 */
const HEAD_FOLLOW_FACTOR = 0.85;

/*
 * 环境姿态漂移持续写入头部三轴，避免 VTS idle 与注入参数之间发生所有权跳变。
 * idle 头部动作由 1/f 漂移替代，pose 在其上叠加；眨眼、目光和呼吸不受影响。
 * 漂移主要频率为 0.1–0.7Hz，幅度约为常见 idle 动画头部摆幅的 70%。
 */
const AMBIENT_HEAD = [
  { param: 'FaceAngleX', amp: 6.5, hz: 0.13, phase: 0 },
  { param: 'FaceAngleY', amp: 3.5, hz: 0.17, phase: 2.1 },
  { param: 'FaceAngleZ', amp: 2.5, hz: 0.11, phase: 4.4 },
] as const;
const HEAD_PARAMS = ['FaceAngleX', 'FaceAngleY', 'FaceAngleZ'] as const;


/**
 * 眼球参数满量程按 COMR 中位数标定：水平约 ±18°，垂直约 ±22°
 * (Sidenmark & Gellersen 2019)。超出该范围的视线由头部补偿，避免持续触发
 * OMR-block(Pejsa 2013)。
 */
const EYE_RANGE_DEG = { x: 18, y: 22 } as const;

/** 反应式视线转移里头动滞后于眼动的时间(文献 25–150ms) */
const HEAD_LATENCY_MS = 60;

/**
 * 换目标扫视的最短时长。**这是渲染率的让步,不是生理数值**:
 * 主序列给 34° 扫视只有 96ms,而注入链路实测只有 19–46Hz——
 * 96ms 只够 2–4 个采样点,采样这么疏,生理正确的扫视看起来就是瞬移。
 * 兜到 5 帧上下才能读成"快速一瞥"而不是"闪现"。
 */
const SHIFT_MIN_MS = 130;

/** 注视时长 ex-Gaussian:Cronin 2020 实测均值 298ms / SD 64ms,右偏长尾 */
const FIX_MU_MS = 240;
const FIX_SIGMA_MS = 50;
const FIX_TAU_MS = 60;
/** 最短注视间隔(inter-saccadic interval 下限) */
const FIX_MIN_MS = 150;

/**
 * 注视区内单步扫视幅度,取注视半径的这个比例作指数分布均值。
 * 区域内扫描按目标视角半径缩放;自由观看实测的 4.58° 跨物体扫视不适用。
 */
const SCAN_AMP_RATIO = 0.4;
/** 注视半径缺省值(度);目标可用 GazeTarget.scanRadiusDeg 覆盖 */
const SCAN_RADIUS_DEFAULT_DEG = 3;
/** 扫视方向显著偏水平:纵向分量按此压缩(纵向游走范围同比压缩) */
const SCAN_VERTICAL_BIAS = 0.5;

/** 慢漂移 drift:一阶低通白噪声,量级 0.2–0.3° */
const DRIFT_SD_DEG = 0.22;
const DRIFT_TAU_SEC = 0.45;

/*
 * 眼睑默认由模型 idle 动画驱动;clip 写入眼睑分量时由注入接管。
 * 本层输出相对睁眼偏移,L4 按模型档案的 wiring 转为绝对输入量。
 * 接管期间本层补充眨眼;无眼睑写入的帧将所有权留给 idle 动画。
 */
const BLINK_CLOSE_MS = 75;
const BLINK_TOTAL_MS = 233;
const BLINK_GAP_MIN_MS = 2000;
const BLINK_GAP_MEAN_MS = 2500;

/**
 * 嘴部闭合时间常数(非对称跟随器的下行 τ;上行即时)。
 * 包络采样过端点硬回 0,而 speechEnd 要等播毕回执,晚于包络走完——
 * 只在 speechEnd 时刻做收口斜坡兜不住这个缝,诊断实测 MouthOpen 单帧
 * 0.71→0。跟随器盖住所有下行悬崖(片尾、片间、打断);说话中的闭合本来
 * 就由包络自带的 ~120ms 释放滤波给出,比这里慢,不受影响。
 */
const MOUTH_FALL_TAU_MS = 40;

const EMPTY_LAYER: ReadonlyMap<string, number> = new Map();

/** 扫视时长主序列:D(ms) = 2.2·A(°) + 21(Carpenter 1988) */
function saccadeDurationMs(ampDeg: number): number {
  return 2.2 * ampDeg + 21;
}

/**
 * 扫视位移曲线。速度取三角形(峰在进度 q),积分成位移:
 * 小幅扫视近对称(q→0.5),幅度越大减速相拖得越长(q→0.25)——
 * 因为加速相时长约 20–25ms 与幅度无关(van Opstal & van Gisbergen 1987)。
 */
function saccadeProgress(u: number, q: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u <= q) return (u * u) / q;
  const w = 1 - q;
  const d = u - q;
  return 2 * (q / 2 + d - (d * d) / (2 * w));
}

/** 峰速时刻占比:加速相固定 ~22ms,除以总时长并钳在 [0.25, 0.5] */
function saccadePeakAt(durMs: number): number {
  return Math.min(0.5, Math.max(0.25, 22 / durMs));
}

/** 注视区内的一次扫视 */
interface ScanSaccade {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startTs: number;
  durMs: number;
  peakAt: number;
}

interface SustainSlot {
  clip: SustainClip | null;
  /**
   * 换 clip 那一刻旧贡献的冻结快照(逐参数),淡出的是这份快照而不是旧 clip 本身。
   * 快照能覆盖"衰减淡出进行到一半又来新表情"的链式替换:若淡出的是活的旧 clip,
   * 链上更早那层会在替换瞬间整块消失(诊断实测 MouthSmile 一帧掉 0.48)。
   * 代价是淡出期间旧贡献的噪声/settle 停走,300ms 的 fade 里看不出来。
   */
  from: Map<string, number> | null;
  fadeStart: number;
  fadeMs: number;
  setAt: number;
  intensity: number;
}

export class Mixer {
  private readonly rng: () => number;
  /** 环境漂移开关(测试里关掉以取得确定性数值;运行时恒开) */
  private readonly ambientOn: boolean;
  private readonly sustains: Record<'pose' | 'emotion', SustainSlot> = {
    pose: { clip: null, from: null, fadeStart: 0, fadeMs: 1, setAt: 0, intensity: 1 },
    emotion: { clip: null, from: null, fadeStart: 0, fadeMs: 1, setAt: 0, intensity: 1 },
  };
  private pulses: GestureCue[] = [];
  /**
   * 韵律轨迹(句首头动这类)。与 gesture 用同一套资产,但**不参与 ducking**——
   * 它每句话都会来一次,若压低同参数的 State 贡献,前倾/可怜这些保持姿态
   * 会被反复抽掉再恢复,看起来是一直在抽动。
   */
  private prosody: GestureCue[] = [];
  /** 每参数当前的 ducking 系数(在 1 与 DUCK_LEVEL 之间滑动) */
  private readonly duckNow = new Map<string, number>();

  // Gaze controller
  private gazeTarget: GazeTarget | null = null;
  private gazeEngaged = false;
  private headFollowX = 0;
  private headFollowY = 0;
  /** 头动起动时刻(眼先动、头滞后) */
  private headStartAt = 0;
  /** 注视点相对目标中心的偏移(度);注视期保持不动,靠扫视换位 */
  private walkX = 0;
  private walkY = 0;
  private scan: ScanSaccade | null = null;
  private nextFixAt = 0;
  /** 换目标时的大幅扫视:从换向那一刻的眼位过渡到新的算术目标 */
  private shift: { fromX: number; fromY: number; startTs: number; durMs: number; peakAt: number } | null = null;
  /** 慢漂移(度) */
  private driftX = 0;
  private driftY = 0;
  /** 本帧解出的眼在头内角度(度) */
  private eyeDegX = 0;
  private eyeDegY = 0;


  // Lipsync
  private speechEnvelope: ((ms: number) => number) | null = null;
  private speechStartedAt = 0;
  /** 非对称跟随后的嘴部电平:上行即时、下行按 MOUTH_FALL_TAU_MS */
  private mouthLevel = 0;

  // 接管期眨眼
  private nextBlinkAt: number | null = null;
  private blinkStartTs = Number.NEGATIVE_INFINITY;

  private lastFrameAt: number | null = null;
  /** 诊断挂上后才算分层归因;不挂零开销 */
  private diag: PerfDiagnostics | null = null;

  /** 模型自带 idle 会不会眨眼(见 applyBlink);缺省 true = 沿用旧行为 */
  private readonly idleBlinks: () => boolean;

  /** 演出包(词表与曲线);每次查询时取,控制台重载后立即生效 */
  private readonly pack: () => PerformancePack;

  constructor(opts: { pack: () => PerformancePack; rng?: () => number; ambient?: boolean; idleBlinks?: () => boolean }) {
    this.pack = opts.pack;
    this.rng = opts.rng ?? Math.random;
    this.ambientOn = opts.ambient ?? true;
    this.idleBlinks = opts.idleBlinks ?? (() => true);
  }

  /** 按演出包声明的量程钳位;包里没声明的参数不钳 */
  private clampParam(param: string, v: number): number {
    const range = this.pack().range(param);
    if (!range) return v;
    return Math.min(range[1], Math.max(range[0], v));
  }

  attachDiagnostics(diag: PerfDiagnostics | null): void {
    this.diag = diag;
  }

  /** 当前分层实况(诊断报表里的 state 段) */
  snapshot(): Record<string, unknown> {
    return {
      pulses: this.pulses.map((p) => p.clipId),
      prosody: this.prosody.map((p) => p.clipId),
      pose: this.sustains.pose.clip?.id ?? null,
      emotion: this.sustains.emotion.clip?.id ?? null,
      gazeTarget: this.gazeTarget?.id ?? null,
      gazeEngaged: this.gazeEngaged,
      eyeDeg: [Math.round(this.eyeDegX * 10) / 10, Math.round(this.eyeDegY * 10) / 10],
      headFollowDeg: [Math.round(this.headFollowX * 10) / 10, Math.round(this.headFollowY * 10) / 10],
      walkDeg: [Math.round(this.walkX * 10) / 10, Math.round(this.walkY * 10) / 10],
      speaking: this.speechEnvelope !== null,
    };
  }


  stateCue(cue: StateCue): void {
    if (cue.channel === 'gaze') {
      this.gazeTarget = cue.clipId ? (this.pack().gaze[cue.clipId] ?? null) : null;
      if (this.gazeTarget) this.gazeEngaged = true;
      this.retargetGaze(cue.startTs);
      return;
    }
    const slot = this.sustains[cue.channel];
    slot.from = this.freezeSustain(slot, cue.startTs);
    slot.clip = cue.clipId ? (this.pack().sustain[cue.clipId] ?? null) : null;
    slot.fadeStart = cue.startTs;
    slot.fadeMs = Math.max(1, cue.fadeInMs);
    slot.setAt = cue.startTs;
    slot.intensity = cue.intensity;
  }

  /** 槽位此刻的实际贡献(快照淡出部分 + 当前 clip 部分),作为下一次 crossfade 的出发点 */
  private freezeSustain(slot: SustainSlot, now: number): Map<string, number> | null {
    const out = new Map<string, number>();
    this.accumulateSlot(out, slot, now, { pruneFrom: false });
    return out.size > 0 ? out : null;
  }

  /** 槽位贡献进 sum:冻结快照按 (1-mix) 淡出 + 当前 clip 按 mix 淡入 */
  private accumulateSlot(
    sum: Map<string, number>,
    slot: SustainSlot,
    now: number,
    opts: { pruneFrom: boolean },
  ): void {
    if (!slot.clip && !slot.from) return;
    const mix = Math.min(1, Math.max(0, (now - slot.fadeStart) / slot.fadeMs));
    if (slot.from) {
      if (mix < 1) {
        for (const [param, v] of slot.from) sum.set(param, (sum.get(param) ?? 0) + v * (1 - mix));
      } else if (opts.pruneFrom) {
        slot.from = null;
      }
    }
    this.accumulateSustain(sum, slot.clip, mix * slot.intensity, now, slot.setAt);
  }

  gestureCue(cue: GestureCue): void {
    if (!this.pack().pulse[cue.clipId]) return;
    this.pulses.push(cue);
  }

  /** 韵律轨迹:同资产格式,纯加性叠加,不 duck 任何 State 贡献。intensity 可为负(镜像) */
  prosodyCue(cue: GestureCue): void {
    if (!this.pack().pulse[cue.clipId]) return;
    this.prosody.push(cue);
  }

  /** 丢掉还没起跳的韵律轨迹:硬打断时,已作废语音的伴随头动不该再发生 */
  dropPendingProsody(now: number): void {
    this.prosody = this.prosody.filter((p) => p.startTs <= now);
  }

  /** 换注视目标:头动重新计时滞后,注视点游走从新中心重来,眼球走一次大幅扫视 */
  private retargetGaze(ts: number): void {
    this.headStartAt = ts + HEAD_LATENCY_MS;
    this.scan = null;
    this.walkX = 0;
    this.walkY = 0;
    this.nextFixAt = ts + this.sampleFixationMs();

    /*
     * 目标切换必须经过扫视轨迹，不能直接应用总视线差。
     * 头部跟随存在滞后，直接切换会使眼球在单帧内跨越大部分量程。
     */
    const target = this.gazeTarget;
    const total = totalGazeDeg(target);
    const toX = clampDeg(total.x - this.headFollowX, EYE_RANGE_DEG.x);
    const toY = clampDeg(total.y - this.headFollowY, EYE_RANGE_DEG.y);
    const ampDeg = Math.hypot(toX - this.eyeDegX, toY - this.eyeDegY);
    if (ampDeg < 0.5) {
      this.shift = null;
      return;
    }
    const durMs = Math.max(SHIFT_MIN_MS, saccadeDurationMs(ampDeg));
    this.shift = {
      fromX: this.eyeDegX,
      fromY: this.eyeDegY,
      startTs: ts,
      durMs,
      peakAt: saccadePeakAt(durMs),
    };
  }

  speechStart(envelopeAt: (ms: number) => number, startedAt: number): void {
    this.speechEnvelope = envelopeAt;
    this.speechStartedAt = startedAt;
  }

  speechEnd(): void {
    this.speechEnvelope = null;
  }

  /** L1 是否显式持有注视(反射瞟的跳过条件由调用方查) */
  get hasExplicitGaze(): boolean {
    return this.gazeTarget !== null;
  }


  frame(now: number): IRFrame {
    const dtSec = this.lastFrameAt === null ? 1 / 60 : Math.min(0.05, Math.max(0.001, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;

    /** param → 各层加性和 */
    const stateSum = new Map<string, number>();
    const pulseSum = new Map<string, number>();
    const prosodySum = new Map<string, number>();

    // 1. State sustain(pose / emotion):冻结快照淡出 + 新 clip 淡入 + 保持位低频噪声
    for (const key of ['pose', 'emotion'] as const) {
      this.accumulateSlot(stateSum, this.sustains[key], now, { pruneFrom: true });
    }

    // 2. 一次性加性轨迹:gesture pulse 记 marks 供 ducking,韵律不 duck(见 prosody 字段)
    const paramsUnderPulse = new Set<string>();
    this.pulses = this.advancePulses(this.pulses, now, pulseSum, paramsUnderPulse);
    this.prosody = this.advancePulses(this.prosody, now, prosodySum);

    // 3. Gaze controller:注视点保持—突跳 + 头部滞后跟随(头部贡献走加性)
    this.stepGaze(now, dtSec);

    // 4. 组装帧
    const frame: IRFrame = {};
    const put = (param: string, delta: number): void => {
      if (delta === 0) return;
      const cur = frame[param];
      if (cur && cur.mode === 'add') cur.value = this.clampParam(param, cur.value + delta);
      else if (!cur) frame[param] = { value: this.clampParam(param, delta), mode: 'add' };
    };

    // 诊断记录逐参数 ducking 系数,用于归因 State 贡献的瞬时变化。
    const duckByParam = this.diag ? new Map<string, number>() : null;
    for (const [param, v] of stateSum) {
      const duck = this.duckFactor(param, paramsUnderPulse, dtSec);
      duckByParam?.set(param, duck);
      put(param, v * duck);
    }
    // 无 State 贡献的参数删除 ducking 状态;再次出现时从未衰减值开始。
    for (const key of this.duckNow.keys()) if (!stateSum.has(key)) this.duckNow.delete(key);
    for (const [param, v] of pulseSum) put(param, v);
    for (const [param, v] of prosodySum) put(param, v);

    // 头部跟随注视(加性)
    put('FaceAngleX', this.headFollowX);
    put('FaceAngleY', this.headFollowY);

    // 环境姿态漂移 + 头部三轴全时持有(见 AMBIENT_HEAD 注释:所有权不倒手)
    const ambientBy = this.diag ? new Map<string, number>() : null;
    if (this.ambientOn) {
      const tSec = now / 1000;
      for (const a of AMBIENT_HEAD) {
        const v = a.amp * driftNoise(tSec, a.hz, a.phase);
        ambientBy?.set(a.param, v);
        put(a.param, v);
      }
    }
    for (const ax of HEAD_PARAMS) {
      if (!frame[ax]) frame[ax] = { value: 0, mode: 'add' };
    }

    // 5. override:gaze 眼球(角度 → 参数量程)
    if (this.gazeEngaged) {
      const ex = this.eyeDegX / EYE_RANGE_DEG.x;
      const ey = this.eyeDegY / EYE_RANGE_DEG.y;
      for (const [param, base] of [
        ['EyeLeftX', ex],
        ['EyeRightX', ex],
        ['EyeLeftY', ey],
        ['EyeRightY', ey],
      ] as const) {
        const additive = pulseSum.get(param) ?? 0;
        frame[param] = { value: this.clampParam(param, base + additive), mode: 'set' };
      }
    }

    // 6. 后处理:接管期眨眼、lipsync 嘴部(最高优先)
    const blinkBy = this.applyBlink(frame, now);
    this.applyMouth(frame, now, dtSec);

    this.diag?.frame(now, frame, {
      stateRaw: stateSum,
      duck: duckByParam ?? new Map(),
      pulse: pulseSum,
      prosody: prosodySum,
      blink: blinkBy ?? EMPTY_LAYER,
      ambient: ambientBy ?? EMPTY_LAYER,
      followX: this.headFollowX,
      followY: this.headFollowY,
    });

    return frame;
  }

  private accumulateSustain(
    sum: Map<string, number>,
    clip: SustainClip | null,
    weight: number,
    now: number,
    setAt: number,
  ): void {
    if (!clip || weight <= 0) return;
    const t = (now - setAt) / 1000;
    for (const [param, spec] of Object.entries(clip.hold)) {
      let v = spec.v;
      if (spec.settleTo !== undefined && spec.settleMs) {
        const u = Math.min(1, Math.max(0, (now - setAt) / spec.settleMs));
        v = spec.v + (spec.settleTo - spec.v) * (u * u * (3 - 2 * u));
      }
      if (spec.noiseAmp && spec.noiseHz) {
        v +=
          spec.noiseAmp *
          (spec.noiseKind === 'drift'
            ? driftNoise(t, spec.noiseHz, spec.phase ?? 0)
            : Math.sin(2 * Math.PI * spec.noiseHz * t + (spec.phase ?? 0)));
      }
      sum.set(param, (sum.get(param) ?? 0) + v * weight);
    }
  }

  /**
   * 将一次性加性轨迹采样到 sum;返回未过期且未被热重载删除的轨迹。
   * marks 给 ducking 记"本帧被 pulse 写过的参数";韵律轨迹不传(不 duck)。
   */
  private advancePulses(
    cues: GestureCue[],
    now: number,
    sum: Map<string, number>,
    marks?: Set<string>,
  ): GestureCue[] {
    const alive: GestureCue[] = [];
    for (const p of cues) {
      const clip = this.pack().pulse[p.clipId];
      if (!clip) continue;
      const t = now - p.startTs;
      if (t >= clip.durationMs) continue;
      alive.push(p);
      if (t < 0) continue; // 排期未到
      for (const [param, keys] of Object.entries(clip.tracks)) {
        marks?.add(param);
        sum.set(param, (sum.get(param) ?? 0) + sampleKeys(keys, t) * p.intensity);
      }
    }
    return alive;
  }

  /**
   * 眼睑值是相对睁眼偏移，闭合作用于 `(1 + offset)`；返回值供诊断归因。
   * `idleBlinks` 为 true 时仅接管已有眼睑写入，否则持续提供中性眼睑与眨眼。
   */
  private applyBlink(frame: IRFrame, now: number): Map<string, number> | null {
    const written = frame.EyeOpenLeft?.mode === 'add' || frame.EyeOpenRight?.mode === 'add';
    if (!written && this.idleBlinks()) {
      this.nextBlinkAt = null;
      return null;
    }
    // 全程持有时补齐两眼:单眼动作(眨单眼)只写一只,另一只也该照常眨
    if (!this.idleBlinks()) {
      for (const param of ['EyeOpenLeft', 'EyeOpenRight'] as const) {
        if (frame[param]?.mode !== 'add') frame[param] = { value: 0, mode: 'add' };
      }
    }
    const close = this.blinkClose(now);
    if (close <= 0) return null;
    const by = this.diag ? new Map<string, number>() : null;
    for (const param of ['EyeOpenLeft', 'EyeOpenRight'] as const) {
      const cell = frame[param];
      if (!cell || cell.mode !== 'add') continue;
      const shut = this.clampParam(param, (1 + cell.value) * (1 - close) - 1);
      by?.set(param, shut - cell.value);
      cell.value = shut;
    }
    return by;
  }

  /** lipsync 嘴部:张嘴即时跟包络,闭嘴过下行 τ(盖住片尾/片间/打断的下行悬崖) */
  private applyMouth(frame: IRFrame, now: number, dtSec: number): void {
    const target = this.speechEnvelope ? this.speechEnvelope(now - this.speechStartedAt) * MOUTH_GAIN : 0;
    this.mouthLevel =
      target >= this.mouthLevel
        ? target
        : target + (this.mouthLevel - target) * Math.exp(-(dtSec * 1000) / MOUTH_FALL_TAU_MS);
    if (this.speechEnvelope || this.mouthLevel > 0.01) {
      frame.MouthOpen = { value: this.clampParam('MouthOpen', this.mouthLevel), mode: 'set' };
    } else {
      this.mouthLevel = 0;
    }
  }

  /** 逐参数平滑 ducking 系数;衰减快于恢复,两端均连续。 */
  private duckFactor(param: string, underPulse: Set<string>, dtSec: number): number {
    const target = underPulse.has(param) ? DUCK_LEVEL : 1;
    const cur = this.duckNow.get(param) ?? 1;
    if (cur === target) {
      if (target === 1) this.duckNow.delete(param);
      return target;
    }
    const tauMs = target < cur ? DUCK_ATTACK_TAU_MS : DUCK_RECOVER_TAU_MS;
    const next = cur + (target - cur) * (1 - Math.exp(-(dtSec * 1000) / tauMs));
    if (target === 1 && 1 - next < 1e-3) {
      this.duckNow.delete(param);
      return 1;
    }
    this.duckNow.set(param, next);
    return next;
  }

  private stepGaze(now: number, dtSec: number): void {
    const target = this.gazeTarget;

    // 头部:滞后于眼动起步,之后一阶跟随(幅度按 HEAD_FOLLOW_FACTOR 衰减,不追到底)
    const headK = now >= this.headStartAt ? 1 - Math.exp(-dtSec * 5) : 0;
    this.headFollowX += ((target?.headX ?? 0) * HEAD_FOLLOW_FACTOR - this.headFollowX) * headK;
    this.headFollowY += ((target?.headY ?? 0) * HEAD_FOLLOW_FACTOR - this.headFollowY) * headK;

    if (target) {
      this.stepScan(now, target.scanRadiusDeg ?? SCAN_RADIUS_DEFAULT_DEG);
      this.stepDrift(dtSec);
    } else {
      // 无目标:游走与漂移收敛回中,眼球才能真正归零并把 override 交还 idle 基座
      const decay = 1 - Math.exp(-dtSec * 4);
      this.scan = null;
      this.walkX -= this.walkX * decay;
      this.walkY -= this.walkY * decay;
      this.driftX -= this.driftX * decay;
      this.driftY -= this.driftY * decay;
    }

    /*
     * 眼在头内 = 总视线 - 头已经转过的部分。
     * 头还没跟上时眼先顶上去(顶到满量程就停在那儿等头,即大幅转向的阶梯式行为),
     * 头追上后眼回落到机位设定值。
     */
    const total = totalGazeDeg(target);
    let degX = total.x - this.headFollowX + this.walkX + this.driftX;
    let degY = total.y - this.headFollowY + this.walkY + this.driftY;

    // 换目标的大幅扫视:从换向那一刻的眼位按主序列过渡到算术目标。
    // 插值终点随头部追踪更新,到期后收敛到当前算术目标。
    if (this.shift) {
      const u = (now - this.shift.startTs) / this.shift.durMs;
      if (u >= 1) this.shift = null;
      else {
        const p = saccadeProgress(u, this.shift.peakAt);
        degX = this.shift.fromX + (degX - this.shift.fromX) * p;
        degY = this.shift.fromY + (degY - this.shift.fromY) * p;
      }
    }

    this.eyeDegX = clampDeg(degX, EYE_RANGE_DEG.x);
    this.eyeDegY = clampDeg(degY, EYE_RANGE_DEG.y);

    if (
      !target &&
      this.gazeEngaged &&
      Math.abs(this.eyeDegX) < 0.4 &&
      Math.abs(this.eyeDegY) < 0.4 &&
      Math.abs(this.headFollowX) < 0.3 &&
      Math.abs(this.headFollowY) < 0.3
    ) {
      this.gazeEngaged = false;
    }
  }

  /** 注视点:保持一段(注视)→ 一次快速换位(扫视)→ 再保持 */
  private stepScan(now: number, radiusDeg: number): void {
    const sac = this.scan;
    if (sac) {
      const u = (now - sac.startTs) / sac.durMs;
      if (u < 1) {
        const p = saccadeProgress(u, sac.peakAt);
        this.walkX = sac.fromX + (sac.toX - sac.fromX) * p;
        this.walkY = sac.fromY + (sac.toY - sac.fromY) * p;
        return;
      }
      this.walkX = sac.toX;
      this.walkY = sac.toY;
      this.scan = null;
      this.nextFixAt = now + this.sampleFixationMs();
      return;
    }
    if (now >= this.nextFixAt) this.beginScanSaccade(now, radiusDeg);
  }

  private beginScanSaccade(now: number, radiusDeg: number): void {
    const amp = Math.min(radiusDeg * 1.2, Math.max(0.1, this.expo(radiusDeg * SCAN_AMP_RATIO)));
    const angle = this.rng() * 2 * Math.PI;
    const toX = reflectInto(this.walkX + Math.cos(angle) * amp, radiusDeg);
    const toY = reflectInto(
      this.walkY + Math.sin(angle) * amp * SCAN_VERTICAL_BIAS,
      radiusDeg * SCAN_VERTICAL_BIAS,
    );
    const durMs = saccadeDurationMs(Math.hypot(toX - this.walkX, toY - this.walkY));
    this.scan = {
      fromX: this.walkX,
      fromY: this.walkY,
      toX,
      toY,
      startTs: now,
      durMs,
      peakAt: saccadePeakAt(durMs),
    };
  }

  /** 注视期的慢漂移:一阶低通白噪声,稳态标准差 ≈ DRIFT_SD_DEG */
  private stepDrift(dtSec: number): void {
    const k = Math.min(1, dtSec / DRIFT_TAU_SEC);
    const gain = DRIFT_SD_DEG * Math.sqrt(2 * k);
    this.driftX += -this.driftX * k + this.gauss() * gain;
    this.driftY += -this.driftY * k + this.gauss() * gain * SCAN_VERTICAL_BIAS;
  }

  private sampleFixationMs(): number {
    return Math.max(FIX_MIN_MS, FIX_MU_MS + this.gauss() * FIX_SIGMA_MS + this.expo(FIX_TAU_MS));
  }

  /** 进行中眨眼的闭合度(0-1),顺带调度下一次;只在眼睑被接管的帧调用 */
  private blinkClose(now: number): number {
    if (this.nextBlinkAt === null) {
      this.nextBlinkAt = now + BLINK_GAP_MIN_MS + this.expo(BLINK_GAP_MEAN_MS);
      return 0;
    }
    if (now >= this.nextBlinkAt) {
      this.blinkStartTs = now;
      this.nextBlinkAt = now + BLINK_TOTAL_MS + BLINK_GAP_MIN_MS + this.expo(BLINK_GAP_MEAN_MS);
    }
    const t = now - this.blinkStartTs;
    if (t < 0 || t >= BLINK_TOTAL_MS) return 0;
    const u = t < BLINK_CLOSE_MS ? t / BLINK_CLOSE_MS : 1 - (t - BLINK_CLOSE_MS) / (BLINK_TOTAL_MS - BLINK_CLOSE_MS);
    return u * u * (3 - 2 * u);
  }

  /** 标准正态(Box-Muller) */
  private gauss(): number {
    const u1 = Math.max(1e-6, this.rng());
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * this.rng());
  }

  private expo(mean: number): number {
    return -Math.log(Math.max(1e-6, 1 - this.rng())) * mean;
  }
}

function clampDeg(v: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, v));
}

/** 一个注视目标的总视线方向(度) = 眼在头内贡献 + 头部贡献 */
function totalGazeDeg(t: GazeTarget | null): { x: number; y: number } {
  return {
    x: (t?.eyeX ?? 0) * EYE_RANGE_DEG.x + (t?.headX ?? 0) * HEAD_FOLLOW_FACTOR,
    y: (t?.eyeY ?? 0) * EYE_RANGE_DEG.y + (t?.headY ?? 0) * HEAD_FOLLOW_FACTOR,
  };
}

/** 越界就朝心反射:注视点不会漂出目标区,且纠正方向与漂移相反 */
function reflectInto(v: number, bound: number): number {
  if (v > bound) return Math.max(-bound, 2 * bound - v);
  if (v < -bound) return Math.min(bound, -2 * bound - v);
  return v;
}
