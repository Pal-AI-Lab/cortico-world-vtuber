/**
 * VoxCPM2 server 进程管理:spawn llama-tts-server.exe 并轮询 health。
 * 控制台的启动/停止/测试按钮经 web 端点打到这里。
 *
 * 进程句柄、阶段、世代号是一套的:`proc` 非空就意味着"系统里还有一个我们起的进程",
 * 收尾必须走到它真的退出为止(见 shutdown),否则新进程会 bind 不上旧进程还占着的端口。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Logger } from 'cortico/core/types.ts';

export type TtsServerPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** 收尾时等 SIGTERM 生效的时长;到点还没退就 SIGKILL */
const SHUTDOWN_GRACE_MS = 3000;

/*
 * 崩溃自动重启沿用框架 MC 观察者客户端的策略(worlds/minecraft 的 GameClient.scheduleRestart
 * 与 restartMax 默认值):上限 3 次,首次等 30 秒、之后逐次加倍,相邻两次崩溃隔 10 分钟以上计数清零。
 * 只有进程在 starting/running 中自行退出才重启;拉起失败、加载超时、人为停止都不重启。
 */
export const TTS_RESTART_MAX = 3;
const RESTART_BACKOFF_MS = 30_000;
const RESTART_WINDOW_MS = 600_000;

/** 自动重启的进度;phase=error 且 dueAt 非空 = 等着重启,phase=starting = 重启出来的进程在加载 */
export interface TtsAutoRestart {
  attempt: number;
  max: number;
  /** 计划拉起的墙钟时刻;已拉起则为 null */
  dueAt: number | null;
}

export interface TtsServerState {
  phase: TtsServerPhase;
  url: string;
  /** 缺文件/退出码之类的最近错误;phase=error 时必有 */
  detail: string | null;
  pid: number | null;
  /** phase=error 的来由:crash=进程自行退出;launch=拉起失败、缺文件或加载超时 */
  failure: 'crash' | 'launch' | null;
  /** 崩溃后的自动重启;没在重启时为 null */
  autoRestart: TtsAutoRestart | null;
  resources: TtsServerResources;
}

/**
 * 进程生命周期里 World 要转告 bot 的节点。
 * crash:进程在 starting/running 中自行退出;attempt=0 表示已到上限,不再自动重启。
 * ready:health 通过(手动启动与自动重启都会来)。
 * failed:不经进程退出的失败(拉起失败、缺文件、加载超时);autoRestart 非空表示是自动重启那一次没起来。
 */
export type TtsServerEvent =
  | { kind: 'crash'; detail: string; exitCode: number | null; attempt: number; max: number; delayMs: number }
  | { kind: 'ready'; autoRestart: number | null }
  | { kind: 'failed'; detail: string; autoRestart: number | null };

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
  /** 运行时目录:解压好的 release,或配置里自备的目录;空字符串 = 还没装 */
  runtimeDir: () => string;
  /** 运行时目录下 server 可执行文件的名字,按平台 */
  serverExe: () => string;
  /** 权重目录;配置里留空的那几项回落到这里的固定文件名 */
  modelsDir: string;
  /** 空字符串沿用 modelsDir 下的固定文件名。 */
  baseLmFile?: () => string;
  acousticFile?: () => string;
  alignerLmFile?: () => string;
  alignerAudioFile?: () => string;
  port: number;
  host?: string;
  nGpuLayers?: number;
  log: Logger;
  /** 测试注入:替换被 spawn 的命令与参数 */
  commandOverride?: { command: string; args: string[] };
  /** health 轮询间隔/上限(测试调小) */
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  /** 自动重启首次等待(测试调小);缺省 30 秒 */
  restartBackoffMs?: number;
  fetchImpl?: typeof fetch;
  onEvent?: (event: TtsServerEvent) => void;
}

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
  /**
   * 世代号:每次 start/stop 自增。健康检查的回应是异步回来的,回来先核对这个号——
   * 不是当前这一代就整个丢掉(连定时器都不许碰,那可能是新一代的)。
   */
  private gen = 0;
  /** 在途的收尾;同一个进程的重复收尾合流到它,免得后一次在进程还没死时就返回 */
  private pendingShutdown: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRestart: TtsAutoRestart | null = null;
  private failure: TtsServerState['failure'] = null;
  /** 相邻异常退出计数及上次时刻 */
  private crashCount = 0;
  private lastCrashAt = 0;

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
      failure: this.phase === 'error' ? this.failure : null,
      autoRestart: this.autoRestart ? { ...this.autoRestart } : null,
      resources: this.resolveResources(),
    };
  }

  /** 拉起进程并开始 health 轮询;已在跑则原样返回。同步返回,结果看 state()。 */
  start(): TtsServerState {
    return this.launch(null);
  }

  /** autoRestart = 自动重启的序号;人点的启动为 null,并取消等着的那次自动重启 */
  private launch(autoRestart: number | null): TtsServerState {
    if (this.phase !== 'stopped' && this.phase !== 'error') return this.state();
    // 上一代还没退干净(加载超时那条路正在收):此刻 spawn 会撞它占着的端口,等它走完再点
    if (this.proc) return this.state();
    this.clearRestartTimer();
    this.autoRestart = autoRestart === null ? null : { attempt: autoRestart, max: TTS_RESTART_MAX, dueAt: null };
    const launch = this.resolveLaunch();
    if ('error' in launch) {
      this.fail(launch.error);
      return this.state();
    }
    this.gen++;
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
      // 拉起失败就没有这个进程了:句柄留着,start 会以为"上一代还没退"而拒绝重试
      this.proc = null;
      this.fail(spawnFailDetail(err, launch.command));
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      // 只有"我们还在等它活着"时的退出才算异常:停掉(check)与加载超时收尾(fail 已给过原因)都不是新闻
      if (this.phase !== 'starting' && this.phase !== 'running') return;
      const detail = `进程退出 code=${code}${this.stderrTail ? `;stderr尾部: ${this.stderrTail.slice(-400)}` : ''}`;
      this.clearHealthTimer();
      this.phase = 'error';
      this.failure = 'crash';
      this.detail = detail;
      this.opts.log.emit('warn', 'TTS server 异常', { event: 'exit', data: { detail, exitCode: code } });
      this.scheduleRestart(detail, code);
    });
    this.beginHealthPolling();
    this.opts.log.info('TTS server 启动中', { pid: proc.pid, url: this.url });
    return this.state();
  }

  async stop(): Promise<TtsServerState> {
    this.clearHealthTimer();
    this.clearRestartTimer();
    this.autoRestart = null;
    this.gen++;
    const proc = this.proc;
    // 进程还在时不能自称 stopped:start 会据此放行,而端口还占着
    this.phase = proc ? 'stopping' : 'stopped';
    this.detail = null;
    await this.shutdown(proc);
    this.proc = null;
    this.phase = 'stopped';
    if (proc) this.opts.log.info('TTS server 已停止');
    return this.state();
  }

  /**
   * 收尾:先 SIGTERM,{@link SHUTDOWN_GRACE_MS} 内不退再 SIGKILL,并且**等它真的退出**才返回。
   * 同一个进程重复调用合流到同一次收尾——stop 连点、stop 与加载超时收尾撞上都会走到这里;
   * 各等各的话,后一次可能在进程还没死时就返回,start 随即撞端口。
   * 不改自身状态(proc/phase 归调用方管),调用方负责在返回后把 proc 清掉。
   */
  private shutdown(proc: ChildProcess | null): Promise<void> {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    this.pendingShutdown ??= (async () => {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      proc.kill();
      const force = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, SHUTDOWN_GRACE_MS);
      try {
        await exited;
      } finally {
        clearTimeout(force);
        this.pendingShutdown = null;
      }
    })();
    return this.pendingShutdown;
  }

  /** 单次健康探测;base 给出时探那个地址(外部自行启动、不在本机端口上的 server) */
  async probe(base: string = this.url): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(2000) });
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
    const runtimeDir = this.opts.runtimeDir().trim();
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
    // 运行时目录里自带 CUDA 运行库(release 配的 cudart),不去碰系统上的 CUDA Toolkit
    const env = { ...process.env };
    if (process.platform === 'win32') {
      env.PATH = `${runtimeDir};${process.env.PATH ?? ''}`;
    } else {
      const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
      env[key] = `${runtimeDir}${process.env[key] ? `:${process.env[key]}` : ''}`;
    }
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
    return { command: resources.server.path, args, cwd: runtimeDir, env };
  }

  private resolveResources(): TtsServerResources {
    const runtimeDir = this.opts.runtimeDir().trim();
    const modelsDir = this.opts.modelsDir;
    const configured = (get?: () => string): string => get?.().trim() ?? '';
    const resource = (value: string, fallback: string): TtsServerResource => {
      const path = value ? resolve(value) : fallback;
      return { path, ready: existsSync(path), configured: value.length > 0 };
    };

    const baseLm = resource(configured(this.opts.baseLmFile), join(modelsDir, 'VoxCPM2-BaseLM-F16.gguf'));
    const acoustic = resource(configured(this.opts.acousticFile), join(modelsDir, 'VoxCPM2-Acoustic-F16.gguf'));
    const alignerLmValue = configured(this.opts.alignerLmFile);
    const alignerLm = resource(alignerLmValue, join(modelsDir, 'Qwen3-Aligner-LM-F16.gguf'));
    const alignerAudioValue = configured(this.opts.alignerAudioFile);
    const alignerAudio = resource(
      alignerAudioValue,
      join(modelsDir, 'Qwen3-Aligner-Audio-F16.gguf'),
    );
    const serverPath = runtimeDir ? join(runtimeDir, this.opts.serverExe()) : '';
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
    const gen = this.gen;
    const startedAt = Date.now();
    const interval = this.opts.healthIntervalMs ?? 2000;
    const timeout = this.opts.healthTimeoutMs ?? 180_000;
    this.healthTimer = setInterval(() => {
      void (async () => {
        // 过期回执:连定时器都不许碰,那可能是新一代的
        if (gen !== this.gen) return;
        if (this.phase !== 'starting') {
          this.clearHealthTimer();
          return;
        }
        const alive = await this.probe();
        // 等回应的这段时间里可能已经被停掉/换过一代:这次的结论(不论死活)都不算数。
        // 死在下面那条超时路上的话,取到的 this.proc 已是新一代的进程
        if (gen !== this.gen || this.phase !== 'starting') return;
        if (alive) {
          this.phase = 'running';
          this.detail = null;
          this.clearHealthTimer();
          this.opts.log.info('TTS server 就绪', { url: this.url });
          const autoRestart = this.autoRestart?.attempt ?? null;
          this.autoRestart = null;
          this.opts.onEvent?.({ kind: 'ready', autoRestart });
          return;
        }
        if (Date.now() - startedAt > timeout) {
          const proc = this.proc;
          this.fail('health 检查超时(模型加载过久或端口不对)');
          // 卡住的进程收到底:等它真退出,清不掉就不清——它握着显存,句柄得留着让人再停
          void this.shutdown(proc).then(() => {
            if (this.proc === proc) this.proc = null;
          });
        }
      })();
    }, interval);
  }

  /** 不经进程退出的失败:拉起失败、缺文件、加载超时。这些不自动重启 */
  private fail(detail: string): void {
    this.clearHealthTimer();
    this.phase = 'error';
    this.failure = 'launch';
    this.detail = detail;
    this.opts.log.emit('warn', 'TTS server 异常', { data: { detail } });
    const autoRestart = this.autoRestart?.attempt ?? null;
    this.autoRestart = null;
    this.opts.onEvent?.({ kind: 'failed', detail, autoRestart });
  }

  /** 异常退出按指数退避重启;相邻崩溃间隔超过 RESTART_WINDOW_MS 时计数清零,超过上限后停止重试并报告 */
  private scheduleRestart(detail: string, exitCode: number | null): void {
    const now = Date.now();
    if (this.lastCrashAt > 0 && now - this.lastCrashAt > RESTART_WINDOW_MS) this.crashCount = 0;
    this.lastCrashAt = now;
    this.crashCount += 1;
    if (this.crashCount > TTS_RESTART_MAX) {
      this.autoRestart = null;
      this.detail = `${detail};已连续崩溃 ${TTS_RESTART_MAX} 次,不再自动重启`;
      this.opts.onEvent?.({ kind: 'crash', detail, exitCode, attempt: 0, max: TTS_RESTART_MAX, delayMs: 0 });
      return;
    }
    const attempt = this.crashCount;
    const delayMs = (this.opts.restartBackoffMs ?? RESTART_BACKOFF_MS) * 2 ** (attempt - 1);
    this.autoRestart = { attempt, max: TTS_RESTART_MAX, dueAt: now + delayMs };
    this.detail = `${detail};${Math.round(delayMs / 1000)} 秒后自动重启(第 ${attempt}/${TTS_RESTART_MAX} 次)`;
    this.opts.log.info(`TTS server 将在 ${Math.round(delayMs / 1000)} 秒后自动重启(第 ${attempt}/${TTS_RESTART_MAX} 次)`);
    this.opts.onEvent?.({ kind: 'crash', detail, exitCode, attempt, max: TTS_RESTART_MAX, delayMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch(attempt);
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }
}
