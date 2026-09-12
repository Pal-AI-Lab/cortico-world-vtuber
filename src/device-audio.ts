/**
 * 本地声卡音频通道:TTS 片经 RtAudio(WASAPI/CoreAudio/ALSA)直接写指定输出设备
 * (虚拟声卡如 VB-Cable → OBS 收麦克风)。播放时点直接由本地时间线确定。
 *
 * 时间线模型:一条按墙钟推进的连续样本流。泵保持写入领先播放位约 AHEAD_MS,
 * 没有语音时补静音——开播/播毕时刻 = 该片样本落在时间线上的位置换算回墙钟。
 * 设备不可用时仍推进静音时间线,保持演出时序。
 */
import { createRequire } from 'node:module';
import type { Logger } from 'cortico/core/types.ts';
import type { CutPlan } from './interrupt-fade.ts';
import type { AudioSink, AudioStreamSession } from './orchestrator.ts';
import type { TraceOptions } from './diagnostics.ts';
import { decodeWav, type TtsPiece } from './tts.ts';

/**
 * 写入领先播放位的目标量;也是 stop/cut 生效延迟的上界。
 * 必须小于编排器的 CUT_LEAD_MS,否则切点永远落在已写入区、音素感知切断退化为淡出。
 */
const AHEAD_MS = 100;
const PUMP_INTERVAL_MS = 15;
/** 开流时先排进去的预热静音帧数;时间线零帧排在它们之后 */
const PRIMING_FRAMES = 8;
/**
 * 声卡时钟纠偏的死区:比这更小的偏差不动。
 * `streamTime` 按回调帧长(20ms)跳,追它的量化噪声只会让写入节拍抖。
 */
const DRIFT_DEADBAND_MS = 25;
/**
 * `streamTime` 停多久算这块表坏了。坏表只会把偏差算成"越来越晚",
 * 一路纠下去等于把声音无限往后推,所以宁可不纠、报一句。
 */
const DRIFT_CLOCK_STALL_MS = 3_000;
/** 声卡空转(队列被泵饿空、回调放静音)的告警折叠窗口:一次事故只报一行。 */
const STARVE_REPORT_FOLD_MS = 1_000;
/**
 * 副输出队列的上限。时间线只能锚在一块表上(主输出 —— 它是直播命脉),副输出那台
 * 设备有自己的晶振,于是它的队列同样只长不短。这一路是监听用的,丢一帧(20ms)
 * 换住相位比让它越听越晚划算:按几十 ppm 的漂移,大约每小时才丢一帧。
 */
const MIRROR_MAX_QUEUE_MS = 250;
/** 合成中止时用于已排队音频末段的淡出时长。 */
const ABORT_FADE_MS = 20;
/** 副输出重开的退避基数,按连续失败次数翻倍到上限。 */
const MIRROR_RETRY_BASE_MS = 500;
const MIRROR_RETRY_MAX_MS = 8000;
/** 连续这么多次开不住就放弃这一路,直到查询串或默认设备变了才重来。 */
const MIRROR_RETRY_LIMIT = 5;
/** 副输出跑满这段时间才算真开住;部分蓝牙设备 start 后一帧内就自己停。 */
const MIRROR_STABLE_MS = 5000;
/**
 * 播放时钟冻住超过这段时间即判「假活」:WASAPI 蓝牙端点实测有一种死法,
 * isStreamRunning 恒真、write 全收,但 streamTime 不走、耳机无声,
 * 一挂就是整场且不进任何失败记账。
 */
const MIRROR_FROZEN_MS = 1500;
/**
 * 主输出重开采用退避，持续恢复且不设放弃上限。WASAPI 渲染线程可能在开流成功后异步停止；退避限制持续停止时的设备枚举与重开频率。
 */
const PRIMARY_RETRY_BASE_MS = 500;
const PRIMARY_RETRY_MAX_MS = 5000;
/** 主输出跑满这段时间才算真开住:start() 返回不等于渲染线程活着。 */
const PRIMARY_STABLE_MS = 3000;
/** 连续开不住到这个次数改记 warn,并按 PRIMARY_WARN_GAP_MS 汇报累计。 */
const PRIMARY_WARN_AFTER = 3;
const PRIMARY_WARN_GAP_MS = 15_000;

interface RtAudioLike {
  openStream(
    out: { deviceId: number; nChannels: number; firstChannel: number },
    input: null,
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: null,
    frameOutputCallback: null,
  ): void;
  closeStream(): void;
  start(): void;
  write(buf: Buffer): void;
  getDevices(): Array<{ id: number; name: string; outputChannels: number }>;
  getDefaultOutputDevice(): number;
  getStreamLatency(): number;
  isStreamRunning(): boolean;
  isStreamOpen(): boolean;
  /** 播放时钟，单位为秒。 */
  streamTime: number;
  outputVolume: number;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number; WINDOWS_DS: number };
}

type DeviceInfo = { id: number; name: string; outputChannels: number };

/**
 * RtAudio 自选后端时在 Windows 上优先 ASIO。装了厂商 ASIO 驱动的机器上这条路
 * 是坏的:设备表只剩一个 "Realtek ASIO",驱动按自己的缓冲区大小工作而不认
 * openStream 请求的帧长,第一次 write() 就写越界(0xC0000005 打死整个子进程)。
 * WASAPI 枚举的是系统设备表,虚拟声卡(VB-Cable 之类)也在里面,正是这里要的。
 */
function preferredApi(audify: AudifyModule): number | undefined {
  return process.platform === 'win32' ? audify.RtAudioApi.WINDOWS_WASAPI : undefined;
}

/**
 * 只在真要开设备那一刻才 require。这个 .node 一旦进了 worker 线程,线程收工时
 * 它的 napi 引用清理会把整个进程打死(`Check failed: node->IsInUse()`),
 * vitest 的线程池收工正好踩这条路——silent 模式压根不碰设备,也就不该载它。
 */
function loadAudify(log?: Logger): AudifyModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require('audify') as AudifyModule;
  } catch (err) {
    log?.warn('audify 原生层不可用,音频走静音时间线', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export interface PlaybackDevice {
  id: number;
  name: string;
  channels: number;
  isDefault: boolean;
}

/** 系统播放设备。audify 不在或枚举失败时给空表,下拉只留固定项。 */
export function listPlaybackDevices(log?: Logger): PlaybackDevice[] {
  const audify = loadAudify(log);
  if (!audify) return [];
  try {
    const rt = new audify.RtAudio(preferredApi(audify));
    const def = rt.getDefaultOutputDevice();
    return rt.getDevices()
      .filter((d) => d.outputChannels > 0)
      .map((d) => ({
        id: d.id,
        name: d.name,
        channels: d.outputChannels,
        isDefault: d.id === def,
      }));
  } catch (err) {
    log?.warn('枚举播放设备失败', { err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * `x-options` 下拉的整张表:固定项在前(主输出:系统默认 / 不出声;副输出:系统默认),
 * 本机声卡随后。固定项的取值与 `pickDevice` / `secondaryPickQuery` 的约定一致
 * (主输出空串 = 系统默认、`none` = 静音;副输出 `default` = 系统默认,关闭走旁边的开关)。
 * 控制台不认识任何 kind,只把这张表原样画出来;不认识的 kind 返回空数组。
 */
export function playbackConfigOptions(
  kind: string,
  language: 'zh' | 'en' = 'zh',
  log?: Logger,
): Array<{ value: string; label: string }> {
  if (kind !== 'playback-primary' && kind !== 'playback-secondary') return [];
  const en = language === 'en';
  const systemDefault = en ? 'System default' : '系统默认';
  const heads = kind === 'playback-primary'
    ? [{ value: '', label: systemDefault }, { value: 'none', label: en ? 'Silent' : '不出声' }]
    : [{ value: 'default', label: systemDefault }];
  const live = listPlaybackDevices(log).map((d) => ({
    value: d.name,
    label: d.isDefault ? `${d.name}${en ? ' · default' : ' · 默认'}` : d.name,
  }));
  return [...heads, ...live];
}

/**
 * 副输出配置 → pickDevice 用的查询串。
 * `off` = 关掉;`default` / 空 = 当前系统默认;其余按名字子串。
 */
export function secondaryPickQuery(raw: string): string | null {
  const t = raw.trim();
  const k = t.toLowerCase();
  if (k === 'off') return null;
  if (!k || k === 'default') return '';
  return t;
}

/** 蓝牙通话端点;48kHz 立体声写进去经常没声。 */
function isCommsEndpoint(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('hands-free') || n.includes('handsfree');
}

/**
 * 折叠成 ASCII 骨架再比:DirectSound 的设备名走 ANSI 代码页,非 ASCII 字符全变
 * '?'(实测 "Headphones (一弛 的 Buds4)" 在 DS 表里是 "Headphones (?? ? Buds4)"),
 * 拿 WASAPI 下配置的原名匹配永远落空,后端轮换形同虚设——蓝牙耳机就卡死在
 * WASAPI 一条道上反复开死路。两边的非 ASCII 与 '?' 都当空白、连续空白折一格,
 * 同一台设备在两个后端下折到同一串。
 */
export function foldAnsiName(raw: string): string {
  return raw
    .replace(/[^\x20-\x7e]|\?/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 在一张设备表里按查询串选播放设备。
 * 空串 = 系统默认;先精确匹配再子串;都落空再按 ASCII 折叠名重试一轮
 * (跨后端的 ANSI 乱码设备名,见 foldAnsiName)。命中多条时避开通话端点、取通道更多的。
 */
export function pickPlaybackHit(
  devices: ReadonlyArray<DeviceInfo>,
  query: string,
  defaultId: number,
): DeviceInfo | undefined {
  const outs = devices.filter((d) => d.outputChannels > 0);
  if (query === '') return outs.find((d) => d.id === defaultId);
  const q = query.toLowerCase();
  const exact = outs.find((d) => d.name.toLowerCase() === q);
  if (exact) return exact;
  let hits = outs.filter((d) => d.name.toLowerCase().includes(q));
  if (!hits.length) {
    const fq = foldAnsiName(query);
    if (!fq) return undefined;
    const foldExact = outs.filter((d) => foldAnsiName(d.name) === fq);
    hits = foldExact.length ? foldExact : outs.filter((d) => foldAnsiName(d.name).includes(fq));
  }
  if (!hits.length) return undefined;
  const media = hits.filter((d) => !isCommsEndpoint(d.name));
  const pool = media.length ? media : hits;
  return pool.reduce((best, d) => (d.outputChannels > best.outputChannels ? d : best));
}

/**
 * 主副共用的后端顺序:先 WASAPI(虚拟线稳),再 DirectSound(部分蓝牙耳机 WASAPI 会自己停)。
 * `avoid` 是刚死掉的那条,下次从另一条先试,避免反复开死路。
 */
export function rotatePreferFirst<T>(items: readonly T[], avoid?: T): T[] {
  if (avoid === undefined || !items.includes(avoid)) return [...items];
  return [...items.filter((item) => item !== avoid), avoid];
}

/** 两路查询是否落到同一台播放设备(在同一张设备表上比)。 */
export function samePlaybackTarget(
  devices: ReadonlyArray<DeviceInfo>,
  defaultId: number,
  primaryQuery: string,
  secondaryQuery: string,
): boolean {
  const a = pickPlaybackHit(devices, primaryQuery, defaultId);
  const b = pickPlaybackHit(devices, secondaryQuery, defaultId);
  return !!a && !!b && a.id === b.id;
}

/**
 * 一条原生流的消费记账。audify 的输出队列无界、`write()` 从不阻塞;声卡回调每跳
 * 一拍(`streamTime` += 帧长)弹一帧,队列空则放静音 —— 那一拍照样计入 `streamTime`,
 * 却没有消费任何写进去的帧。所以"声卡播到哪儿"不能拿拍数直接换算,要按
 * `min(新增拍数, 队列里的帧数)` 记消费,余下的拍数是空转。
 */
interface LaneClock {
  /** 上次读到的回调拍数 */
  ticks: number;
  /** 拍数最近一次前进的墙钟时刻 */
  atMs: number;
  /** 写进去还没被弹掉的帧数(含开流预热静音) */
  queuedFrames: number;
  /** 已被弹掉的帧数(含开流预热静音) */
  poppedFrames: number;
  /** 空转拍数累计 */
  starvedTicks: number;
}

function newLaneClock(primingFrames: number, now: number): LaneClock {
  return { ticks: 0, atMs: now, queuedFrames: primingFrames, poppedFrames: 0, starvedTicks: 0 };
}

interface Track {
  /** 待写入的样本块(已换算到时间线采样率) */
  queue: Int16Array[];
  /** 本片已写进时间线的样本数(片内坐标) */
  written: number;
  /** 最后一个样本落在时间线上的位置 */
  lastTimelineSample: number;
  /** 数据已收齐；队列排空后结束该轨。 */
  closed: boolean;
  onStarted: (ts: number) => void;
  onEnded: (ts: number) => void;
  startedResolved: boolean;
  endedResolved: boolean;
  endedTimer: ReturnType<typeof setTimeout> | null;
}

export class DeviceAudioSink implements AudioSink {
  private readonly now: () => number;
  private readonly trace: (area: string, msg: string, opts?: TraceOptions) => void;
  /** 首次开设备时才载入;silent 模式全程为 null */
  private audify: AudifyModule | null = null;
  private audifyTried = false;

  private rt: RtAudioLike | null = null;
  /** 副输出那一路;与主设备相同或开关关掉时为 null */
  private rtMirror: RtAudioLike | null = null;
  private primaryDeviceId: number | null = null;
  /** 副输出开流时选中的设备;用来判断要不要重开 */
  private mirrorDeviceId: number | null = null;
  /** 上次开副输出时的查询串;`''` = 当时的系统默认 */
  private openedSecondaryQuery: string | null = null;
  /** 副输出跟系统默认时记下的默认设备 id(主实例表);默认切换后重开 */
  private mirrorWatchedDefaultId: number | null = null;
  private lastMirrorCheckMs = 0;
  private mirrorChannels = 1;
  /** 各路上次成功/失败的后端;主副同一套,不按设备种类分叉 */
  private primaryApi: number | undefined;
  private secondaryApi: number | undefined;
  private primaryGaveUp = false;
  /**
   * 主输出重试闸:连续「开起来又停跑」的次数与下次可试时刻。头两次立刻重开
   * (设备切换那类一次性事故照旧无缝),从第三次起指数退避。与副输出的闸门不同,
   * 这里没有放弃项——退到上限频率仍然一直试。
   */
  private primaryGate: { fails: number; nextTryMs: number; warnedAtMs: number; sinceMs: number } | null = null;
  /** 当前这条主输出流的开流时刻;跑满 PRIMARY_STABLE_MS 才算开住 */
  private primaryOpenedAtMs = 0;
  /**
   * 副输出重试闸:按查询串记连续失败次数与下次可试时刻。
   * `dropSecondary` 不碰它——闸门必须跨越关流重开而存活,否则退避形同虚设。
   */
  private secondaryGate: { query: string; fails: number; nextTryMs: number; warned: boolean } | null = null;
  /** 当前这条副输出流的开流时刻;跑满 MIRROR_STABLE_MS 才算开住 */
  private mirrorOpenedAtMs = 0;
  /** 上次读到的副输出播放时钟;advanced=时钟真走过(假活判定与「开住」共用) */
  private mirrorClock: { time: number; wall: number; advanced: boolean } | null = null;
  private openedPrimaryQuery: string | null = null;
  private primaryWatchedDefaultId: number | null = null;
  private streamRate = 0;
  /** 输出通道数;单声道 TTS 复制到每个设备通道。 */
  private outChannels = 1;
  private openedDeviceKey: string | null = null;
  /** 时间线原点(墙钟)与已写样本数;silent 模式同样推进,只是不真写设备 */
  private originWallMs = 0;
  private writtenSamples = 0;
  /** 当前这条原生流开起来时的时间线位置(重开不清 writtenSamples,所以要记基准) */
  private deviceBaseSamples = 0;
  /** 当前这条原生流的预热静音样本数(排在时间线零帧之前) */
  private devicePrimingSamples = 0;
  /** 主输出当前这条原生流的消费记账;没开设备时为 null */
  private deviceLane: LaneClock | null = null;
  /** 声卡时钟停摆的告警只报一次(每条流一次) */
  private driftClockWarned = false;
  /** 副输出当前这条原生流的消费记账 */
  private mirrorLane: LaneClock | null = null;
  /** 副输出为了追上相位丢过多少帧;只用于留痕 */
  private mirrorDropped = 0;
  /** 泵上一拍跑到的墙钟时刻;空转告警用它说清泵隔了多久 */
  private lastStepAtMs = 0;
  private lastStarveReportMs = 0;
  private frameSamples = 0;
  private latencyMs = 0;
  private readonly tracks: Track[] = [];
  /** 已全部落线、仍在等待声卡播放头越过尾帧的普通语音。 */
  private readonly endingTracks = new Set<Track>();
  private pump: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly log: Logger,
    private readonly opts: {
      /** 输出设备名子串;'' = 系统默认,'none' = 不出声(时间线照常) */
      device?: () => string;
      /** 副输出:`off` = 关,`default`/空 = 系统默认,其余按名字 */
      secondary?: () => string;
      trace?: (area: string, msg: string, opts?: TraceOptions) => void;
      now?: () => number;
      /** 测试注入:替换原生模块 */
      audifyOverride?: AudifyModule;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.trace = opts.trace ?? (() => {});
  }

  private nativeAudio(): AudifyModule | null {
    if (!this.audifyTried) {
      this.audifyTried = true;
      this.audify = this.opts.audifyOverride ?? loadAudify(this.log);
    }
    return this.audify;
  }

  play(piece: TtsPiece): Promise<{ startedAt: number; ended: Promise<number> }> {
    let decoded: { samples: Float32Array; sampleRate: number };
    try {
      decoded = decodeWav(piece.wav);
    } catch (err) {
      // 解码失败按估算时长插入静音,保持演出时间线前进。
      this.trace('音频', `⚠ wav 解码失败,按时长占位:${String(err).slice(0, 60)}`);
      const startedAt = this.now();
      return Promise.resolve({
        startedAt,
        ended: new Promise((r) => setTimeout(() => r(this.now()), piece.durationMs)),
      });
    }
    this.ensureOpen(decoded.sampleRate);
    const data = floatToInt16(decoded.samples);
    return new Promise((resolveStart) => {
      let resolveEnd!: (ts: number) => void;
      const ended = new Promise<number>((r) => (resolveEnd = r));
      const track = this.newTrack(
        (ts) => resolveStart({ startedAt: ts, ended }),
        (ts) => resolveEnd(ts),
      );
      track.queue.push(this.toStreamRate(data, decoded.sampleRate));
      track.closed = true;
      this.tracks.push(track);
      this.drive();
    });
  }

  beginStream(sampleRate: number, _text: string): AudioStreamSession {
    this.ensureOpen(sampleRate);
    let resolveStart!: (ts: number) => void;
    let resolveEnd!: (ts: number) => void;
    const started = new Promise<number>((r) => (resolveStart = r));
    const ended = new Promise<number>((r) => (resolveEnd = r));
    const track = this.newTrack(resolveStart, resolveEnd);
    this.tracks.push(track);
    const srcRate = sampleRate;
    return {
      started,
      ended,
      push: (pcm: Uint8Array): void => {
        if (track.closed) return;
        track.queue.push(this.toStreamRate(pcm16BytesToInt16(pcm), srcRate));
        this.drive();
      },
      end: (_durationMs: number): void => {
        track.closed = true;
        this.drive();
      },
      abort: (): void => {
        if (track.closed && track.queue.length === 0) return;
        this.truncateWithFade(track, ABORT_FADE_MS);
        track.closed = true;
        this.drive();
      },
    };
  }

  stop(fadeMs: number): void {
    const head = this.tracks[0];
    const retainFade = head?.startedResolved === true;
    if (head && retainFade) this.truncateWithFade(head, fadeMs);
    for (const t of this.tracks.splice(0)) this.finish(t);
    // 截断斜坡在 finish 前保留于队首轨道;重新入队以完成写入。
    if (head && retainFade && head.queue.length > 0) this.tracks.push(head);
  }

  /**
   * 音素感知切断将 atMs 后的内容替换为衰减段。切点仍在样本队列时直接拼接;
   * 已写入声卡时回退为固定淡出。
   */
  cut(atMs: number, plan: CutPlan): boolean {
    // 正在出声的是队头轨道(后续轨道在 preempt 里已被各自 abort)
    const track = this.tracks[0];
    if (!track || this.streamRate === 0) return false;
    const cutSample = Math.round((atMs / 1000) * this.streamRate);
    if (cutSample < track.written) return false; // 已写过播放头前的区域,回落 stop 淡出
    let keep = cutSample - track.written;
    const kept: Int16Array[] = [];
    for (const chunk of track.queue) {
      if (keep <= 0) break;
      if (chunk.length <= keep) {
        kept.push(chunk);
        keep -= chunk.length;
      } else {
        kept.push(chunk.subarray(0, keep));
        keep = 0;
      }
    }
    track.queue.length = 0;
    track.queue.push(...kept, this.toStreamRate(pcm16BytesToInt16(plan.tailPcm), plan.sampleRate));
    track.closed = true;
    this.trace('音频', `切断 @${Math.round(atMs)}ms(${plan.cls} 尾巴 ${Math.round(plan.fadeMs)}ms)`);
    this.drive();
    return true;
  }

  /** World 停机:收掉一切在途,关流 */
  close(): void {
    for (const t of this.tracks.splice(0)) this.finish(t);
    for (const t of [...this.endingTracks]) this.finish(t);
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    this.closeRt(this.rt);
    this.closeRt(this.rtMirror);
    this.rt = null;
    this.rtMirror = null;
    this.deviceLane = null;
    this.mirrorLane = null;
    this.primaryDeviceId = null;
    this.mirrorDeviceId = null;
    this.openedSecondaryQuery = null;
    this.mirrorWatchedDefaultId = null;
    this.primaryApi = undefined;
    this.secondaryApi = undefined;
    this.primaryGaveUp = false;
    this.primaryGate = null;
    this.primaryOpenedAtMs = 0;
    this.secondaryGate = null;
    this.mirrorOpenedAtMs = 0;
    this.mirrorClock = null;
    this.openedPrimaryQuery = null;
    this.primaryWatchedDefaultId = null;
    this.streamRate = 0;
    this.openedDeviceKey = null;
  }


  private newTrack(onStarted: (ts: number) => void, onEnded: (ts: number) => void): Track {
    return {
      queue: [],
      written: 0,
      lastTimelineSample: 0,
      closed: false,
      onStarted,
      onEnded,
      startedResolved: false,
      endedResolved: false,
      endedTimer: null,
    };
  }

  /** 打开(或按需重开)时间线;设备打不开退化 silent,时间线照常 */
  private ensureOpen(sampleRate: number): void {
    const query = (this.opts.device?.() ?? '').trim();
    const secondary = this.opts.secondary?.() ?? 'default';
    const key = `${query}@${sampleRate}@${secondary}`;
    const sameKey = this.streamRate > 0 && this.openedDeviceKey === key;
    // 有轨道在播时不重开主设备(换采样率的来片走重采样);副路仍跟所选设备
    if (this.streamRate > 0 && this.tracks.length > 0) {
      this.syncSecondary();
      return;
    }
    const intentionalSilentTimeline = query.toLowerCase() === 'none';
    if (sameKey && (this.rt !== null || intentionalSilentTimeline) && !(query === '' && this.primaryDefaultMoved())) {
      this.syncSecondary();
      return;
    }
    this.closeRt(this.rt);
    this.closeRt(this.rtMirror);
    this.rt = null;
    this.rtMirror = null;
    this.deviceLane = null;
    this.mirrorLane = null;
    this.primaryDeviceId = null;
    this.mirrorDeviceId = null;
    this.openedSecondaryQuery = null;
    this.mirrorWatchedDefaultId = null;
    this.primaryApi = undefined;
    this.secondaryApi = undefined;
    this.primaryGaveUp = false;
    // 换设备/换采样率才算新一轮;同一台设备原地重开不清退避,否则一句一开又成循环。
    if (this.openedDeviceKey !== key) {
      this.primaryGate = null;
      this.primaryOpenedAtMs = 0;
    }
    this.secondaryGate = null;
    this.mirrorOpenedAtMs = 0;
    this.mirrorClock = null;
    this.openedPrimaryQuery = null;
    this.primaryWatchedDefaultId = null;
    this.streamRate = sampleRate;
    this.frameSamples = Math.max(64, Math.round(sampleRate / 50));
    this.originWallMs = this.now();
    this.writtenSamples = 0;
    this.latencyMs = 0;
    this.openedDeviceKey = key;
    this.outChannels = 1;
    this.mirrorChannels = 1;
    const audify = query.toLowerCase() === 'none' ? null : this.nativeAudio();
    // 退避期内不开:这台设备刚刚连着开不住,来一句就试一次等于把循环换个驱动源。
    if (audify && this.primaryRetryAllowed()) {
      const opened = this.openOnApis(audify, query, sampleRate, 'cortico-vtuber');
      if (opened) {
        this.rt = opened.rt;
        this.primaryOpenedAtMs = this.now();
        this.primaryDeviceId = opened.deviceId;
        this.outChannels = opened.channels;
        this.primaryApi = opened.api;
        this.openedPrimaryQuery = query;
        this.primaryWatchedDefaultId = query === '' ? this.playbackTable()?.defaultId ?? null : null;
        try {
          this.latencyMs = (opened.rt.getStreamLatency() / sampleRate) * 1000;
        } catch {
          this.latencyMs = 0;
        }
        // 原生流已在时间线零帧之前排入预热静音。
        this.originWallMs = this.now() + opened.primingDelayMs;
        this.writtenSamples = 0;
        this.armDeviceClock(0, opened.primingSamples);
        this.trace(
          '音频',
          `主输出已开:${opened.name} @${sampleRate}Hz ${opened.channels}ch ${opened.label},延迟 ${Math.round(this.latencyMs)}ms`,
        );
        this.syncSecondary();
        // 副输出打开可能慢于主输出预热；两条输出都交回控制权后，时间线零帧才成立。
        this.originWallMs = Math.max(this.originWallMs, this.now());
      } else {
        this.log.warn('输出设备打不开,音频走静音时间线', { query });
      }
    }
    if (!this.rt) {
      this.trace('音频', `静音时间线 @${sampleRate}Hz(${query.toLowerCase() === 'none' ? '设备:none' : '设备不可用'})`);
    }
    if (!this.pump) {
      this.pump = setInterval(() => this.step(), PUMP_INTERVAL_MS);
      this.pump.unref?.();
    }
  }

  private apiSpecs(audify: AudifyModule, avoid?: number): Array<{ api: number | undefined; label: string }> {
    if (process.platform !== 'win32') {
      return [{ api: preferredApi(audify), label: 'default' }];
    }
    const all = [
      { api: audify.RtAudioApi.WINDOWS_WASAPI, label: 'WASAPI' },
      { api: audify.RtAudioApi.WINDOWS_DS, label: 'DirectSound' },
    ];
    return rotatePreferFirst(all, all.find((item) => item.api === avoid));
  }

  /** 主副共用:按名字在开流的那条实例上选设备,后端顺序见 `apiSpecs`。 */
  private openOnApis(
    audify: AudifyModule,
    query: string,
    sampleRate: number,
    streamName: string,
    avoid?: number,
  ): {
    rt: RtAudioLike;
    deviceId: number;
    channels: number;
    name: string;
    primingDelayMs: number;
    primingSamples: number;
    api: number | undefined;
    label: string;
  } | null {
    for (const spec of this.apiSpecs(audify, avoid)) {
      const opened = this.tryOpenOutput(audify, spec.api, query, sampleRate, streamName);
      if (opened) return { ...opened, api: spec.api, label: spec.label };
    }
    return null;
  }

  /** 配置页那张 WASAPI 设备表;主副是否同一台设备也按它比,不拿两条流各自的 id 对。 */
  private playbackTable(): { devices: DeviceInfo[]; defaultId: number } | null {
    const audify = this.audify ?? this.nativeAudio();
    if (!audify) return null;
    try {
      const rt = new audify.RtAudio(preferredApi(audify));
      return { devices: rt.getDevices(), defaultId: rt.getDefaultOutputDevice() };
    } catch {
      if (!this.rt) return null;
      return { devices: this.rt.getDevices(), defaultId: this.rt.getDefaultOutputDevice() };
    }
  }

  /**
   * 主输出这条流死了。跑满 PRIMARY_STABLE_MS 的那条死掉算新一轮(设备切换、
   * 驱动重载那类一次性事故不该背旧账);没跑够的留着记账,交给退避阶梯。
   */
  private notePrimaryDeath(): void {
    const stable = this.primaryOpenedAtMs > 0
      && this.now() - this.primaryOpenedAtMs >= PRIMARY_STABLE_MS;
    // 开流时刻只属于活着的那条流:留着它,退避期里的每次重试都会被判成「上一条
    // 跑够久了」,阶梯永远爬不上去。
    this.primaryOpenedAtMs = 0;
    if (stable) this.primaryGate = null;
  }

  /**
   * 记一次重开尝试,并排下次可试时刻。第一次死立刻重开、第二次也还给一次即时
   * 重试(真一次性事故常常两帧内解决),从第三次起 0.5→5s 指数退避。
   */
  private notePrimaryAttempt(): void {
    const now = this.now();
    if (!this.primaryGate) this.primaryGate = { fails: 0, nextTryMs: 0, warnedAtMs: 0, sinceMs: now };
    const gate = this.primaryGate;
    gate.fails += 1;
    gate.nextTryMs = now + (gate.fails <= 1
      ? 0
      : Math.min(PRIMARY_RETRY_MAX_MS, PRIMARY_RETRY_BASE_MS * 2 ** (gate.fails - 2)));
  }

  /** 退避未到点时不再开主输出流。没有失败记账时永远放行。 */
  private primaryRetryAllowed(): boolean {
    const gate = this.primaryGate;
    if (!gate || gate.fails === 0) return true;
    return this.now() >= gate.nextTryMs;
  }

  /** 主输出跑满 PRIMARY_STABLE_MS 才算真开住:那一刻才清失败记账,并报一次恢复。 */
  private notePrimaryAlive(): void {
    const gate = this.primaryGate;
    if (!gate || this.primaryOpenedAtMs === 0) return;
    if (this.now() - this.primaryOpenedAtMs < PRIMARY_STABLE_MS) return;
    if (gate.fails >= PRIMARY_WARN_AFTER) {
      this.log.warn('主输出已开住', {
        此前连续开不住: gate.fails,
        无声时长秒: Math.round((this.now() - gate.sinceMs) / 1000),
      });
    }
    this.primaryGate = null;
  }

  /**
   * 重开的回报。偶发一次仍走原来的 trace(演出日志里那行事实);连着开不住就
   * 改成节流的 warn,把「这段时间这台设备没有声音」说出口——刷屏的 info 谁都
   * 看不出它是一场事故。
   */
  private reportPrimaryReopen(name: string, label: string, dead: { open?: boolean; time?: number }): void {
    const gate = this.primaryGate;
    if (!gate || gate.fails < PRIMARY_WARN_AFTER) {
      this.trace('音频', `主输出重开:${name} ${label}`);
      return;
    }
    const now = this.now();
    if (gate.warnedAtMs > 0 && now - gate.warnedAtMs < PRIMARY_WARN_GAP_MS) return;
    gate.warnedAtMs = now;
    this.log.warn('主输出反复开不住:开流成功后随即停跑,这段时间该设备上没有声音', {
      device: name,
      api: label,
      连续次数: gate.fails,
      已持续秒: Math.round((now - gate.sinceMs) / 1000),
      死流: dead.open === undefined ? '未知' : dead.open ? '仍开着(渲染线程自己退了)' : '已关',
      ...(dead.time === undefined ? {} : { 播放时钟秒: dead.time }),
    });
  }

  /** 读取失效流的开关状态与播放时钟；原生后端读取失败的字段留空。 */
  private probeStream(rt: RtAudioLike | null): { open?: boolean; time?: number } {
    if (!rt) return {};
    const out: { open?: boolean; time?: number } = {};
    try {
      out.open = rt.isStreamOpen();
    } catch {
      /* 已经坏了 */
    }
    try {
      out.time = rt.streamTime;
    } catch {
      /* 后端不报 */
    }
    return out;
  }

  /**
   * 记一次副输出失败(开不起来,或开起来随即停跑),排下次可试时刻。
   * 到 MIRROR_RETRY_LIMIT 即放弃,并且整轮只 warn 一次。
   */
  private noteSecondaryFail(query: string, reason: string): void {
    if (!this.secondaryGate || this.secondaryGate.query !== query) {
      this.secondaryGate = { query, fails: 0, nextTryMs: 0, warned: false };
    }
    const gate = this.secondaryGate;
    gate.fails += 1;
    gate.nextTryMs = this.now()
      + Math.min(MIRROR_RETRY_MAX_MS, MIRROR_RETRY_BASE_MS * 2 ** (gate.fails - 1));
    if (gate.fails < MIRROR_RETRY_LIMIT || gate.warned) return;
    gate.warned = true;
    this.log.warn('副输出连续开不住,放弃这一路,只走主设备', { query, reason, tries: gate.fails });
  }

  /** 退避未到点或已放弃时不再开流。查询串与闸门记的那条不同,视为新一轮。 */
  private secondaryRetryAllowed(query: string): boolean {
    const gate = this.secondaryGate;
    if (!gate || gate.query !== query) return true;
    if (gate.fails >= MIRROR_RETRY_LIMIT) return false;
    return this.now() >= gate.nextTryMs;
  }

  /** 副输出跑满 MIRROR_STABLE_MS 才清失败计数:开成不等于开住,假活(时钟没走过)也不算。 */
  private noteMirrorAlive(): void {
    const gate = this.secondaryGate;
    if (!gate || gate.fails === 0 || this.mirrorOpenedAtMs === 0) return;
    if (this.now() - this.mirrorOpenedAtMs < MIRROR_STABLE_MS) return;
    if (this.mirrorClock && !this.mirrorClock.advanced) return;
    gate.fails = 0;
    gate.nextTryMs = 0;
    gate.warned = false;
  }

  /**
   * 假活判定:isStreamRunning 恒真但播放时钟(streamTime)冻住超过
   * MIRROR_FROZEN_MS。原生后端读取失败时跳过判定。
   * 每 500ms 的 syncSecondary 巡检里调用,顺带维护 mirrorClock 记账。
   */
  private mirrorClockFrozen(): boolean {
    const rt = this.rtMirror;
    if (!rt) return false;
    let t: number;
    try {
      t = rt.streamTime;
    } catch {
      return false;
    }
    const wall = this.now();
    const prev = this.mirrorClock;
    if (!prev || t > prev.time + 0.05) {
      this.mirrorClock = { time: t, wall, advanced: prev != null };
      return false;
    }
    return wall - prev.wall >= MIRROR_FROZEN_MS;
  }

  private openSecondary(audify: AudifyModule, sampleRate: number, query: string, avoid?: number): void {
    const opened = this.openOnApis(audify, query, sampleRate, 'cortico-vtuber-monitor', avoid);
    this.mirrorClock = null;
    if (!opened) {
      this.rtMirror = null;
      this.mirrorDeviceId = null;
      this.mirrorOpenedAtMs = 0;
      this.openedSecondaryQuery = query;
      this.secondaryApi = undefined;
      this.noteSecondaryFail(query, '开流失败');
      return;
    }
    this.rtMirror = opened.rt;
    this.mirrorChannels = opened.channels;
    this.mirrorLane = newLaneClock(opened.primingSamples / this.frameSamples, this.now());
    this.mirrorDeviceId = opened.deviceId;
    this.mirrorOpenedAtMs = this.now();
    this.openedSecondaryQuery = query;
    this.secondaryApi = opened.api;
    this.trace('音频', `副输出已开:${opened.name} @${sampleRate}Hz ${opened.channels}ch ${opened.label}`);
  }

  private tryOpenOutput(
    audify: AudifyModule,
    api: number | undefined,
    query: string,
    sampleRate: number,
    streamName: string,
  ): {
    rt: RtAudioLike; deviceId: number; channels: number; name: string;
    primingDelayMs: number; primingSamples: number;
  } | null {
    let rt: RtAudioLike | null = null;
    try {
      rt = new audify.RtAudio(api);
      const hit = pickPlaybackHit(rt.getDevices(), query, rt.getDefaultOutputDevice());
      if (!hit) return null;
      const channels = Math.min(2, Math.max(1, hit.outputChannels));
      rt.openStream(
        { deviceId: hit.id, nChannels: channels, firstChannel: 0 },
        null,
        audify.RtAudioFormat.RTAUDIO_SINT16,
        sampleRate,
        this.frameSamples,
        streamName,
        null,
        null,
      );
      rt.outputVolume = 1;
      rt.start();
      const silence = Buffer.alloc(this.frameSamples * channels * 2);
      const primingStartedAt = this.now();
      for (let i = 0; i < PRIMING_FRAMES; i++) rt.write(silence);
      const primingFrames = this.frameSamples * PRIMING_FRAMES;
      const elapsedFrames = Math.max(0, this.now() - primingStartedAt) * sampleRate / 1000;
      const primingDelayMs = Math.max(0, primingFrames - elapsedFrames) / sampleRate * 1000;
      if (!rt.isStreamRunning()) {
        this.closeRt(rt);
        return null;
      }
      return { rt, deviceId: hit.id, channels, name: hit.name, primingDelayMs, primingSamples: primingFrames };
    } catch {
      this.closeRt(rt);
      return null;
    }
  }

  private primaryDefaultMoved(): boolean {
    if (this.openedPrimaryQuery !== '') return false;
    const table = this.playbackTable();
    if (!table || this.primaryWatchedDefaultId == null) return false;
    return table.defaultId !== this.primaryWatchedDefaultId;
  }

  /** 副输出跟当前所选设备;主设备不动。选「系统默认」时默认切换会重开这一路。 */
  private syncSecondary(): void {
    if (this.streamRate === 0 || !this.audify) return;
    const pick = secondaryPickQuery(this.opts.secondary?.() ?? 'default');
    if (pick === null) {
      this.dropSecondary();
      return;
    }
    const table = this.playbackTable();
    const primaryQ = (this.opts.device?.() ?? '').trim();
    if (
      table
      && primaryQ.toLowerCase() !== 'none'
      && samePlaybackTarget(table.devices, table.defaultId, primaryQ, pick)
    ) {
      this.dropSecondary();
      return;
    }
    const def = table?.defaultId ?? null;
    let running = false;
    try {
      running = this.rtMirror?.isStreamRunning() === true;
    } catch {
      running = false;
    }
    const sameQuery = this.openedSecondaryQuery === pick;
    const defaultMoved = pick === '' && def != null && this.mirrorWatchedDefaultId !== def;
    // 假活与真死同路:记一笔失败、收流,让下面的退避与后端轮换接手。
    if (running && sameQuery && this.mirrorClockFrozen()) {
      this.noteSecondaryFail(pick, '假活(播放时钟不走)');
      this.closeMirrorStream();
      running = false;
    }
    if (running && sameQuery && !defaultMoved) return;
    // 开成了却已停跑,记一次失败;recoverLane 记过的那条已被收走,不会重复计。
    if (this.rtMirror && !running && sameQuery) this.noteSecondaryFail(pick, '流已停');
    // 默认设备换了 = 换了台机器,旧账作废;否则闸门说了算。
    if (defaultMoved) this.secondaryGate = null;
    else if (!this.secondaryRetryAllowed(pick)) {
      // 退避期内只收停掉的流:mirrorWatchedDefaultId 是 defaultMoved 的基准,清了闸门就被绕过。
      this.closeMirrorStream();
      return;
    }
    const avoid = running ? undefined : this.secondaryApi;
    this.dropSecondary();
    this.openSecondary(this.audify, this.streamRate, pick, avoid);
    this.mirrorWatchedDefaultId = def;
  }

  /**
   * 退避期收掉的主输出没人再碰它:写入路径见 `rt === null` 就直接返回,不会再进
   * `recoverLane`。所以退避到点这件事由泵巡检来推,和副输出同一个 500ms 节拍。
   */
  private retryPrimaryIfDue(): void {
    if (this.rt || this.primaryGaveUp || this.streamRate === 0 || !this.audify) return;
    const gate = this.primaryGate;
    if (!gate || gate.fails === 0 || !this.primaryRetryAllowed()) return;
    if ((this.opts.device?.() ?? '').trim().toLowerCase() === 'none') return;
    // recoverLane 会把这次记成一次尝试:退避阶梯按「试了几次」而不是「死了几次」
    // 爬,两者在这条路上是同一件事。
    this.recoverLane('primary');
  }

  /** 只收副输出那条流;查询串、默认设备、后端等记账留着供退避判断。 */
  private closeMirrorStream(): void {
    this.closeRt(this.rtMirror);
    this.rtMirror = null;
    this.mirrorLane = null;
    this.mirrorDeviceId = null;
    this.mirrorOpenedAtMs = 0;
    this.mirrorClock = null;
  }

  private dropSecondary(): void {
    this.closeMirrorStream();
    this.openedSecondaryQuery = null;
    this.mirrorWatchedDefaultId = null;
    this.secondaryApi = undefined;
  }

  private closeRt(rt: RtAudioLike | null): void {
    if (!rt) return;
    try {
      rt.closeStream();
    } catch {
      /* 已经坏了或未开 */
    }
  }

  /**
   * 读一次这条流的回调拍数,把这段时间弹掉的帧记到账上。
   * 原生时钟读取失败或数值非有限时返回 null；`advanced` 表示拍数是否增长。
   */
  private consumeTicks(rt: RtAudioLike, lane: LaneClock, now: number): { advanced: boolean; starved: number } | null {
    let time: number;
    try {
      time = rt.streamTime;
    } catch {
      return null;
    }
    if (!Number.isFinite(time)) return null;
    const ticks = Math.round((time * this.streamRate) / this.frameSamples);
    const delta = ticks - lane.ticks;
    if (delta <= 0) return { advanced: false, starved: 0 };
    const popped = Math.min(delta, lane.queuedFrames);
    lane.ticks = ticks;
    lane.atMs = now;
    lane.queuedFrames -= popped;
    lane.poppedFrames += popped;
    lane.starvedTicks += delta - popped;
    return { advanced: true, starved: delta - popped };
  }

  private laneOf(kind: 'primary' | 'mirror'): LaneClock | null {
    return kind === 'primary' ? this.deviceLane : this.mirrorLane;
  }

  private writeDevice(rt: RtAudioLike | null, channels: number, frame: Int16Array, kind: 'primary' | 'mirror'): void {
    if (!rt) return;
    try {
      if (!rt.isStreamRunning()) {
        this.recoverLane(kind);
        return;
      }
      const lane = this.laneOf(kind);
      // 副输出按真实积压追相位:主输出纠的是时间线,这一路纠的是"要不要写这一帧"。
      if (kind === 'mirror' && lane && this.consumeTicks(rt, lane, this.now()) !== null) {
        const queuedMs = ((lane.queuedFrames * this.frameSamples) / this.streamRate) * 1000;
        if (queuedMs > MIRROR_MAX_QUEUE_MS) {
          this.mirrorDropped += 1;
          // 每丢满 50 帧(1 秒)留一句:这一路一直在追,说明那台设备的时钟偏得多
          if (this.mirrorDropped % 50 === 0) {
            this.trace('音频', `副输出已丢 ${this.mirrorDropped} 帧追相位(队列曾到 ${Math.round(queuedMs)}ms)`);
          }
          return;
        }
      }
      const out = channels === 1 ? frame : spreadChannels(frame, channels);
      rt.write(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
      if (lane) lane.queuedFrames += 1;
      if (kind === 'mirror') this.noteMirrorAlive();
      else this.notePrimaryAlive();
    } catch (err) {
      this.log.warn(
        kind === 'primary' ? '音频写入失败,换后端重开' : '副输出写入失败,先收掉这一路',
        { err: err instanceof Error ? err.message : String(err) },
      );
      this.recoverLane(kind);
    }
  }

  /**
   * 停跑的那一路怎么救。主输出就地换后端重开(它是直播命脉,断一帧都算断播);
   * 副输出只记一笔失败并收掉流,重开交给 `syncSecondary` 按退避节奏做。
   */
  private recoverLane(kind: 'primary' | 'mirror'): void {
    const audify = this.audify;
    if (!audify || this.streamRate === 0) return;
    if (kind === 'primary') {
      const query = (this.opts.device?.() ?? '').trim();
      if (query.toLowerCase() === 'none') return;
      this.notePrimaryDeath();
      if (!this.primaryRetryAllowed()) {
        // 退避期内只收死流:时间线继续走静音,泵与演出时序不受影响,
        // 重开交给 step() 的巡检按退避节奏做。
        this.closeRt(this.rt);
        this.rt = null;
        return;
      }
      this.notePrimaryAttempt();
      const avoid = this.primaryApi;
      const dead = this.probeStream(this.rt);
      this.closeRt(this.rt);
      this.rt = null;
      const reopeningAt = this.now();
      const opened = this.openOnApis(audify, query, this.streamRate, 'cortico-vtuber', avoid);
      if (!opened) {
        this.primaryGaveUp = true;
        this.primaryApi = undefined;
        return;
      }
      this.rt = opened.rt;
      this.primaryOpenedAtMs = this.now();
      this.primaryDeviceId = opened.deviceId;
      this.outChannels = opened.channels;
      this.primaryApi = opened.api;
      this.primaryGaveUp = false;
      try {
        this.latencyMs = (opened.rt.getStreamLatency() / this.streamRate) * 1000;
      } catch {
        this.latencyMs = 0;
      }
      // 重开期间时间线没有推进:已排入样本的墙钟落点整体后移这段空档与预热。
      this.originWallMs += this.now() - reopeningAt + opened.primingDelayMs;
      // 新流的 streamTime 从 0 重新起算,基准是此刻的时间线位置(writtenSamples 不清)
      this.armDeviceClock(this.writtenSamples, opened.primingSamples);
      this.rearmTimelineEnds();
      this.reportPrimaryReopen(opened.name, opened.label, dead);
      return;
    }
    const pick = secondaryPickQuery(this.opts.secondary?.() ?? 'default');
    if (pick === null) {
      this.dropSecondary();
      return;
    }
    this.noteSecondaryFail(pick, '流已停');
    this.closeMirrorStream();
  }

  /** 新数据到达时立即推进，以降低首声延迟。 */
  private drive(): void {
    if (this.streamRate > 0) this.step();
  }

  /** 一条原生流刚开起来:记下它的时间线基准与预热量,消费记账重新起算 */
  private armDeviceClock(baseSamples: number, primingSamples: number): void {
    this.deviceBaseSamples = baseSamples;
    this.devicePrimingSamples = primingSamples;
    this.deviceLane = newLaneClock(primingSamples / this.frameSamples, this.now());
    this.driftClockWarned = false;
  }

  /**
   * 把时间线锚回声卡实际消费到哪儿。**没有这一步,声音会越播越晚。**
   *
   * 写入按墙钟推(见 step 的 target),消费按声卡时钟走,队列无界(见 LaneClock):
   * 两个时钟只要不同速,队列就只会往长的方向长,而队列有多长就是声音比字幕、比嘴型
   * 晚多少。锚点是**已消费的时间线样本数**,不是拍数:泵停一下(事件循环卡住超过
   * AHEAD_MS),声卡把队列饿空后放的是静音,拍数照走、帧没少 —— 拿拍数当消费量,
   * 那段静音就被记成"已播",之后补写进去的帧永远多出一段积压,一次卡顿一个台阶。
   * 按消费量锚,同一下卡顿变成时间线整体后移这么多(声音里是一段静音),不留台阶。
   *
   * "按声卡看,时间线零帧对应墙钟哪一刻" = `now − 已消费时间线样本数/采样率`。
   * `originWallMs` 对齐到它之后:写入节拍由声卡时钟决定(队列深度稳定在 AHEAD_MS
   * 附近)、`startedAt` 的投影不再乐观、播毕时刻也跟着准。
   *
   * 停摆的表不纠(见 DRIFT_CLOCK_STALL_MS):坏表只会一路把声音往后推。
   */
  private reanchorToDeviceClock(now: number): void {
    const rt = this.rt;
    const lane = this.deviceLane;
    if (!rt || !lane || this.streamRate === 0) return;
    const read = this.consumeTicks(rt, lane, now);
    if (read === null) return; // 后端不报这块表
    if (!read.advanced) {
      if (now - lane.atMs > DRIFT_CLOCK_STALL_MS && !this.driftClockWarned) {
        this.driftClockWarned = true;
        this.log.warn('声卡播放时钟停摆,时间线不再按它纠偏(声音与字幕的相位这段时间只能靠开流时的估计)', {
          停在拍: lane.ticks,
          停了毫秒: Math.round(now - lane.atMs),
        });
      }
      return;
    }
    if (read.starved > 0) this.reportStarvation(lane, read.starved, now);
    // 声卡已经弹掉的帧里,前 devicePrimingSamples 个样本是预热静音
    const played = this.deviceBaseSamples + lane.poppedFrames * this.frameSamples - this.devicePrimingSamples;
    if (played < 0) return; // 预热还没放完
    const observed = now - (played / this.streamRate) * 1000;
    const drift = observed - this.originWallMs;
    if (Math.abs(drift) < DRIFT_DEADBAND_MS) return;
    this.originWallMs = observed;
    // 一次纠偏超过 AHEAD_MS 就不是量化噪声了:已排定的播毕时刻跟着挪,并留痕
    if (Math.abs(drift) >= AHEAD_MS) {
      this.rearmTimelineEnds();
      this.trace('音频', `时间线按声卡纠偏 ${drift > 0 ? '+' : ''}${Math.round(drift)}ms`
        + `(正 = 声音本来会比字幕晚这么多)`);
    }
  }

  /** 声卡空转 = 泵没在 AHEAD_MS 内跑到,这段声音是静音;一次事故一行,进滚动摘要。 */
  private reportStarvation(lane: LaneClock, ticks: number, now: number): void {
    if (now - this.lastStarveReportMs < STARVE_REPORT_FOLD_MS) return;
    this.lastStarveReportMs = now;
    const ms = (n: number) => Math.round((n * this.frameSamples * 1000) / this.streamRate);
    this.trace(
      '音频',
      `声卡空转 ${ms(ticks)}ms:泵隔了 ${Math.round(now - this.lastStepAtMs)}ms 才跑到,这段没有声音,`
        + `时间线随之后移(本条流累计 ${ms(lane.starvedTicks)}ms)`,
      { level: 'warn', tally: '声卡空转' },
    );
  }

  /** 写入游标至少领先播放游标 AHEAD_MS；空轨道写入静音。 */
  private step(): void {
    if (this.streamRate === 0) return;
    const now = this.now();
    if (now - this.lastMirrorCheckMs >= 500) {
      this.lastMirrorCheckMs = now;
      this.retryPrimaryIfDue();
      this.syncSecondary();
    }
    // 先纠偏再算 target:target 是按 originWallMs 推的,纠完这一拍就按声卡的节拍写
    this.reanchorToDeviceClock(now);
    const target =
      Math.ceil(((this.now() - this.originWallMs) / 1000) * this.streamRate) +
      Math.round((AHEAD_MS / 1000) * this.streamRate);
    while (this.writtenSamples < target) this.writeFrame();
    this.lastStepAtMs = now;
  }

  private writeFrame(): void {
    const frame = new Int16Array(this.frameSamples);
    let filled = 0;
    while (filled < this.frameSamples) {
      const track = this.tracks[0];
      if (!track) break; // 队列空:剩余补静音
      const chunk = track.queue[0];
      if (!chunk) {
        if (track.closed) {
          this.finalize(track);
          this.tracks.shift();
          continue;
        }
        break; // 合成没跟上:本帧余下静音,时间线照走
      }
      if (!track.startedResolved) {
        track.startedResolved = true;
        const ts = this.originWallMs + ((this.writtenSamples + filled) / this.streamRate) * 1000 + this.latencyMs;
        track.onStarted(ts);
      }
      const n = Math.min(chunk.length, this.frameSamples - filled);
      frame.set(chunk.subarray(0, n), filled);
      filled += n;
      track.written += n;
      if (n === chunk.length) track.queue.shift();
      else track.queue[0] = chunk.subarray(n);
      track.lastTimelineSample = this.writtenSamples + filled;
      if (track.queue.length === 0 && track.closed) {
        this.finalize(track);
        this.tracks.shift();
      }
    }
    this.writeDevice(this.rt, this.outChannels, frame, 'primary');
    this.writeDevice(this.rtMirror, this.mirrorChannels, frame, 'mirror');
    this.writtenSamples += this.frameSamples;
  }

  /** 主输出重开会改变已排入样本的墙钟落点。 */
  private rearmTimelineEnds(): void {
    for (const track of this.endingTracks) {
      if (!track.endedTimer || track.endedResolved) continue;
      clearTimeout(track.endedTimer);
      track.endedTimer = null;
      this.finalize(track);
    }
  }

  /** 本片样本全部落线:按最后样本的墙钟位置排播毕 */
  private finalize(track: Track): void {
    if (track.endedResolved || track.endedTimer) return;
    if (!track.startedResolved) {
      track.startedResolved = true;
      track.onStarted(this.now());
    }
    const endWallMs = this.originWallMs + (track.lastTimelineSample / this.streamRate) * 1000 + this.latencyMs;
    this.endingTracks.add(track);
    track.endedTimer = setTimeout(
      () => {
        track.endedResolved = true;
        this.endingTracks.delete(track);
        track.onEnded(endWallMs);
      },
      Math.max(0, endWallMs - this.now()),
    );
    track.endedTimer.unref?.();
  }

  /** 立即收尾(stop/close):promise 不悬着 */
  private finish(track: Track): void {
    if (!track.startedResolved) {
      track.startedResolved = true;
      track.onStarted(this.now());
    }
    if (track.endedTimer) clearTimeout(track.endedTimer);
    this.endingTracks.delete(track);
    if (!track.endedResolved) {
      track.endedResolved = true;
      track.onEnded(this.now());
    }
  }

  /** 未写入部分套上 fadeMs 线性收口,之后的全部丢弃 */
  private truncateWithFade(track: Track, fadeMs: number): void {
    const fadeSamples = Math.max(1, Math.round((fadeMs / 1000) * Math.max(1, this.streamRate)));
    const out: Int16Array[] = [];
    let taken = 0;
    for (const chunk of track.queue) {
      if (taken >= fadeSamples) break;
      const n = Math.min(chunk.length, fadeSamples - taken);
      const faded = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        faded[i] = Math.round(chunk[i] * (1 - (taken + i) / fadeSamples));
      }
      out.push(faded);
      taken += n;
    }
    track.queue.length = 0;
    track.queue.push(...out);
    track.closed = true;
  }

  /** 采样率不合时间线时线性重采样(常态是同率直通) */
  private toStreamRate(data: Int16Array, srcRate: number): Int16Array {
    if (this.streamRate === 0 || srcRate === this.streamRate) return data;
    const ratio = this.streamRate / srcRate;
    const out = new Int16Array(Math.round(data.length * ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i / ratio;
      const lo = Math.floor(pos);
      const hi = Math.min(data.length - 1, lo + 1);
      out[i] = Math.round(data[lo] + (data[hi] - data[lo]) * (pos - lo));
    }
    return out;
  }
}

/** 默认设备变了之后镜像这一路怎么处理。 */
export function mirrorRetarget(
  shouldMirror: boolean,
  openedMirrorId: number | null,
  defaultId: number,
): 'keep' | 'close' | 'open' {
  if (!shouldMirror) return openedMirrorId == null ? 'keep' : 'close';
  if (openedMirrorId === defaultId) return 'keep';
  return 'open';
}

/** 主设备已经是系统默认时不再镜像,避免本机出两份。 */
export function shouldMirrorSystem(
  enabled: boolean,
  deviceQuery: string,
  primaryId: number,
  defaultId: number,
): boolean {
  if (!enabled) return false;
  const q = deviceQuery.trim().toLowerCase();
  if (!q || q === 'none') return false;
  return primaryId !== defaultId;
}

/** 单声道帧铺进 channels 路交织样本:每路同一份内容,左右等响 */
export function spreadChannels(frame: Int16Array, channels: number): Int16Array {
  const out = new Int16Array(frame.length * channels);
  for (let i = 0; i < frame.length; i++) {
    const base = i * channels;
    for (let c = 0; c < channels; c++) out[base + c] = frame[i];
  }
  return out;
}

function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  }
  return out;
}

function pcm16BytesToInt16(bytes: Uint8Array): Int16Array {
  // PCM16LE;字节数落单直接截掉残字节
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  const aligned = new Uint8Array(usable);
  aligned.set(bytes.subarray(0, usable));
  return new Int16Array(aligned.buffer);
}
