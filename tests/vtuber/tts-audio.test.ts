import { describe, it, expect } from 'vitest';
import {
  IncrementalWavParser,
  decodeAudioBytes,
  decodePcm16ToDecoded,
  decodeWav,
  decodedToWav,
  type WavFormat,
} from '../../src/tts/audio.ts';

/** 生成 PCM16LE 字节;样本值域 [-1,1] */
function pcm16(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(samples[i] * 32767), true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 24 位 PCM 的字节形式(小端,三字节) */
function pcm24(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, samples[i])) * 8388607);
    out[i * 3] = v & 0xff;
    out[i * 3 + 1] = (v >> 8) & 0xff;
    out[i * 3 + 2] = (v >> 16) & 0xff;
  }
  return out;
}

/** 32 位浮点样本的字节形式 */
function f32(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
  return out;
}

interface WavSpec {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** data 块里声明的长度;占位长度的夹具自己传 */
  dataLength: number;
  /** data 之前插入的块,内容已含 padding */
  before?: Uint8Array;
  /** data 之后插入的字节(尾部元信息) */
  after?: Uint8Array;
  pcm: Uint8Array;
}

/** 全部按裸字节拼 wav;块头长度字段与真实字节数可以故意不一致 */
function wavBytes(spec: WavSpec): Uint8Array {
  const { format, channels, sampleRate, bitsPerSample } = spec;
  const frameBytes = (bitsPerSample / 8) * channels;
  const fmtBody = new Uint8Array(16);
  const v = new DataView(fmtBody.buffer);
  v.setUint16(0, format, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, sampleRate, true);
  v.setUint32(8, sampleRate * frameBytes, true);
  v.setUint16(12, frameBytes, true);
  v.setUint16(14, bitsPerSample, true);
  const fmtHead = new Uint8Array(8);
  const hv = new DataView(fmtHead.buffer);
  fmtHead.set(ascii('fmt '), 0);
  hv.setUint32(4, fmtBody.length, true);
  const dataHead = new Uint8Array(8);
  const dv = new DataView(dataHead.buffer);
  dataHead.set(ascii('data'), 0);
  dv.setUint32(4, spec.dataLength, true);
  const riff = new Uint8Array(12);
  const rv = new DataView(riff.buffer);
  riff.set(ascii('RIFF'), 0);
  rv.setUint32(4, 4 + fmtHead.length + fmtBody.length + dataHead.length + spec.pcm.length, true);
  riff.set(ascii('WAVE'), 8);
  return concat([riff, fmtHead, fmtBody, spec.before ?? new Uint8Array(0), dataHead, spec.pcm, spec.after ?? new Uint8Array(0)]);
}

describe('IncrementalWavParser', () => {
  it('头跨三个 chunk 到达也能拼出格式与样本', () => {
    const pcm = pcm16([0.25, -0.5, 1]);
    const bytes = wavBytes({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    // 44 字节头切成 10 / 10 / 剩下的部分,头本身也要跨块
    expect(parser.push(bytes.subarray(0, 10)).length).toBe(0);
    expect(parser.push(bytes.subarray(10, 20)).length).toBe(0);
    const rest = parser.push(bytes.subarray(20));
    expect(parser.sampleRate).toBe(16000);
    expect(parser.format?.bitsPerSample).toBe(16);
    expect(parser.format?.channels).toBe(1);
    expect(Buffer.from(rest).equals(Buffer.from(pcm))).toBe(true);
  });

  it('data 之前的 LIST/fact 块按块长跳过,含 padding', () => {
    const before = concat([
      ascii('LIST'), new Uint8Array([5, 0, 0, 0]), ascii('INFOx'), new Uint8Array([0]), // 5 字节块体 + padding
      ascii('fact'), new Uint8Array([4, 0, 0, 0]), new Uint8Array([3, 0, 0, 0]),
    ]);
    const pcm = pcm16([0.1, 0.2]);
    const bytes = wavBytes({ format: 1, channels: 1, sampleRate: 8000, bitsPerSample: 16, dataLength: pcm.length, before, pcm });
    const parser = new IncrementalWavParser();
    const out = parser.push(bytes);
    expect(Buffer.from(out).equals(Buffer.from(pcm))).toBe(true);
    expect(parser.format?.dataOffset).toBe(12 + 8 + 16 + before.length + 8);
  });

  it('data 长度是占位值:不按它预分配,收到多少解多少', () => {
    const pcm = pcm16([0.5, -0.25, 0.75, -1]);
    const bytes = wavBytes({
      format: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      dataLength: 0xffffffff,
      pcm,
    });
    const parser = new IncrementalWavParser();
    // 44 字节头之后只剩 4 个 PCM 字节可解
    expect(parser.push(bytes.subarray(0, 48)).length).toBe(4);
    // 占位长度下的第二块交回剩下的样本
    const rest = parser.push(bytes.subarray(48));
    expect(rest.length).toBe(pcm.length - 4);
    expect(parser.format?.dataLength).toBeNull();
    expect(parser.done).toBe(false);
  });

  it('声明长度收满后多给的字节忽略', () => {
    const pcm = pcm16([0.5, 0.5]);
    const bytes = wavBytes({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    expect(parser.push(concat([bytes, pcm16([0.9, 0.9])])).length).toBe(pcm.length);
    expect(parser.done).toBe(true);
    expect(parser.push(pcm16([0.9])).length).toBe(0);
  });

  it('data 之后的尾部元信息不当 PCM', () => {
    const pcm = pcm16([0.5, -0.5]);
    const after = concat([ascii('LIST'), new Uint8Array([4, 0, 0, 0]), new Uint8Array([1, 2, 3, 4])]);
    const bytes = wavBytes({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataLength: pcm.length, after, pcm });
    const parser = new IncrementalWavParser();
    // 尾部与 PCM 同一次到达:解出的样本只有 data 块那一份
    const out = parser.push(bytes);
    expect(Buffer.from(out).equals(Buffer.from(pcm))).toBe(true);
    expect(parser.frameCount).toBe(2);
  });

  it('立体声取平均并为单声道', () => {
    const left = [1, -1, 0.5];
    const right = [0, 1, 0.5];
    const interleaved: number[] = [];
    for (let i = 0; i < left.length; i++) interleaved.push(left[i], right[i]);
    const pcm = pcm16(interleaved);
    const bytes = wavBytes({ format: 1, channels: 2, sampleRate: 8000, bitsPerSample: 16, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    const decoded = decodePcm16ToDecoded(parser.push(bytes), 8000, 1);
    expect(decoded.samples[0]).toBeCloseTo(0.5, 4);
    expect(decoded.samples[1]).toBe(0);
    expect(decoded.samples[2]).toBeCloseTo(0.5, 4);
    expect(decoded.durationMs).toBeCloseTo(0.375, 6);
  });

  it('float32 样本钳到 [-1,1] 后按单声道给出', () => {
    const pcm = f32([0.5, -0.5, 2, -3]);
    const bytes = wavBytes({ format: 3, channels: 1, sampleRate: 22050, bitsPerSample: 32, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    const decoded = decodePcm16ToDecoded(parser.push(bytes), 22050, 1);
    expect(decoded.samples[0]).toBeCloseTo(0.5, 4);
    expect(decoded.samples[1]).toBeCloseTo(-0.5, 4);
    // 越界样本先钳到端点,再落进 16 位量化:1 回读是 32767/32768
    expect(decoded.samples[2]).toBeCloseTo(1, 4);
    expect(decoded.samples[3]).toBeCloseTo(-1, 4);
  });

  it('24 位 PCM 按符号扩展解出', () => {
    const values = [0.5, -0.5, 1];
    const pcm = pcm24(values);
    const bytes = wavBytes({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 24, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    const decoded = decodePcm16ToDecoded(parser.push(bytes), 16000, 1);
    // 24 位样本经 16 位中转,逐项同量级而非逐位相同
    expect(decoded.samples.length).toBe(3);
    for (let i = 0; i < values.length; i++) expect(decoded.samples[i]).toBeCloseTo(values[i]!, 4);
  });

  it('WAVE_FORMAT_EXTENSIBLE 报出格式与位深', () => {
    const pcm = pcm16([0.5]);
    const bytes = wavBytes({ format: 0xfffe, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    expect(() => parser.push(bytes)).toThrow('不支持的 wav 格式: format=65534 bits=16');
  });

  it('结尾的半个样本由 finish() 丢掉并记数', () => {
    const pcm = pcm16([0.5, -0.5]);
    const bytes = wavBytes({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    // 44 字节头 + 一个完整帧 + 一个字节:不足一帧的那个字节不解出
    const out = parser.push(bytes.subarray(0, 47));
    expect(out.length).toBe(2);
    parser.finish();
    expect(parser.trailingPartialBytes).toBe(1);
    expect(parser.frameCount).toBe(1);
  });

  it('增量解出的样本与整段 decodeWav 一致', () => {
    const sr = 16000;
    const interleaved: number[] = [];
    for (let i = 0; i < 400; i++) {
      const v = Math.sin(i / 9) * 0.8;
      interleaved.push(v, -v);
    }
    const pcm = pcm16(interleaved);
    const bytes = wavBytes({ format: 1, channels: 2, sampleRate: sr, bitsPerSample: 16, dataLength: pcm.length, pcm });
    const parser = new IncrementalWavParser();
    const parts: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 37) parts.push(parser.push(bytes.subarray(at, Math.min(at + 37, bytes.length))));
    const streamed = decodePcm16ToDecoded(concat(parts), sr, 1);
    const whole = decodeWav(bytes);
    expect(streamed.samples.length).toBe(whole.samples.length);
    // 增量路的每一帧经过一次 int16 中转,与整段读取是同量级而非逐位相同
    for (let i = 0; i < whole.samples.length; i++) expect(streamed.samples[i]).toBeCloseTo(whole.samples[i], 4);
  });

  it('交回的分片不被后续 push 改写', () => {
    const pcm = pcm16([0.5, -0.5, 0.25, -0.25]);
    const bytes = wavBytes({
      format: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      dataLength: 0xffffffff,
      pcm,
    });
    const parser = new IncrementalWavParser();
    // 头 44 字节 + 前两个样本;余下的样本与另一段音频随后才到
    const first = parser.push(bytes.subarray(0, 48));
    parser.push(bytes.subarray(48));
    parser.push(pcm16([1, 1]));
    // 后两次 push 会重建内部缓冲,先前交回的那一段必须还是自己的字节
    expect(Buffer.from(first).equals(Buffer.from(pcm.subarray(0, 4)))).toBe(true);
  });
});

describe('decodePcm16ToDecoded', () => {
  it('原始 pcm16 末尾的半个样本丢掉,不抛错', () => {
    const raw = pcm16([0.5, -0.5]);
    const odd = concat([raw, new Uint8Array([0x7f])]);
    const decoded = decodePcm16ToDecoded(odd, 16000, 1);
    // 夹具按 32767 量化、这里按 32768 回读,半步以内的差是量化本身
    expect(decoded.samples[0]).toBeCloseTo(0.5, 3);
    expect(decoded.samples[1]).toBeCloseTo(-0.5, 3);
    expect(decoded.durationMs).toBeCloseTo(0.125, 6);
    expect(decoded.samples.length).toBe(2);
  });

  it('立体声按帧取平均', () => {
    const raw = pcm16([1, 0, -1, 1]);
    const decoded = decodePcm16ToDecoded(raw, 8000, 2);
    expect(decoded.samples[0]).toBeCloseTo(0.5, 4);
    expect(decoded.samples[1]).toBe(0);
    expect(decoded.durationMs).toBeCloseTo(0.25, 6);
  });
});

describe('decodeAudioBytes', () => {
  const pcm = pcm16([0.5, -0.5]);

  it('wav 走整段解析', () => {
    const bytes = wavBytes({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataLength: pcm.length, pcm });
    expect(decodeAudioBytes(bytes, { responseFormat: 'wav' }).sampleRate).toBe(16000);
  });

  it('pcm 用配置里的采样率与声道数;缺配置直接报错', () => {
    const pcmOut = decodeAudioBytes(pcm, { responseFormat: 'pcm', pcm: { sampleRate: 24000, channels: 1, encoding: 's16le' } });
    expect(pcmOut.sampleRate).toBe(24000);
    expect(pcmOut.durationMs).toBeCloseTo(0.0833, 3);
    expect(() => decodeAudioBytes(pcm, { responseFormat: 'pcm' })).toThrow('输出格式为 pcm 时必须给出采样率与声道数');
  });

  it('压缩格式报出缺 ffmpeg', () => {
    expect(() => decodeAudioBytes(pcm, { responseFormat: 'mp3' })).toThrow(
      '解码 mp3 需要本机 ffmpeg;请改用 wav 或 pcm 输出',
    );
    expect(() => decodeAudioBytes(pcm, { responseFormat: 'flac' })).toThrow(/需要本机 ffmpeg/);
  });
});

describe('decodedToWav', () => {
  it('样本量化回单声道 PCM16LE 的有效 wav', () => {
    const decoded = { samples: new Float32Array([0.5, -0.5, 1]), sampleRate: 16000, durationMs: 0.1875 };
    const bytes = decodedToWav(decoded);
    const format = new DataView(bytes.buffer);
    expect(format.getUint32(0, false)).toBe(0x52494646);
    expect(format.getUint32(8, false)).toBe(0x57415645);
    expect(format.getUint32(24, true)).toBe(16000);
    const back = decodeWav(bytes);
    expect(back.sampleRate).toBe(16000);
    expect(back.samples.length).toBe(3);
    expect(back.samples[0]).toBeCloseTo(0.5, 3);
    expect(back.samples[2]).toBeCloseTo(1, 3);
    // 类型面:WavFormat 的字段都在
    const info: WavFormat = {
      format: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      blockAlign: 2,
      dataOffset: 44,
      dataLength: 6,
    };
    expect(info.dataLength).toBe(6);
  });
});
