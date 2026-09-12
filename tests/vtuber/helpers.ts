import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogEmitOptions, Logger, LogLevel } from 'cortico/core/types.ts';

/** worlds-vtuber 测试共用:合成 PCM16 单声道 wav */
export function makeWav(samples: number[], sampleRate = 16000): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const writeStr = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  }
  return new Uint8Array(buf);
}

/** 转码测试的素材:用 ffmpeg 自己把 wav 压成 mp3/m4a 之类 */
export function encodeAudio(
  ffmpeg: string,
  wav: Uint8Array,
  ext: string,
  args: string[],
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'vtuber-fixture-'));
  const src = join(dir, 'in.wav');
  const dst = join(dir, `out.${ext}`);
  writeFileSync(src, wav);
  return new Promise<Uint8Array>((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...args, dst]);
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(readFileSync(dst)));
      else reject(new Error(`素材编码失败 code=${code}: ${stderr}`));
    });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** 范例演出包 fx 通道的十个 clipId,按 vocab.json 声明顺序 */
export const FX_IDS: readonly string[] = [
  'fx_surprise', 'fx_sweat', 'fx_idea', 'fx_question', 'fx_star',
  'fx_loading', 'fx_blush', 'fx_anger', 'fx_sigh', 'fx_glasses',
];

/** 范例演出包声明的参数集 */
export const PARAM_IDS: readonly string[] = [
  'FaceAngleX', 'FaceAngleY', 'FaceAngleZ', 'MouthOpen', 'MouthSmile',
  'EyeOpenLeft', 'EyeOpenRight', 'EyeRightX', 'EyeRightY', 'EyeLeftX', 'EyeLeftY',
  'BrowLeftY', 'BrowRightY', 'CheekPuff',
];

/** 档案校验用的演出包事实(范例包) */
export const PROFILE_CTX = { paramIds: PARAM_IDS, fxIds: FX_IDS } as const;

/** 一份能过 parseProfile 的档案 JSON;没有 FX,按需覆盖 */
export function fixtureProfileJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'VTS-Fixture',
    label: '测试模型',
    backend: 'vts',
    vtsModelName: 'FixtureModel',
    wiring: {},
    unsupported: [],
    fx: {},
    keepExpressions: [],
    idleBlinks: false,
    ...overrides,
  };
}

/** 在 live2dDir 下建一个模型目录并写入 cortico.profile.json;返回模型目录路径 */
export function writeProfileDir(live2dDir: string, dirName: string, profile: Record<string, unknown> | string): string {
  const dir = join(live2dDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cortico.profile.json'), typeof profile === 'string' ? profile : JSON.stringify(profile));
  return dir;
}

/** 运行日志的一条记录(测试只看这些字段) */
export interface LogLine {
  level: string;
  msg: string;
  area: string;
  event?: string;
  durMs?: number;
  data?: unknown;
}

/** 记录型 Logger:区域按 child 逐层累加,每条记录带落盘契约的字段 */
export function recordingLogger(area: string, sink: (line: LogLine) => void): Logger {
  const emit = (level: LogLevel, msg: string, opts?: LogEmitOptions): void => {
    sink({ level, msg, area, event: opts?.event, durMs: opts?.durMs, data: opts?.data });
  };
  return {
    trace: (m, d) => emit('trace', m, { data: d }),
    debug: (m, d) => emit('debug', m, { data: d }),
    info: (m, d) => emit('info', m, { data: d }),
    warn: (m, d) => emit('warn', m, { data: d }),
    error: (m, d) => emit('error', m, { data: d }),
    emit,
    child: (sub) => recordingLogger(`${area}.${sub}`, sink),
  };
}
