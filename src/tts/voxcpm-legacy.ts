/**
 * 旧 VoxCPM2 / llama-tts-server 适配器。请求形状、默认 model/voice、参考音频克隆
 * 与私有 `/audio/speech/stream` 全部保持原样:不要求用户升级原 TTS 服务来迁就
 * 这次的客户端改造。
 *
 * 与标准适配器的差别只有三处:请求体带 llama-tts-server 的生成参数与
 * reference_audio;低延迟走私有 `/audio/speech/stream`;私有路由不存在时最多
 * 回退一次非流式。鉴权、参数错误、限流与服务故障不属于"不支持流式",不回退。
 */
import { decodeAudioBytes, decodedToWav, extractEnvelope } from './audio.ts';
import { scanSilence } from '../silence-scan.ts';
import {
  consumeAudioStream,
  deliverPieceIntoSink,
  httpErrorOf,
  isAudioContentType,
  isEventStreamContentType,
  isMissingRoute,
  linkedSignal,
  pieceFromStream,
} from './stream.ts';
import type {
  TtsAdapter,
  TtsExecutionSnapshot,
  TtsPiece,
  TtsStreamOptions,
  TtsStreamSink,
} from './types.ts';

/** 请求体。字段顺序与原实现一致,便于对照旧行为。 */
export function buildLegacyBody(snapshot: TtsExecutionSnapshot, text: string): Record<string, unknown> {
  const p = snapshot.profile ?? {};
  const body: Record<string, unknown> = {
    model: snapshot.model,
    input: text,
    voice: typeof snapshot.voice === 'string' ? snapshot.voice : snapshot.voice.id,
    response_format: 'wav',
  };
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.cfgValue !== undefined) body.cfg_value = p.cfgValue;
  if (p.inferenceTimesteps !== undefined) body.inference_timesteps = p.inferenceTimesteps;
  if (p.maxSteps !== undefined) body.max_steps = p.maxSteps;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.referenceAudioB64) {
    body.reference_audio = p.referenceAudioB64;
    if (p.refText) body.prompt_text = p.refText;
  }
  return body;
}

export function buildLegacyHeaders(snapshot: TtsExecutionSnapshot): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (snapshot.authHeader) headers.Authorization = snapshot.authHeader;
  for (const [k, v] of Object.entries(snapshot.headers ?? {})) headers[k] = v;
  return headers;
}

export class VoxcpmLegacyAdapter implements TtsAdapter {
  constructor(
    private readonly snapshot: TtsExecutionSnapshot,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private init(text: string, signal: AbortSignal): RequestInit {
    return {
      method: 'POST',
      headers: buildLegacyHeaders(this.snapshot),
      body: JSON.stringify(buildLegacyBody(this.snapshot, text)),
      signal,
      redirect: this.snapshot.authHeader ? 'manual' : 'follow',
    };
  }

  async synth(text: string, signal?: AbortSignal): Promise<TtsPiece> {
    const res = await this.fetchImpl(
      this.snapshot.speechUrl,
      this.init(text, linkedSignal(signal, this.snapshot.timeoutMs)),
    );
    if (!res.ok) throw await httpErrorOf(this.snapshot.name, '合成', res);
    if (isEventStreamContentType(res.headers.get('content-type'))) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`TTS[${this.snapshot.name}] 服务返回 SSE 音频事件,本版本未实现该传输格式。`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let decoded;
    try {
      decoded = decodeAudioBytes(bytes, { responseFormat: 'wav' });
    } catch (err) {
      throw new Error(`TTS[${this.snapshot.name}] 解码失败:${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      text,
      wav: decodedToWav(decoded),
      durationMs: decoded.durationMs,
      envelope: extractEnvelope(decoded),
      silence: scanSilence(decoded.samples, decoded.sampleRate),
    };
  }

  /**
   * 私有流式;失败时只在"路由不存在且还没有向下游交付过 PCM"两个条件同时成立时
   * 回退一次非流式。已经出过声就不整句重发——那会重复播放前缀并可能多收费。
   */
  async synthStream(text: string, sink: TtsStreamSink, opts: TtsStreamOptions): Promise<TtsPiece> {
    const signal = linkedSignal(opts.signal, this.snapshot.timeoutMs);
    let delivered = false;
    const watched: TtsStreamSink = {
      begin: (info) => sink.begin?.(info),
      pcm: (chunk) => {
        delivered = true;
        sink.pcm(chunk);
      },
    };
    const streamUrl = this.snapshot.legacyStreamUrl ?? `${this.snapshot.speechUrl}/stream`;
    try {
      const res = await this.fetchImpl(streamUrl, this.init(text, signal));
      if (!res.ok) throw await httpErrorOf(this.snapshot.name, '流式合成', res);
      if (isEventStreamContentType(res.headers.get('content-type'))) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`TTS[${this.snapshot.name}] 私有流式端点返回 SSE,不是二进制音频。`);
      }
      if (!res.body) throw new Error(`TTS[${this.snapshot.name}] 流式合成响应没有响应体。`);
      if (!isAudioContentType(res.headers.get('content-type'))) {
        await res.body.cancel().catch(() => {});
        throw await httpErrorOf(this.snapshot.name, '流式合成响应', res);
      }
      const result = await consumeAudioStream(res.body, {
        format: 'wav',
        sink: watched,
        signal,
        ...(opts.maxDurationMs !== undefined ? { maxDurationMs: opts.maxDurationMs } : {}),
      });
      return pieceFromStream(text, result);
    } catch (err) {
      if (signal.aborted) throw err;
      if (!opts.fallback || delivered || !isMissingRoute(err)) throw err;
      const piece = await this.synth(text, signal);
      deliverPieceIntoSink(piece, sink);
      return piece;
    }
  }
}
