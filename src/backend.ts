/**
 * L4:IR → VTS 注入。
 *
 * 每帧把全量快照装成 InjectParameterData(add/set 各一条请求,VTS 的 mode 是
 * 整条请求的属性),FX 转发为 Expression 定时开关。发送按帧流水:最多两帧在途
 * (VTS 按 requestID 配对应答,顺序由 socket 保证),满了就把**最新一帧**存进
 * 候补位,上一帧回执一到立刻补发——真正丢掉的只有被更新覆盖的候补帧。
 * 单帧在途时吞吐受 VTS 往返时间限制(实测约 25ms,注入约 35Hz),
 * 两帧流水可维持混音台的求值率。
 *
 * 这一层也是唯一处理**模型接线约定**的地方,而那份约定整个收在模型档案里
 * (`models/`):换算表、演不出来的参数、FX 表情文件名与时长、复位保留名单。
 * 换模型 = 换一份档案,L1-L3 一个字不改。
 */
import type { IRFrame } from './mixer.ts';
import { DEFAULT_PROFILE, fxFor, toWire, type ModelProfile } from './models/index.ts';
import type { VtsClient } from './vts-client.ts';

/** 同时在途的帧数上限;超过则进候补位(最新帧胜出) */
const MAX_IN_FLIGHT = 2;

export interface VtsBackendOptions {
  onError?: (err: Error) => void;
  /**
   * 当前生效的模型档案，缺省时使用默认档案。
   * 每帧重新读取,使控制台换档即时生效。
   */
  profile?: () => ModelProfile;
  /**
   * 每帧注入实况(诊断用)。sent=false 表示候补帧被更新的帧覆盖、彻底没发出——
   * 丢帧率直接决定短促动作(340ms 的点头)能落到几个采样点上。
   */
  onInjectStat?: (stat: { sent: boolean; rejected?: readonly string[] }) => void;
  /** 一帧两条请求全部得到回执:上层据此判定 VTS 还活着(onError 只报失败,单看它分不出僵死与恢复)。 */
  onInjectOk?: () => void;
  /**
   * 连上之后由谁重建实机参数名单。给了就用它,它必须自己调 setKnownParameters
   * (那一步同时解除本次的发帧暂停)。 World 给的是 syncKnownParameters——那一份
   * 连模型定档一起重跑,名单因此只查一次。
   * 不给就自己查:backend 单独使用时也得自足,否则暂停永远解不掉。
   */
  resyncKnown?: () => Promise<void>;
}

export class VtsBackend {
  private inFlight = 0;
  private pendingFrame: IRFrame | null = null;
  private readonly fxTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly onError?: (err: Error) => void;
  private readonly profile: () => ModelProfile;
  private readonly onInjectStat?: (stat: { sent: boolean; rejected?: readonly string[] }) => void;
  private readonly onInjectOk?: () => void;
  /** 实机接受的输入参数；null 表示查询不可用，不执行过滤。 */
  private known: Set<string> | null = null;
  /** 参数名单查询期间暂停发帧，避免未知参数触发 API 453 整条请求被拒。 */
  private syncingKnown = false;
  /**
   * 按不支持的参数累计丢弃次数，实机缺失或档案不支持时不修改上层词表。每个 key 按十进位里程碑记录累计量，保留频次并限制日志量。
   */
  private readonly dropped = new Map<string, number>();
  /** 最后一帧 IR。重连后照这一帧补发一次,皮套立刻回到冻结前的姿态而不是停在半路。 */
  private lastFrame: IRFrame | null = null;
  private unsubConnected: (() => void) | null = null;
  private readonly resyncKnown: () => Promise<void>;

  constructor(
    private readonly vts: VtsClient,
    opts: VtsBackendOptions = {},
  ) {
    this.onError = opts.onError;
    this.profile = opts.profile ?? (() => DEFAULT_PROFILE);
    this.onInjectStat = opts.onInjectStat;
    this.onInjectOk = opts.onInjectOk;
    this.resyncKnown = opts.resyncKnown ?? (async () => {
      const names = await this.vts.inputParameterNames();
      this.setKnownParameters(names.size > 0 ? names : null);
    });
    /*
     * 换过 socket 之后,在途计数、候补帧、实机参数名单全是旧连接的账——
     * inFlight 不归零就会永久卡在 MAX_IN_FLIGHT 上,连接回来了也再不发帧。
     * 首连也会触发:那同样是一条全新的连接。
     * (测试替身不一定实现这个方法,按可选读。)
     */
    const onConnected: VtsClient['onConnected'] | undefined = vts.onConnected;
    if (onConnected) this.unsubConnected = onConnected.call(vts, () => this.handleConnected());
  }

  /** 连上之后的恢复:归零背压账、重建实机参数名单、补发最后一帧。 */
  private handleConnected(): void {
    this.inFlight = 0;
    this.pendingFrame = null;
    // 名单重建期间不发帧:连接刚回来到名单到手之间照发会撞 453 整条请求被拒
    this.beginParameterSync();
    void (async () => {
      try {
        await this.resyncKnown();
      } catch (err) {
        this.setKnownParameters(null); // 查不到就照发,行为回到过滤前
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      const last = this.lastFrame;
      if (last) this.sendFrame(last);
    })();
  }

  /**
   * 声明"正在查实机参数名单":此间不发帧。连接刚建立到名单到手之间有一个
   * 窗口,照发的话名单外参数会让整条请求被拒(实测启动那 1s 刷出 69 条 453)。
   */
  beginParameterSync(): void {
    this.syncingKnown = true;
  }

  /** 连接失败等半途而废时解除暂停,名单维持原样 */
  cancelParameterSync(): void {
    this.syncingKnown = false;
  }

  /**
   * 声明实机认识哪些输入参数。不在这份名单里的一律不发——
   * 注入一个不存在的参数会让**整条请求**被 VTS 拒(APIError 453),
   * 连同同一条请求里其他正常参数一起丢,等于那一帧全灭。
   * 传 null 表示查不到,退回照发。调用后解除 beginParameterSync 的暂停。
   */
  setKnownParameters(names: Set<string> | null): void {
    this.known = names;
    this.syncingKnown = false;
    // 名单变了,先前被判无效的参数可能重新有效,计数表必须重置——但重置前把
    // 这一段的累计写出去一条,否则「换模型/重连」会把频次连同表一起抹掉。
    this.reportDropTotals();
    this.dropped.clear();
  }

  /** 把当前累计的丢弃次数汇成一条。没有丢弃过就不写。 */
  private reportDropTotals(): void {
    if (this.dropped.size === 0) return;
    let total = 0;
    for (const n of this.dropped.values()) total += n;
    const bits = [...this.dropped]
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key}×${n}`)
      .join('、');
    this.onError?.(new Error(`已跳过合计 ${total} 次:${bits}`));
  }

  /** 已丢弃组合的累计次数快照(观测用;键为 `名称:原因`)。 */
  dropCounts(): ReadonlyMap<string, number> {
    return new Map(this.dropped);
  }

  /** 非阻塞:在途满两帧时进候补位,候补被覆盖才算丢帧 */
  sendFrame(frame: IRFrame): void {
    // 发没发得出去都留着:重连后补发的就是它
    this.lastFrame = frame;
    if (this.syncingKnown) return;
    if (!this.vts.connected) {
      // 掉线期照记丢帧,并踢一脚重连(ensureConnected 自带退避,不会变成 60Hz 的连接尝试)
      this.vts.ensureConnected?.();
      this.onInjectStat?.({ sent: false });
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      if (this.pendingFrame) this.onInjectStat?.({ sent: false });
      this.pendingFrame = frame;
      return;
    }
    this.transmit(frame);
  }

  private transmit(frame: IRFrame): void {
    const profile = this.profile();
    /**
     * 目标输入参数 → 累加桶。模型只给合并输入时(左右眉共用一个 Brows)
     * 多路语义会并到同一个目标上,按均值合。
     */
    const buckets = new Map<string, { sum: number; n: number; mode: 'add' | 'set' }>();
    const newlyDropped: string[] = [];
    for (const [id, p] of Object.entries(frame)) {
      const wired = toWire(profile, id, p.value);
      if (!wired) {
        if (this.drop(id, `${profile.label} 演不出`)) newlyDropped.push(id);
        continue;
      }
      for (const target of wired.targets) {
        if (this.known && !this.known.has(target)) {
          if (this.drop(target, '实机无此输入参数')) newlyDropped.push(target);
          continue;
        }
        const b = buckets.get(target);
        if (b) {
          b.sum += wired.value;
          b.n += 1;
        } else {
          buckets.set(target, { sum: wired.value, n: 1, mode: p.mode === 'set' ? 'set' : 'add' });
        }
      }
    }
    const add: Array<{ id: string; value: number }> = [];
    const set: Array<{ id: string; value: number; weight: number }> = [];
    for (const [id, b] of buckets) {
      const value = b.sum / b.n;
      if (b.mode === 'set') set.push({ id, value, weight: 1 });
      else add.push({ id, value });
    }
    if (add.length === 0 && set.length === 0) return;
    this.onInjectStat?.({ sent: true, rejected: newlyDropped });
    this.inFlight++;
    void (async () => {
      /*
       * 两条请求**并发**发,而不是串行 await。
       * 串行时每帧要两次往返(实测约 52ms),注入帧率被压到 19Hz、丢帧 54%——
       * 340ms 的点头只落到六个采样点,峰值直接被跳过。VTS 按 requestID 配对应答,
       * 同时发两个请求没有问题。两条各自成败:一条被拒不该把另一条也带走。
       */
      const results = await Promise.allSettled([
        add.length > 0 ? this.vts.injectParameters(add, 'add') : null,
        set.length > 0 ? this.vts.injectParameters(set, 'set') : null,
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          this.onError?.(r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
        }
      }
      if (results.every((r) => r.status === 'fulfilled')) this.onInjectOk?.();
      this.inFlight--;
      const next = this.pendingFrame;
      if (next && this.inFlight < MAX_IN_FLIGHT) {
        this.pendingFrame = null;
        this.transmit(next);
      }
    })();
  }

  /**
   * FX 脉冲:开 → durationMs 后关。表情文件与时长来自模型档案;
   * 档案把它标成 null(这个模型没这个特效)就咽掉并提醒一次。
   */
  fx(clipId: string): void {
    const profile = this.profile();
    const entry = fxFor(profile, clipId);
    if (!entry) {
      this.drop(clipId, `${profile.label} 没有这个特效`);
      return;
    }
    const { file } = entry;
    void this.vts.setExpression(file, true).catch((err) => {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    const timer = setTimeout(() => {
      this.fxTimers.delete(timer);
      void this.vts.setExpression(file, false).catch((err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, entry.durationMs);
    this.fxTimers.add(timer);
  }

  /** FX 在当前档案上的脉冲时长;没有这个特效时 0(编排器据此不为它留拍) */
  fxDurationMs(clipId: string): number {
    return fxFor(this.profile(), clipId)?.durationMs ?? 0;
  }

  /**
   * 记一次丢弃；返回该组合是否首次出现(上层据此填 rejected 名单)。
   *
   * 上报节流按十进位里程碑:第 1、10、100、1000… 次各写一条,带累计次数。
   * 首条与旧行为逐字相同,后续几条把频次补上——一场下来每个组合最多三四条。
   */
  private drop(name: string, why: string): boolean {
    const key = `${name}:${why}`;
    const n = (this.dropped.get(key) ?? 0) + 1;
    this.dropped.set(key, n);
    if (n === 1) this.onError?.(new Error(`已跳过 ${name}:${why}`));
    else if (isDecadeMilestone(n)) this.onError?.(new Error(`已跳过 ${name}:${why}(累计 ${n} 次)`));
    return n === 1;
  }

  stop(): void {
    // 收工时把整场累计写出去:里程碑上报只到十进位,尾数(以及从没上过 10 的组合)靠这条。
    this.reportDropTotals();
    this.dropped.clear();
    for (const t of this.fxTimers) clearTimeout(t);
    this.fxTimers.clear();
    this.pendingFrame = null;
    this.lastFrame = null;
    this.unsubConnected?.();
    this.unsubConnected = null;
  }
}

/** n 是不是 10 的整数次幂(10/100/1000…):丢弃上报的节流刻度。 */
function isDecadeMilestone(n: number): boolean {
  if (n < 10) return false;
  let v = n;
  while (v % 10 === 0) v /= 10;
  return v === 1;
}
