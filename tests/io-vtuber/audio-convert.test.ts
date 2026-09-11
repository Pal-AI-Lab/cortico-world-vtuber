import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FFMPEG_EXE,
  findFfmpeg,
  formatLabel,
  sniffAudioFormat,
  transcodeToWav,
} from '../../src/io-vtuber/audio-convert.ts';
import { decodeWav } from '../../src/io-vtuber/tts.ts';
import { encodeAudio, makeWav } from './helpers.ts';

/** 满足格式检测最小长度的 12 字节文件头。 */
function header(bytes: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(bytes);
  return out;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

const ffmpeg = findFfmpeg('');
const withFfmpeg = ffmpeg ? it : it.skip;

describe('sniffAudioFormat', () => {
  it('按文件头认出各容器', () => {
    expect(sniffAudioFormat(makeWav([0.1, -0.1]))).toBe('wav');
    expect(sniffAudioFormat(header([...ascii('ID3'), 4, 0, 0]))).toBe('mp3');
    expect(sniffAudioFormat(header([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
    expect(sniffAudioFormat(header([0, 0, 0, 0x20, ...ascii('ftypM4A ')]))).toBe('m4a');
    expect(sniffAudioFormat(header(ascii('OggS')))).toBe('ogg');
    expect(sniffAudioFormat(header(ascii('fLaC')))).toBe('flac');
    expect(sniffAudioFormat(header([...ascii('FORM'), 0, 0, 0, 0, ...ascii('AIFF')]))).toBe('aiff');
  });

  it('认不出的一律 null(交给 ffmpeg 去探)', () => {
    expect(sniffAudioFormat(new Uint8Array(Buffer.from('不是音频啊啊啊')))).toBeNull();
    expect(sniffAudioFormat(new Uint8Array([1, 2, 3]))).toBeNull(); // 短于 12 字节
    // RIFF 容器但不是 WAVE(比如 avi)不算 wav
    expect(sniffAudioFormat(header([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('AVI ')]))).toBeNull();
    expect(formatLabel(null)).toBe('未知格式');
  });
});

describe('findFfmpeg', () => {
  it('包内 bin/ 优先于 PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-serverdir-'));
    try {
      expect(findFfmpeg(dir)).toBe(ffmpeg); // bin/ 里没有,回落 PATH(本机没装则 null)
      mkdirSync(join(dir, 'bin'));
      const bundled = join(dir, 'bin', FFMPEG_EXE);
      writeFileSync(bundled, '');
      chmodSync(bundled, 0o755);
      expect(findFfmpeg(dir)).toBe(bundled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transcodeToWav', () => {
  // 0.5s 440Hz 正弦,立体声源可顺带验证并轨
  const tone = Array.from({ length: 24_000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5);
  const sourceWav = makeWav(tone, 48_000);

  withFfmpeg('mp3 转出 24kHz 单声道 PCM16,时长保持', async () => {
    const mp3 = await encodeAudio(ffmpeg!, sourceWav, 'mp3', ['-ac', '2', '-b:a', '128k']);
    expect(sniffAudioFormat(mp3)).toBe('mp3');

    const wav = await transcodeToWav(mp3, { ffmpeg: ffmpeg!, sourceExt: 'mp3' });
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(24_000);
    // mp3 编码在两端各补一点静音,允许 100ms 出入
    expect(decoded.durationMs).toBeGreaterThan(400);
    expect(decoded.durationMs).toBeLessThan(600);
    // 真解出了信号,不是一段静音
    expect(Math.max(...decoded.samples)).toBeGreaterThan(0.2);
  });

  withFfmpeg('m4a(moov 在文件尾)也能转', async () => {
    const m4a = await encodeAudio(ffmpeg!, sourceWav, 'm4a', ['-c:a', 'aac', '-b:a', '128k']);
    expect(sniffAudioFormat(m4a)).toBe('m4a');

    const decoded = decodeWav(await transcodeToWav(m4a, { ffmpeg: ffmpeg!, sourceExt: 'm4a' }));
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.durationMs).toBeGreaterThan(400);
    expect(Math.max(...decoded.samples)).toBeGreaterThan(0.2);
  });

  withFfmpeg('坏文件带着 ffmpeg 的错误抛出', async () => {
    const junk = new Uint8Array(Buffer.from('这不是音频'.repeat(50)));
    await expect(transcodeToWav(junk, { ffmpeg: ffmpeg!, sourceExt: 'bin' })).rejects.toThrow(/ffmpeg 转码失败/);
  });

  it('ffmpeg 路径不存在时报启动失败', async () => {
    const missing = join(tmpdir(), 'no-such-ffmpeg-binary');
    await expect(transcodeToWav(makeWav([0.1]), { ffmpeg: missing })).rejects.toThrow(/ffmpeg 启动失败/);
  });
});
