/**
 * 演出引擎子进程入口(经 proxy.ts fork,不手动运行)。
 *
 * VtuberWorld 在子进程运行。日志和用量使用单向通知，需回执的宿主调用使用
 * hreq/hrep。事件库仅重放播出延迟计算所需的 cursor、ts 与 source；range/grep
 * 返回空结果。
 */
import { createIpcLogger } from 'cortico/core/ipc-logger.ts';
import { withAnchors } from 'cortico/core/log-context.ts';
import {
  VTUBER_DEFAULTS,
  VtuberWorld,
  type VtuberWorldOptions,
} from './world.ts';
import type {
  ChildToMain,
  EngineConfigSnapshot,
  EngineInit,
  EnginePanel,
  EngineReady,
  EngineRequest,
  HostRequest,
  MainToChild,
  SlimEvent,
} from './engine-ipc.ts';
import type {
  EventEnvelope,
  EventStoreReader,
  WorldHost,
  Logger,
  OutputTap,
  ToolDef,
} from 'cortico/core/types.ts';

function send(msg: ChildToMain): void {
  if (!process.connected || !process.send) return;
  // The channel can close after the connected check. Supplying a callback keeps
  // that race on this send instead of raising ERR_IPC_CHANNEL_CLOSED on process.
  process.send(msg, () => {});
}

const makeLogger = (area: string): Logger => createIpcLogger((note) => send({ t: 'note', note }), area);

/** Bounded event-store view over retained slim envelopes; older cursors are unavailable. */
class SlimEventStore implements EventStoreReader {
  private readonly byCursor = new Map<number, EventEnvelope>();
  private readonly order: number[] = [];

  push(events: SlimEvent[]): void {
    for (const s of events) {
      this.byCursor.set(s.cursor, {
        cursor: s.cursor,
        ts: s.ts,
        source: s.source,
        // 防先知穿帮只读 source/ts;别的字段瘦身时就没过界,填空占位
        origin: 'external',
        type: '',
        text: '',
      });
      this.order.push(s.cursor);
      if (this.order.length > 512) {
        const drop = this.order.shift();
        if (drop !== undefined) this.byCursor.delete(drop);
      }
    }
  }

  get(cursor: number): EventEnvelope | undefined {
    return this.byCursor.get(cursor);
  }

  latestCursor(): number {
    return this.order.length > 0 ? this.order[this.order.length - 1] : -1;
  }

  range(): EventEnvelope[] {
    return [];
  }

  around(): EventEnvelope[] {
    return [];
  }

  grep(): [] {
    return [];
  }
}

const store = new SlimEventStore();
// 根 logger 不带区域名:主进程那侧的 host.log 已经是本 World 的区域,
// 这里再冠一层会让日志落成 core.worlds.vtuber.vtuber
const log = makeLogger('');

const HOST_RPC_TIMEOUT_MS = 10_000;
let nextHostReqId = 1;
const pendingHost = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function hostRpc(req: HostRequest): Promise<unknown> {
  if (!process.connected) return Promise.reject(new Error('主进程 IPC 已断开'));
  const id = nextHostReqId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(new Error(`主进程 ${HOST_RPC_TIMEOUT_MS / 1000}s 未回执宿主调用(${req.kind})`));
    }, HOST_RPC_TIMEOUT_MS);
    timer.unref?.();
    pendingHost.set(id, { resolve, reject, timer });
    send({ t: 'hreq', id, req });
  });
}

// 同步成员无法跨进程边界。不可用成员必须显式失败;占位返回会违反调用方依赖的
// 事实可用性契约。
const unavailable = (what: string): never => {
  throw new Error(`${what} 在子进程宿主里不可用`);
};

const host: WorldHost = {
  // 附件随记录过界要走字节序列化,子进程侧不推带附件的事件。
  pushEvent: (e, opts) => hostRpc({ kind: 'push', evt: e as Parameters<typeof host.pushEvent>[0] & { blobs?: undefined }, opts }) as Promise<EventEnvelope>,
  // 渲染回调过不了进程边界;演出状态行的投递成文挂单由主进程代理侧实现(proxy.armStatus)
  pushDeferred: () => unavailable('pushDeferred'),
  store,
  // filter 函数过不了进程边界:主进程按"本 World 来源"筛,drain 语义只窄不宽
  drainPendingEvents: () => hostRpc({ kind: 'drain' }) as Promise<EventEnvelope[]>,
  modelFacts: {
    model: () => unavailable('modelFacts.model'),
    accepts: () => unavailable('modelFacts.accepts'),
    contextWindow: () => unavailable('modelFacts.contextWindow'),
  },
  blob: () => unavailable('blob'),
  reportUsage: (usage, opts) => send({ t: 'note', note: { kind: 'usage', usage, opts } }),
  llmStalls: (withinMs) => hostRpc({ kind: 'stalls', withinMs }) as Promise<number>,
  log,
};

let mod: VtuberWorld | null = null;
let tap: OutputTap | null = null;
let tools = new Map<string, ToolDef>();
let panels: Record<EnginePanel, Record<string, unknown>> | null = null;
let snap: EngineConfigSnapshot = {};
let statusTimer: ReturnType<typeof setInterval> | null = null;
let lastStatus = '';
let shuttingDown = false;

/** init 快照里在场的键才建 getter:键缺席 = 装配层没提供,World 用自己的默认 */
function configGetters(initial: EngineConfigSnapshot): Partial<VtuberWorldOptions> {
  snap = initial;
  const out: Partial<VtuberWorldOptions> = {};
  if ('audioDevice' in initial) out.audioDevice = () => snap.audioDevice ?? VTUBER_DEFAULTS.audioDevice;
  if ('audioMirrorSystem' in initial) {
    out.audioMirrorSystem = () => snap.audioMirrorSystem ?? VTUBER_DEFAULTS.audioMirrorSystem;
  }
  if ('audioSecondary' in initial) {
    out.audioSecondary = () => snap.audioSecondary ?? VTUBER_DEFAULTS.audioSecondary;
  }
  if ('alignEnabled' in initial) out.alignEnabled = () => snap.alignEnabled === true;
  if ('streamEnabled' in initial) out.streamEnabled = () => snap.streamEnabled === true;
  if ('speechCapSec' in initial) out.speechCapSec = () => snap.speechCapSec as number;
  if ('maxActRoundsPerTurn' in initial) out.maxActRoundsPerTurn = () => snap.maxActRoundsPerTurn as number;
  if ('silenceRemindSec' in initial) out.silenceRemindSec = () => snap.silenceRemindSec as number;
  if ('mutedText' in initial) out.mutedText = () => snap.mutedText ?? '';
  if ('obsDelaySec' in initial) out.obsDelaySec = () => snap.obsDelaySec as number;
  if ('delayedSources' in initial) out.delayedSources = () => snap.delayedSources ?? [];
  if ('yieldWindowMs' in initial) out.yieldWindowMs = () => snap.yieldWindowMs as number;
  if ('yieldFadeMs' in initial) out.yieldFadeMs = () => snap.yieldFadeMs as number;
  if ('decaySec' in initial) out.decaySec = () => snap.decaySec as NonNullable<EngineConfigSnapshot['decaySec']>;
  if ('modelProfile' in initial) out.modelProfile = () => snap.modelProfile as string;
  if ('ttsBaseLmFile' in initial) {
    out.ttsBaseLmFile = () => snap.ttsBaseLmFile ?? VTUBER_DEFAULTS.ttsBaseLmFile;
  }
  if ('ttsAcousticFile' in initial) {
    out.ttsAcousticFile = () => snap.ttsAcousticFile ?? VTUBER_DEFAULTS.ttsAcousticFile;
  }
  if ('ttsAlignerLmFile' in initial) {
    out.ttsAlignerLmFile = () => snap.ttsAlignerLmFile ?? VTUBER_DEFAULTS.ttsAlignerLmFile;
  }
  if ('ttsAlignerAudioFile' in initial) {
    out.ttsAlignerAudioFile = () => snap.ttsAlignerAudioFile ?? VTUBER_DEFAULTS.ttsAlignerAudioFile;
  }
  if ('ttsVoicesDir' in initial) {
    out.ttsVoicesDir = () => snap.ttsVoicesDir ?? VTUBER_DEFAULTS.ttsVoicesDir;
  }
  if ('live2dDir' in initial) out.live2dDir = () => snap.live2dDir ?? VTUBER_DEFAULTS.live2dDir;
  return out;
}

async function handleInit(init: EngineInit): Promise<EngineReady> {
  const m = new VtuberWorld({
    timezone: init.timezone,
    botName: init.botName,
    vtsWsUrl: init.vtsWsUrl,
    streamPort: init.streamPort,
    ttsUrl: init.ttsUrl,
    ...(init.packDir ? { packDir: init.packDir } : {}),
    ...(init.diagDir ? { diagDir: init.diagDir } : {}),
    ...(init.vtsAuthToken ? { vtsAuthToken: init.vtsAuthToken } : {}),
    ...(init.ttsProfile ? { ttsProfile: init.ttsProfile } : {}),
    ...(init.overlay ? { overlay: init.overlay } : {}),
    onTtsProfile: (profile) => send({ t: 'note', note: { kind: 'tts-profile', profile } }),
    onOverlayConfig: (config) => send({ t: 'note', note: { kind: 'overlay-config', config } }),
    onVtsToken: (token) => send({ t: 'note', note: { kind: 'vts-token', token } }),
    ...configGetters(init.config),
  });
  await m.start(host);
  mod = m;
  tap = m.outputTap();
  tools = new Map(m.tools().map((t) => [t.name, t]));
  panels = {
    vts: m.vtsConsole() as unknown as Record<string, unknown>,
    tts: m.ttsConsole() as unknown as Record<string, unknown>,
    align: m.alignConsole() as unknown as Record<string, unknown>,
    log: m.logConsole() as unknown as Record<string, unknown>,
    diag: m.diagConsole() as unknown as Record<string, unknown>,
    perform: m.performConsole() as unknown as Record<string, unknown>,
    clips: m.clipsConsole() as unknown as Record<string, unknown>,
    overlay: m.overlayConsole() as unknown as Record<string, unknown>,
    model: m.modelConsole() as unknown as Record<string, unknown>,
  };
  statusTimer = setInterval(pushStatus, 300);
  statusTimer.unref?.();
  return { streamUrl: m.streamUrl, danmakuUrl: m.danmakuUrl, overlayUrl: m.overlayUrl };
}

/** 状态行与徽标推给主进程缓存(心跳与控制台读缓存,不跨进程拉) */
function pushStatus(): void {
  if (!mod) return;
  const decl = mod.console();
  const note = {
    kind: 'status' as const,
    line: mod.statusLine(),
    live: mod.live,
    decl: { lamps: decl.lamps, badges: decl.badges, links: decl.links },
  };
  const key = JSON.stringify(note);
  if (key === lastStatus) return;
  lastStatus = key;
  send({ t: 'note', note });
}

async function handleRequest(req: EngineRequest, signal: AbortSignal): Promise<unknown> {
  if (shuttingDown) throw new Error('演出引擎正在停机');
  if (req.kind === 'init') {
    if (mod) throw new Error('已经 init 过了');
    return handleInit(req.init);
  }
  if (req.kind === 'shutdown') {
    shuttingDown = true;
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    const reason = new Error('演出引擎正在停机');
    for (const controller of activeRequests.values()) controller.abort(reason);
    await mod?.stop();
    mod = null;
    setImmediate(() => process.exit(0));
    return null;
  }
  if (!mod) throw new Error('演出引擎还没 init');
  if (req.kind === 'tool') {
    const tool = tools.get(req.name);
    if (!tool) throw new Error(`未知工具「${req.name}」`);
    return withAnchors({ sess: req.role, ...(req.callId ? { call: req.callId } : {}), ...(req.round !== null ? { round: req.round } : {}) }, () => tool.handler(req.args, {
      role: req.role,
      log,
      signal,
      ...(req.callId ? { callId: req.callId } : {}),
      ...(req.round !== null ? { round: req.round } : {}),
    }));
  }
  const panel = panels?.[req.panel];
  const method = panel?.[req.method];
  if (typeof method !== 'function') throw new Error(`未知面板方法 ${req.panel}.${req.method}`);
  return (method as (...args: unknown[]) => unknown).apply(panel, req.args);
}

const activeRequests = new Map<number, AbortController>();

process.on('message', (msg: MainToChild) => {
  if (msg.t === 'req') {
    const controller = new AbortController();
    activeRequests.set(msg.id, controller);
    void Promise.resolve()
      .then(() => handleRequest(msg.req, controller.signal))
      .then(
        (value) => send({ t: 'rep', id: msg.id, ok: true, value }),
        (err: unknown) =>
          send({ t: 'rep', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => activeRequests.delete(msg.id));
    return;
  }
  if (msg.t === 'cancel') {
    activeRequests.get(msg.id)?.abort(new Error('主进程已取消工具调用'));
    return;
  }
  if (msg.t === 'hrep') {
    const p = pendingHost.get(msg.id);
    if (!p) return;
    pendingHost.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error ?? '宿主调用失败'));
    return;
  }
  if (shuttingDown) return;
  const cast = msg.cast;
  switch (cast.kind) {
    case 'tap':
      tap?.onEvent(cast.event);
      return;
    case 'tap-round-end':
      tap?.onRoundEnd?.();
      return;
    case 'tap-abort':
      tap?.onAbort?.(cast.reason);
      return;
    case 'config':
      snap = cast.config;
      return;
    case 'events':
      store.push(cast.events);
      return;
  }
});

// 父进程没了就跟着退,不留孤儿(连带音频/演出流句柄)
process.on('disconnect', () => {
  shuttingDown = true;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  const error = new Error('主进程 IPC 已断开');
  for (const controller of activeRequests.values()) controller.abort(error);
  for (const pending of pendingHost.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingHost.clear();
  const m = mod;
  if (!m) {
    process.exit(0);
  }
  void m.stop().finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  log.emit('error', '子进程未捕获异常', { event: 'uncaught-exception', err });
  process.exit(1);
});
