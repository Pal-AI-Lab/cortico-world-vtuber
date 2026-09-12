/**
 * VTube Studio Public API 客户端，提供认证、参数注入与表情开关。
 * 半开连接可保持 OPEN 且 send 成功，close 握手不能及时判定存活。采用分层超时、独立 ping-pong 心跳与连续无应答检测；判死后 terminate，不等对端 Close，再指数退避重连。
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const API_NAME = 'VTubeStudioPublicAPI';
const API_VERSION = '1.0';

/** 逐帧注入的超时。皮套冻结按秒计价,等不起控制类的 5 秒。 */
const INJECT_TIMEOUT_MS = 2_000;
/** 认证、表情开关、参数读回等控制类请求 */
const CONTROL_TIMEOUT_MS = 5_000;
/**
 * AuthenticationTokenRequest 单独放宽:它要等人在 VTS 窗口里点「允许」,
 * 按控制类 5 秒会在人还没抬手时就超时,并把 token 申请判成失败。
 */
const AUTH_POPUP_TIMEOUT_MS = 60_000;
/** 看门狗节拍;心跳每 PING_TICKS 个节拍发一次 */
const WATCH_TICK_MS = 1_000;
const PING_TICKS = 5;
/** 有请求在途却这么久没收到对端任何一条消息 → 判半开 */
const NO_ACK_MS = 3_000;
/**
 * 连续这么多次请求超时即熔断。上层 VTS_STALL_STREAK=4 是「告知她」的阈值,
 * 故意排在这个数之后:先自救,救不回来再打断她。
 */
const TIMEOUT_STREAK_LIMIT = 3;
/** 重连退避阶梯,封顶 5 秒:皮套冻结的每一秒都在直播上 */
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000];
/** close() 等对端 Close 帧的死线;超了自己 terminate,不让 World stop 陪 ws 库耗满 30 秒 */
const CLOSE_DEADLINE_MS = 1_000;

export interface VtsClientOptions {
  url?: string;
  pluginName?: string;
  pluginDeveloper?: string;
  /** 已授权 token；空则走一次 AuthenticationTokenRequest */
  authToken?: string;
  onToken?: (token: string) => void;
  /**
   * 熔断/重连/恢复各一条事实陈述;不传则这三件事只在连接内部发生。
   * event 是机器可读小类:reconnected / subscribe-failed / breaker / reconnect-stopped / reconnect。
   */
  log?: (event: string, msg: string, fields: Record<string, string | number>) => void;
  /**
   * token 被 VTS 判无效(true)与此后重新认证成功(false)。只在状态翻转时各调一次。
   *
   * 判无效之后自动重连就永久停了,皮套从此静默冻死——只有日志的话没人会知道。
   * 上层据此报障并在恢复时解除。
   */
  onAuthRejected?: (rejected: boolean) => void;
}

type Pending = {
  /** 发出时的连接世代;换过 socket 之后的应答与超时一律丢弃 */
  gen: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
};

/** 参数读回的一行:实时值 + 默认值 */
export interface VtsParamValue {
  name: string;
  value: number;
  defaultValue: number;
}

function pickParamValues(
  list: Array<{ name?: string; value?: number; defaultValue?: number }> | undefined,
): VtsParamValue[] {
  const out: VtsParamValue[] = [];
  for (const p of list ?? []) {
    if (typeof p.name !== 'string' || !p.name || typeof p.value !== 'number') continue;
    out.push({ name: p.name, value: p.value, defaultValue: typeof p.defaultValue === 'number' ? p.defaultValue : 0 });
  }
  return out;
}

function apiErrorMessage(msg: {
  message?: string;
  data?: unknown;
}): string {
  const data = msg.data;
  if (data && typeof data === 'object') {
    const d = data as { message?: unknown; errorID?: unknown };
    const detail = typeof d.message === 'string' ? d.message.trim() : '';
    const id = typeof d.errorID === 'number' ? d.errorID : null;
    if (detail && id != null) return `VTS APIError ${id}: ${detail}`;
    if (detail) return `VTS APIError: ${detail}`;
  }
  if (typeof msg.message === 'string' && msg.message.trim()) return msg.message.trim();
  return 'VTS APIError';
}

export class VtsClient {
  private readonly url: string;
  private readonly pluginName: string;
  private readonly pluginDeveloper: string;
  private authToken: string;
  private readonly onToken?: (token: string) => void;
  private readonly onAuthRejected?: (rejected: boolean) => void;
  private readonly log?: (event: string, msg: string, fields: Record<string, string | number>) => void;
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  /** 进行中的连接；失败不会留下永久 rejected 的 Promise */
  private connecting: Promise<void> | null = null;
  private authed = false;
  /** 连接世代。socket 一死就 +1,旧代的应答、超时与看门狗节拍全部作废。 */
  private gen = 0;
  /** 最近一次收到对端任何消息的时刻(判半开用,pong 不算——那只证明协议层还在) */
  private lastAckAt = 0;
  private timeoutStreak = 0;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** 认证成功过至少一次。只决定日志措辞;重建连接期状态由 connectedListeners 负责,首次也要跑 */
  private everAuthed = false;
  /** close() 之后不再自动重连,直到下一次显式 connect() */
  private closedByUser = false;
  /** token 被 VTS 判无效:再自动重连只会反复弹窗,停下等人处理 */
  private authRejected = false;
  private readonly connectedListeners = new Set<() => void>();
  private readonly modelLoadedListeners = new Set<() => void>();

  constructor(opts: VtsClientOptions = {}) {
    this.url = opts.url ?? 'ws://127.0.0.1:8001';
    this.pluginName = opts.pluginName ?? 'Cortico Vtuber';
    this.pluginDeveloper = opts.pluginDeveloper ?? 'Cortico';
    this.authToken = opts.authToken?.trim() ?? '';
    this.onToken = opts.onToken;
    this.onAuthRejected = opts.onAuthRejected;
    this.log = opts.log;
  }

  get connected(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  get address(): string {
    return this.url;
  }

  get tokenSet(): boolean {
    return this.authToken !== '';
  }

  /**
   * 每一次认证成功(**含本进程的第一次**)的通知。换 socket 之后上层那些
   * 「连接期状态」——在途计数、实机参数名单、模型定档、最后一帧姿态——
   * 全是旧连接的账,必须重建。
   *
   * 首次也要通知:bot 先于 VTS 启动时首连必然 ECONNREFUSED,之后自动连上的
   * 那一次在本进程里是「第一次认证成功」,可它同样是一条全新的连接。把它当
   * 「不是重连」静默放过,模型定档就没人补跑,整场回落默认档。
   * 返回退订函数。
   */
  onConnected(fn: () => void): () => void {
    this.connectedListeners.add(fn);
    return () => this.connectedListeners.delete(fn);
  }

  /**
   * VTS 里换了模型(加载或卸载)的通知。订阅按连接计,每次认证成功后重订;
   * 订阅失败只记日志,定档仍靠连接期那一次。返回退订函数。
   */
  onModelLoaded(fn: () => void): () => void {
    this.modelLoadedListeners.add(fn);
    return () => this.modelLoadedListeners.delete(fn);
  }

  /**
   * 逐帧路径用:不等待、不抛错,只保证「掉线了就已经在重连」。
   * 走退避阶梯而不是直接 connect,否则 60Hz 的帧会变成 60Hz 的连接尝试。
   */
  ensureConnected(): void {
    if (this.connected || this.connecting || this.reconnectTimer) return;
    this.scheduleReconnect('注入时发现未连接');
  }

  /** 当前加载的模型;没加载返回 null */
  async currentModel(): Promise<{ name: string; id: string } | null> {
    await this.connect();
    const d = await this.request<{ modelLoaded?: boolean; modelName?: string; modelID?: string }>(
      'CurrentModelRequest',
      {},
    );
    if (!d.modelLoaded || !d.modelName) return null;
    return { name: d.modelName, id: d.modelID ?? '' };
  }

  async connect(): Promise<void> {
    // 显式连接 = 明确要用它:撤销 close() 立的自动重连禁令,并抢在排定的重连之前
    this.closedByUser = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openAndAuth().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    this.authed = false;
    this.connecting = null;
    this.gen += 1; // 让这个 socket 的 close 事件与残余超时都变成旧代
    const ws = this.ws;
    this.ws = null;
    this.rejectAllPending(new Error('VTS 连接已关闭'));
    if (!ws) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        resolve();
      };
      /*
       * 半开时对端不会回 Close 帧,ws 库要等满 30 秒才硬拆——World stop 的预算
       * 装不下(MODULE_STOP_MS)。到点自己 terminate。
       */
      const deadline = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* 已经死了 */
        }
        finish();
      }, CLOSE_DEADLINE_MS);
      deadline.unref?.();
      ws.once('close', finish);
      try {
        ws.close();
      } catch {
        try {
          ws.terminate();
        } catch {
          /* 已经死了 */
        }
        finish();
      }
    });
    ws.removeAllListeners();
  }

  /**
   * 逐帧参数注入。mode 整包生效:add 叠加在模型自带 idle/物理之上,
   * set 覆盖模型值(lipsync 嘴部、gaze 眼球)。faceFound 恒 false,交给模型自身跟踪。
   *
   * 这是最高频的路径,唯一不 await connect() 的方法:等连接会把每一帧都拖进
   * 连接的等待链里。掉线时踢一脚重连,这一帧直接丢(上层记 sent:false)。
   */
  async injectParameters(
    values: Array<{ id: string; value: number; weight?: number }>,
    mode: 'set' | 'add',
  ): Promise<void> {
    if (!this.connected) {
      this.ensureConnected();
      throw new Error('VTS 未连接');
    }
    await this.request(
      'InjectParameterDataRequest',
      {
        faceFound: false,
        mode,
        parameterValues: values,
      },
      INJECT_TIMEOUT_MS,
    );
  }

  /**
   * 实机认识的输入参数名(内置 + 别的插件/面捕程序创建的自定义参数)。
   *
   * 必须查:模型的 .vtube.json 里可能配着只有外部面捕程序在跑时才存在的参数
   * (BrowAngleL/MouthShrug/JawOpen 这类)。注入不存在的参数会让**整包**被拒
   * (APIError 453),连同包里其他正常参数一起丢。
   */
  async inputParameterNames(): Promise<Set<string>> {
    await this.connect();
    const d = await this.request<{
      defaultParameters?: Array<{ name?: string }>;
      customParameters?: Array<{ name?: string }>;
    }>('InputParameterListRequest', {});
    const out = new Set<string>();
    for (const p of [...(d.defaultParameters ?? []), ...(d.customParameters ?? [])]) {
      if (typeof p.name === 'string' && p.name) out.add(p.name);
    }
    return out;
  }

  /**
   * 当前模型全部 Live2D **输出**参数的实时值(对拍读回用)。
   * 这是映射、idle 动画、表情与物理合成后实际落在模型上的值。
   * 与注入 IR 的差异可定位跳变发生在注入端还是 VTS 端。
   */
  async live2dParameters(): Promise<VtsParamValue[]> {
    await this.connect();
    const d = await this.request<{
      parameters?: Array<{ name?: string; value?: number; defaultValue?: number }>;
    }>('Live2DParameterListRequest', {});
    return pickParamValues(d.parameters);
  }

  /**
   * 全部**输入**参数的实时值与默认值。实时值反映 VTS 当前的注入量
   * (含停发后的保持/衰减),默认值用来验证 add 模式的基线假设。
   */
  async inputParameters(): Promise<VtsParamValue[]> {
    await this.connect();
    const d = await this.request<{
      defaultParameters?: Array<{ name?: string; value?: number; defaultValue?: number }>;
      customParameters?: Array<{ name?: string; value?: number; defaultValue?: number }>;
    }>('InputParameterListRequest', {});
    return [...pickParamValues(d.defaultParameters), ...pickParamValues(d.customParameters)];
  }

  /** 开关单个表情文件(FX 定时脉冲用) */
  async setExpression(file: string, active: boolean, fadeTimeSec = 0.25): Promise<void> {
    await this.connect();
    await this.request('ExpressionActivationRequest', {
      expressionFile: file,
      active,
      fadeTime: fadeTimeSec,
    });
  }

  /**
   * 关掉当前模型上所有已激活表情（开局残留的灯泡/光环/汗等）。
   * 返回被关掉的 expression 文件名列表。
   */
  async clearActiveExpressions(opts?: { keepFiles?: string[] }): Promise<string[]> {
    await this.connect();
    const keep = new Set((opts?.keepFiles ?? []).map((f) => f.toLowerCase()));
    const state = await this.request<{
      expressions?: Array<{ file?: string; active?: boolean }>;
    }>('ExpressionStateRequest', { details: false });
    const cleared: string[] = [];
    for (const exp of state.expressions ?? []) {
      const file = typeof exp.file === 'string' ? exp.file : '';
      if (!file || !exp.active) continue;
      if (keep.has(file.toLowerCase())) continue;
      await this.request('ExpressionActivationRequest', {
        expressionFile: file,
        active: false,
        fadeTime: 0.25,
      });
      cleared.push(file);
    }
    return cleared;
  }

  private async openAndAuth(): Promise<void> {
    try {
      await this.openSocket();
      await this.authenticate();
      this.authed = true;
      this.lastAckAt = Date.now();
      this.timeoutStreak = 0;
      this.reconnectAttempt = 0;
      // 「重连成功」只报给日志:首连成功不值一条重连告警(everAuthed 只管措辞)
      if (this.everAuthed) this.log?.('reconnected', 'VTS 重连成功', { url: this.url });
      this.everAuthed = true;
      void this.request('EventSubscriptionRequest', {
        eventName: 'ModelLoadedEvent',
        subscribe: true,
        config: {},
      }).catch((err: unknown) => {
        this.log?.('subscribe-failed', 'VTS 模型事件订阅失败', { err: err instanceof Error ? err.message : String(err) });
      });
      // 监听器一次不落:首连与重连对上层是同一件事——手上是一条全新的连接
      for (const fn of this.connectedListeners) {
        try {
          fn();
        } catch {
          /* 监听器自己的问题不该把刚建好的连接带下去 */
        }
      }
    } catch (err) {
      this.authed = false;
      this.dropSocket(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const gen = ++this.gen;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      ws.on('open', () => {
        if (settled) return;
        settled = true;
        this.lastAckAt = Date.now();
        this.startWatchdog(ws, gen);
        resolve();
      });
      ws.on('message', (raw) => this.onMessage(String(raw)));
      ws.on('pong', () => {
        this.awaitingPong = false;
      });
      ws.on('error', (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on('close', () => {
        fail(new Error(`VTS 连接关闭（${this.url}）`));
        this.down(gen, '对端关闭连接', true);
      });
    });
  }

  /** 显式路径上的收摊:不排重连,由调用方决定下一步 */
  private dropSocket(why: string): void {
    this.down(this.gen, why, false);
  }

  /**
   * 收摊一个 socket。allowReconnect 只在「曾经认证成功过的连接掉了」时才真的排重连——
   * 显式 connect() 失败由调用方处理,不在这里自作主张。
   */
  private down(gen: number, why: string, allowReconnect: boolean): void {
    if (gen !== this.gen) return; // 旧代,已经收过一次
    this.gen += 1;
    this.clearWatchdog();
    const ws = this.ws;
    const wasAuthed = this.authed;
    this.ws = null;
    this.authed = false;
    this.timeoutStreak = 0;
    if (ws) {
      ws.removeAllListeners();
      // terminate 而不是 close:半开时 close 要等对端回 Close 帧,ws 库的死线是 30 秒
      try {
        ws.terminate();
      } catch {
        /* 已经死了 */
      }
    }
    this.rejectAllPending(new Error(`VTS 连接已断开（${why}）`));
    if (allowReconnect && wasAuthed) this.scheduleReconnect(why);
  }

  /** 熔断:判定对端已经不在了,主动把 socket 拆掉并排重连 */
  private trip(why: string): void {
    this.log?.('breaker', 'VTS 熔断,主动切断并重连', {
      why,
      pending: this.pending.size,
      timeoutStreak: this.timeoutStreak,
      url: this.url,
    });
    this.down(this.gen, why, true);
  }

  private scheduleReconnect(why: string): void {
    if (this.reconnectTimer || this.closedByUser) return;
    if (this.authRejected) {
      this.log?.('reconnect-stopped', 'VTS 停止自动重连:token 已被判无效,需人工在 VTS 重新授权', { url: this.url });
      return;
    }
    const delayMs = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 5_000;
    this.reconnectAttempt += 1;
    this.log?.('reconnect', 'VTS 排定重连', { why, delayMs, attempt: this.reconnectAttempt, url: this.url });
    const t = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err: unknown) => {
        this.scheduleReconnect(err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
    t.unref?.();
    this.reconnectTimer = t;
  }

  /**
   * 看门狗:一个节拍器同时管两件事。
   * ① 有请求在途却 NO_ACK_MS 没收到对端任何消息 → 半开;
   * ② 每 PING_TICKS 拍发一次 ping,上一轮的 pong 没回来就判死(最坏 2×间隔)。
   * ping 不依赖业务流量,空闲期掉线也能发现。
   */
  private startWatchdog(ws: WebSocket, gen: number): void {
    this.clearWatchdog();
    this.awaitingPong = false;
    let tick = 0;
    const timer = setInterval(() => {
      if (gen !== this.gen || this.ws !== ws) return;
      // 只在认证之后判无应答:认证前那一段可能正等着人在 VTS 窗口里点「允许」
      if (this.authed && this.pending.size > 0 && Date.now() - this.lastAckAt >= NO_ACK_MS) {
        this.trip(`${NO_ACK_MS / 1000} 秒没有任何应答,仍有 ${this.pending.size} 个请求在途`);
        return;
      }
      tick += 1;
      if (tick % PING_TICKS !== 0) return;
      /*
       * 没收到 pong 还要再看一眼业务应答:实机 VTS 的 WebSocket 实现万一不回 ping,
       * 光凭 pong 判死会把一条正在好好回执的连接每 10 秒拆一次。业务在应答就算活着,
       * 半开由超时连击(2 秒一次)和无应答闸接管。
       */
      if (this.awaitingPong && Date.now() - this.lastAckAt >= PING_TICKS * WATCH_TICK_MS) {
        this.trip(`心跳 ${(PING_TICKS * WATCH_TICK_MS) / 1000} 秒没有 pong,期间也没有任何业务应答`);
        return;
      }
      this.awaitingPong = true;
      try {
        ws.ping();
      } catch {
        this.trip('心跳发不出去');
      }
    }, WATCH_TICK_MS);
    timer.unref?.();
    this.watchTimer = timer;
  }

  private clearWatchdog(): void {
    if (!this.watchTimer) return;
    clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async authenticate(): Promise<void> {
    if (!this.authToken) {
      const tok = await this.request<{ authenticationToken?: string }>(
        'AuthenticationTokenRequest',
        {
          pluginName: this.pluginName,
          pluginDeveloper: this.pluginDeveloper,
        },
        AUTH_POPUP_TIMEOUT_MS,
      );
      if (!tok.authenticationToken) {
        throw new Error('VTS 未返回 authenticationToken（请在 VTS 弹窗中允许「Cortico Vtuber」插件）');
      }
      this.authToken = tok.authenticationToken;
      this.onToken?.(this.authToken);
    }
    // 重连走的永远是这一条:AuthenticationTokenRequest 会在实机弹窗,不能自动重走
    const auth = await this.request<{ authenticated?: boolean }>('AuthenticationRequest', {
      pluginName: this.pluginName,
      pluginDeveloper: this.pluginDeveloper,
      authenticationToken: this.authToken,
    });
    if (!auth.authenticated) {
      // token 失效时清掉，下次重新申请弹窗
      this.authToken = '';
      this.setAuthRejected(true);
      throw new Error('VTS 认证失败：token 无效，请在 VTS 弹窗重新允许插件，或清掉 VTS_AUTH_TOKEN 后重启');
    }
    this.setAuthRejected(false);
  }

  /** 翻转时才通知上层:报障与解除各只出一条 */
  private setAuthRejected(rejected: boolean): void {
    if (this.authRejected === rejected) return;
    this.authRejected = rejected;
    this.onAuthRejected?.(rejected);
  }

  private request<T>(
    messageType: string,
    data: Record<string, unknown>,
    timeoutMs: number = CONTROL_TIMEOUT_MS,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('VTS 未连接'));
    }
    const gen = this.gen;
    const requestID = randomUUID();
    const payload = {
      apiName: API_NAME,
      apiVersion: API_VERSION,
      requestID,
      messageType,
      data,
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 收到应答时会 clearTimeout,不再让每个请求留一个不清理的定时器
        if (!this.pending.delete(requestID)) return;
        reject(new Error(`VTS 请求超时: ${messageType}`));
        if (gen === this.gen) this.noteTimeout();
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestID, {
        gen,
        timer,
        resolve: (d) => resolve(d as T),
        reject,
      });
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestID);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private noteTimeout(): void {
    this.timeoutStreak += 1;
    if (this.timeoutStreak < TIMEOUT_STREAK_LIMIT) return;
    this.trip(`连续 ${this.timeoutStreak} 次请求超时`);
  }

  private onMessage(raw: string): void {
    let msg: {
      requestID?: string;
      messageType?: string;
      data?: unknown;
      message?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 收到任何一条消息都证明对端还在(含 VTS 主动推的事件)
    this.lastAckAt = Date.now();
    if (msg.messageType === 'ModelLoadedEvent') {
      for (const fn of this.modelLoadedListeners) {
        try {
          fn();
        } catch {
          /* 监听器自己的问题不影响收包 */
        }
      }
      return;
    }
    const id = msg.requestID;
    if (!id) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (p.gen !== this.gen) return; // 旧代的应答:promise 已在 down() 里 reject 过
    this.timeoutStreak = 0;
    if (msg.messageType === 'APIError') {
      p.reject(new Error(apiErrorMessage(msg)));
      return;
    }
    p.resolve(msg.data ?? {});
  }
}
