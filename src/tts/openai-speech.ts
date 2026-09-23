/**
 * 标准 OpenAI Speech 适配器:一个端点 `/audio/speech`,二进制音频响应。
 *
 * 请求字段由 buildSpeechBody 构造,厂商扩展经 extraBody 显式配置。
 *
 * 增量模式读取同一个端点的响应体;buffered 模式收齐再解码。
 * 当前只消费二进制响应,收到 SSE 时明确报错。
 */
import { decodeAudioBytes, decodeWav, decodedToWav, extractEnvelope, type PcmAudio } from './audio.ts';
import { findFfmpeg, transcodeAudioToWav } from '../audio-convert.ts';
import { TTS_TRANSCODE_BUDGET_MS } from './config.ts';
import { scanSilence } from '../silence-scan.ts';
import {
  consumeAudioStream,
  httpErrorOf,
  isAudioContentType,
  isEventStreamContentType,
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

/** 标准协议能边收边解码的格式;其余必须先收齐再交解码器。 */
const INCREMENTAL_FORMATS = new Set(['wav', 'pcm']);

export function isIncrementalFormat(snapshot: TtsExecutionSnapshot): boolean {
  return INCREMENTAL_FORMATS.has(snapshot.responseFormat);
}

/** 请求体。顺序固定,便于测试与人工核对。 */
export function buildSpeechBody(snapshot: TtsExecutionSnapshot, text: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: snapshot.model,
    input: text,
    voice: snapshot.voice,
    response_format: snapshot.responseFormat,
  };
  if (snapshot.speed !== undefined) body.speed = snapshot.speed;
  if (snapshot.instructions !== undefined && snapshot.instructions !== '') body.instructions = snapshot.instructions;
  if (snapshot.extraBody) Object.assign(body, snapshot.extraBody);
  return body;
}

export function buildSpeechHeaders(snapshot: TtsExecutionSnapshot): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (snapshot.authHeader) headers.Authorization = snapshot.authHeader;
  for (const [k, v] of Object.entries(snapshot.headers ?? {})) headers[k] = v;
  return headers;
}

/** 压缩格式的容器后缀,交给 ffmpeg 当输入提示;认不出时让它自己探。 */
const COMPRESSED_EXT: Record<string, string> = { mp3: 'mp3', opus: 'opus', aac: 'aac', flac: 'flac' };

/**
 * 响应字节 → 内部样本。WAV/PCM 本地解;压缩格式收齐后交本机 ffmpeg 转成 wav,
 * 缺 ffmpeg 就报格式依赖,而不是把压缩字节当 PCM 硬啃。保留源采样率。
 */
async function decodeResponse(bytes: Uint8Array, service: string, snapshot: TtsExecutionSnapshot, signal: AbortSignal): Promise<PcmAudio> {
  const format = snapshot.responseFormat;
  if (format === 'wav' || format === 'pcm') {
    return decodeAudioBytes(bytes, { responseFormat: format, ...(snapshot.pcm ? { pcm: snapshot.pcm } : {}) });
  }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    throw new Error(`TTS[${service}] 解码 ${format} 需要本机 ffmpeg;请改用 wav 或 pcm 输出。`);
  }
  const ext = COMPRESSED_EXT[format] ?? 'bin';
  // 转码预算与 HTTP 超时成套:两者相加仍留在面板 RPC 死线之内
  const wav = await transcodeAudioToWav(bytes, { ffmpeg, sourceExt: ext, signal, timeoutMs: TTS_TRANSCODE_BUDGET_MS });
  return decodeWav(wav);
}

/**
 * 错误正文只留截断摘要:第三方响应可能回显输入或密钥。
 * 状态、服务、阶段都带上,便于按服务定位。
 */
export class OpenAiSpeechAdapter implements TtsAdapter {
  constructor(
    private readonly snapshot: TtsExecutionSnapshot,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private requestInit(text: string, signal: AbortSignal): RequestInit {
    const headers = buildSpeechHeaders(this.snapshot);
    return {
      method: 'POST',
      headers,
      body: JSON.stringify(buildSpeechBody(this.snapshot, text)),
      signal,
      // 带凭据时不自动跟随重定向:换 origin 就等于把旧 Key 发给新站点
      redirect: this.snapshot.authHeader ? 'manual' : 'follow',
    };
  }

  private async post(text: string, signal: AbortSignal, phase: string): Promise<Response> {
    const res = await this.fetchImpl(this.snapshot.speechUrl, this.requestInit(text, signal));
    if (!res.ok) throw await httpErrorOf(this.snapshot.name, phase, res);
    return res;
  }

  async synth(text: string, signal?: AbortSignal): Promise<TtsPiece> {
    const linked = linkedSignal(signal, this.snapshot.timeoutMs);
    const res = await this.post(text, linked, '合成');
    if (isEventStreamContentType(res.headers.get('content-type'))) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`TTS[${this.snapshot.name}] 服务返回 SSE 音频事件,本版本未实现该传输格式,请改用二进制 audio 响应。`);
    }
    if (!isAudioContentType(res.headers.get('content-type'))) {
      await res.body?.cancel().catch(() => {});
      throw await httpErrorOf(this.snapshot.name, '合成响应', res);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let decoded: PcmAudio;
    try {
      decoded = await decodeResponse(bytes, this.snapshot.name, this.snapshot, linked);
    } catch (err) {
      throw new Error(`TTS[${this.snapshot.name}] 解码失败:${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      text,
      qualityPolicy: 'generic',
      wav: decodedToWav(decoded),
      durationMs: decoded.durationMs,
      envelope: extractEnvelope(decoded),
      silence: scanSilence(decoded.samples, decoded.sampleRate),
    };
  }

  async synthStream(text: string, sink: TtsStreamSink, opts: TtsStreamOptions): Promise<TtsPiece> {
    if (!isIncrementalFormat(this.snapshot)) {
      throw new Error(`TTS[${this.snapshot.name}] 输出格式 ${this.snapshot.responseFormat} 只能缓冲解码,不能增量消费。`);
    }
    const signal = linkedSignal(opts.signal, this.snapshot.timeoutMs);
    const res = await this.post(text, signal, '流式合成');
    if (isEventStreamContentType(res.headers.get('content-type'))) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`TTS[${this.snapshot.name}] 服务返回 SSE 音频事件,本版本未实现该传输格式,请改用二进制 audio 响应。`);
    }
    if (!res.body) throw new Error(`TTS[${this.snapshot.name}] 合成响应没有响应体。`);
    if (!isAudioContentType(res.headers.get('content-type'))) {
      await res.body.cancel().catch(() => {});
      throw await httpErrorOf(this.snapshot.name, '流式合成响应', res);
    }
    const result = await consumeAudioStream(res.body, {
      format: this.snapshot.responseFormat === 'pcm' ? 'pcm' : 'wav',
      ...(this.snapshot.pcm ? { pcm: this.snapshot.pcm } : {}),
      sink,
      signal,
    });
    return { ...pieceFromStream(text, result), qualityPolicy: 'generic' };
  }
}
