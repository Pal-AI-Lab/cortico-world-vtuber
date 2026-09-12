import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { TtsServerManager } from '../../src/tts-server.ts';
import { recordingLogger, type LogLine } from './helpers.ts';

/** 置位时让 spawn 学 Windows 应用控制拦截:同步抛 errno=UNKNOWN;其余时候走真 spawn */
const spawnStub = vi.hoisted(() => ({ throwUnknown: false }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnStub.throwUnknown) throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' });
      return actual.spawn(...args);
    },
  };
});

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor 超时'));
      }
    }, 20);
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

describe('TtsServerManager', () => {
  let mgr: TtsServerManager | null = null;
  afterEach(async () => {
    await mgr?.stop();
    mgr = null;
  });

  it('start→health 就绪→running;stop 杀进程回 stopped', async () => {
    const port = await freePort();
    // Node 测试夹具替代服务端二进制,仅实现 /health。
    const script = `require('node:http').createServer((req,res)=>{res.end('{"ok":true}')}).listen(${port},'127.0.0.1')`;
    mgr = new TtsServerManager({
      serverDir: 'unused',
      port,
      log: nullLogger(),
      commandOverride: { command: process.execPath, args: ['-e', script] },
      healthIntervalMs: 50,
      healthTimeoutMs: 5000,
    });
    const st = mgr.start();
    expect(st.phase).toBe('starting');
    expect(st.pid).not.toBeNull();
    await waitFor(() => mgr!.state().phase === 'running');
    expect(await mgr.probe()).toBe(true);

    const stopped = await mgr.stop();
    expect(stopped.phase).toBe('stopped');
    await waitFor(() => !mgr || mgr.state().pid === null);
  });

  it('进程早退 → error 并带退出码;stderr 逐行进 server 区域,退出记录带 exitCode', async () => {
    const port = await freePort();
    const logs: LogLine[] = [];
    mgr = new TtsServerManager({
      serverDir: 'unused',
      port,
      log: recordingLogger('worlds.vtuber', (line) => logs.push(line)),
      commandOverride: {
        command: process.execPath,
        args: ['-e', 'process.stderr.write("loading "); process.stderr.write("model\\n\\n"); process.exit(3)'],
      },
      healthIntervalMs: 50,
      healthTimeoutMs: 2000,
    });
    mgr.start();
    await waitFor(() => mgr!.state().phase === 'error');
    expect(mgr.state().detail).toContain('code=3');
    await waitFor(() => logs.some((l) => l.event === 'stderr'));
    expect(logs.filter((l) => l.event === 'stderr')).toEqual([
      { area: 'worlds.vtuber.server', level: 'debug', event: 'stderr', msg: 'loading model', durMs: undefined, data: undefined },
    ]);
    const exit = logs.find((l) => l.event === 'exit')!;
    expect(exit).toMatchObject({ area: 'worlds.vtuber', level: 'warn', msg: 'TTS server 异常', data: { exitCode: 3 } });
    expect((exit.data as { detail: string }).detail).toContain('loading model');
  });

  it('缺 bin/models → 同步 error,不 spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-empty-'));
    try {
      mgr = new TtsServerManager({ serverDir: dir, port: 8010, log: nullLogger() });
      const st = mgr.start();
      expect(st.phase).toBe('error');
      expect(st.detail).toContain('缺文件');
      expect(st.pid).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spawn 同步抛(Windows 应用控制拦截)→ error 状态,不往面板漏异常', () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnStub.throwUnknown = true;
    try {
      mgr = new TtsServerManager({
        serverDir: 'unused',
        port: 8011,
        log: nullLogger(),
        commandOverride: { command: 'C:\\blocked\\llama-tts-server.exe', args: [] },
      });
      let st: ReturnType<TtsServerManager['start']> | null = null;
      expect(() => { st = mgr!.start(); }).not.toThrow();
      expect(st!.phase).toBe('error');
      expect(st!.pid).toBeNull();
      expect(st!.detail).toContain('应用控制');
      expect(st!.detail).toContain('llama-tts-server.exe');
    } finally {
      spawnStub.throwUnknown = false;
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('重复 start 幂等:starting/running 时原样返回', async () => {
    const port = await freePort();
    const script = `require('node:http').createServer((req,res)=>{res.end('ok')}).listen(${port},'127.0.0.1')`;
    mgr = new TtsServerManager({
      serverDir: 'unused',
      port,
      log: nullLogger(),
      commandOverride: { command: process.execPath, args: ['-e', script] },
      healthIntervalMs: 50,
    });
    const first = mgr.start();
    const second = mgr.start();
    expect(second.pid).toBe(first.pid);
  });
});

describe('TtsServerManager 启动参数', () => {
  /** 造一个只有 bin/models 骨架的 server 目录;文件内容无所谓,resolveLaunch 只看存在性 */
  function fakeServerDir(withAligner: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'ttssrv-'));
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'models'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'llama-tts-server.exe'), '');
    writeFileSync(join(dir, 'models', 'VoxCPM2-BaseLM-Q8_0.gguf'), '');
    writeFileSync(join(dir, 'models', 'VoxCPM2-Acoustic-F16.gguf'), '');
    if (withAligner) {
      writeFileSync(join(dir, 'models', 'Qwen3-Aligner-LM-Q8_0.gguf'), '');
      writeFileSync(join(dir, 'models', 'Qwen3-Aligner-Audio-F16.gguf'), '');
    }
    return dir;
  }

  /** 启动即失败(exe 是空文件),但 spawn 用过的 argv 已经落在 state 里可查 */
  const argsOf = (dir: string): string[] => {
    const mgr = new TtsServerManager({ serverDir: dir, port: 1, log: nullLogger() });
    return (mgr as unknown as { resolveLaunch(): { args: string[] } }).resolveLaunch().args;
  };

  it('两个对齐 GGUF 都在时带上 --aligner-lm / --aligner-audio', () => {
    const dir = fakeServerDir(true);
    try {
      const args = argsOf(dir);
      expect(args).toContain('--aligner-lm');
      expect(args).toContain('--aligner-audio');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有对齐 GGUF 时不带对齐参数,只起 TTS', () => {
    const dir = fakeServerDir(false);
    try {
      const args = argsOf(dir);
      expect(args).not.toContain('--aligner-lm');
      expect(args).toContain('--voxcpm2-base-lm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('四个外置权重进入启动参数,state 报告实际路径与就绪状态', () => {
    const dir = fakeServerDir(false);
    const external = mkdtempSync(join(tmpdir(), 'ttssrv-models-'));
    const files = {
      baseLm: join(external, 'base.gguf'),
      acoustic: join(external, 'acoustic.gguf'),
      alignerLm: join(external, 'aligner-lm.gguf'),
      alignerAudio: join(external, 'aligner-audio.gguf'),
    };
    for (const path of Object.values(files)) writeFileSync(path, 'fixture');
    try {
      const mgr = new TtsServerManager({
        serverDir: dir,
        port: 1,
        log: nullLogger(),
        baseLmFile: () => files.baseLm,
        acousticFile: () => files.acoustic,
        alignerLmFile: () => files.alignerLm,
        alignerAudioFile: () => files.alignerAudio,
      });
      const launch = (mgr as unknown as { resolveLaunch(): { args: string[] } }).resolveLaunch();
      expect(launch.args).toEqual(expect.arrayContaining([
        '--voxcpm2-base-lm', files.baseLm,
        '--voxcpm2-acoustic', files.acoustic,
        '--aligner-lm', files.alignerLm,
        '--aligner-audio', files.alignerAudio,
      ]));
      const resources = mgr.state().resources;
      expect(resources).toMatchObject({ ready: true, alignerRequired: true, alignerReady: true });
      expect(resources.baseLm).toEqual({ path: files.baseLm, ready: true, configured: true });
      expect(resources.alignerAudio).toEqual({ path: files.alignerAudio, ready: true, configured: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('显式路径缺失时报错,不退回旧目录里的同类文件', () => {
    const dir = fakeServerDir(true);
    const missingBase = join(dir, 'outside', 'missing-base.gguf');
    const missingAligner = join(dir, 'outside', 'missing-aligner.gguf');
    try {
      const baseMgr = new TtsServerManager({
        serverDir: dir,
        port: 1,
        log: nullLogger(),
        baseLmFile: () => missingBase,
      });
      expect(baseMgr.start()).toMatchObject({
        phase: 'error',
        detail: expect.stringContaining(missingBase),
      });

      const alignerMgr = new TtsServerManager({
        serverDir: dir,
        port: 1,
        log: nullLogger(),
        alignerLmFile: () => missingAligner,
      });
      expect(alignerMgr.start()).toMatchObject({
        phase: 'error',
        detail: expect.stringContaining(missingAligner),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
