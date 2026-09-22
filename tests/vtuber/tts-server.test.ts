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
      runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
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
      runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
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
      mgr = new TtsServerManager({ runtimeDir: () => dir, serverExe: () => 'llama-tts-server.exe', modelsDir: join(dir, 'models'), port: 8010, log: nullLogger() });
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
        runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
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
      runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
      port,
      log: nullLogger(),
      commandOverride: { command: process.execPath, args: ['-e', script] },
      healthIntervalMs: 50,
    });
    const first = mgr.start();
    const second = mgr.start();
    expect(second.pid).toBe(first.pid);
  });

  it('拉起失败(异步 error)后不留句柄:改好命令再点启动就能起来', async () => {
    const port = await freePort();
    const script = `require('node:http').createServer((req,res)=>{res.end('{"ok":true}')}).listen(${port},'127.0.0.1')`;
    const override = { command: join(tmpdir(), 'no-such-llama-tts-server'), args: [] as string[] };
    mgr = new TtsServerManager({
      runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
      port,
      log: nullLogger(),
      commandOverride: override,
      healthIntervalMs: 50,
      healthTimeoutMs: 5000,
    });
    mgr.start();
    await waitFor(() => mgr!.state().phase === 'error');
    expect(mgr.state().pid).toBeNull();
    // 残留句柄会把这次重试挡在门外(以为"上一代还没退"),修好命令也该起得来
    override.command = process.execPath;
    override.args = ['-e', script];
    expect(mgr.start().phase).toBe('starting');
    await waitFor(() => mgr!.state().phase === 'running');
  });

  it('过期的那次"失败"回执不许杀新一代:超时判据只看当前这一代', async () => {
    const port = await freePort();
    let mode: 'slow-fail' | 'ok' = 'slow-fail';
    const health = createServer((_req, res) => {
      if (mode === 'ok') {
        res.end('{"ok":true}');
        return;
      }
      // 挂住 400ms 再以 503 收场:回执必然晚于超时阈值(120ms)到达
      setTimeout(() => {
        res.statusCode = 503;
        res.end('{}');
      }, 400);
    });
    await new Promise<void>((resolve) => health.listen(port, '127.0.0.1', () => resolve()));
    try {
      mgr = new TtsServerManager({
        runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
        port,
        log: nullLogger(),
        commandOverride: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
        healthIntervalMs: 50,
        healthTimeoutMs: 120,
      });
      mgr.start();
      await new Promise((r) => setTimeout(r, 150)); // 这一次检查已在途,阈值也已过
      await mgr.stop();
      const restarted = mgr.start();
      mode = 'ok';
      await waitFor(() => mgr!.state().phase === 'running');
      const pid = restarted.pid;
      await new Promise((r) => setTimeout(r, 500)); // 等旧回执送到
      expect(mgr.state().phase).toBe('running');
      expect(mgr.state().pid).toBe(pid);
    } finally {
      await new Promise<void>((resolve) => health.close(() => resolve()));
    }
  });

  it('检查在途时按停止:那次"活着"的回执不许把状态写回 running', async () => {
    const port = await freePort();
    // 同端口上另有一个应答者(不属于我们起的进程,所以"停止"杀不掉它):
    // 用它复现"回执晚于停止"——没有世代号时这一下会把状态改回 running。
    const health = createServer((_req, res) => {
      setTimeout(() => res.end('{"ok":true}'), 400);
    });
    await new Promise<void>((resolve) => health.listen(port, '127.0.0.1', () => resolve()));
    try {
      mgr = new TtsServerManager({
        runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
        port,
        log: nullLogger(),
        commandOverride: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
        healthIntervalMs: 50,
        healthTimeoutMs: 5000,
      });
      mgr.start();
      await new Promise((r) => setTimeout(r, 120)); // 第一次检查已发出,回应还要 300ms 才到
      const stopped = await mgr.stop();
      expect(stopped.phase).toBe('stopped');
      await new Promise((r) => setTimeout(r, 500)); // 等那次在途回执送到
      expect(mgr.state().phase).toBe('stopped');
    } finally {
      await new Promise<void>((resolve) => health.close(() => resolve()));
    }
  });

  it('加载超时:卡住的进程收到真死(SIGTERM 不理就强杀),期间句柄不丢、不放行 start', async () => {
    const port = await freePort();
    mgr = new TtsServerManager({
      runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
      port,
      log: nullLogger(),
      // 不监听端口、也不理 SIGTERM 的假 server:健康检查永远不通
      commandOverride: { command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"] },
      healthIntervalMs: 50,
      healthTimeoutMs: 150,
    });
    const pid = mgr.start().pid;
    expect(pid).not.toBeNull();
    await waitFor(() => mgr!.state().phase === 'error');
    expect(mgr.state().detail).toContain('超时');
    // Windows 上 kill() 就是 TerminateProcess,子进程的 SIGTERM 处理器不生效,进程当场就退:
    // 没有宽限期可测,只剩下面"最终收到真死"那条
    if (process.platform !== 'win32') {
      // 宽限期里进程还在:句柄留着(pid 报得出来,停止按钮还停得到),start 不许再拉一个
      expect(mgr.state().pid).toBe(pid);
      expect(mgr.start().pid).toBe(pid);
    }
    // 3 秒宽限到点强杀,pid 归 null
    await waitFor(() => mgr!.state().pid === null, 8000);
  });

  it('停完立刻启动:不起第二个进程,等停完再启动才真的拉新的', async () => {
    const port = await freePort();
    const script = `require('node:http').createServer((req,res)=>{res.end('{"ok":true}')}).listen(${port},'127.0.0.1')`;
    mgr = new TtsServerManager({
      runtimeDir: () => 'unused', serverExe: () => 'llama-tts-server.exe', modelsDir: 'unused',
      port,
      log: nullLogger(),
      commandOverride: { command: process.execPath, args: ['-e', script] },
      healthIntervalMs: 50,
    });
    const firstPid = mgr.start().pid;
    const stopping = mgr.stop(); // 不 await:模拟用户在停止过程中又点了启动
    const blocked = mgr.start();
    expect(blocked.phase).toBe('stopping');
    expect(blocked.pid).toBe(firstPid);
    await stopping;
    expect(mgr.state().phase).toBe('stopped');
    const again = mgr.start();
    expect(again.phase).toBe('starting');
    expect(again.pid).not.toBe(firstPid);
  });
});

describe('TtsServerManager 启动参数', () => {
  /**
   * 造一个运行时目录加一个权重目录;文件内容无所谓,resolveLaunch 只看存在性。
   * 运行时目录就是解压后的样子:可执行文件在根上,不再套一层 bin/。
   */
  function fakeServerDir(withAligner: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'ttssrv-'));
    mkdirSync(join(dir, 'models'), { recursive: true });
    writeFileSync(join(dir, 'llama-tts-server.exe'), '');
    writeFileSync(join(dir, 'models', 'VoxCPM2-BaseLM-F16.gguf'), '');
    writeFileSync(join(dir, 'models', 'VoxCPM2-Acoustic-F16.gguf'), '');
    if (withAligner) {
      writeFileSync(join(dir, 'models', 'Qwen3-Aligner-LM-F16.gguf'), '');
      writeFileSync(join(dir, 'models', 'Qwen3-Aligner-Audio-F16.gguf'), '');
    }
    return dir;
  }

  /** 启动即失败(exe 是空文件),但 spawn 用过的 argv 已经落在 state 里可查 */
  const argsOf = (dir: string): string[] => {
    const mgr = new TtsServerManager({ runtimeDir: () => dir, serverExe: () => 'llama-tts-server.exe', modelsDir: join(dir, 'models'), port: 1, log: nullLogger() });
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
        runtimeDir: () => dir, serverExe: () => 'llama-tts-server.exe', modelsDir: join(dir, 'models'),
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
        runtimeDir: () => dir, serverExe: () => 'llama-tts-server.exe', modelsDir: join(dir, 'models'),
        port: 1,
        log: nullLogger(),
        baseLmFile: () => missingBase,
      });
      expect(baseMgr.start()).toMatchObject({
        phase: 'error',
        detail: expect.stringContaining(missingBase),
      });

      const alignerMgr = new TtsServerManager({
        runtimeDir: () => dir, serverExe: () => 'llama-tts-server.exe', modelsDir: join(dir, 'models'),
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
