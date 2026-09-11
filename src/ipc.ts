import type { StreamEvent } from '../protocol/open-responses/index.ts';
/**
 * 演出引擎子进程的 IPC 协议。
 *
 * 演出链路(编排/混音/注入/TTS/声卡/演出流)在独立子进程中运行。60Hz 求值与
 * 注入同主进程事件循环隔离;帧数据不跨进程边界。跨界只有两类流量:
 *
 * - 主 → 子:工具调用与 outputTap 增量(KB/s 级)、x-hot 配置快照、事件信封
 *   (去正文,只为播出延迟地板);
 * - 子 → 主:日志、事件、状态徽标这类通知。
 *
 * 消息按 Node IPC 的到达序处理:tap 增量先于同一调用的工具请求发出,子进程里
 * 的处理顺序因此与进程内一致。
 */
import type { LogNote } from '../core/ipcLogger.ts';
import type { EventEnvelope, LLMUsage, PushOptions } from '../core/types.ts';
import type { ModuleConsoleDecl } from '../core/types.ts';
import type { OverlayConfig, TtsProfile, VtuberDecaySec } from './module.ts';

/**
 * x-hot 配置的取值快照。键缺席 = 装配层没提供那个 getter(子进程用模组默认值);
 * 键的在场集在 init 时定死,之后的快照只更新取值。
 */
export interface EngineConfigSnapshot {
  audioDevice?: string;
  audioMirrorSystem?: boolean;
  audioSecondary?: string;
  alignEnabled?: boolean;
  streamEnabled?: boolean;
  speechCapSec?: number;
  maxActRoundsPerTurn?: number;
  silenceRemindSec?: number;
  mutedText?: string;
  obsDelaySec?: number;
  delayedSources?: string[];
  yieldWindowMs?: number;
  yieldFadeMs?: number;
  decaySec?: VtuberDecaySec;
  modelProfile?: string;
  ttsBaseLmFile?: string;
  ttsAcousticFile?: string;
  ttsAlignerLmFile?: string;
  ttsAlignerAudioFile?: string;
  ttsVoicesDir?: string;
  live2dDir?: string;
}

/** 子进程里构造真模组的一次性载荷 */
export interface EngineInit {
  timezone: string;
  botName: string;
  vtsWsUrl: string;
  streamPort: number;
  ttsUrl: string;
  ttsServerDir: string | null;
  /** 演出包目录;null = 范例包 */
  packDir: string | null;
  diagDir: string | null;
  vtsAuthToken: string | null;
  ttsProfile: Partial<TtsProfile> | null;
  overlay: Partial<OverlayConfig> | null;
  config: EngineConfigSnapshot;
}

/** 事件信封的瘦身版:只带播出延迟地板要扫的字段,正文不过界 */
export interface SlimEvent {
  cursor: number;
  ts: string;
  source: string;
}

/** 主 → 子:要回执的请求 */
export type EngineRequest =
  | { kind: 'init'; init: EngineInit }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; role: string; callId: string | null; round: number | null }
  | { kind: 'panel'; panel: EnginePanel; method: string; args: unknown[] }
  | { kind: 'shutdown' };

export type EnginePanel =
  | 'vts'
  | 'tts'
  | 'align'
  | 'log'
  | 'diag'
  | 'perform'
  | 'clips'
  | 'overlay'
  | 'model';

/** init 的回执:演出流的实际地址(偏好端口被占会顺延) */
export interface EngineReady {
  streamUrl: string;
  danmakuUrl: string;
  overlayUrl: string;
}

/** 主 → 子:单向投递 */
export type EngineCast =
  | { kind: 'tap'; event: StreamEvent }
  | { kind: 'tap-round-end' }
  | { kind: 'tap-abort'; reason: string }
  | { kind: 'config'; config: EngineConfigSnapshot }
  | { kind: 'events'; events: SlimEvent[] };

/** 子 → 主的无回执通知。 */
export type EngineNote =
  | LogNote
  | { kind: 'usage'; usage: LLMUsage; opts?: Parameters<import('../core/types.ts').IOModuleHost['reportUsage']>[1] }
  | { kind: 'status'; line: string | null; live: boolean; decl: Pick<ModuleConsoleDecl, 'lamps' | 'badges' | 'links'> }
  | { kind: 'tts-profile'; profile: TtsProfile }
  | { kind: 'overlay-config'; config: OverlayConfig }
  | { kind: 'vts-token'; token: string };

/**
 * 子 → 主:宿主调用(IOModuleHost 有回执的那几个方法,跨进程兑现真实结果)。
 * drain 的 filter 函数过不了界:跨进程宿主只支持"取本模组来源的事件"这一种。
 */
export type HostRequest =
  | {
      kind: 'push';
      evt: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & { origin?: EventEnvelope['origin']; blobs?: undefined };
      opts?: PushOptions;
    }
  | { kind: 'drain' }
  | { kind: 'stalls'; withinMs: number };

export type MainToChild =
  | { t: 'req'; id: number; req: EngineRequest }
  | { t: 'cancel'; id: number }
  | { t: 'hrep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'cast'; cast: EngineCast };

export type ChildToMain =
  | { t: 'rep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'hreq'; id: number; req: HostRequest }
  | { t: 'note'; note: EngineNote };
