/**
 * 参考音频转码。声线库只存 wav(VoxCPM2 的 reference_audio 只吃 wav),导入的
 * mp3/m4a 这类压缩格式在落盘前经本机 ffmpeg 转成 24kHz 单声道 PCM16——模型的
 * 原生采样率,与手工放进 voices/ 的参考音频同规格。
 *
 * ffmpeg 与 bin/ 里的 llama-tts-server 一样不入库:按包内 bin/ 与 PATH 找,
 * 找不到就只收 wav。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** VoxCPM2 声学模型的采样率 */
const TARGET_SAMPLE_RATE = 24_000;
/** 正常人声片段应远低于此转码上限。 */
const TRANSCODE_TIMEOUT_MS = 60_000;

export const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

export type AudioFormat = 'wav' | 'mp3' | 'm4a' | 'ogg' | 'flac' | 'aiff';

const FORMAT_LABEL: Record<AudioFormat, string> = {
  wav: 'WAV',
  mp3: 'MP3',
  m4a: 'M4A/MP4',
  ogg: 'Ogg',
  flac: 'FLAC',
  aiff: 'AIFF',
};

export function formatLabel(format: AudioFormat | null): string {
  return format ? FORMAT_LABEL[format] : '未知格式';
}

/**
 * 按文件头判格式。面板里的文件是操作者随手选的,扩展名不足信。
 * 认不出返回 null:可能是坏文件,也可能是这里没列的编码,两种都交给 ffmpeg 去探。
 */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat | null {
  if (bytes.length < 12) return null;
  const ascii = (at: number, len: number): string => {
    let s = '';
    for (let i = at; i < at + len; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(4, 4) === 'ftyp') return 'm4a';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 4) === 'FORM' && ascii(8, 3) === 'AIF') return 'aiff';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  // 裸帧同步字(11 位全 1)。ADTS 的 .aac 也落这条,ffmpeg 按内容解不受影响
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** ffmpeg 可执行文件:只认 PATH。转码不是 World 的本职,不随包分发也不代装 */
export function findFfmpeg(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, FFMPEG_EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 转成 wav。省略 `targetSampleRate` 时保留源采样率(合成输出走这条);
 * 参考音频导入固定要 24kHz,那是 VoxCPM2 的原生规格,由 `transcodeToWav` 给出。
 * 输入使用临时文件；位于 m4a 尾部的 moov 原子需要可 seek 数据源。
 */
export async function transcodeAudioToWav(
  bytes: Uint8Array,
  opts: { ffmpeg: string; sourceExt?: string; targetSampleRate?: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-audio-'));
  const src = join(dir, `in.${opts.sourceExt ?? 'bin'}`);
  const dst = join(dir, 'out.wav');
  try {
    writeFileSync(src, bytes);
    await runFfmpeg(opts.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', src,
      // 只取第一条音轨:内嵌封面是一条视频流,不 map 掉会连它一起编码
      '-map', '0:a:0',
      '-ac', '1',
      ...(opts.targetSampleRate === undefined ? [] : ['-ar', String(opts.targetSampleRate)]),
      '-c:a', 'pcm_s16le',
      dst,
    ], opts.signal, opts.timeoutMs ?? TRANSCODE_TIMEOUT_MS);
    return new Uint8Array(readFileSync(dst));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 参考音频的旧入口:一律 24kHz 单声道 PCM16。 */
export async function transcodeToWav(
  bytes: Uint8Array,
  opts: { ffmpeg: string; sourceExt?: string },
): Promise<Uint8Array> {
  return transcodeAudioToWav(bytes, { ...opts, targetSampleRate: TARGET_SAMPLE_RATE });
}

function runFfmpeg(exe: string, args: string[], signal?: AbortSignal, timeoutMs = TRANSCODE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderrTail = '';
    const kill = (): void => {
      proc.kill('SIGKILL');
    };
    const onAbort = (): void => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`ffmpeg 转码超时(${timeoutMs / 1000}s)`));
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1000);
    });
    proc.on('error', (err) => {
      done();
      reject(new Error(`ffmpeg 启动失败: ${err.message}`));
    });
    proc.on('close', (code) => {
      done();
      // 取消是调用方的决定,不是转码失败;原样上抛让上层区分"用户打断"与"转码坏了"
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 转码失败(code=${code}): ${stderrTail.trim().slice(-300) || '无错误输出'}`));
    });
  });
}
