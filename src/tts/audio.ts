/**
 * 音频解码与归一化原语:wav 解析(整段与增量)、包络提取、PCM 与 wav 的互转。
 *
 * 这里不碰网络,也不起子进程:服务端给的字节怎么变成单声道样本是这一层的事,
 * `src/tts.ts` 把名字原样再导出,旧的导入面不变。
 */

import type { TtsPcmConfig, TtsResponseFormat } from './config.ts';

/** 整段包络与流式增量包络共用的只读接口。 */
export interface EnvelopeLike {
  readonly hopMs: number;
  at(ms: number): number;
}

/** 逐 hop 的响度包络,值域 [0,1] */
export class Envelope {
  constructor(
    private readonly values: Float32Array,
    readonly hopMs: number,
  ) {}

  at(ms: number): number {
    if (this.values.length === 0) return 0;
    const idx = ms / this.hopMs;
    if (idx <= 0) return this.values[0];
    const hi = Math.ceil(idx);
    if (hi >= this.values.length) return 0;
    const lo = Math.floor(idx);
    const frac = idx - lo;
    return this.values[lo] * (1 - frac) + this.values[hi] * frac;
  }
}

/** 解码后的单声道样本(与容器无关的那部分) */
export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

export interface DecodedWav extends PcmAudio {
  /** 源文件的编码事实:要不要规范成 PCM16 再发由它决定(服务端只按 16bit 读) */
  format: number;
  bitsPerSample: number;
  channels: number;
  /** 容器是 WAVE_FORMAT_EXTENSIBLE:子格式即便写着 PCM16,服务端也只认 0x0001 那种老容器 */
  extensible: boolean;
}

/** RIFF/WAVE 解析:PCM16 / PCM24 / PCM32f,多声道并为单声道;EXTENSIBLE 容器按它的子格式走 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error('不是 RIFF/WAVE 数据');
  }
  let offset = 12;
  let format = 0;
  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let extensible = false;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = view.getUint32(offset, false);
    const chunkLen = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 0x666d7420) {
      // 'fmt '
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE:真正的编码在 cbSize 之后的 SubFormat GUID 头两个字节
      // (ffmpeg 写 24bit 或三声道以上时会给这个容器;扩展块不完整就按原样落到"不支持")
      if (format === 0xfffe && chunkLen >= 40) {
        extensible = true;
        format = view.getUint16(body + 24, true);
      }
    } else if (chunkId === 0x64617461) {
      // 'data'
      dataStart = body;
      dataLen = Math.min(chunkLen, bytes.length - body);
      break;
    }
    offset = body + chunkLen + (chunkLen % 2);
  }
  if (dataStart < 0 || sampleRate === 0) throw new Error('wav 缺 fmt/data 块');
  let frames: number;
  let read: (frame: number, ch: number) => number;
  if (format === 1 && bitsPerSample === 16) {
    frames = Math.floor(dataLen / 2 / channels);
    read = (f, c) => view.getInt16(dataStart + (f * channels + c) * 2, true) / 32768;
  } else if (format === 1 && bitsPerSample === 24) {
    frames = Math.floor(dataLen / 3 / channels);
    read = (f, c) => {
      const at = dataStart + (f * channels + c) * 3;
      // 高字节按有符号读,负数自然带出符号位
      return (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608;
    };
  } else if (format === 3 && bitsPerSample === 32) {
    frames = Math.floor(dataLen / 4 / channels);
    read = (f, c) => view.getFloat32(dataStart + (f * channels + c) * 4, true);
  } else {
    throw new Error(`不支持的 wav 格式: format=${format} bits=${bitsPerSample}`);
  }
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += read(f, c);
    samples[f] = acc / channels;
  }
  return { samples, sampleRate, durationMs: (frames / sampleRate) * 1000, format, bitsPerSample, channels, extensible };
}

/** RIFF 头与各块头里的长度字段;`data` 长度在流式响应里可能是占位值,所以可空。 */
export interface WavFormat {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** `data` 块体在流里起的字节位置(块头之后) */
  dataOffset: number;
  /** 声明长度;0 与 0xFFFFFFFF 是流式占位值,记 null */
  dataLength: number | null;
}

/** 还没读到 `fmt ` 时的占位元信息:只有 RIFF 头之后的偏移是已知的。 */
const UNKNOWN_FORMAT: WavFormat = {
  format: 0,
  channels: 0,
  sampleRate: 0,
  bitsPerSample: 0,
  blockAlign: 0,
  dataOffset: 12,
  dataLength: null,
};

/** 占位长度不能当长度用:流式服务器在头里先写 0 或 0xFFFFFFFF。 */
function isPlaceholderLength(len: number): boolean {
  return len === 0 || len === 0xffffffff;
}

/**
 * 四字节标签按小端当无符号整数读出来的值(块头长度字段是小端,标签在同一次
 * 读取里也随之反向)。写成字面量极易把字节序写反,这里一律由标签算出。
 */
function leTag(tag: string): number {
  let v = 0;
  for (let i = 0; i < 4; i++) v |= tag.charCodeAt(i) << (i * 8);
  return v >>> 0;
}

const RIFF_TAG = leTag('RIFF');
const WAVE_TAG = leTag('WAVE');
const FMT_TAG = leTag('fmt ');
const DATA_TAG = leTag('data');

/**
 * RIFF/WAVE 字节流的增量解析器:头、块头、单个样本都可能被网络切成两半。
 *
 * 每个 `push()` 交回这一段新解出的 PCM,一律是文件真实采样率下的单声道 PCM16LE;
 * 多声道取平均,浮点先钳到 [-1,1]。解码在 `data` 块里原地推进,只用已收到的字节
 * 作依据,所以声明长度是占位值也不影响。
 */
export class IncrementalWavParser {
  /** 收到但还没解析的字节;交回的分片是新数组,缓冲可以原地复用 */
  private buf = new Uint8Array(0);
  private state: 'riff' | 'chunks' | 'convert' | 'skip' | 'done' = 'riff';
  /** 缓冲里下一个待解析字节的下标;RIFF 头验过之后才有意义 */
  private pos = 0;
  private fmt: WavFormat = UNKNOWN_FORMAT;
  /** `data` 块声明的长度;null = 按流尾为止 */
  private declaredData: number | null = null;
  /** 还欠多少字节才轮到下一个块头(块体 + padding) */
  private skip = 0;
  /** 一个样本(所有声道)的字节数,进 convert 时定下 */
  private frameBytes = 0;
  /** `data` 块已解出的字节数,和声明长度同口径 */
  private dataBytes = 0;
  /** 已解出的单声道样本数 */
  private frames = 0;
  private trailing = 0;
  /** `data` 声明长度的部分已收满;此后的字节是尾部元信息 */
  private ended = false;

  push(chunk: Uint8Array): Uint8Array {
    if (chunk.length > 0) {
      if (this.buf.length === 0) {
        // 缓冲每次都是新数组:交回的分片与后续写入不共享底层存储
        this.buf = chunk.slice();
      } else {
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf);
        merged.set(chunk, this.buf.length);
        this.buf = merged;
      }
    }
    /*
     * 输出按本次实际解出的帧攒:转成 convert 可能就发生在这一次 push 里,所以不能
     * 按入口状态预分配一块固定大小的缓冲。
     */
    const parts: Uint8Array[] = [];
    let produced = 0;
    for (;;) {
      if (this.state === 'riff') {
        // 缓冲尚未消费过:第 0 字节就是流的起点
        if (this.buf.length < 12) break;
        if (this.u32(0) !== RIFF_TAG || this.u32(8) !== WAVE_TAG) {
          throw new Error('不是 RIFF/WAVE 数据');
        }
        this.pos = 12;
        this.state = 'chunks';
        continue;
      }
      if (this.state === 'chunks') {
        if (this.buf.length - this.pos < 8) break;
        const id = this.u32(this.pos);
        const declared = this.u32(this.pos + 4);
        if (id === FMT_TAG) {
          // 'fmt ':16 字节块体才够读到 bitsPerSample
          if (this.buf.length - this.pos - 8 < 16) break;
          const body = this.pos + 8;
          this.fmt = {
            format: this.u16(body),
            channels: this.u16(body + 2),
            sampleRate: this.u32(body + 4),
            bitsPerSample: this.u16(body + 14),
            blockAlign: this.u16(body + 12),
            dataOffset: body + declared + (declared % 2),
            dataLength: null,
          };
          /*
           * fmt 的扩展字节(cbSize、extensible 的子格式等)与块尾 padding 可能在下一块
           * HTTP 数据里,不能用声明长度直接跳过去。先吃掉已经读到的 16 字节主体,余下
           * 的交给现有的 skip 状态跨块消费;`end` 用声明长度算,声明值小于 16 的畸形块
           * 也不会被推过头。
           */
          const end = body + declared + (declared % 2);
          this.pos = Math.min(body + 16, end);
          this.skip = Math.max(0, end - this.pos);
          this.state = this.skip > 0 ? 'skip' : 'chunks';
          continue;
        }
        if (id === DATA_TAG) {
          // 'data'
          if (this.fmt.sampleRate === 0) throw new Error('wav 缺 fmt/data 块');
          if (this.fmt.channels < 1) {
            throw new Error(`不支持的 wav 格式: format=${this.fmt.format} bits=${this.fmt.bitsPerSample}`);
          }
          this.fmt = { ...this.fmt, dataOffset: this.pos + 8, dataLength: isPlaceholderLength(declared) ? null : declared };
          this.declaredData = this.fmt.dataLength;
          this.startConvert();
          this.pos += 8;
          this.state = 'convert';
          continue;
        }
        // 其余块(LIST/fact/…):块体整段跳过
        this.skip = declared + (declared % 2);
        this.pos += 8;
        this.state = 'skip';
        continue;
      }
      if (this.state === 'convert') {
        const avail = this.buf.length - this.pos;
        if (avail === 0) break;
        // 两处口径都是字节:声明长度是字节数,不能拿帧数去比
        const want = this.declaredData === null ? avail : Math.min(avail, this.declaredData - this.dataBytes);
        if (want <= 0) {
          this.ended = true;
          this.state = 'done';
          break;
        }
        const got = this.convert(this.pos, want);
        // 不足一帧就等下一个 chunk:字节留在缓冲里,下一轮接着切
        if (got === null) break;
        this.pos += (got.length / 2) * this.frameBytes;
        this.dataBytes += (got.length / 2) * this.frameBytes;
        this.frames += got.length / 2;
        parts.push(got);
        produced += got.length;
        if (this.declaredData !== null && this.dataBytes >= this.declaredData) {
          this.ended = true;
          this.state = 'done';
        }
        continue;
      }
      if (this.state === 'skip') {
        const take = Math.min(this.skip, this.buf.length - this.pos);
        if (take <= 0) break;
        this.pos += take;
        this.skip -= take;
        if (this.skip === 0) this.state = 'chunks';
        continue;
      }
      // done:此后的字节一律不碰
      break;
    }
    /*
     * 消费掉的字节从缓冲里丢掉。还没验过 RIFF 头时一个字节都不能丢:这时的 `pos`
     * 只是 0,而成帧的表头长度还没被确认过——早先按固定 12 丢会在"头分几块到"
     * 的情形下把流的前 12 字节吃掉,后面全部错位。
     */
    const consumed = this.state === 'riff' ? 0 : this.state === 'done' ? this.buf.length : this.pos;
    if (consumed > 0) {
      this.buf = this.buf.subarray(consumed);
      this.pos = 0;
    }
    if (parts.length === 0) return new Uint8Array(0);
    if (parts.length === 1) return parts[0]!;
    const merged = new Uint8Array(produced);
    let at = 0;
    for (const part of parts) {
      merged.set(part, at);
      at += part.length;
    }
    return merged;
  }

  get format(): WavFormat | null {
    return this.fmt.sampleRate > 0 ? this.fmt : null;
  }

  get sampleRate(): number {
    return this.fmt.sampleRate;
  }

  /** 已解出的单声道样本数 */
  get frameCount(): number {
    return this.frames;
  }

  /** `data` 声明长度已收满;后续字节不再当 PCM */
  get done(): boolean {
    return this.ended;
  }

  /** `data` 块还欠多少字节;null = 按流尾为止 */
  get dataLength(): number | null {
    return this.declaredData;
  }

  /**
   * 收流结尾:不足一帧的残留丢掉并记下字节数,半个样本不成帧。
   * 声明了长度却还欠着就是服务端少发了,长度不符由调用方判断,这里只报事实。
   */
  finish(): void {
    this.trailing = this.state === 'convert' ? this.buf.length - this.pos : 0;
    this.ended = true;
    this.state = 'done';
    this.buf = new Uint8Array(0);
    this.pos = 0;
    this.skip = 0;
  }

  /** 尾部不足一帧的字节数;`finish()` 之后才有意义 */
  get trailingPartialBytes(): number {
    return this.trailing;
  }

  /** 进 convert 前先验格式并定下一个样本的字节数 */
  private startConvert(): void {
    const { format, bitsPerSample, channels } = this.fmt;
    if (format === 1) {
      if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
        throw new Error(`不支持的 wav 格式: format=${format} bits=${bitsPerSample}`);
      }
    } else if (format === 3) {
      if (bitsPerSample !== 32 && bitsPerSample !== 64) {
        throw new Error(`不支持的 wav 格式: format=${format} bits=${bitsPerSample}`);
      }
    } else {
      // 0xFFFE(WAVE_FORMAT_EXTENSIBLE)与其余格式码都走这里
      throw new Error(`不支持的 wav 格式: format=${format} bits=${bitsPerSample}`);
    }
    this.frameBytes = (bitsPerSample / 8) * channels;
  }

  /**
   * 把 [from, from+len) 里完整的帧解成单声道 PCM16LE;返回新数组(与缓冲不共享
   * 底层存储,后续 push 改不到它)。不足一帧返回 null,字节留给下一个 chunk。
   */
  private convert(from: number, len: number): Uint8Array | null {
    const { format, bitsPerSample, channels } = this.fmt;
    const bytes = bitsPerSample / 8;
    const frames = Math.floor(len / this.frameBytes);
    if (frames === 0) return null;
    const out = new Uint8Array(frames * 2);
    let read: (at: number) => number;
    if (format === 1) {
      if (bitsPerSample === 8) read = (at) => (this.byte(at) - 128) / 128;
      else if (bitsPerSample === 16) read = (at) => this.i16(at) / 32768;
      // 24 位无符号拼接后手动符号扩展:bit 23 是符号位
      else if (bitsPerSample === 24) read = (at) => this.i24(at) / 8388608;
      else read = (at) => this.i32(at) / 2147483648;
    } else if (bitsPerSample === 32) {
      read = (at) => this.clampUnit(this.f32(at));
    } else {
      read = (at) => this.clampUnit(this.f64(at));
    }
    for (let f = 0; f < frames; f++) {
      const frameAt = from + f * this.frameBytes;
      let acc = 0;
      for (let c = 0; c < channels; c++) acc += read(frameAt + c * bytes);
      const v = Math.max(-32768, Math.min(32767, Math.round((acc / channels) * 32768)));
      const at = f * 2;
      out[at] = v & 0xff;
      out[at + 1] = (v >> 8) & 0xff;
    }
    return out;
  }

  private clampUnit(v: number): number {
    // NaN 也走 -1:比较对 NaN 全假,不会漏出去
    return Number.isNaN(v) ? 0 : Math.max(-1, Math.min(1, v));
  }

  /**
   * 以下读取都由调用方先保证长度够;万一越界一律当 0,不把 DataView 的范围错漏出去。
   */
  private byte(at: number): number {
    return at < this.buf.length ? this.buf[at] : 0;
  }

  private u16(at: number): number {
    return this.byte(at) | (this.byte(at + 1) << 8);
  }

  private u32(at: number): number {
    return (this.u16(at) | (this.u16(at + 2) << 16)) >>> 0;
  }

  private i16(at: number): number {
    const v = this.u16(at);
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  private i24(at: number): number {
    const v = this.byte(at) | (this.byte(at + 1) << 8) | (this.byte(at + 2) << 16);
    return v >= 0x800000 ? v - 0x1000000 : v;
  }

  private i32(at: number): number {
    const v = this.u32(at);
    return v >= 0x80000000 ? v - 0x100000000 : v;
  }

  private f32(at: number): number {
    return at + 4 <= this.buf.length ? new DataView(this.buf.buffer, this.buf.byteOffset + at, 4).getFloat32(0, true) : 0;
  }

  private f64(at: number): number {
    return at + 8 <= this.buf.length ? new DataView(this.buf.buffer, this.buf.byteOffset + at, 8).getFloat64(0, true) : 0;
  }
}

/** 原始 PCM16LE 字节 → 样本;多声道取平均,末尾半个样本丢掉 */
export function decodePcm16ToDecoded(pcm: Uint8Array, sampleRate: number, channels: 1 | 2): PcmAudio {
  const frames = Math.floor(pcm.length / 2 / channels);
  const samples = new Float32Array(frames);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += view.getInt16((f * channels + c) * 2, true) / 32768;
    samples[f] = acc / channels;
  }
  return { samples, sampleRate, durationMs: (frames / sampleRate) * 1000 };
}

export interface DecodeAudioOptions {
  responseFormat: TtsResponseFormat;
  pcm?: TtsPcmConfig;
}

/**
 * 整段响应字节 → 样本,按配置的输出格式分派。
 *
 * mp3/opus/aac/flac 要有本机 ffmpeg 才解得开,这一层不起子进程:报错说清是缺
 * ffmpeg,不是数据坏了,由调用方决定接不接转码。
 */
export function decodeAudioBytes(bytes: Uint8Array, opts: DecodeAudioOptions): PcmAudio {
  switch (opts.responseFormat) {
    case 'wav':
      return decodeWav(bytes);
    case 'pcm': {
      const pcm = opts.pcm;
      if (!pcm) throw new Error('输出格式为 pcm 时必须给出采样率与声道数');
      return decodePcm16ToDecoded(bytes, pcm.sampleRate, pcm.channels);
    }
    default:
      throw new Error(`解码 ${opts.responseFormat} 需要本机 ffmpeg;请改用 wav 或 pcm 输出`);
  }
}

/** 浮点样本 → 单声道 PCM16 wav:声线库的规范形,与 ffmpeg 转码产物同规格(采样率沿用源文件,服务端自己重采样) */
export function samplesToPcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return pcm16ToWav([pcm], sampleRate);
}

/** PCM16LE 单声道分块 → 完整 wav 字节。 */
export function pcm16ToWav(parts: Uint8Array[], sampleRate: number): Uint8Array {
  let pcmBytes = 0;
  for (const p of parts) pcmBytes += p.length;
  const wav = new Uint8Array(44 + pcmBytes);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) wav[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcmBytes, true);
  let at = 44;
  for (const part of parts) {
    wav.set(part, at);
    at += part.length;
  }
  return wav;
}

/** 样本 → 单声道 PCM16LE 字节;量化步长与 device-audio 写卡用的一致(32767) */
export function decodedToPcm16(decoded: PcmAudio): Uint8Array {
  const pcm = new Uint8Array(decoded.samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < decoded.samples.length; i++) {
    const v = Math.max(-1, Math.min(1, decoded.samples[i]));
    view.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return pcm;
}

/**
 * 单声道样本 → 完整 wav 字节。量化只有一个方向,来回一趟有半步以内的误差。
 * 分块只为少一次整段拷贝,块大小不承载任何格式含义。
 */
export function decodedToWav(decoded: PcmAudio): Uint8Array {
  const pcm = decodedToPcm16(decoded);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < pcm.length; at += 0x1000) parts.push(pcm.subarray(at, at + 0x1000));
  return pcm16ToWav(parts, decoded.sampleRate);
}

export const ENVELOPE_HOP_MS = 20;

/**
 * Incremental 20 ms RMS envelope with the same p95 normalization and attack/release as
 * `extractEnvelope`. Values converge to batch output as samples arrive.
 */
export class StreamingEnvelope {
  readonly hopMs = ENVELOPE_HOP_MS;
  private readonly hop: number;
  private readonly rms: number[] = [];
  private carry: number[] = [];
  private smoothed: Float32Array = new Float32Array(0);
  private dirty = false;

  constructor(sampleRate: number) {
    this.hop = Math.max(1, Math.round((sampleRate * ENVELOPE_HOP_MS) / 1000));
  }

  append(samples: Float32Array): void {
    for (const s of samples) {
      this.carry.push(s);
      if (this.carry.length === this.hop) {
        let acc = 0;
        for (const v of this.carry) acc += v * v;
        this.rms.push(Math.sqrt(acc / this.hop));
        this.carry = [];
      }
    }
    this.dirty = true;
  }

  /** 收流时计入不足一个 hop 的末段。 */
  finish(): void {
    if (this.carry.length > 0) {
      let acc = 0;
      for (const v of this.carry) acc += v * v;
      this.rms.push(Math.sqrt(acc / this.carry.length));
      this.carry = [];
    }
    this.dirty = true;
  }

  /** 已覆盖到的时长(ms) */
  coveredMs(): number {
    return this.rms.length * ENVELOPE_HOP_MS;
  }

  at(ms: number): number {
    if (this.dirty) this.recompute();
    const values = this.smoothed;
    if (values.length === 0) return 0;
    const idx = ms / ENVELOPE_HOP_MS;
    if (idx <= 0) return values[0];
    const hi = Math.ceil(idx);
    if (hi >= values.length) return 0;
    const lo = Math.floor(idx);
    const frac = idx - lo;
    return values[lo] * (1 - frac) + values[hi] * frac;
  }

  private recompute(): void {
    this.dirty = false;
    const n = this.rms.length;
    const sorted = [...this.rms].sort((a, b) => a - b);
    const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))] || 1;
    const out = new Float32Array(n);
    let level = 0;
    for (let i = 0; i < n; i++) {
      const target = Math.min(1, this.rms[i] / p95);
      const k = target > level ? 0.5 : 0.15;
      level += (target - level) * k;
      out[i] = level;
    }
    this.smoothed = out;
  }
}

/** RMS 包络:20ms hop,p95 归一,快攻慢放平滑(嘴形不抖) */
export function extractEnvelope(wav: PcmAudio): Envelope {
  const hop = Math.max(1, Math.round((wav.sampleRate * ENVELOPE_HOP_MS) / 1000));
  const n = Math.ceil(wav.samples.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * hop;
    const end = Math.min(start + hop, wav.samples.length);
    let acc = 0;
    for (let j = start; j < end; j++) acc += wav.samples[j] * wav.samples[j];
    rms[i] = Math.sqrt(acc / Math.max(1, end - start));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))] || 1;
  const out = new Float32Array(n);
  let level = 0;
  for (let i = 0; i < n; i++) {
    const target = Math.min(1, rms[i] / p95);
    // 攻 ~40ms、放 ~120ms(以 hop 为步长的一阶滤波)
    const k = target > level ? 0.5 : 0.15;
    level += (target - level) * k;
    out[i] = level;
  }
  return new Envelope(out, ENVELOPE_HOP_MS);
}
