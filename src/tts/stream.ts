/**
 * 增量消费一次合成响应体:一个端点、一条读流循环,两种协议共用。
 *
 * 标准 Speech 与 legacy 私有流式的差别只在请求怎么发;响应一旦到手,二进制音频
 * 的处理是同一件事:按 RIFF/WAVE 或 raw PCM 描述拆出 PCM16LE 单声道,边收边喂
 * 给 sink 的增量包络与静默扫描,并在掐流判据命中时取消未读网络流。
 *
 * 已向下游交付过 PCM 之后断流,不允许整句自动重发——调用方按 `deliveredPcm`
 * 区分"收到过字节"与"真的播出过声音"。
 */
import type { SilenceReport } from '../silence-scan.ts';
import { SilenceScanner } from '../silence-scan.ts';
import {
  IncrementalWavParser,
  StreamingEnvelope,
  decodeWav,
  decodedToPcm16,
  pcm16ToWav,
} from './audio.ts';
import type { TtsPcmConfig } from './config.ts';
import type { TtsPiece, TtsStreamSink } from './types.ts';

/** 一次收流的事实。`deliveredPcm` 是"已经交给下游"的唯一判据。 */export interface PcmStreamResult {
  sampleRate: number;
  pieces: Uint8Array[];
  bytes: number;
  envelope: StreamingEnvelope;
  silence: SilenceReport | undefined;
  truncated: boolean;
  deliveredPcm: boolean;
}

export interface ConsumeStreamOptions {
  /** 响应体的格式描述;raw PCM 必须带 `pcm` 描述 */
  format: 'wav' | 'pcm';
  pcm?: TtsPcmConfig;
  sink?: TtsStreamSink;
  signal: AbortSignal;
  /** 跑飞止损预算;超出即掐流保留已收部分 */
  maxDurationMs?: number;
  /** VoxCPM 的长静默截流策略,由适配器显式启用。 */
  stopOnSilence?: boolean;
  /** 收流开始时通知采样率(面板/编排器要在线路之外也知道) */
  onSampleRate?: (sampleRate: number) => void;
}

/** 响应体首字节到达前的等待;卡住的连接不该拖满整个合成超时 */
export const FIRST_BYTE_TIMEOUT_MS = 15_000;
/** 收到首字节后允许的空闲时长 */
export const IDLE_TIMEOUT_MS = 30_000;
/** 一次合成允许的响应体上限;超长音频不是正常台本 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * HTTP 层失败。带上服务、阶段与状态码,让调用方能区分"这条路由没有"(404/405,
 * 可以回退)与参数错误、鉴权、限流、服务故障(不能当成"不支持流式")。
 * 正文只留截断摘要:第三方响应可能回显输入或密钥。
 */
export class TtsHttpError extends Error {
  constructor(
    readonly service: string,
    readonly phase: string,
    readonly status: number,
    readonly summary: string,
  ) {
    super(`TTS[${service}] ${phase} HTTP ${status}${summary ? `:${summary}` : ''}`);
    this.name = 'TtsHttpError';
  }
}

/** 由响应构造错误;顺带消费掉响应体,避免连接悬着。 */
export async function httpErrorOf(service: string, phase: string, res: Response): Promise<TtsHttpError> {
  const detail = await res.text().catch(() => '');
  return new TtsHttpError(service, phase, res.status, detail.replace(/\s+/g, ' ').trim().slice(0, 200));
}

/** 路由不存在:只有这一种才允许 legacy 回退整段合成。 */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof TtsHttpError && (err.status === 404 || err.status === 405 || err.status === 501);
}

export function isAudioContentType(contentType: string | null): boolean {  if (!contentType) return true; // 不声明就按二进制试;真正的判据是能不能解析出音频
  const value = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return value.startsWith('audio/') || value === 'application/octet-stream' || value === 'binary/octet-stream';
}

export function isEventStreamContentType(contentType: string | null): boolean {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
}

/**
 * 合并调用方的取消信号与单片超时。任一触发都中止 fetch 与读流;
 * 超时定时器由 AbortSignal.timeout 自己持有,不额外维护。
 */
export function linkedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 原始 Int16LE 单声道字节 → float 样本(包络与静默扫描吃它) */
export function int16ToFloats(chunk: Uint8Array): Float32Array {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const out = new Float32Array(chunk.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(2 * i, true) / 32768;
  return out;
}

/** 立体声 Int16LE → 单声道 Int16LE(均值);单声道原样返回。 */
function toMonoInt16(chunk: Uint8Array, channels: 1 | 2): Uint8Array {
  if (channels === 1) return chunk;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const frames = Math.floor(chunk.length / 4);
  const out = new Uint8Array(frames * 2);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    const l = view.getInt16(4 * i, true);
    const r = view.getInt16(4 * i + 2, true);
    outView.setInt16(2 * i, Math.round((l + r) / 2), true);
  }
  return out;
}

/**
 * 读一块,超时或取消即失败。
 *
 * 卡住的连接不该靠整个合成超时兜底:首字节与后续空闲各有各的预算。取消必须
 * 当场结束等待——真实的 fetch 会因 signal 中止而让 read() 失败,但换一个
 * 不理会 signal 的响应体实现时,只等 read() 就会一直挂到空闲超时,用户按了
 * 打断却还在等。两条路都竞速,超时/取消后由外层取消未读流。
 */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  budgetMs: number,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${Math.round(budgetMs / 1000)}s 内没有等到音频数据`)), budgetMs);
    timer.unref?.();
  });
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 收一条响应体。
 *
 * 掐流有两道判据,先后有别:超大静默段说得出掐在哪,先判;时长宽容界是兜底。
 * 两条都以取消未读网络流收场——对服务是正常收场,已收部分照常交回。
 */
export async function consumeAudioStream(
  body: ReadableStream<Uint8Array>,
  opts: ConsumeStreamOptions,
): Promise<PcmStreamResult> {
  const reader = body.getReader();
  const wavParser = opts.format === 'wav' ? new IncrementalWavParser() : null;
  const pcmChannels: 1 | 2 = opts.pcm?.channels ?? 1;
  if (opts.format === 'pcm' && !opts.pcm) {
    reader.releaseLock();
    throw new Error('输出格式为 pcm 时必须给出采样率与声道数');
  }
  let sampleRate = opts.format === 'pcm' ? (opts.pcm?.sampleRate ?? 0) : 0;
  let channels = pcmChannels;
  /*
   * 包络与静默扫描在拿到采样率那一刻才建,而那一刻发生在读流循环里的
   * `startAt()` 内部。放进可变对象是为了让循环里的读取看到闭包的赋值——
   * 普通的 `let` 会被控制流分析缩成 `null`,`?.check()` 就成了访问 never。
   */
  const live: { envelope: StreamingEnvelope | null; silence: SilenceScanner | null } = {
    envelope: null,
    silence: null,
  };
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  let deliveredPcm = false;
  /** raw PCM 的不足一帧残字节:一次合成内必须与后续 chunk 拼接 */
  let frameCarry: Uint8Array | null = null;

  const startAt = (rate: number, ch: number): void => {
    if (live.envelope) return;
    sampleRate = rate;
    channels = ch === 2 ? 2 : 1;
    if (!(sampleRate > 0)) throw new Error('音频流没有可用的采样率');
    live.envelope = new StreamingEnvelope(sampleRate);
    live.silence = new SilenceScanner(sampleRate);
    opts.onSampleRate?.(sampleRate);
    opts.sink?.begin?.({ sampleRate, envelope: live.envelope });
  };

  const emit = (pcm: Uint8Array): void => {
    if (pcm.length === 0) return;
    const envelope = live.envelope;
    if (!envelope) throw new Error('音频流没有可用的采样率');
    const chunk = pcm.slice();
    pieces.push(chunk);
    bytes += chunk.length;
    const floats = int16ToFloats(chunk);
    envelope.append(floats);
    live.silence?.append(floats);
    opts.sink?.pcm(chunk);
    deliveredPcm = true;
  };

  try {
    for (;;) {
      const { done, value } = await readWithTimeout(
        reader,
        bytes > 0 || live.envelope ? IDLE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS,
        opts.signal,
      );
      if (done) break;
      if (opts.signal.aborted) throw opts.signal.reason;
      const chunk = value as Uint8Array;
      if (bytes + chunk.length > MAX_RESPONSE_BYTES) {
        throw new Error(`合成响应超过 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB 上限,已中止`);
      }
      if (wavParser) {
        const pcm = wavParser.push(chunk);
        if (!wavParser.format) continue;
        startAt(wavParser.sampleRate, wavParser.format.channels);
        emit(pcm);
      } else {
        startAt(sampleRate, pcmChannels);
        let buf = chunk;
        const frameBytes = channels * 2;
        if (frameCarry) {
          const merged = new Uint8Array(frameCarry.length + buf.length);
          merged.set(frameCarry);
          merged.set(buf, frameCarry.length);
          buf = merged;
          frameCarry = null;
        }
        const remainder = buf.length % frameBytes;
        if (remainder !== 0) {
          // 残留可能是半个样本或半个帧;同一片内拼回去,绝不跨合成污染
          frameCarry = buf.slice(buf.length - remainder);
          buf = buf.subarray(0, buf.length - remainder);
        }
        emit(toMonoInt16(buf, channels));
      }
      // 掐流判据一:超大静默段(说得清掐在哪)
      const sil = opts.stopOnSilence ? live.silence?.check() : null;
      if (sil) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      // 掐流判据二:时长宽容界(兜底)
      if (opts.maxDurationMs !== undefined && sampleRate > 0 && (bytes / 2 / sampleRate) * 1000 >= opts.maxDurationMs) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (err) {
    // 解析器或 sink 抛错时也要取消未读网络流,只 releaseLock 会留着连接与解码
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (wavParser) wavParser.finish();
  const envelope = live.envelope;
  if (!envelope || bytes === 0) throw new Error('合成没有产出音频');
  envelope.finish();
  live.silence?.finish();
  return {
    sampleRate,
    pieces,
    bytes,
    envelope,
    silence: live.silence?.report(),
    truncated,
    deliveredPcm,
  };
}

/** 收流结果 → TtsPiece(wav 用真实长度重组,供对齐与非流式回退使用)。 */
export function pieceFromStream(text: string, result: PcmStreamResult): TtsPiece {
  const wav = pcm16ToWav(result.pieces, result.sampleRate);
  return {
    text,
    wav,
    durationMs: (result.bytes / 2 / result.sampleRate) * 1000,
    envelope: result.envelope,
    ...(result.silence ? { silence: result.silence } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
}

/**
 * 已经整段拿到的音频交给流式 sink:解码后按真实样本重推一遍。
 * 走这条路的片不是"边合成边播",而是合成完成后按整块交付;不假设 44 字节头,
 * 也不假设 raw PCM 是 24 kHz。
 */
export function deliverPieceIntoSink(piece: TtsPiece, sink: TtsStreamSink): void {
  const decoded = decodeWav(piece.wav);
  const envelope = new StreamingEnvelope(decoded.sampleRate);
  envelope.append(decoded.samples);
  envelope.finish();
  sink.begin?.({ sampleRate: decoded.sampleRate, envelope });
  const bytes = decodedToPcm16(decoded);
  // 分块交付,与流式路的粒度一致;声卡的时间线按样本推进,与块大小无关
  const BLOCK = 8192;
  for (let at = 0; at < bytes.length; at += BLOCK) sink.pcm(bytes.subarray(at, Math.min(at + BLOCK, bytes.length)));
}
