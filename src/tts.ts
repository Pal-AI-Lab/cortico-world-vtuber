/**
 * TTS 兼容门面。旧的公共导出保持原样:`TtsClient`、`decodeWav`、`pcm16ToWav`、
 * 包络类都还能按原来的方式导入。新代码走 `./tts/registry.ts` 的服务解析器。
 *
 * `new TtsClient({ url })` 仍是纯 legacy 语义:只懂旧服务根、私有
 * `/audio/speech/stream` 与 VoxCPM 生成参数,且不在内部回退。它是同一份
 * `VoxcpmLegacyAdapter` 的薄包装,请求与解码逻辑只有一处实现。
 */
import type { TtsAdapter, TtsPiece, TtsStreamOptions, TtsStreamSink, TtsSynthProfile } from './tts/types.ts';
import { legacySnapshotFromUrl } from './tts/registry.ts';
import { VoxcpmLegacyAdapter } from './tts/voxcpm-legacy.ts';

export {
  Envelope,
  StreamingEnvelope,
  extractEnvelope,
  decodeWav,
  pcm16ToWav,
  ENVELOPE_HOP_MS,
} from './tts/audio.ts';
export type { EnvelopeLike, DecodedWav } from './tts/audio.ts';
export type {
  TtsAdapter,
  TtsCapabilities,
  TtsExecutionSnapshot,
  TtsPiece,
  TtsStreamOptions,
  TtsStreamSink,
  TtsSynthProfile,
} from './tts/types.ts';
export { deliverPieceIntoSink } from './tts/stream.ts';

/** 默认单片合成超时;VoxCPM2 本机 CUDA 合成短句通常秒级。 */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface TtsClientOptions {
  /** 旧语义:服务根;客户端在后面追加 `/v1/audio/speech`。 */
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 每次合成时取当前声线档案;undefined=裸调用 */
  profile?: () => TtsSynthProfile;
}

/**
 * 旧构造方式的兼容包装。新代码不要用它:注册表路径支持多服务、鉴权与格式选择,
 * 而这里只有一条写死为 VoxCPM2 的服务。
 */
export class TtsClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly root: string;
  private readonly profile?: () => TtsSynthProfile;

  constructor(opts: TtsClientOptions) {
    this.root = opts.url;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.profile = opts.profile;
  }

  private adapterFor(override?: TtsSynthProfile): TtsAdapter {
    return new VoxcpmLegacyAdapter(
      legacySnapshotFromUrl({
        root: this.root,
        timeoutMs: this.timeoutMs,
        profile: override ?? this.profile?.() ?? {},
        name: this.root,
      }),
      this.fetchImpl,
    );
  }

  /** override 给控制台试听用:按面板上的档案合成一次,不动当前生效的那份 */
  async synth(text: string, override?: TtsSynthProfile, signal?: AbortSignal): Promise<TtsPiece> {
    return this.adapterFor(override).synth(text, signal);
  }

  /**
   * 流式合成:私有 `/audio/speech/stream` 的 chunked wav,边收边把 PCM16 交给 sink。
   * 返回的 Promise 在收流后 resolve 成完整 TtsPiece。signal 中止 = 硬打断。
   */
  async synthStream(
    text: string,
    sink: TtsStreamSink,
    opts: { override?: TtsSynthProfile; signal?: AbortSignal; maxDurationMs?: number } = {},
  ): Promise<TtsPiece> {
    const adapter = this.adapterFor(opts.override);
    if (!adapter.synthStream) throw new Error('这个 TTS 客户端不支持流式合成');
    const streamOpts: TtsStreamOptions = {
      signal: opts.signal ?? new AbortController().signal,
      ...(opts.maxDurationMs !== undefined ? { maxDurationMs: opts.maxDurationMs } : {}),
      // 兼容入口不改变旧契约:回退由调用方决定,它自己不做
      fallback: false,
    };
    return adapter.synthStream(text, sink, streamOpts);
  }
}
