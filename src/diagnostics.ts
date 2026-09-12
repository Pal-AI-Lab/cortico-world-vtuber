/**
 * 演出诊断提供可复算的结构化事件与逐帧参数数据。
 * 事件环保存轮、拍、语音和 cue；控制台文本日志是其投影。
 * 帧分析汇总参数动态范围、分层峰值贡献与最大跳变归因。
 * JSON 导出可选附带指定时长的逐帧原始值。
 */
import type { LogLevel } from 'cortico/core/types.ts';
import type { IRFrame } from './mixer.ts';

/** 混合链各层；follow、ambient、override 与 blink 仅覆盖各自控制的参数。 */
export const DIAG_LAYERS = ['state', 'pulse', 'prosody', 'blink', 'ambient', 'follow', 'override'] as const;
export type DiagLayer = (typeof DIAG_LAYERS)[number];

/** 混音台逐帧提供的分层贡献；诊断层不重新求值。 */
export interface FrameLayers {
  /** State 通道**未乘 ducking**的贡献 */
  stateRaw: ReadonlyMap<string, number>;
  /** 每参数当帧的 ducking 系数(1 = 未被压;缺省视为 1) */
  duck: ReadonlyMap<string, number>;
  pulse: ReadonlyMap<string, number>;
  prosody: ReadonlyMap<string, number>;
  /** 接管期眨眼对眼睑的当帧修正量 */
  blink: ReadonlyMap<string, number>;
  /** 环境姿态漂移(头部三轴全时持有的底层) */
  ambient: ReadonlyMap<string, number>;
  followX: number;
  followY: number;
}

export interface DiagEvent {
  seq: number;
  tsMs: number;
  /** 通道名(轮/拍/TTS/音频/状态/韵律/注入…) */
  lane: string;
  label: string;
  /** 有跨度的事件(拍、语音片、clip)给出时长,时间轴上画成条 */
  durMs?: number;
  detail?: string;
}

/**
 * 埋点级别与运行日志一致；缺席时由 world.ts 的 LANE_TRACE 决定。info 用于可逐条阅读的状态迁移；warn 用于播出与预期不一致的情况，如拒播、无效单元表、截断、禁播词过滤或修订未命中。
 */
export type TraceLevel = LogLevel;

/** 埋点选项。事件环只收 durMs/detail;其余字段只影响运行日志投影与滚动摘要。 */
export interface TraceOptions {
  /** 有跨度的事件给出时长 */
  durMs?: number;
  detail?: string;
  /** 显式给的级别优先于通道默认 */
  level?: TraceLevel;
  /**
   * 滚动摘要的计数桶名(如「拒收」「对齐降级」「掐流」)。
   * 只有 warn/error 且给了桶名才计数——摘要行自己不带桶名,不会自计数成环。
   */
  tally?: string;
  /** 运行日志的机器可读小类(kebab-case) */
  event?: string;
  /** 运行日志 data 的结构化字段;detail 另以 `detail` 键并入 */
  data?: Record<string, unknown>;
}

/** 一次逐帧跳变及其归因 */
export interface DiagJump {
  tsMs: number;
  from: number;
  to: number;
  delta: number;
  dtMs: number;
  /** 各层相对上一帧的变化量。 */
  dBy: Partial<Record<DiagLayer, number>>;
  /** ducking 系数的 [上一帧, 当前帧]。 */
  duck?: [number, number];
}

interface ParamStat {
  seen: boolean;
  min: number;
  max: number;
  peakBy: Record<DiagLayer, number>;
  jumps: DiagJump[];
  prev: Record<DiagLayer, number>;
  prevFinal: number;
  prevDuck: number;
}

/** 每参数保留最坏的几次跳变 */
const JUMPS_PER_PARAM = 4;
/** 事件环容量 */
const EVENT_CAP = 400;

function zeroLayers(): Record<DiagLayer, number> {
  return { state: 0, pulse: 0, prosody: 0, blink: 0, ambient: 0, follow: 0, override: 0 };
}

function newStat(): ParamStat {
  return {
    seen: false,
    min: 0,
    max: 0,
    peakBy: zeroLayers(),
    jumps: [],
    prev: zeroLayers(),
    prevFinal: 0,
    prevDuck: 1,
  };
}

/** 报表数值保留 4 位小数,避免序列化浮点精度噪声。 */
function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export class PerfDiagnostics {
  private readonly events: DiagEvent[] = [];
  private seq = 0;
  private readonly params = new Map<string, ParamStat>();

  // 用 null 而不是 0 当"还没有过帧"的哨兵:now 合法地可以是 0
  private startedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private frames = 0;

  // 注入侧实况(由 L4 报)
  private sent = 0;
  private droppedBusy = 0;
  private readonly rejected = new Set<string>();

  private capturing: { untilMs: number; params: string[]; rows: number[][] } | null = null;

  /**
   * 对拍读回:录制窗口内轮询 VTS 得到的实机值序列。
   * outputRows 是合成后落在模型上的 Live2D 输出参数;inputRows 是 VTS 输入参数的
   * 实时值(含停发后的保持/衰减);inputDefaults 验证注入基线。
   * 时间轴与 capture 同源(相对窗口起点),三条序列可以直接对齐对差。
   */
  private probe: {
    outputParams: string[];
    inputParams: string[];
    inputDefaults: Record<string, number>;
    outputRows: number[][];
    inputRows: number[][];
  } | null = null;


  trace(lane: string, label: string, opts: TraceOptions = {}): DiagEvent {
    const e: DiagEvent = { seq: ++this.seq, tsMs: Date.now(), lane, label };
    if (opts.durMs !== undefined) e.durMs = Math.round(opts.durMs);
    if (opts.detail) e.detail = opts.detail;
    this.events.push(e);
    if (this.events.length > EVENT_CAP) this.events.shift();
    return e;
  }

  /** seq > after 的事件(面板增量拉取) */
  eventsAfter(after = 0): DiagEvent[] {
    return this.events.filter((e) => e.seq > after);
  }


  frame(now: number, frame: IRFrame, layers: FrameLayers): void {
    if (this.startedAt === null) this.startedAt = now;
    const dtMs = this.lastFrameAt === null ? 0 : now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.frames++;

    // 参数集包含本帧值、State 贡献和前帧值,以记录消失参数归零的跳变。
    const names = new Set<string>(this.params.keys());
    for (const k of Object.keys(frame)) names.add(k);
    for (const k of layers.stateRaw.keys()) names.add(k);

    for (const name of names) {
      let st = this.params.get(name);
      if (!st) {
        st = newStat();
        this.params.set(name, st);
      }
      const cell = frame[name];
      const final = cell?.value ?? 0;
      const duck = layers.duck.get(name) ?? 1;
      const cur: Record<DiagLayer, number> = {
        state: (layers.stateRaw.get(name) ?? 0) * duck,
        pulse: layers.pulse.get(name) ?? 0,
        prosody: layers.prosody.get(name) ?? 0,
        blink: layers.blink.get(name) ?? 0,
        ambient: layers.ambient.get(name) ?? 0,
        follow: name === 'FaceAngleX' ? layers.followX : name === 'FaceAngleY' ? layers.followY : 0,
        override: cell?.mode === 'set' ? final : 0,
      };

      if (!st.seen) {
        st.seen = true;
        st.min = final;
        st.max = final;
      } else {
        if (final < st.min) st.min = final;
        if (final > st.max) st.max = final;
        const delta = final - st.prevFinal;
        if (dtMs > 0 && Math.abs(delta) > 1e-9) {
          const dBy: Partial<Record<DiagLayer, number>> = {};
          for (const l of DIAG_LAYERS) {
            const d = cur[l] - st.prev[l];
            if (Math.abs(d) > 1e-9) dBy[l] = r4(d);
          }
          this.recordJump(st, {
            tsMs: now,
            from: r4(st.prevFinal),
            to: r4(final),
            delta: r4(delta),
            dtMs: Math.round(dtMs),
            dBy,
            ...(duck !== st.prevDuck ? { duck: [r4(st.prevDuck), r4(duck)] as [number, number] } : {}),
          });
        }
      }
      for (const l of DIAG_LAYERS) {
        const a = Math.abs(cur[l]);
        if (a > st.peakBy[l]) st.peakBy[l] = a;
      }
      st.prev = cur;
      st.prevFinal = final;
      st.prevDuck = duck;
    }

    // 到点后停止追加,已录的数据留着导出
    if (this.capturing && now <= this.capturing.untilMs) {
      this.capturing.rows.push([
        Math.round(now - (this.startedAt ?? now)),
        ...this.capturing.params.map((p) => r4(frame[p]?.value ?? 0)),
      ]);
    }
  }

  /** 只留最坏的几次:按 |delta| 降序 */
  private recordJump(st: ParamStat, jump: DiagJump): void {
    const mag = Math.abs(jump.delta);
    if (st.jumps.length >= JUMPS_PER_PARAM && mag <= Math.abs(st.jumps[st.jumps.length - 1].delta)) return;
    st.jumps.push(jump);
    st.jumps.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (st.jumps.length > JUMPS_PER_PARAM) st.jumps.length = JUMPS_PER_PARAM;
  }


  noteInject(stat: { sent: boolean; rejected?: readonly string[] }): void {
    if (stat.sent) this.sent++;
    else this.droppedBusy++;
    for (const n of stat.rejected ?? []) this.rejected.add(n);
  }


  startCapture(ms: number, params: readonly string[]): void {
    this.capturing = {
      untilMs: (this.lastFrameAt ?? Date.now()) + Math.max(100, ms),
      params: [...params],
      rows: [],
    };
  }


  beginProbe(outputParams: string[], inputParams: string[], inputDefaults: Record<string, number>): void {
    this.probe = { outputParams, inputParams, inputDefaults, outputRows: [], inputRows: [] };
  }

  probeOutputRow(now: number, values: readonly number[]): void {
    this.probe?.outputRows.push([Math.round(now - (this.startedAt ?? now)), ...values.map(r4)]);
  }

  probeInputRow(now: number, values: readonly number[]): void {
    this.probe?.inputRows.push([Math.round(now - (this.startedAt ?? now)), ...values.map(r4)]);
  }


  /** 汇总报表；调用方提供的 `state` 快照按不透明数据转交。 */
  report(state?: unknown): Record<string, unknown> {
    const spanMs = Math.max(1, (this.lastFrameAt ?? 0) - (this.startedAt ?? 0));
    const sec = spanMs / 1000;
    const params: Record<string, unknown> = {};
    for (const [name, st] of [...this.params].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!st.seen) continue;
      const peakBy: Record<string, number> = {};
      for (const l of DIAG_LAYERS) if (st.peakBy[l] !== 0) peakBy[l] = r4(st.peakBy[l]);
      params[name] = {
        min: r4(st.min),
        max: r4(st.max),
        p2p: r4(st.max - st.min),
        peakBy,
        jumps: st.jumps,
      };
    }
    return {
      window: {
        spanMs: Math.round(spanMs),
        frames: this.frames,
        evalHz: r4(this.frames / sec),
      },
      inject: {
        sent: this.sent,
        droppedBusy: this.droppedBusy,
        sentHz: r4(this.sent / sec),
        dropPct: this.sent + this.droppedBusy > 0
          ? Math.round((this.droppedBusy / (this.sent + this.droppedBusy)) * 100)
          : 0,
        rejectedParams: [...this.rejected],
      },
      state: state ?? null,
      params,
      events: this.events.slice(-EVENT_CAP),
      capture: this.capturing
        ? { params: this.capturing.params, rows: this.capturing.rows }
        : null,
      probe: this.probe,
    };
  }

  /** 清掉累计量重新开窗(事件环保留) */
  resetWindow(): void {
    this.params.clear();
    this.frames = 0;
    this.startedAt = null;
    this.sent = 0;
    this.droppedBusy = 0;
    this.rejected.clear();
    this.capturing = null;
    this.probe = null;
  }
}
