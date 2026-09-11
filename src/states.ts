/**
 * State 状态机。
 *
 * Pose / Emotion / Gaze 每通道一个长驻状态机,beat 只向它发事件。
 * 转移与超时都以 cue 形式发往 L3(fade 由 cue 声明,L3 执行);
 * 本层不逐帧计算,也不知道任何 Live2D 参数。
 */

export type StateChannel = 'pose' | 'emotion' | 'gaze';

/** L2→L3 契约。clipId=null 表示回中性(该通道无叠加)。 */
export interface StateCue {
  channel: StateChannel;
  clipId: string | null;
  startTs: number;
  intensity: number;
  fadeInMs: number;
}

/** 设置/替换的 crossfade */
export const STATE_FADE_IN_MS = 300;

/** 超时范围默认档;控制台可按通道热调(StateMachinesOptions.timeouts) */
export const DEFAULT_TIMEOUT_RANGE_MS: Record<StateChannel, [number, number]> = {
  gaze: [4000, 6000],
  pose: [10000, 15000],
  emotion: [20000, 30000],
};

const DECAY_FADE_RANGE_MS: [number, number] = [2000, 3000];

interface ChannelState {
  clipId: string | null;
  expiresAt: number;
}

export interface StateMachinesOptions {
  emit: (cue: StateCue) => void;
  /**
   * 超时衰减的落点。gaze 的中性是"当前模式的默认注视",
   * pose/emotion 通常返回 null(纯中性)。
   */
  neutral: (channel: StateChannel) => string | null;
  /** 超时范围(ms);缺省 DEFAULT_TIMEOUT_RANGE_MS。每次 set 时取值,支持热调 */
  timeouts?: (channel: StateChannel) => [number, number];
  rng?: () => number;
}

export class StateMachines {
  private readonly emit: (cue: StateCue) => void;
  private readonly neutral: (channel: StateChannel) => string | null;
  private readonly timeouts: (channel: StateChannel) => [number, number];
  private readonly rng: () => number;
  private readonly channels: Record<StateChannel, ChannelState> = {
    pose: { clipId: null, expiresAt: 0 },
    emotion: { clipId: null, expiresAt: 0 },
    gaze: { clipId: null, expiresAt: 0 },
  };

  constructor(opts: StateMachinesOptions) {
    this.emit = opts.emit;
    this.neutral = opts.neutral;
    this.timeouts = opts.timeouts ?? ((channel) => DEFAULT_TIMEOUT_RANGE_MS[channel]);
    this.rng = opts.rng ?? Math.random;
  }

  active(channel: StateChannel): string | null {
    return this.channels[channel].clipId;
  }

  /** 还有多久超时滑回中性;没挂东西或已衰减完返回 null(诊断用) */
  remainingMs(channel: StateChannel, now: number): number | null {
    const st = this.channels[channel];
    if (st.clipId === null || !Number.isFinite(st.expiresAt)) return null;
    return Math.max(0, Math.round(st.expiresAt - now));
  }

  /**
   * 同通道新值直接 crossfade;重复设当前值也重发 cue——
   * 重复点名【大笑】= 重新起势(爆发分量的 settle 从头再来),不只是续命。
   */
  set(channel: StateChannel, clipId: string, ts: number): void {
    const st = this.channels[channel];
    st.expiresAt = ts + this.pick(this.timeouts(channel));
    st.clipId = clipId;
    this.emit({ channel, clipId, startTs: ts, intensity: 1, fadeInMs: STATE_FADE_IN_MS });
  }

  resetAll(ts: number): void {
    for (const channel of ['pose', 'emotion', 'gaze'] as const) {
      const st = this.channels[channel];
      if (st.clipId === null) continue;
      st.clipId = null;
      this.emit({ channel, clipId: this.neutral(channel), startTs: ts, intensity: 1, fadeInMs: STATE_FADE_IN_MS });
    }
  }

  /** 超时缓慢衰减回中性(2–3s 淡出) */
  tick(now: number): void {
    for (const channel of ['pose', 'emotion', 'gaze'] as const) {
      const st = this.channels[channel];
      if (st.clipId === null || now < st.expiresAt) continue;
      st.expiresAt = Number.POSITIVE_INFINITY;
      const target = this.neutral(channel);
      if (st.clipId === target) continue;
      st.clipId = null;
      this.emit({ channel, clipId: target, startTs: now, intensity: 1, fadeInMs: this.pick(DECAY_FADE_RANGE_MS) });
    }
  }

  private pick([lo, hi]: [number, number]): number {
    return lo + (hi - lo) * this.rng();
  }
}
