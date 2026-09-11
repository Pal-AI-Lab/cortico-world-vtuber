/**
 * VoxCPM2 server 进程管理:spawn llama-tts-server.exe 并轮询 health。
 * 控制台的启动/停止/测试按钮经 web 端点打到这里。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Logger } from '../core/types.ts';

export type TtsServerPhase = 'stopped' | 'starting' | 'running' | 'error';

export interface TtsServerState {
  phase: TtsServerPhase;
  url: string;
  /** 缺文件/退出码之类的最近错误;phase=error 时必有 */
  detail: string | null;
  pid: number | null;
  resources: TtsServerResources;
}

export interface TtsServerResource {
  path: string;
  ready: boolean;
  /** true 表示路径来自配置；false 表示使用随包目录的旧约定。 */
  configured: boolean;
}

export interface TtsServerResources {
  server: Omit<TtsServerResource, 'configured'>;
  baseLm: TtsServerResource;
  acoustic: TtsServerResource;
  alignerLm: TtsServerResource;
  alignerAudio: TtsServerResource;
  /** 任一对齐路径显式配置后，对齐模型成为本次启动的必需资源。 */
  alignerRequired: boolean;
  alignerReady: boolean;
  ready: boolean;
}

export interface TtsServerOptions {
  /** voxcpm2-server 目录；随包二进制固定从 bin/ 读取。 */
  serverDir: string;
  /** 空字符串沿用 serverDir/models 下的旧文件名。 */
  baseLmFile?: () => string;
  acousticFile?: () => string;
  alignerLmFile?: () => string;
  alignerAudioFile?: () => string;
  port: number;
  host?: string;
  nGpuLayers?: number;
  /** CUDA 运行时目录;存在则前置进 PATH */
  cudaBinDir?: string;
  log: Logger;
  /** 测试注入:替换被 spawn 的命令与参数 */
  commandOverride?: { command: string; args: string[] };
  /** health 轮询间隔/上限(测试调小) */
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_CUDA_BIN = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.3\\bin\\x64';

/**
 * spawn 失败的人话。Windows 上 errno=UNKNOWN 几乎只有一个来源:应用控制策略
 * (智能应用控制/WDAC)拦下了未签名的 exe——照字面报 "spawn UNKNOWN" 没人猜得到。
 */
function spawnFailDetail(err: unknown, exe: string): string {
  const e = err as NodeJS.ErrnoException;
  if (process.platform === 'win32' && e?.code === 'UNKNOWN') {
    return `Windows 应用控制策略拦下了 ${exe}(智能应用控制对未签名二进制的默认处置)。`
      + '去「Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」关掉,或给二进制签名;改完要重启本进程。';
  }
  return `进程启动失败: ${e?.message ?? String(err)}`;
}

export class TtsServerManager {
  private readonly opts: TtsServerOptions;
  private readonly host: string;
  private proc: ChildProcess | null = null;
  private phase: TtsServerPhase = 'stopped';
  private detail: string | null = null;
  private stderrTail = '';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TtsServerOptions) {
    this.opts = opts;
    this.host = opts.host ?? '127.0.0.1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get url(): string {
    return `http://${this.host}:${this.opts.port}`;
  }

  state(): TtsServerState {
    return {
      phase: this.phase,
      url: this.url,
      detail: this.detail,
      pid: this.proc?.pid ?? null,
      resources: this.resolveResources(),
    };
  }

  /** 拉起进程并开始 health 轮询;已在跑则原样返回。同步返回,结果看 state()。 */
  start(): TtsServerState {
    if (this.phase === 'starting' || this.phase === 'running') return this.state();
    const launch = this.resolveLaunch();
    if ('error' in launch) {
      this.phase = 'error';
      this.detail = launch.error;
      return this.state();
    }
    this.detail = null;
    this.stderrTail = '';
    this.phase = 'starting';
    // spawn 的一部分错误(Windows 的 UNKNOWN 就是)是同步抛的,不走 error 事件;
    // 漏出去会变成面板一句 "调用失败",而 phase 永远卡在 starting。
    let proc: ChildProcess;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.proc = null;
      this.fail(spawnFailDetail(err, launch.command));
      return this.state();
    }
    this.proc = proc;
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    // server 自己的日志逐行进运行日志(区域 server);面板与退出文案只用尾巴
    const serverLog = this.opts.log.child('server');
    createInterface({ input: proc.stderr! }).on('line', (raw) => {
      const line = raw.trim();
      if (line) serverLog.emit('debug', line, { event: 'stderr' });
    });
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.fail(spawnFailDetail(err, launch.command));
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.phase === 'stopped') return;
      this.fail(
        `进程退出 code=${code}${this.stderrTail ? `;stderr尾部: ${this.stderrTail.slice(-400)}` : ''}`,
        { event: 'exit', data: { exitCode: code } },
      );
    });
    this.beginHealthPolling();
    this.opts.log.info('TTS server 启动中', { pid: proc.pid, url: this.url });
    return this.state();
  }

  async stop(): Promise<TtsServerState> {
    this.clearHealthTimer();
    const proc = this.proc;
    this.proc = null;
    this.phase = 'stopped';
    this.detail = null;
    if (proc && proc.exitCode === null) {
      proc.kill();
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
      });
      this.opts.log.info('TTS server 已停止');
    }
    return this.state();
  }

  /** 单次健康探测(也用于探测外部自行启动的 server) */
  async probe(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private resolveLaunch():
    | { command: string; args: string[]; cwd: string | undefined; env: NodeJS.ProcessEnv }
    | { error: string } {
    if (this.opts.commandOverride) {
      return {
        command: this.opts.commandOverride.command,
        args: this.opts.commandOverride.args,
        cwd: undefined,
        env: process.env,
      };
    }
    const resources = this.resolveResources();
    const binDir = join(this.opts.serverDir, 'bin');
    const required: Array<[string, TtsServerResource | TtsServerResources['server']]> = [
      ['TTS server', resources.server],
      ['VoxCPM2 BaseLM', resources.baseLm],
      ['VoxCPM2 Acoustic', resources.acoustic],
    ];
    for (const [label, resource] of required) {
      if (!resource.ready) {
        const configured = 'configured' in resource && resource.configured;
        return { error: `${configured ? '配置的文件不存在' : '缺文件'}(${label}): ${resource.path}` };
      }
    }
    if (resources.alignerRequired && !resources.alignerReady) {
      const missing = [
        ['Aligner LM', resources.alignerLm],
        ['Aligner Audio', resources.alignerAudio],
      ].find(([, resource]) => !(resource as TtsServerResource).ready) as [string, TtsServerResource] | undefined;
      if (missing) {
        const [label, resource] = missing;
        return {
          error: `${resource.configured ? '配置的文件不存在' : '缺文件'}(${label}): ${resource.path}`,
        };
      }
    }
    const cudaBin = this.opts.cudaBinDir ?? DEFAULT_CUDA_BIN;
    const pathPrefix = existsSync(cudaBin) ? `${binDir};${cudaBin};` : `${binDir};`;
    const args = [
      '--host', this.host,
      '--port', String(this.opts.port),
      '--voxcpm2-base-lm', resources.baseLm.path,
      '--voxcpm2-acoustic', resources.acoustic.path,
      '--voxcpm2-n-gpu-layers', String(this.opts.nGpuLayers ?? -1),
    ];
    if (resources.alignerReady) {
      args.push('--aligner-lm', resources.alignerLm.path, '--aligner-audio', resources.alignerAudio.path);
    }
    return {
      command: resources.server.path,
      args,
      cwd: binDir,
      env: { ...process.env, PATH: pathPrefix + (process.env.PATH ?? '') },
    };
  }

  private resolveResources(): TtsServerResources {
    const binDir = join(this.opts.serverDir, 'bin');
    const modelsDir = join(this.opts.serverDir, 'models');
    const configured = (get?: () => string): string => get?.().trim() ?? '';
    const resource = (value: string, fallback: string): TtsServerResource => {
      const path = value ? resolve(value) : fallback;
      return { path, ready: existsSync(path), configured: value.length > 0 };
    };

    const baseLm = resource(configured(this.opts.baseLmFile), join(modelsDir, 'VoxCPM2-BaseLM-Q8_0.gguf'));
    const acoustic = resource(configured(this.opts.acousticFile), join(modelsDir, 'VoxCPM2-Acoustic-F16.gguf'));
    const alignerLmValue = configured(this.opts.alignerLmFile);
    const alignerLmCandidates = [
      join(modelsDir, 'Qwen3-Aligner-LM-Q8_0.gguf'),
      join(modelsDir, 'Qwen3-Aligner-LM-F16.gguf'),
    ];
    const alignerLm = resource(
      alignerLmValue,
      alignerLmCandidates.find((path) => existsSync(path)) ?? alignerLmCandidates[0],
    );
    const alignerAudioValue = configured(this.opts.alignerAudioFile);
    const alignerAudio = resource(
      alignerAudioValue,
      join(modelsDir, 'Qwen3-Aligner-Audio-F16.gguf'),
    );
    const serverPath = join(binDir, 'llama-tts-server.exe');
    const alignerRequired = alignerLmValue.length > 0 || alignerAudioValue.length > 0;
    const alignerReady = alignerLm.ready && alignerAudio.ready;
    return {
      server: { path: serverPath, ready: existsSync(serverPath) },
      baseLm,
      acoustic,
      alignerLm,
      alignerAudio,
      alignerRequired,
      alignerReady,
      ready: existsSync(serverPath) && baseLm.ready && acoustic.ready && (!alignerRequired || alignerReady),
    };
  }

  private beginHealthPolling(): void {
    this.clearHealthTimer();
    const startedAt = Date.now();
    const interval = this.opts.healthIntervalMs ?? 2000;
    const timeout = this.opts.healthTimeoutMs ?? 180_000;
    this.healthTimer = setInterval(() => {
      void (async () => {
        if (this.phase !== 'starting') {
          this.clearHealthTimer();
          return;
        }
        if (await this.probe()) {
          this.phase = 'running';
          this.detail = null;
          this.clearHealthTimer();
          this.opts.log.info('TTS server 就绪', { url: this.url });
          return;
        }
        if (Date.now() - startedAt > timeout) {
          this.fail('health 检查超时(模型加载过久或端口不对)');
          void this.stopOrphan();
        }
      })();
    }, interval);
  }

  private async stopOrphan(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) proc.kill();
  }

  private fail(detail: string, record: { event?: string; data?: Record<string, unknown> } = {}): void {
    this.clearHealthTimer();
    this.phase = 'error';
    this.detail = detail;
    this.opts.log.emit('warn', 'TTS server 异常', { event: record.event, data: { detail, ...record.data } });
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }
}
