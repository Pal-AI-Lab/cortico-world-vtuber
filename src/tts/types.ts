/**
 * TTS 的公共形状:一次合成的产物(TtsPiece)、流式接收端、执行快照与适配器契约。
 *
 * 单独成文件是为了让依赖单向:config → audio → types → 各适配器 → registry → tts.ts。
 * `src/tts.ts` 把这些名字原样再导出,旧的导入面不变。
 */
import type { AlignedUnit } from '../align.ts';
import type { SilenceReport } from '../silence-scan.ts';
import type { EnvelopeLike, StreamingEnvelope } from './audio.ts';
import type {
  JsonValue,
  TtsDelivery,
  TtsManagement,
  TtsPcmConfig,
  TtsProtocol,
  TtsResponseFormat,
} from './config.ts';

/** 整段包络与流式增量包络共用的只读接口。 */
export type { EnvelopeLike } from './audio.ts';

export interface TtsPiece {
  text: string;
  /** 有效、长度正确的 wav 字节(经 device-audio 写本机声卡) */
  wav: Uint8Array;
  durationMs: number;
  envelope: EnvelopeLike;
  /** 片内逐单元起止时间;未开启标注时缺省 */
  units?: AlignedUnit[];
  /** 流式合成被中途掐断(撞时长宽容界,或撞超大静默段):已收部分照常可用 */
  truncated?: boolean;
  /** 合成开始时的服务策略;后续服务切换不改变本片的处理方式。 */
  qualityPolicy?: 'voxcpm' | 'generic';
  /** 本片所用后端的音频时长上限。 */
  maxAudioMs?: number;
  /** 本片最长的连续近静默段;只有 VoxCPM 策略使用 triggered 决定截流。 */
  silence?: SilenceReport;
  /**
   * 流式对齐判废时不采信 units,附带原因和 lastGoodEndMs。判废本身不触发破坏性
   * 动作;字幕与锚点回落估计,lastGoodEndMs 供达到后端硬时长上限的末级兜底估计划点。
   */
  alignBad?: { reasons: string[]; lastGoodEndMs: number | null };
}

/** 使用本片合成快照,对已收到的 PCM16 前缀生成单元时间点。 */
export type TtsPcmAligner = (pcm: Uint8Array, sampleRate: number, units: string[]) => Promise<AlignedUnit[] | null>;

/** 流式合成的接收端 */
export interface TtsStreamSink {
  /** 头解析完成,采样率已知;envelope 是增量包络,lipsync/重音扫描边播边读 */
  begin?(info: { sampleRate: number; envelope: StreamingEnvelope; alignPcm?: TtsPcmAligner }): void;
  /** 一块 PCM16LE 单声道字节(偶数长度),到达即转发舞台页 */
  pcm(chunk: Uint8Array): void;
}

/** VoxCPM2 声线与生成参数;undefined 字段不进请求体(用 server 默认) */
export interface TtsSynthProfile {
  referenceAudioB64?: string;
  /** 参考音频的转写;与 referenceAudioB64 同给才有意义 */
  refText?: string;
  seed?: number;
  cfgValue?: number;
  inferenceTimesteps?: number;
  maxSteps?: number;
  temperature?: number;
}

/**
 * 后端能力面。能力来自适配器的明确契约,不由"非 404"这类探测推断;
 * 实际成功/失败只用于修正可用状态。
 */
export interface TtsCapabilities {
  /** 能增量消费同一个合成端点的响应体(标准协议 wav/pcm,或 legacy 私有流式) */
  incremental: boolean;
  /** 有 VoxCPM 私有 `/audio/speech/stream` 端点 */
  privateStream: boolean;
  /** 同一服务根上挂着 VoxCPM 对齐器 */
  aligner: boolean;
  /** 参考音频克隆 */
  referenceAudio: boolean;
  /** 允许 World 用本地管理器启停这个服务的进程 */
  managesProcess: boolean;
  /** 质量策略归属:VoxCPM 的长静默重合成只对 legacy 生效 */
  qualityPolicy: 'voxcpm' | 'generic';
  /** 后端硬时长上限(ms);只有 VoxCPM server 有,通用服务不给 */
  maxAudioMs?: number;
  /** 服务端可渲染音素感知衰减段 */
  serverCut?: boolean;
}

/** 一次合成的冻结快照:整片(含允许的回退)共用同一份。 */
export interface TtsExecutionSnapshot {
  serviceId: string;
  /** 配置来源版本;虚拟迁移的 legacy 是 0 */
  revision: number;
  /** 不含密钥的配置指纹,用于缓存与语速统计命名空间 */
  fingerprint: string;
  name: string;
  protocol: TtsProtocol;
  management: TtsManagement;
  speechUrl: string;
  /** legacy 私有流式地址;通用服务为 null */
  legacyStreamUrl: string | null;
  /** legacy 服务根(对齐器与本地管理器用);通用服务为 null */
  serviceRoot: string | null;
  /** 已经拼好的 Authorization 头;`none` 时为 null */
  authHeader: string | null;
  model: string;
  voice: string | { id: string };
  responseFormat: TtsResponseFormat;
  delivery: TtsDelivery;
  timeoutMs: number;
  speed?: number;
  instructions?: string;
  extraBody?: Record<string, JsonValue>;
  headers?: Record<string, string>;
  pcm?: TtsPcmConfig;
  /** 只对 legacy 有意义 */
  profile?: TtsSynthProfile;
  capabilities: TtsCapabilities;
}

export interface TtsStreamOptions {
  signal: AbortSignal;
  /** 跑飞止损预算;超出即掐流保留已收部分 */
  maxDurationMs?: number;
  /**
   * 私有流式路由不存在且尚未交付过 PCM 时,允许回退一次整段合成。
   * 兼容入口 `new TtsClient({url})` 传 false:它的旧契约是不回退。
   */
  fallback?: boolean;
}

/**
 * 一个服务协议适配器。适配器只管"怎么组织请求与解码响应",
 * 排队、对齐、字幕与打断仍在编排器与 World 里。
 */
export interface TtsAdapter {
  /** 整段合成 */
  synth(text: string, signal?: AbortSignal): Promise<TtsPiece>;
  /** 增量合成;`delivery: buffered` 或格式不允许时缺席 */
  synthStream?(text: string, sink: TtsStreamSink, opts: TtsStreamOptions): Promise<TtsPiece>;
}
