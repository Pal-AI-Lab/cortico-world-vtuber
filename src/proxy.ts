/**
 * VtuberModuleProxy — 主进程侧的演出模组。
 *
 * 真正的 VtuberModule 跑在子进程里(child.ts),这里只留不带时钟的部分:
 * 工具面与 outputTap 的消息转发、心跳状态行与控制台徽标的缓存、事件信封与
 * x-hot 配置的采样推送、以及子进程生命周期(拉起/崩溃重启/停机)。
 * 60Hz 求值注入、TTS/对齐/声卡、演出流服务全在子进程,主进程事件循环上的
 * 同步大块从此打不断帧插入。
 *
 * 装配层用它替换 VtuberModule,选项形状不变:getter 型选项在这里定期采样成
 * 快照推给子进程,回写型回调(声线档案/overlay 配置/VTS token)由子进程的
 * 通知触发。工具回执、结果事件的语义与进程内版本一致;唯一的放宽是心跳
 * 状态行与徽标走 300ms 级的推送缓存。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  World,
  WorldHost,
  Logger,
  ModuleConsoleDecl,
  OutputTap,
  ToolDef,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { emitLogNote } from 'cortico/core/ipcLogger.ts';
import { childExecArgv } from 'cortico/plugins/runtime.ts';
import { loadProfiles, profileChoices } from './models/index.ts';
import { EXAMPLE_PACK_DIR, loadPack, vocabTableRows, type PerformancePack } from './pack.ts';
import {
  PERFORM_PRESETS,
  SHUTDOWN_DRAIN_MAX_MS,
  VTUBER_CONFIG_GROUP,
  VTUBER_MODULE_DEFAULTS,
  VTUBER_PANEL_DECLS,
  VTUBER_TOOL_DECLS,
  type VtuberAlignConsole,
  type VtuberClipsConsole,
  type VtuberDiagConsole,
  type VtuberLogConsole,
  HANDOFF_NOTE,
  type VtuberModuleOptions,
  type VtuberOverlayConsole,
  type VtuberPerformConsole,
  type VtuberTtsConsole,
  type VtuberVtsConsole,
} from './module.ts';
import type {
  ChildToMain,
  EngineCast,
  EngineConfigSnapshot,
  EngineInit,
  EngineNote,
  EnginePanel,
  EngineReady,
  EngineRequest,
  HostRequest,
  SlimEvent,
} from './ipc.ts';
import { invalidActScriptShapeReceipt, normalizeExternalActScript } from './act-script.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const CHILD_ENTRY = fileURLToPath(new URL('./child.ts', import.meta.url));

/** x-hot 配置的采样周期:控制台热改最迟这么久到达子进程 */
const CONFIG_SAMPLE_MS = 1000;
/** 事件信封的转发周期:播出延迟地板的粒度远大于它 */
const EVENT_FORWARD_MS = 250;
const RESTART_DELAY_MS = 2000;
/** Windows 关控制台窗口/Ctrl+C 把整组进程打死时的退出码(STATUS_CONTROL_C_EXIT) */
const CONSOLE_KILL_EXIT_CODE = 3221225786;
/**
 * 工具与 init 的回执死线;面板另算(录制/转码这类操作以十秒计)。一律有限:
 * 主循环不许挂在任何一个工具调用上(ctx.signal 在 core 里从不赋值,没有别的兜底)。
 */
export const RPC_TIMEOUT_MS = 20_000;
/** 演出状态行进上下文的最短间隔(投递成文挂单的节流,见 armStatus) */
const STATUS_GAP_MS = 10_000;
const PANEL_RPC_TIMEOUT_MS = 120_000;
/** 停机回执死线:盖得住子进程等在播音频片放完的那一段,外加收尾余量 */
const SHUTDOWN_RPC_TIMEOUT_MS = SHUTDOWN_DRAIN_MAX_MS + 4_000;

/** 面板接口的跨进程形态:方法同名同参,返回一律 Promise */
type Asyncified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detachAbort?: () => void;
}

/**
 * 子进程的 stdout/stderr 逐行进运行日志(区域 stdio):stdout 记 debug,stderr 记 warn,
 * event 是流名。跨 chunk 的半行攒到换行再发,流关时把残段发出;空行丢弃。
 * 模组自己的日志走 IPC note,这里只收自己写 console 的部件(tsx、原生模块、崩溃前的栈)。
 */
export function attachStdio(
  child: { stdout: Readable | null; stderr: Readable | null },
  log: () => Logger | undefined,
): void {
  const forward = (stream: Readable | null, event: 'stdout' | 'stderr', level: 'debug' | 'warn'): void => {
    if (!stream) return;
    createInterface({ input: stream }).on('line', (raw) => {
      const line = raw.trim();
      if (line) log()?.child('stdio').emit(level, line, { event });
    });
  };
  forward(child.stdout, 'stdout', 'debug');
  forward(child.stderr, 'stderr', 'warn');
}


export class VtuberModuleProxy implements World {
  readonly id = 'vtuber';

  private host: WorldHost | null = null;
  private child: ChildProcess | null = null;
  private ready = false;
  private stopping = false;
  private nextReqId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private urls: EngineReady | null = null;
  private statusCache: string | null = null;
  private liveCache = false;
  /** 演出状态挂单时刻;null=没有在途挂单(见 armStatus) */
  private statusArmedAt: number | null = null;
  /** 上一份状态行实际进上下文的时刻;STATUS_GAP_MS 节流的基准 */
  private lastStatusRenderAt = 0;
  private declCache: Pick<ModuleConsoleDecl, 'lamps' | 'badges' | 'links'> = {};
  private lastConfigJson = '';
  private lastForwardedCursor = -1;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 演出包在主进程也读一份:环境提示词由主进程渲染,词表段从这里出。
   * 与子进程读的是同一目录;控制台重载只换子进程那份,前缀在下次重建时跟上。
   */
  private readonly pack: PerformancePack;

  constructor(private readonly opts: VtuberModuleOptions = {}) {
    this.pack = loadPack(opts.packDir?.trim() || EXAMPLE_PACK_DIR);
  }

  envPromptVars(): Record<string, string> {
    return { 'vtuber.vocab': vocabTableRows(this.pack) };
  }

  console(): ModuleConsoleDecl {
    return {
      // 子进程报上来之前只有一件事是确定的:引擎在不在。真模组那排灯一到就盖掉这颗。
      lamps: this.declCache.lamps ?? [this.child
        ? { label: '引擎', state: 'loading' as const, hint: '启动中' }
        : { label: '引擎', state: 'offline' as const, hint: '未启动' }],
      badges: this.declCache.badges ?? [
        { label: '引擎', value: this.child ? '启动中' : '未启动', tone: 'off' },
      ],
      panels: [...VTUBER_PANEL_DECLS],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.vtuber.envPrompt',
          title: 'VTuber · 环境提示词',
          description: '直播 / VTuber 渠道的常驻事实（形象动作、气泡、弹幕）。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{
            name: 'vtuber.vocab',
            description: '演出包词表按通道分组的表格行(动作/姿态/表情/看向/特效),来自 bot 的 vtuber-pack/vocab.json。',
            multiline: true,
          }],
        },
      ],
      links: this.declCache.links ?? [],
      config: [VTUBER_CONFIG_GROUP],
    };
  }

  /**
   * 按 console().panels[].id 的局部面板 id 声明允许调用的方法。面板可覆盖多个 EnginePanel 命名空间，分派必须与 ctx.invoke 的面板范围一致。
   * 跨命名空间的方法重名时使用链路前缀，避免 vts.state 与 tts.state 冲突。
   */
  private static readonly PANEL_METHODS: Record<string, string[]> = {
    mount: ['state', 'vtsState', 'vtsConnect', 'vtsDisconnect', 'vtsTest', 'ttsState', 'ttsStart', 'ttsStop'],
    model: ['state', 'selfCheck', 'setProfile'],
    overlay: ['state', 'setConfig', 'demo'],
    clips: ['state', 'reload', 'trigger', 'reset'],
    log: ['entries'],
    diag: ['state', 'report', 'record', 'presets', 'perform'],
    tts: ['state', 'start', 'stop', 'setProfile', 'saveVoice', 'voiceWav', 'test'],
    align: ['state', 'units', 'align', 'synth'],
  };

  /**
   * 面板通用调用面；声线 wav 按 $binary 约定返回二进制。
   */
  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    const allowed = VtuberModuleProxy.PANEL_METHODS[panel];
    if (!allowed) throw new Error(`未知面板: ${panel}`);
    if (!allowed.includes(method)) throw new Error(`未知面板方法: ${panel}.${method}`);

    if (panel === 'mount') return this.invokeMount(method, args);
    if (panel === 'model') return this.invokeModel(method, args);
    if (panel === 'diag') return this.invokeDiag(method, args);

    if (panel === 'tts' && method === 'voiceWav') {
      const b64 = await this.panelCall<string | null>('tts', 'voiceWav', args);
      if (!b64) throw new Error(`声线不存在: ${String(args[0] ?? '')}`);
      return { $binary: { mime: 'audio/wav', base64: b64 } };
    }
    if (panel === 'tts' && method === 'test') {
      return { ok: true, ...((await this.panelCall<object>('tts', 'test', args)) ?? {}) };
    }
    if (panel === 'log' && method === 'entries') {
      return { entries: await this.panelCall('log', 'entries', args) };
    }
    if (panel === 'align' && method === 'units') {
      return { units: await this.panelCall('align', 'units', args) };
    }
    if (panel === 'clips' && (method === 'trigger' || method === 'reset')) {
      return { ok: true, message: await this.panelCall<string>('clips', method, args) };
    }
    if (panel === 'overlay' && method === 'demo') {
      return { result: await this.panelCall('overlay', 'demo', args) };
    }
    return this.panelCall(panel as EnginePanel, method, args);
  }

  /**
   * 挂载面板统一读取 VTS、TTS 与演出流状态，演出流取 overlay 的 streamUp。某一路不可读时仅将该项置 null，由面板显示不可用，不影响其他链路。
   */
  private async invokeMount(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'state': {
        const [vts, tts, overlay] = await Promise.all([
          this.panelCall('vts', 'state').catch(() => null),
          this.panelCall('tts', 'state').catch(() => null),
          this.panelCall<{ url: string | null; streamUp: boolean }>('overlay', 'state').catch(() => null),
        ]);
        return {
          vts,
          tts,
          stream: overlay ? { up: overlay.streamUp, url: overlay.url } : null,
        };
      }
      case 'vtsState':
        return this.panelCall('vts', 'state');
      case 'vtsConnect':
        return this.panelCall('vts', 'connect');
      case 'vtsDisconnect':
        return this.panelCall('vts', 'disconnect');
      case 'vtsTest':
        return { ok: true, message: await this.panelCall<string>('vts', 'test', args) };
      case 'ttsState':
        return this.panelCall('tts', 'state');
      case 'ttsStart':
        return this.panelCall('tts', 'start');
      default:
        return this.panelCall('tts', 'stop');
    }
  }

  /**
   * 模型档案通过 setProfile 写入 worlds.vtuber.modelProfile 并持久化。写后立即向子进程推送配置快照，避免随后 state 请求读到采样周期前的旧值；cast 与 req 共用保序 IPC 通道。
   */
  private async invokeModel(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'setProfile') {
      const value = typeof args[0] === 'string' ? args[0].trim() : '';
      // 注册表按目录现扫:主进程与子进程各读一遍同一批文件,无需跨进程同步
      const choices = profileChoices(loadProfiles(this.opts.live2dDir?.() ?? '', { paramIds: this.pack.paramIds, fxIds: this.pack.fxIds }));
      if (!choices.some((c) => c.value === value)) {
        throw new Error(`未知模型档案: ${value || '(空)'}`);
      }
      const write = this.opts.onModelProfile;
      if (!write) throw new Error('模型档案不可切换:装配层没有提供写回口');
      write(value);
      this.pushConfigIfChanged();
      return { ok: true, configured: value };
    }
    return this.panelCall('model', method, args);
  }

  /** 「演出诊断」面板:报表(diag)与台本演出(perform)两个命名空间合成一屏。 */
  private async invokeDiag(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'state': {
        // 报表与落盘状态一起回,面板一次取数画完整屏
        const [state, report] = await Promise.all([
          this.panelCall('diag', 'state', []),
          this.panelCall('diag', 'report', []),
        ]);
        return { state, report };
      }
      case 'record':
        return { ok: true, result: await this.panelCall('diag', 'record', args) };
      case 'presets':
        // 预置台本是主进程静态数据,不经过 IPC
        return { presets: PERFORM_PRESETS.map((x) => ({ ...x })) };
      case 'perform':
        return { ok: true, message: await this.panelCall<string>('perform', 'perform', args) };
      default:
        return this.panelCall('diag', 'report', args);
    }
  }

  tools(): ToolDef[] {
    return VTUBER_TOOL_DECLS.map((decl) => this.toolDefFor(decl));
  }

  /** 把一条工具声明绑成走子进程 RPC 的 ToolDef。 */
  private toolDefFor(decl: Omit<ToolDef, 'handler'>): ToolDef {
    return {
      ...decl,
      handler: async (args, ctx) => {
        if (decl.name === 'vtuber_act' && typeof args.script === 'string') {
          const normalization = normalizeExternalActScript(args.script);
          if (!normalization.ok) {
            this.host?.log.child('script-shape').emit('warn', `${normalization.code}:代理拒绝外部容器形状`, {
              event: 'reject',
              data: { code: normalization.code },
            });
            return invalidActScriptShapeReceipt();
          }
        }
        try {
          return (await this.rpc(
            { kind: 'tool', name: decl.name, args, role: ctx.role, callId: ctx.callId ?? null, round: ctx.round ?? null },
            RPC_TIMEOUT_MS,
            ctx.signal,
          )) as string;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `[${decl.name} 失败] 演出引擎进程不可用:${msg}`;
        }
      },
    };
  }

  /**
   * 输出旁路:增量原样转发进子进程,那边的真模组做流式解析与排队裁决。
   * reasoning 增量不过界——演出链路不读它,省一半流量。
   */
  outputTap(): OutputTap {
    return {
      externalizes: event => event.type === 'response.output_item.added' && event.item?.type === 'function_call'
        && event.item.name === 'vtuber_act',
      onEvent: event => { this.cast({ kind: 'tap', event }); },
      onRoundEnd: () => this.cast({ kind: 'tap-round-end' }),
      onAbort: (reason) => this.cast({ kind: 'tap-abort', reason }),
    };
  }

  /** 演出状态一行;子进程状态推送的缓存,新鲜度 300ms 级 */
  statusLine(): string | null {
    return this.ready ? this.statusCache : null;
  }

  /** 在播判据来自子进程状态推送(overlay 有消费者);崩溃重启的空窗算不在播 */
  get live(): boolean {
    return this.ready && this.liveCache;
  }

  /**
   * 演出状态行的挂单(投递成文):在播时保持一条 piggyback 在途,
   * 状态推送(~300ms)顺路驱动补挂。不唤醒,搭下一班投递走,发车刻读缓存现拿;
   * 进上下文的频率由 STATUS_GAP_MS 节流。渲染时不在播 → null 蒸发。
   */
  private armStatus(): void {
    if (!this.host || !this.live) return;
    const now = Date.now();
    if (this.statusArmedAt !== null && now - this.statusArmedAt < 300_000) return;
    if (now - this.lastStatusRenderAt < STATUS_GAP_MS) return;
    this.statusArmedAt = now;
    this.host.pushDeferred(
      {
        type: 'vtuber.status',
        senderKey: 'vtuber',
        tags: ['snapshot'],
        render: () => {
          this.statusArmedAt = null;
          const at = Date.now();
          if (at - this.lastStatusRenderAt < 1000) return null; // 同批双份兜底
          if (!this.live) return null;
          const line = this.statusLine();
          if (!line) return null;
          this.lastStatusRenderAt = at;
          return line;
        },
      },
      { trigger: 'piggyback' },
    );
  }

  /** 交接后的开口提示直接由代理侧推,不过子进程:它不依赖引擎状态。 */
  onHandoff(): void {
    void this.host
      ?.pushEvent(
        { ts: new Date().toISOString(), source: this.id, type: 'worlds.note', origin: 'internal', text: HANDOFF_NOTE },
        { trigger: 'flush' },
      )
      .catch((e) => this.host?.log.warn('交接开口提示投递失败', { err: String(e) }));
  }

  get streamUrl(): string {
    return this.urls?.streamUrl ?? '';
  }

  get danmakuUrl(): string {
    return this.urls?.danmakuUrl ?? '';
  }

  get overlayUrl(): string {
    return this.urls?.overlayUrl ?? '';
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopping = false;
    // 地板扫描只关心启动之后的事件;历史信封不补
    this.lastForwardedCursor = host.store.latestCursor();
    await this.spawn();
    this.configTimer = setInterval(() => this.pushConfigIfChanged(), CONFIG_SAMPLE_MS);
    this.configTimer.unref?.();
    this.eventTimer = setInterval(() => this.forwardEvents(), EVENT_FORWARD_MS);
    this.eventTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.configTimer) clearInterval(this.configTimer);
    this.configTimer = null;
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.eventTimer = null;
    const child = this.child;
    if (child) {
      try {
        await this.rpc({ kind: 'shutdown' }, SHUTDOWN_RPC_TIMEOUT_MS);
      } catch {
        /* 停机死线内没回执就直接杀 */
      }
      await waitExit(child, 3000);
      if (child.exitCode === null && !child.killed) child.kill();
    }
    this.teardownChild();
    this.host = null;
  }


  vtsConsole(): Asyncified<VtuberVtsConsole> {
    return {
      state: () => this.panelCall('vts', 'state'),
      connect: () => this.panelCall('vts', 'connect'),
      disconnect: () => this.panelCall('vts', 'disconnect'),
      test: () => this.panelCall('vts', 'test'),
    };
  }

  ttsConsole(): Asyncified<VtuberTtsConsole> {
    return {
      state: () => this.panelCall('tts', 'state'),
      start: () => this.panelCall('tts', 'start'),
      stop: () => this.panelCall('tts', 'stop'),
      setProfile: (patch) => this.panelCall('tts', 'setProfile', [patch]),
      saveVoice: (name, audioBase64) => this.panelCall('tts', 'saveVoice', [name, audioBase64]),
      voiceWav: (file) => this.panelCall('tts', 'voiceWav', [file]),
      test: (text, profile) => this.panelCall('tts', 'test', [text, profile]),
    };
  }

  alignConsole(): Asyncified<VtuberAlignConsole> {
    return {
      state: () => this.panelCall('align', 'state'),
      units: (text) => this.panelCall('align', 'units', [text]),
      align: (audioBase64, text, units) => this.panelCall('align', 'align', [audioBase64, text, units]),
      synth: (text) => this.panelCall('align', 'synth', [text]),
    };
  }

  logConsole(): Asyncified<VtuberLogConsole> {
    return {
      entries: (after) => this.panelCall('log', 'entries', [after]),
    };
  }

  diagConsole(): Asyncified<VtuberDiagConsole> {
    return {
      state: () => this.panelCall('diag', 'state'),
      report: () => this.panelCall('diag', 'report'),
      record: (ms, params) => this.panelCall('diag', 'record', [ms, params]),
    };
  }

  performConsole(): Asyncified<VtuberPerformConsole> {
    return {
      // 预置台本是主进程静态数据,不经过 IPC。
      presets: async () => PERFORM_PRESETS.map((p) => ({ ...p })),
      perform: (script) => this.panelCall('perform', 'perform', [script]),
    };
  }

  clipsConsole(): Asyncified<VtuberClipsConsole> {
    return {
      state: () => this.panelCall('clips', 'state'),
      reload: () => this.panelCall('clips', 'reload'),
      trigger: (kind, clipId, intensity) => this.panelCall('clips', 'trigger', [kind, clipId, intensity]),
      reset: () => this.panelCall('clips', 'reset'),
    };
  }

  overlayConsole(): Asyncified<VtuberOverlayConsole> {
    return {
      state: () => this.panelCall('overlay', 'state'),
      setConfig: (patch) => this.panelCall('overlay', 'setConfig', [patch]),
      demo: (kind) => this.panelCall('overlay', 'demo', [kind]),
    };
  }


  private async spawn(): Promise<void> {
    const child = fork(CHILD_ENTRY, [], {
      // tsx 的 ESM 钩子(跑 TS 源)加上框架的 `cortico/*` 解析钩子:child.ts 那边
      // 同样 import `cortico/core/ipcLogger.ts`,少了后者子进程起不来。
      execArgv: childExecArgv(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    attachStdio(child, () => this.host?.log);
    child.on('message', (msg) => this.onMessage(msg as ChildToMain));
    child.on('exit', (code) => this.onExit(code));
    child.on('error', (err) => {
      const msg = String(err);
      // 关机阶段子进程已退出后的管道写入可产生 EPIPE，降低日志级别但保留记录。
      const noise = this.stopping || /EPIPE|ERR_IPC_CHANNEL_CLOSED/.test(msg);
      if (noise) this.host?.log.debug('演出引擎子进程管道已关', { err: msg });
      else this.host?.log.error('演出引擎子进程出错', { err: msg });
    });
    const ready = (await this.rpc({ kind: 'init', init: this.buildInit() }, 30_000)) as EngineReady;
    this.urls = ready;
    this.ready = true;
    this.host?.log.info(`演出引擎子进程已就绪 pid=${child.pid}`, { overlay: ready.overlayUrl });
  }

  private teardownChild(): void {
    this.child = null;
    this.ready = false;
    this.urls = null;
    this.statusCache = null;
    this.liveCache = false;
    this.statusArmedAt = null;
    this.declCache = {};
    this.lastConfigJson = '';
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.detachAbort?.();
      p.reject(new Error('演出引擎子进程已退出'));
    }
    this.pending.clear();
  }

  private onExit(code: number | null): void {
    const wasStopping = this.stopping;
    this.teardownChild();
    if (wasStopping) return;
    if (code === CONSOLE_KILL_EXIT_CODE) {
      // 子进程随控制台窗口一起被打死:这是人为关停不是崩溃,整机跟着退,别对着空气重启
      this.host?.log.warn('演出引擎子进程随控制台关闭退出(0xC000013A),判定人为关停,整机退出');
      if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT');
      else process.exit(0);
      return;
    }
    this.host?.log.error(`演出引擎子进程意外退出(code=${code}),${RESTART_DELAY_MS / 1000}s 后重启`);
    /*
     * 非关机阶段的子进程退出必须投递给 agent，报告演出接入中断。
     */
    void this.host
      ?.pushEvent(
        {
          ts: nowIso(this.opts.timezone ?? 'Asia/Shanghai'),
          source: this.id,
          type: 'worlds.note',
          // 模组报自己这一侧机制的话:进 user 区,不进事件帧。
          origin: 'internal',
          text:
            `[演出] 演出引擎子进程意外退出(code=${code}),画面与声音这段时间都停了;` +
            `${RESTART_DELAY_MS / 1000}s 后自动重启。`,
        },
        { trigger: 'flush' },
      )
      .catch((e: unknown) => this.host?.log.warn('子进程退出事件投递失败', { err: String(e) }));
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.spawn().catch((err: unknown) => {
        this.host?.log.error('演出引擎子进程重启失败,继续重试', { err: String(err) });
        this.teardownChild();
        this.scheduleRestart();
      });
    }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }


  private onMessage(msg: ChildToMain): void {
    if (msg.t === 'rep') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.detachAbort?.();
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error ?? '子进程报错'));
      return;
    }
    if (msg.t === 'hreq') {
      void this.onHostRequest(msg.id, msg.req);
      return;
    }
    this.onNote(msg.note);
  }

  /** 子进程里模组的宿主调用:在真 host 上执行,把真实结果送回去 */
  private async onHostRequest(id: number, req: HostRequest): Promise<void> {
    const child = this.child;
    try {
      const host = this.host;
      if (!host) throw new Error('宿主未接线');
      let value: unknown;
      if (req.kind === 'push') {
        value = await host.pushEvent(req.evt, req.opts);
      } else if (req.kind === 'drain') {
        value = await host.drainPendingEvents((e) => e.source === this.id);
      } else if (req.kind === 'stalls') {
        // 宿主没接线时报 0:分辨不出来就别乱说"卡了几次"
        value = (await host.llmStalls?.(req.withinMs)) ?? 0;
      }
      child?.send({ t: 'hrep', id, ok: true, value });
    } catch (err) {
      child?.send({ t: 'hrep', id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private onNote(note: EngineNote): void {
    const host = this.host;
    if (!host) return;
    switch (note.kind) {
      case 'log':
        emitLogNote(host.log, note, this.opts.timezone ?? 'Asia/Shanghai');
        return;
      case 'usage':
        host.reportUsage(note.usage, note.opts);
        return;
      case 'status':
        this.statusCache = note.line;
        this.liveCache = note.live;
        this.declCache = note.decl;
        // 状态推送 ~300ms 一次,顺路当演出状态挂单的驱动时钟
        this.armStatus();
        return;
      case 'tts-profile':
        this.opts.onTtsProfile?.(note.profile);
        return;
      case 'overlay-config':
        this.opts.onOverlayConfig?.(note.config);
        return;
      case 'vts-token':
        this.opts.onVtsToken?.(note.token);
        return;
    }
  }

  private rpc(req: EngineRequest, timeoutMs: number | null, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child || !child.connected) return Promise.reject(new Error('演出引擎子进程未运行'));
    if (signal?.aborted) return Promise.reject(new Error('工具调用已取消'));
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const cancel = (reason: Error): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.detachAbort?.();
        if (child.connected) child.send({ t: 'cancel', id });
        reject(reason);
      };
      const timer = timeoutMs === null
        ? null
        : setTimeout(() => {
            this.host?.log.error('演出引擎请求超时', {
              requestId: id,
              kind: req.kind,
              ...(req.kind === 'tool' ? { tool: req.name, callId: req.callId } : {}),
              timeoutMs,
              childPid: child.pid,
              connected: child.connected,
              lastStatus: this.statusCache,
            });
            cancel(new Error(`子进程 ${timeoutMs / 1000}s 未回执(${req.kind})`));
          }, timeoutMs);
      timer?.unref?.();
      const onAbort = (): void => cancel(new Error('工具调用已取消'));
      const detachAbort = signal ? () => signal.removeEventListener('abort', onAbort) : undefined;
      this.pending.set(id, { resolve, reject, timer, ...(detachAbort ? { detachAbort } : {}) });
      signal?.addEventListener('abort', onAbort, { once: true });
      child.send({ t: 'req', id, req });
    });
  }

  private cast(cast: EngineCast): void {
    const child = this.child;
    if (!child || !child.connected) return;
    child.send({ t: 'cast', cast });
  }

  private panelCall<T>(
    panel: EnginePanel,
    method: string,
    args: unknown[] = [],
    timeoutMs = PANEL_RPC_TIMEOUT_MS,
  ): Promise<T> {
    // 序列化前移除末尾 undefined,避免 JSON 将其转换为 null。
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    // 路径选择保存后可能立刻读状态或启动服务；先投最新配置，保证这次 RPC
    // 与刚写入的外置资源路径处于同一顺序。
    this.pushConfigIfChanged();
    return this.rpc({ kind: 'panel', panel, method, args }, timeoutMs) as Promise<T>;
  }


  private buildInit(): EngineInit {
    const o = this.opts;
    return {
      timezone: o.timezone ?? 'Asia/Shanghai',
      botName: o.botName ?? 'bot',
      vtsWsUrl: o.vtsWsUrl ?? VTUBER_MODULE_DEFAULTS.vtsWsUrl,
      streamPort: o.streamPort ?? VTUBER_MODULE_DEFAULTS.streamPort,
      ttsUrl: o.ttsUrl ?? VTUBER_MODULE_DEFAULTS.ttsUrl,
      ttsServerDir: o.ttsServerDir ?? null,
      packDir: o.packDir ?? null,
      diagDir: o.diagDir ?? null,
      vtsAuthToken: o.vtsAuthToken ?? null,
      ttsProfile: o.ttsProfile ?? null,
      overlay: o.overlay ?? null,
      config: this.sampleConfig(),
    };
  }

  /**
   * getter 型选项采样成快照。键的在场集只看装配层给没给 getter,取值缺失时
   * 落到模组默认——JSON 序列化会丢 undefined 值的键,而子进程在 init 时按
   * 键的在场集定死了 getter 集,在场集必须每次一致。
   */
  private sampleConfig(): EngineConfigSnapshot {
    const o = this.opts;
    const d = VTUBER_MODULE_DEFAULTS;
    const s: EngineConfigSnapshot = {};
    if (o.audioDevice) s.audioDevice = o.audioDevice() ?? d.audioDevice;
    if (o.audioMirrorSystem) s.audioMirrorSystem = o.audioMirrorSystem() ?? d.audioMirrorSystem;
    if (o.audioSecondary) s.audioSecondary = o.audioSecondary() ?? d.audioSecondary;
    if (o.alignEnabled) s.alignEnabled = o.alignEnabled() ?? d.alignEnabled;
    if (o.streamEnabled) s.streamEnabled = o.streamEnabled() ?? d.streamEnabled;
    if (o.speechCapSec) s.speechCapSec = o.speechCapSec() ?? d.speechCapSec;
    if (o.maxActRoundsPerTurn) s.maxActRoundsPerTurn = o.maxActRoundsPerTurn() ?? d.maxActRoundsPerTurn;
    if (o.silenceRemindSec) s.silenceRemindSec = o.silenceRemindSec() ?? d.silenceRemindSec;
    if (o.mutedText) s.mutedText = o.mutedText() ?? '';
    if (o.obsDelaySec) s.obsDelaySec = o.obsDelaySec() ?? d.obsDelaySec;
    if (o.delayedSources) s.delayedSources = o.delayedSources() ?? [];
    if (o.yieldWindowMs) s.yieldWindowMs = o.yieldWindowMs() ?? d.yieldWindowMs;
    if (o.yieldFadeMs) s.yieldFadeMs = o.yieldFadeMs() ?? d.yieldFadeMs;
    if (o.decaySec) {
      s.decaySec = o.decaySec() ?? {
        gaze: [...d.decayGazeSec] as [number, number],
        pose: [...d.decayPoseSec] as [number, number],
        emotion: [...d.decayEmotionSec] as [number, number],
      };
    }
    if (o.modelProfile) s.modelProfile = o.modelProfile() ?? d.modelProfile;
    if (o.ttsBaseLmFile) s.ttsBaseLmFile = o.ttsBaseLmFile() ?? d.ttsBaseLmFile;
    if (o.ttsAcousticFile) s.ttsAcousticFile = o.ttsAcousticFile() ?? d.ttsAcousticFile;
    if (o.ttsAlignerLmFile) s.ttsAlignerLmFile = o.ttsAlignerLmFile() ?? d.ttsAlignerLmFile;
    if (o.ttsAlignerAudioFile) s.ttsAlignerAudioFile = o.ttsAlignerAudioFile() ?? d.ttsAlignerAudioFile;
    if (o.ttsVoicesDir) s.ttsVoicesDir = o.ttsVoicesDir() ?? d.ttsVoicesDir;
    if (o.live2dDir) s.live2dDir = o.live2dDir() ?? d.live2dDir;
    return s;
  }

  private pushConfigIfChanged(): void {
    if (!this.ready) return;
    const config = this.sampleConfig();
    const json = JSON.stringify(config);
    if (json === this.lastConfigJson) return;
    this.lastConfigJson = json;
    this.cast({ kind: 'config', config });
  }

  /** 新到的事件信封瘦身后转发;播出延迟地板在子进程里按它们扫 */
  private forwardEvents(): void {
    const store = this.host?.store;
    if (!store || !this.ready) return;
    const latest = store.latestCursor();
    if (latest <= this.lastForwardedCursor) return;
    const events: SlimEvent[] = [];
    for (let c = this.lastForwardedCursor + 1; c <= latest; c++) {
      const e = store.get(c);
      // 只转外部事件:防先知穿帮问的是"观众从延迟画面里看到了什么",内部项不经画面
      if (e && e.origin === 'external') events.push({ cursor: e.cursor, ts: e.ts, source: e.source });
    }
    this.lastForwardedCursor = latest;
    if (events.length > 0) this.cast({ kind: 'events', events });
  }
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
