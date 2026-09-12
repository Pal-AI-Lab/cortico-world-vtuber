/**
 * L2 编排器:beat 队列、时序(gap 公式)、同拍次序、排队/硬打断、
 * 双触发调度。
 *
 * 语义与时间止步于此:向 L3 只发 cue,不碰任何参数值。
 */
import type { Logger } from 'cortico/core/types.ts';
import { countPauses, pauseMs, segmentUnits, type AlignedUnit, type PausePriors } from './align.ts';
import type { TraceOptions } from './diagnostics.ts';
import { planCut, pcm16ToFloat, type CutClass, type CutPlan } from './interrupt-fade.ts';
import type { GestureCue, IRFrame, Mixer } from './mixer.ts';
import { ScriptParser, type Beat, type BeatCommand, type SpeechAnchor, type SpeechPiece } from './parser.ts';
import { describeSilence, silenceData, type SilenceReport } from './silence-scan.ts';
import { StateMachines, type StateChannel } from './states.ts';
import {
  computeSubtitleCues,
  describeSubtitleCues,
  subtitleChunks,
  summarizeSubtitleCues,
  type SubtitleCue,
} from './subtitle-cues.ts';
import { decodeWav, type StreamingEnvelope, type TtsPiece, type TtsStreamSink } from './tts.ts';
import type { Channel, PerformancePack } from './pack.ts';

const BOUNDARY_SAME_LINE_MS = 100;
const BOUNDARY_NEW_LINE_MS = 400;
const ELLIPSIS_COMP_MS = 300;
const GAP_CAP_MS = 1200;
const GAP_JITTER = 0.1;
const SAME_BEAT_GESTURE_DELAY_MS = 300;
const HARD_INTERRUPT_FADE_MS = 150;
const TTS_PREFETCH = 2;
const GAZE_ONSET_MS = 350;
/** 静默 beat(无语音)占位:无 pulse 时停这一拍 */
const SILENT_BEAT_MS = 300;
/*
 * 主拍定时。Windows 的系统计时器量子约 15.6ms,setInterval(16) 常常落到
 * 两个量子(31ms):本机实测 60Hz 请求只能达到 36Hz,所有短促动作的单帧步长
 * 直接翻倍(诊断里 6-8°/帧 的"pulse 跳变"多半是它)。请求 8ms 则每个量子
 * 都到,实测 ~64Hz。
 *
 * 最小帧间隔只挡"系统计时器被别的进程拉到 1ms 分辨率时空转"这一种情况,
 * 阈值必须远小于目标帧间隔:真机进程里 WS 回包会把定时器唤醒的相位打散,
 * 阈值取 13ms 时一次 12.9ms 的早到被跳过、下一次落到下个量子,凭空造出
 * 28-31ms 长帧(诊断实测 evalHz 54 但跳变帧清一色 30ms+)。评估多了不亏:
 * 发送节奏由 L4 的双帧流水 + 候补位自己限流。
 */
const TICK_INTERVAL_MS = 8;
const MIN_FRAME_MS = 6;
/** 语音积压遍历的节流周期;见底通知的时间粒度为 250ms。 */
const BACKLOG_POLL_MS = 250;
/**
 * 句首头部模式(反射层):停顿超过这么久后再开口,算一个"句首",
 * 提前 LEAD 触发 speech_onset 韵律轨迹,让"先下压、再上扬"的上扬落在开口那一刻。
 */
const SPEECH_ONSET_PAUSE_MS = 350;
const SPEECH_ONSET_LEAD_MS = 260;

/*
 * 句内韵律:从 TTS 振幅包络里找重音,按概率排头动基元与抬眉。
 *
 * 为什么是事件级而不是把包络连续映射到角度:语音→头动本质欠定——头动能解释
 * F0 方差的 63–88%,反过来 F0 只能解释头动的 25–50%,连续映射最多复现一半方差。
 * 而事件级的条件概率很稳:重音处出现主要头动的概率约 80%(点头 42% /
 * 带过冲的点头 18% / 甩动 20%),强重音处抬眉约 70%。
 */
const ACCENT_MOTION_P = 0.8;
/** 三种基元在"有头动"里的归一化占比;swing 用带符号 intensity 随机甩左右 */
const ACCENT_PRIMITIVES: ReadonlyArray<{ clipId: string; weight: number; mirrored?: boolean }> = [
  { clipId: 'accent_nod', weight: 0.525 },
  { clipId: 'accent_nod_overshoot', weight: 0.225 },
  { clipId: 'accent_swing', weight: 0.25, mirrored: true },
];
/**
 * 抬眉取片内重音排名的前段,比例为工程参数。包络按 p95 归一化后峰值集中在
 * 0.8–1.0,绝对电平不能区分强重音。
 */
const ACCENT_BROW_P = 0.7;
const ACCENT_BROW_TOP_RATIO = 1 / 3;
const ACCENT_BROW_LEAD_MS = 60;
const ACCENT_BROW_JITTER_MS = 200;
/** 重音判定:包络局部极大、不低于此电平、相邻重音至少隔这么久 */
const ACCENT_LEVEL_MIN = 0.6;
const ACCENT_MIN_GAP_MS = 320;
/** 包络扫描步长(Envelope 自身 hop 是 20ms) */
const ACCENT_SCAN_HOP_MS = 20;

/*
 * <> 锚点按全量对齐、前缀对齐、语速估计降级，超过死线时使用估计。语速来自 speechRate() 的实测分位，冷启动使用常量回落；埋点记录使用值与来源以复现计算。
 */
/** 起播引子:首单元 start 的实测量级。估计、预算、字幕三路共用这一个。 */
export const SPEECH_LEAD_IN_MS = 500;
/** 前缀对齐触发:已合成时长盖过估计位置这么多才对齐(要对齐的单元必须已在音频里);锚点与字幕跟播共用 */
const ANCHOR_ALIGN_MARGIN_MS = 500;
/** 前缀对齐仅在估计触发点进入此窗口后抢跑;窗口外等待全量对齐。 */
const ANCHOR_PREFIX_WINDOW_MS = 2500;
/** 前缀对齐重试要求 PCM 相比上次尝试新增足够覆盖量，避免对同一份音频反复请求。 */
const ANCHOR_REALIGN_GROWTH_MS = 300;
/** 对齐在死线到达时仍在执行，仅允许一次宽限。 */
const ANCHOR_DEADLINE_GRACE_MS = 400;
/** 锚点轮询与增量重音扫描节拍 */
const ANCHOR_POLL_MS = 150;
const STREAM_ACCENT_SCAN_MS = 300;

/*
 * 抢占在回看窗口内选择最近的 ≥150ms 对齐间隙;无合格停顿时立即收束。
 * 两类切点优先使用音素感知衰减,失败时回退为整体淡出;窗口与淡出时长可热调。
 */
const YIELD_WINDOW_MS = 500;
const YIELD_GAP_MS = 150;
/** 停顿切点保留 40ms 尾音,避免截断对齐单元末尾。 */
const YIELD_TAIL_MS = 40;
/** 立即收束的切点提前量:须大于声卡 sink 的写入领先量(AHEAD_MS),切点才落在未写入区 */
const CUT_LEAD_MS = 160;

/*
 * 过长合成的时长预算由文本单元、停顿和语速估计组成，用于限制持续输出的异常长音频。
 * 被检查片段自身的对齐末点或截断时长不能决定其破坏性阈值；语速取同声线其他有效样本，样本不足时使用默认值。
 */
/**
 * 预算倍率补偿逐字语速的个体差异：校准样本的实测音频约为裸估计的 1.4 倍。该倍率与预算之外的宽容余量分开计算。
 */
const OVERRUN_ESTIMATE_TOLERANCE = 1.6;
/**
 * 当前声线样本不足时，估计与预算共用的每单元时长回落值；有效实测速率可用时采用实测值。
 * 校准样本反解的每单元时长中位为 304ms、上尾为 776ms，400ms 回落用于避免单元时长系统性低估。字幕、锚点与预算共用该回落来源。
 */
export const BUDGET_MS_PER_UNIT = 400;
/**
 * 停顿补偿来自 3245 片完整样本的最小二乘系数（句末 569ms、句中 195ms、标签 1572ms），取整后使用。
 * 停顿单独计入以覆盖标点密集和拖音短句；同批校准中补偿使 125 片误截降为零，8 单元的 32 秒异常片仍超过约 6.1 秒的预算。
 */
export const PAUSE_PRIORS: PausePriors = { endPunctMs: 570, midPunctMs: 200, voiceTagMs: 1500 };
/**
 * 预算上的宽容余量取绝对项与比例项中的较大值。829 条样本的实测/预算比 p99 约为 1.38，1.8 倍项覆盖正常长尾；绝对 4000ms 项保障短句的下限。
 * 该门限制持续发声的异常长音频，静默检测另行处理连续静默。字幕时序仍使用 speechRate() 的 p75，不随宽容界放大。
 */
const OVERRUN_FORGIVE_MS = 4000;
const OVERRUN_FORGIVE_RATIO = 1.8;
/**
 * TTS server 的解码步数上限使输出恰好在 32000ms 停止；此信号独立于文本预算。与无效对齐、未被本地截流及文本预算不足共同构成末级时长兜底条件。
 */
const TTS_SERVER_MAX_AUDIO_MS = 32_000;
/**
 * 静默段几乎从片头开始且覆盖实测时长九成以上时，整片作废，不送声卡或字幕。静默必须严格连续，任一有声 hop 都会断开区间，避免把笑腔、拖音或间歇停顿合并为整片静默。
 */
const DEAD_SEG_MAX_START_MS = 200;
const DEAD_SEG_MIN_COVERAGE = 0.9;
const CUT_CLASS_LABEL: Record<CutClass, string> = { periodic: '浊音', noise: '擦音', silence: '静音' };

/** drainCurrentPiece 的轮询步长 */
const DRAIN_POLL_MS = 50;

/** 没有显式注视时的落点:面向镜头是待机相 */
const DEFAULT_GAZE = 'camera';

/** 一路流式播放会话(声卡 sink 边收边排播) */
export interface AudioStreamSession {
  /** 首块实际出声时刻 */
  started: Promise<number>;
  /** 尾块播毕时刻 */
  ended: Promise<number>;
  push(pcm: Uint8Array): void;
  /** 收流；durationMs 用于播毕超时计时。 */
  end(durationMs: number): void;
  /** 合成中止时移除已排队的剩余音频并立即释放资源。 */
  abort(): void;
}

export interface AudioSink {
  /** 送声卡播放;resolve 于实际开播,ended 于播毕 */
  play(piece: TtsPiece): Promise<{ startedAt: number; ended: Promise<number> }>;
  beginStream(sampleRate: number, text: string): AudioStreamSession;
  stop(fadeMs: number): void;
  /**
   * 音素感知切断在 atMs 截停当前播放,并用服务端渲染的衰减段替换后续内容。
   * 返回值表示切断是否已送达播放端。
   */
  cut?(atMs: number, plan: CutPlan): boolean;
}

export interface PreparedPlaybackOptions {
  /** 取消当前片，不影响普通语音队列。 */
  signal?: AbortSignal;
  /** 外部时间线选定的绝对墙钟锚点。 */
  anchorTs?: number;
  /** 取消后，已经开始的外部音频播毕前仍保留口型和字幕。 */
  drainAudioOnAbort?: boolean;
  /** 当前播放结束时清除状态指令。 */
  transientState?: boolean;
  /** 加入由 TTS 包络生成的开口和重音动作。 */
  speechProsody?: boolean;
}

/** TTS 后端能力面。 World 按开关与 server 能力决定给哪几样(§合成路径四组合)。 */
export interface PerformerTts {
  /** 整段合成;开启对齐时 World 内部已挂质量门并附 units */
  synth(text: string, signal?: AbortSignal): Promise<TtsPiece>;
  /** 流式合成;server 不支持或开关关闭时缺席。返回的完整片可能带 units(World 收流后对齐)。maxDurationMs=跑飞止损预算,超出即掐流保留已收部分 */
  synthStream?(text: string, sink: TtsStreamSink, signal: AbortSignal, maxDurationMs?: number): Promise<TtsPiece>;
  /** 对一段 PCM16 前缀跑对齐(锚点抢时间用);对齐不可用返回 null */
  alignPcm?(pcm: Uint8Array, sampleRate: number, units: string[]): Promise<AlignedUnit[] | null>;
}

/** onCue 的一条:标签词与所属通道(Reset 无通道,记 'reset') */
export interface PerformCueNote {
  word: string;
  channel: Channel | 'reset';
}

/**
 * 一次估计使用的语速，由 World 按当前声线近期样本计算。编排器不缓存，每次现取；样本更新后，同一文本的估计可随语速变化。
 */
export interface SpeechRateHint {
  /** 每语言单元的时长(ms);与 SPEECH_LEAD_IN_MS 配套用 */
  msPerUnit: number;
  /** true=当前声线近期实测的分位;false=样本不足,这是 BUDGET_MS_PER_UNIT 回落 */
  measured: boolean;
  /** 参与分位的样本条数(回落时是不足的那个数,埋点要印) */
  samples: number;
}

/** 语速口径的一行说明,进埋点用:字幕/预算走了哪一级时间源一眼可见。 */
export function describeSpeechRate(hint: SpeechRateHint): string {
  return hint.measured
    ? `实测 ${Math.round(hint.msPerUnit)}ms/单元(近期 ${hint.samples} 片)`
    : `常数回落 ${Math.round(hint.msPerUnit)}ms/单元(样本 ${hint.samples} 片,不足)`;
}

export interface PerformerDeps {
  tts: PerformerTts;
  audio: AudioSink;
  mixer: Mixer;
  backend: { sendFrame(frame: IRFrame): void; fx(clipId: string): void; fxDurationMs(clipId: string): number; stop(): void };
  /** 演出包(词表与曲线);每拍现取,控制台重载后立即生效 */
  pack: () => PerformancePack;
  log: Logger;
  /**
   * 播出延迟地板:演出不得早于这个墙钟时刻(0=无约束)。 World 按
   * OBS 延迟与延迟源的近期事件算出来;编排器每拍现问,不缓存。
   */
  broadcastFloorMs?: () => number;
  /** 流式输出开关(热;还需 tts.synthStream 在场才真流式) */
  streamEnabled?: () => boolean;
  /** 礼让收束找停顿的窗口(ms;控制台热调);缺省 500 */
  yieldWindowMs?: () => number;
  /** 礼让收束的回落淡出时长(ms;控制台热调);音素感知切断走不了时才用,缺省 150 */
  yieldFadeMs?: () => number;
  /** 逐字对齐开关(热):关闭时流式片沿 <> 剪成子片、接缝触发锚点 */
  alignEnabled?: () => boolean;
  /**
   * 当前声线的实测语速(热;缺席或返回不合法数时全线回落 BUDGET_MS_PER_UNIT)。
   * 字幕 estimate 档、跑飞门预算、锚点死线估计三处共用这一个来源。
   */
  speechRate?: () => SpeechRateHint;
  /** 队列耗尽(下降沿,每次见底报一次;新语音顶回后才允许再次触发)。 */
  onDrained?: () => void;
  /** State 通道超时范围(ms;控制台热调);缺省用 states.ts 的默认档 */
  stateTimeouts?: (channel: StateChannel) => [number, number];
  /** 一束演出指令实际触发时的旁路通知(舞台页的标签提示等);reset 的 channel 为 'reset' */
  onCue?: (cues: PerformCueNote[]) => void;
  /**
   * 一片语音的字幕时间轴。cue 的 atMs 相对**这次回调的时刻**:开播尚在未来时为正,
   * 负值表示这条已经念到 |atMs| 处(订阅端立即上屏、增量从该处续)。同一片会多次
   * 回调——开播一次,播放中每拿到更准的时间源再发一次,每次都是仍在显示区间内的
   * 全部 cue,订阅端以最新一批为准。basis 说明这批的时间源:全量对齐 > 前缀对齐 >
   * 片时长比例 > 校准估计。
   */
  onSubtitle?: (payload: {
    text: string;
    cues: SubtitleCue[];
    basis: 'align' | 'prefix' | 'duration' | 'estimate';
  }) => void;
  /** 外部播放被截断时使当前字幕失效。 */
  onSubtitleCut?: () => void;
  /** 演出关键事件的旁路日志(轮/拍/TTS/cue/模式…);不提供则静默。opts.level 见 TraceOptions */
  trace?: (area: string, msg: string, opts?: TraceOptions) => void;
  rng?: () => number;
  now?: () => number;
}

/**
 * 流式片的一段(逐字对齐关闭时沿 <> 剪开,每段一路流;开启时整片一段)。
 * 合成与播放解耦:分块先进 chunks 缓冲,播放会话开启后直推——预取语义
 * 由此保住,整轮只有第一段真正付 TTFA。
 */
interface StreamSeg {
  text: string;
  /** 段后接缝要触发的锚点指令(组合②);最后一段为空 */
  seamCommands: BeatCommand[];
  sampleRate: number;
  envelope: StreamingEnvelope | null;
  /** 播放会话开启前积压的分块 */
  chunks: Uint8Array[];
  /** 全部已收分块(前缀对齐要用原始 PCM;片播完释放) */
  pcm: Uint8Array[];
  pcmBytes: number;
  session: AudioStreamSession | null;
  synthing: boolean;
  synthDone: boolean;
  failed: boolean;
  /** 整片死气已作废(静默起点≈0 且覆盖近全片):不入声卡、playSeg 不发字幕 */
  dead: boolean;
  /** 收流后的完整片(World 开对齐时带 units) */
  result: TtsPiece | null;
  abort: (() => void) | null;
  /** 播放中最近一次前缀对齐的结果;锚点抢跑与字幕跟播共用,一段同时最多一次在途 */
  prefix: PrefixAlign | null;
  prefixInFlight: Promise<PrefixAlign | null> | null;
  /** 上次前缀对齐时的已覆盖时长;覆盖没长出 ANCHOR_REALIGN_GROWTH_MS 就不再发 */
  prefixTriedAtMs: number;
}

/** 一次前缀对齐:对齐器对单元表前缀给出的时刻,以及送去的 PCM 覆盖到哪 */
interface PrefixAlign {
  units: AlignedUnit[];
  coveredMs: number;
}

/**
 * 前缀对齐里可采信的单元数:单元要完整落在送去对齐的音频里。估计偏早时前缀可能
 * 还没盖到真实位置,对齐器会把时间桶外推出去,真机实测方差到秒级——那种结果留给
 * 后续更长的前缀或全量对齐。
 */
function trustedPrefixCount(pa: PrefixAlign): number {
  const limitSec = (pa.coveredMs - ACCENT_SCAN_HOP_MS) / 1000;
  let n = 0;
  for (const u of pa.units) {
    if (u.end > limitSec || u.end < u.start) break;
    n++;
  }
  return n;
}

interface PerfPiece {
  round: Round;
  beatIndex: number;
  text: string;
  endsWithEllipsis: boolean;
  anchors: SpeechAnchor[];
  /** 播前立即触发的锚点指令(空文本段坍缩而来) */
  preCommands: BeatCommand[];
  /** 非流式路径 */
  tts: TtsPiece | null;
  synthing: boolean;
  failed: boolean;
  played: boolean;
  /** 流式路径;null = 走非流式 */
  segs: StreamSeg[] | null;
}

interface PerfBeat {
  round: Round;
  beat: Beat;
  pieces: PerfPiece[];
  /** 后续还可能有 piece(流没关、且它是最后一个 beat) */
  open: boolean;
  cuesFired: boolean;
}

interface Round {
  id: number;
  /** 播放结果关联的 vtuber_act 调用 id；控制台演出等无源调用为 null。 */
  callId: string | null;
  beats: PerfBeat[];
  ended: boolean;
  dropped: boolean;
}

/** 一片语音的本地播放结果 */
export interface PieceOutcome {
  text: string;
  /** 片前指令块的标签词(重组"实际播出的台本"用) */
  tags: string[];
  /** 'all'=全片播出;数字=播出的前缀字符数;'none'=没开播 */
  spoken: 'all' | 'none' | number;
  precision?: 'aligned' | 'estimated' | 'playback-state';
}

/** 一轮演出被抢占/打断时的外流账本:实际播出了哪些、播到哪 */
export interface RoundOutcome {
  roundId: number;
  callId: string | null;
  /** true 表示完整台本均已播出。 */
  complete: boolean;
  pieces: PieceOutcome[];
}

/** 已完整合成、等待外部播放窗口调度的演出片。 */
export interface PreparedActPiece {
  index: number;
  text: string;
  tts: TtsPiece | null;
  commands: BeatCommand[];
  anchors: SpeechAnchor[];
  endsWithEllipsis: boolean;
  /** 从窗口边界到语音起点的延迟。 */
  leadMs: number;
  /** 音频结束后仍继续的动作或效果尾部。 */
  tailMs: number;
  occupiedMs: number;
}

export interface PreparedAct {
  callId: string | null;
  script: string;
  pieces: PreparedActPiece[];
}

export interface PreparedPlayback {
  startedAt: number;
  ended: Promise<number>;
  /** 外部总线暂停或重定基墙钟时的实际媒体位置。 */
  positionMs?: () => number;
}

export type PreparedAudioPlayer = (piece: TtsPiece) => Promise<PreparedPlayback>;

interface CurrentPlayback {
  piece: PerfPiece;
  startedAt: number;
  /** 流式路径时是正在出声的那一段 */
  seg?: StreamSeg;
}

/**
 * 从振幅包络里挑重音:局部极大 + 不低于电平门 + 相邻不挤在一起。
 * 用能量而不是 F0 是因为 TTS 只给了振幅包络;能量对头动的解释力弱一些
 * (R²≈0.32 vs F0 的 0.63),但重音位置基本对得上。
 */
function findAccents(
  tts: TtsPiece,
  levelMin: number,
  minGapMs: number,
): Array<{ ms: number; level: number }> {
  const n = Math.floor(tts.durationMs / ACCENT_SCAN_HOP_MS);
  if (n < 3) return [];
  const levels: number[] = [];
  for (let i = 0; i <= n; i++) levels.push(tts.envelope.at(i * ACCENT_SCAN_HOP_MS));
  const out: Array<{ ms: number; level: number }> = [];
  for (let i = 1; i < levels.length - 1; i++) {
    const v = levels[i];
    if (v < levelMin || v <= levels[i - 1] || v < levels[i + 1]) continue;
    const ms = i * ACCENT_SCAN_HOP_MS;
    const last = out[out.length - 1];
    if (last && ms - last.ms < minGapMs) {
      // 挤在一起时保留更强的那个
      if (v > last.level) out[out.length - 1] = { ms, level: v };
      continue;
    }
    out.push({ ms, level: v });
  }
  return out;
}

function concatPcm(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * 返回各单元在原文中的字符结束位置。单元按原文顺序出现，`[tag]` 按字面匹配。
 */
function unitCharEnds(text: string, unitTexts: string[]): number[] {
  const ends: number[] = [];
  let cursor = 0;
  for (const u of unitTexts) {
    const at = text.indexOf(u, cursor);
    if (at < 0) break;
    cursor = at + u.length;
    ends.push(cursor);
  }
  return ends;
}

/** 跑飞门的预算分项;estMs 是预算、cutMs 是掐流的宽容界,其余是它们的来源 */
export interface OverrunBreakdown {
  units: number;
  endPunct: number;
  midPunct: number;
  voiceTags: number;
  pauseMs: number;
  /** 这次预算实际用的每单元时长(实测分位或常数回落);埋点印它,不印常量 */
  msPerUnit: number;
  estMs: number;
  cutMs: number;
}

/**
 * 文本与显式传入的语速决定预算和宽容界，函数不读取实例状态。
 * segmentUnits 不计标点停顿，语音标签仅计一个单元，因此停顿需另行补偿；样本净速率扣除的停顿与此处补回的停顿使用同一组先验。
 */
export function overrunBudget(text: string, msPerUnit = BUDGET_MS_PER_UNIT): OverrunBreakdown {
  const units = segmentUnits(text).length;
  const counts = countPauses(text);
  const pause = pauseMs(counts, PAUSE_PRIORS);
  return {
    units,
    ...counts,
    ...overrunBudgetOf(units, pause, msPerUnit),
    pauseMs: pause,
    msPerUnit,
  };
}

/** 预算的数值内核:单元数、停顿补偿与每单元时长 → 预算与宽容界。历史样本按分项复算走这里。 */
export function overrunBudgetOf(
  units: number,
  pauseMs: number,
  msPerUnit = BUDGET_MS_PER_UNIT,
): { estMs: number; cutMs: number } {
  const estMs = (SPEECH_LEAD_IN_MS + units * msPerUnit + pauseMs) * OVERRUN_ESTIMATE_TOLERANCE;
  return { estMs, cutMs: Math.max(estMs + OVERRUN_FORGIVE_MS, estMs * OVERRUN_FORGIVE_RATIO) };
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('工具调用已取消');
}

class Gate {
  private waiters: Array<() => void> = [];
  wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }
  pulse(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

export class Performer {
  private readonly d: Required<Pick<PerformerDeps, 'tts' | 'audio' | 'mixer' | 'backend' | 'pack' | 'log'>> &
    PerformerDeps;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly states: StateMachines;
  private readonly gate = new Gate();

  private rounds: Round[] = [];
  private roundSeq = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private synthPumping = false;
  private stopped = true;
  /** 上一片语音结束时刻(下一 beat 锚点基准) */
  private prevEnd = 0;
  private prevEndedWithEllipsis = false;
  private lastEventAt = 0;
  private lastTickAt = 0;
  private playing = false;
  /** 锚点/接缝的在途定时器,打断与停机时一并清掉 */
  private readonly anchorTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 正在出声的那一片(礼让收束与积压估算的锚) */
  private currentPlayback: CurrentPlayback | null = null;
  /** 播报水位档位；仅在非空积压的下降沿报告。 */
  private backlogLevel: 'ample' | 'empty' = 'empty';
  private lastBacklogAt = 0;

  private readonly trace: (area: string, msg: string, opts?: TraceOptions) => void;

  constructor(deps: PerformerDeps) {
    this.d = deps;
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.trace = deps.trace ?? (() => {});
    this.states = new StateMachines({
      emit: (cue) => {
        this.trace('状态', `${cue.channel} → ${cue.clipId ?? '中性'} (fade ${Math.round(cue.fadeInMs)}ms)`);
        this.d.mixer.stateCue(cue);
      },
      neutral: (ch) => (ch === 'gaze' ? DEFAULT_GAZE : null),
      timeouts: deps.stateTimeouts,
      rng: this.rng,
    });
  }


  start(): void {
    this.stopped = false;
    const t = this.now();
    this.lastEventAt = t;
    this.prevEnd = t;
    this.ticker = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const r of this.rounds) r.dropped = true;
    this.abortLiveSynth(this.rounds);
    this.clearAnchorTimers();
    this.d.audio.stop(0);
    this.d.backend.stop();
    this.gate.pulse();
  }

  private clearAnchorTimers(): void {
    for (const t of this.anchorTimers) clearTimeout(t);
    this.anchorTimers.clear();
  }

  /** 打断或停机时立即中止在途流式合成。 */
  private abortLiveSynth(rounds: readonly Round[]): void {
    for (const r of rounds) {
      for (const b of r.beats) {
        for (const p of b.pieces) {
          if (!p.segs) continue;
          for (const s of p.segs) s.abort?.();
        }
      }
    }
  }


  status(): { queuedBeats: number; playing: boolean } {
    let queued = 0;
    for (const r of this.rounds) {
      if (r.dropped) continue;
      for (const b of r.beats) if (!b.cuesFired) queued++;
    }
    return { queuedBeats: queued, playing: this.playing };
  }

  /** 所有已受理轮次的末段音频与动作尾部完成后结束等待。 */
  async whenIdle(): Promise<void> {
    while (!this.drained()) await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }

  /** 外部时间线接管前清除普通演出状态。 */
  beginExternalTimeline(): void {
    const now = this.now();
    this.clearAnchorTimers();
    this.d.mixer.dropPendingProsody(now);
    this.states.resetAll(now);
  }

  /** 编排器当前状态全貌(诊断报表的 state 段) */
  snapshot(): Record<string, unknown> {
    const now = this.now();
    const live = this.rounds.filter((r) => !r.dropped);
    const round = live[live.length - 1];
    const pieces = this.livePieces();
    return {
      playing: this.playing,
      queuedBeats: this.status().queuedBeats,
      round: round ? { id: round.id, ended: round.ended, beats: round.beats.length } : null,
      pieces: {
        total: pieces.length,
        ready: pieces.filter((p) => !p.played && p.text !== '' && this.pieceReady(p)).length,
        synthing: pieces.filter((p) => p.synthing || p.segs?.some((s) => s.synthing)).length,
        failed: pieces.filter((p) => p.failed || (p.segs !== null && p.segs.length > 0 && p.segs.every((s) => s.failed)))
          .length,
      },
      states: {
        pose: this.states.active('pose'),
        poseLeftMs: this.states.remainingMs('pose', now),
        emotion: this.states.active('emotion'),
        emotionLeftMs: this.states.remainingMs('emotion', now),
        gaze: this.states.active('gaze'),
        gazeLeftMs: this.states.remainingMs('gaze', now),
      },
      timing: {
        prevEndInMs: Math.round(this.prevEnd - now),
        sinceLastEventMs: Math.round(now - this.lastEventAt),
        broadcastFloorInMs: (() => {
          const floor = this.d.broadcastFloorMs?.() ?? 0;
          return floor > now ? Math.round(floor - now) : null;
        })(),
      },
    };
  }

  statusLine(): string {
    const s = this.status();
    const play = s.playing ? '正在说话' : s.queuedBeats > 0 ? `排队 ${s.queuedBeats} 拍` : '安静';
    return `[演出状态] ${play}`;
  }


  /**
   * 开始新一轮演出——**追加语义**:排在既有队列后面,不动正在播/排队的内容。
   * 替换旧内容时先调用 preempt(),再开始新轮;perform()组合这两个操作。
   * 返回的手柄接收增量 script 文本。
   */
  beginRound(opts: { callId?: string | null } = {}): { feed(text: string): void; end(): void } {
    const queuedBehind = this.status().queuedBeats;
    const round: Round = {
      id: ++this.roundSeq,
      callId: opts.callId ?? null,
      beats: [],
      ended: false,
      dropped: false,
    };
    this.rounds.push(round);
    this.trace('轮', `#${round.id} 开新轮${queuedBehind > 0 ? `,排在 ${queuedBehind} 拍之后` : ''}`, {
      level: 'info',
      event: 'round-open',
      data: { roundId: round.id, queuedBehind },
    });
    const parser = new ScriptParser({
      onBeat: (beat) => this.onBeat(round, beat),
      onSpeech: (beatIndex, piece) => this.onSpeech(round, beatIndex, piece),
      onEnd: () => {
        round.ended = true;
        const last = round.beats[round.beats.length - 1];
        if (last) last.open = false;
        const pieces = round.beats.reduce((n, b) => n + b.pieces.length, 0);
        this.trace('轮', `#${round.id} 脚本收完:${round.beats.length} 拍 / ${pieces} 片语音`, {
          level: 'info',
          event: 'script-done',
          data: { roundId: round.id, beats: round.beats.length, pieces },
        });
        this.gate.pulse();
      },
    }, this.d.pack());
    return {
      feed: (text) => parser.feed(text),
      end: () => parser.end(),
    };
  }

  /**
   * 打断栅栏:此刻为止已经开出去的最后一个轮号。传给 `preempt({ maxRoundId })`
   * 就把那次打断钉死在这一刻——之后开的轮不在它的作用域内。
   */
  roundFence(): number {
    return this.roundSeq;
  }

  /** 控制台整段演出:立即抢占旧内容并开始新轮。 */
  perform(script: string): void {
    void this.preempt({ boundaryWindowMs: 0 });
    const h = this.beginRound();
    h.feed(script);
    h.end();
  }

  /** 完整编译一段 act，不触发 cue，也不写入音频。 */
  async prepareAct(
    script: string,
    callId: string | null = null,
    signal?: AbortSignal,
  ): Promise<PreparedAct> {
    throwIfCancelled(signal);
    const beats: Array<{ beat: Beat; pieces: SpeechPiece[] }> = [];
    const parser = new ScriptParser({
      onBeat: (beat) => beats.push({ beat, pieces: [] }),
      onSpeech: (beatIndex, piece) => {
        const beat = beats.find((entry) => entry.beat.index === beatIndex);
        if (beat) beat.pieces.push(piece);
      },
      onEnd: () => {},
    }, this.d.pack());
    parser.feed(script);
    parser.end();

    const pieces: PreparedActPiece[] = [];
    for (const entry of beats) {
      const speech = entry.pieces.length > 0
        ? entry.pieces
        : [{ text: '', endsWithEllipsis: false, anchors: [] } satisfies SpeechPiece];
      for (let i = 0; i < speech.length; i++) {
        const source = speech[i];
        const commands = i === 0 ? [...entry.beat.commands] : [];
        const tts = source.text ? await this.d.tts.synth(source.text, signal) : null;
        throwIfCancelled(signal);
        const leadMs = this.preparedLeadMs(commands);
        const tailMs = this.preparedTailMs(commands, source, tts, leadMs);
        const bodyMs = tts?.durationMs ?? 0;
        pieces.push({
          index: pieces.length,
          text: source.text,
          tts,
          commands,
          anchors: source.anchors.map((anchor) => ({
            charOffset: anchor.charOffset,
            commands: [...anchor.commands],
          })),
          endsWithEllipsis: source.endsWithEllipsis,
          leadMs,
          tailMs,
          occupiedMs: Math.max(SILENT_BEAT_MS, leadMs + bodyMs + tailMs),
        });
      }
    }
    return { callId, script, pieces };
  }

  /** 通过外部选定的音频总线播放一个预编译片。 */
  async playPreparedPiece(
    piece: PreparedActPiece,
    play: PreparedAudioPlayer,
    options: PreparedPlaybackOptions = {},
  ): Promise<number> {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const signal = options.signal;
    let speechActive = false;
    let subtitleVisible = false;
    let actionsStopped = false;
    const stopActions = (): void => {
      if (actionsStopped) return;
      actionsStopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      this.d.mixer.dropPendingProsody(this.now());
      if (options.transientState) this.states.resetAll(this.now());
    };
    const onAbort = (): void => stopActions();
    const anchor = options.anchorTs ?? this.now();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) return this.now();
      this.firePreparedCommands(piece.commands, anchor, timers, signal);
      if (!piece.tts) {
        await this.sleepUntilOrAbort(anchor + piece.occupiedMs, signal);
        return this.now();
      }

      const speechAt = anchor + piece.leadMs;
      if (options.speechProsody !== false && piece.leadMs >= SPEECH_ONSET_PAUSE_MS) {
        this.d.mixer.prosodyCue({
          clipId: 'speech_onset',
          startTs: speechAt - SPEECH_ONSET_LEAD_MS,
          intensity: 1,
        });
      }
      if (!await this.sleepUntilOrAbort(speechAt, signal)) return this.now();
      const opening = play(piece.tts);
      const opened = options.drainAudioOnAbort
        ? { completed: true as const, value: await opening }
        : await this.awaitOrAbort(opening, signal);
      if (!opened.completed) return this.now();
      const playback = opened.value;
      this.emitSubtitle(piece.text, piece.tts.units ?? null, piece.tts.durationMs, playback.startedAt, 'open');
      subtitleVisible = true;
      this.d.mixer.speechStart(
        (ms) => piece.tts!.envelope.at(playback.positionMs?.() ?? ms),
        playback.startedAt,
      );
      speechActive = true;
      if (!signal?.aborted) {
        if (options.speechProsody !== false) this.scheduleAccentProsody(piece.tts, playback.startedAt);
        this.schedulePreparedAnchors(piece, playback, timers, signal);
      }
      const ended = options.drainAudioOnAbort
        ? { completed: true as const, value: await playback.ended }
        : await this.awaitOrAbort(playback.ended, signal);
      if (!ended.completed) return this.now();
      if (!signal?.aborted && piece.tailMs > 0) {
        await this.sleepUntilOrAbort(ended.value + piece.tailMs, signal);
      }
      return this.now();
    } finally {
      signal?.removeEventListener('abort', onAbort);
      stopActions();
      if (speechActive) this.d.mixer.speechEnd();
      if (subtitleVisible && signal?.aborted) this.d.onSubtitleCut?.();
    }
  }

  /**
   * 关机前仅等待当前正在播放的片段，最多 maxMs，返回实际等待时长；不等待排队片段，下一片开播即视为本片结束。
   */
  async drainCurrentPiece(maxMs: number): Promise<number> {
    const playing = this.currentPlayback;
    if (!playing || this.stopped) return 0;
    const t0 = this.now();
    const deadline = t0 + Math.max(0, maxMs);
    while (this.currentPlayback === playing && !this.stopped && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    return this.now() - t0;
  }

  /**
   * 关机前等待整个演出队列（在播与排队），最多 maxMs，返回实际等待时长。调用方须使此期限明显小于全部 IO 收尾预算；仅等待当前片段使用 drainCurrentPiece。
   */
  async drainQueue(maxMs: number): Promise<number> {
    if (this.stopped) return 0;
    const t0 = this.now();
    const deadline = t0 + Math.max(0, maxMs);
    while (!this.stopped && this.speechBacklogMs() > 0 && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    return this.now() - t0;
  }

  /** 还没播出的片数(有台词、没失败、没播完):关机丢词回报的口径 */
  unplayedPieces(): number {
    return this.livePieces().filter((p) => !p.played && !p.failed && p.text !== '').length;
  }

  /**
   * 礼让式收束同步作废排队内容并中止对应合成;当前播放在 ≤window 内最近的
   * 自然停顿处淡出。音频结束后返回各轮外流账本,供调用方追加播放结果事件。
   *
   * `maxRoundId` 是**打断栅栏**:只作用到这个轮号为止,更晚开的轮一概不动
   * (音频、在途合成、锚点、韵律都不动)。缺省 = 作用于当下全部在活的轮。
   *
   * 同步保证:dropped 标记、合成 abort、锚点/韵律清理在返回 Promise 之前就已
   * 生效(async 函数首个 await 前同步执行),调用方可紧接着 beginRound 排新话。
   */
  async preempt(
    opts: { boundaryWindowMs?: number; fadeMs?: number; maxRoundId?: number } = {},
  ): Promise<RoundOutcome[]> {
    const windowMs = opts.boundaryWindowMs ?? this.d.yieldWindowMs?.() ?? YIELD_WINDOW_MS;
    const fadeMs = opts.fadeMs ?? this.d.yieldFadeMs?.() ?? HARD_INTERRUPT_FADE_MS;
    const fence = opts.maxRoundId;
    const inScope = (r: Round): boolean => fence === undefined || r.id <= fence;
    const live = this.rounds.filter((r) => !r.dropped && inScope(r));
    const playing = this.currentPlayback;
    // 栅栏外的那一片正在出声:这次打断与它无关,连淡出都不许碰
    const playingInScope = playing === null || inScope(playing.piece.round);
    if (live.length === 0) {
      if (playingInScope) this.d.audio.stop(fadeMs);
      return [];
    }
    for (const r of live) r.dropped = true;
    this.abortLiveSynth(live);
    if (playingInScope) {
      this.clearAnchorTimers();
      // 已作废语音的伴随头动不该继续发生
      this.d.mixer.dropPendingProsody(this.now());
    }
    this.gate.pulse();

    let cutInfo: { playing: CurrentPlayback; cutMs: number } | null = null;
    if (playing && playingInScope && !playing.piece.played) {
      // startedAt 是预计可听时刻，可位于未来；此时发生打断，已播时长钳为 0。
      const posMs = Math.max(0, this.now() - playing.startedAt);
      const boundaryMs = this.findYieldBoundary(playing, posMs, windowMs);
      // 停顿处收束,或立即收束(切点要越过 sink 的写入领先量,落在还改得动的区域)
      const atMs = boundaryMs > posMs ? boundaryMs : posMs + CUT_LEAD_MS;
      const plan = this.planCutFor(playing, atMs);
      if (plan && (this.d.audio.cut?.(atMs, plan) ?? false)) {
        cutInfo = { playing, cutMs: atMs };
        this.trace(
          '打断',
          `收束:播放位 ${Math.round(posMs)}ms → ${Math.round(atMs)}ms 切在${CUT_CLASS_LABEL[plan.cls]}上,衰减 ${Math.round(plan.fadeMs)}ms`,
          {
            event: 'yield-cut',
            data: { posMs: Math.round(posMs), atMs: Math.round(atMs), cls: plan.cls, fadeMs: Math.round(plan.fadeMs) },
          },
        );
        await this.sleepUntil(playing.startedAt + atMs + plan.fadeMs);
      } else {
        // 回落固定时长淡出:PCM 不在手,或切点越过已合成的末尾
        cutInfo = { playing, cutMs: boundaryMs };
        if (boundaryMs > posMs) {
          this.trace('打断', `收束:播放位 ${Math.round(posMs)}ms → ${Math.round(boundaryMs)}ms 停顿处淡出`, {
            event: 'yield-fade',
            data: { posMs: Math.round(posMs), atMs: Math.round(boundaryMs), fadeMs },
          });
          await this.sleepUntil(playing.startedAt + boundaryMs);
          // 等待期间片子自己放完了(停顿点贴着片尾):按全片播出记账
          if (playing.piece.played) cutInfo = null;
        }
        // 等待期间新一轮可能已开播(流式开演不经工具串行链):此刻 stop 切到的
        // 会是新话——仍是同一片在放才停
        if (this.currentPlayback === playing) this.d.audio.stop(fadeMs);
      }
    } else if (playingInScope) {
      this.d.audio.stop(fadeMs);
    }
    this.gate.pulse();
    return live.map((r) => this.roundOutcome(r, cutInfo?.playing ?? null, cutInfo?.cutMs ?? null));
  }

  /**
   * 超大静默段的处置:把静默段起点之后的死气从**观众还没听到的部分**里去掉。
   * 流已经在检出的那一刻被掐(见 tts.ts synthStream),这里管的是已收到的字节。
   *
   * 三种时序:
   * - 整片死气(静默起点≈0 且覆盖近全片,还没开始播放):整片作废——dead 标记,
   *   一个字节不进声卡,playSeg 连字幕都不发。判据依据见 DEAD_SEG_* 常量注释。
   * - 还没开始播放(预取时就收完了流):积压的分块还压在 seg.chunks 里,按起点裁掉,
   *   连带把交给播放会话的时长改成起点——那段死气一个字节都不进声卡。
   * - 已经在播:走与跑飞兜底同一套音素感知切断,切在起点(或播放位)之后。
   */
  private dropSilentTail(seg: StreamSeg, silence: SilenceReport): void {
    const result = seg.result;
    if (!result || seg.sampleRate <= 0) return;
    const startMs = silence.startMs;
    const coverage = result.durationMs > 0 ? silence.longestMs / result.durationMs : 0;
    if (!seg.session && startMs <= DEAD_SEG_MAX_START_MS && coverage >= DEAD_SEG_MIN_COVERAGE) {
      seg.dead = true;
      seg.chunks = [];
      const droppedMs = result.durationMs;
      result.durationMs = 0;
      this.trace(
        'TTS',
        `整片死气作废:${Math.round(droppedMs)}ms 音频里静默段起点 ${Math.round(startMs)}ms、`
          + `覆盖 ${Math.round(coverage * 100)}%,一个字节不进声卡,字幕也不发`,
        {
          detail: `「${seg.text.slice(0, 24)}」`,
          level: 'warn',
          tally: '死片',
          event: 'dead-seg',
          data: { droppedMs: Math.round(droppedMs), startMs: Math.round(startMs), coveragePct: Math.round(coverage * 100) },
        },
      );
      return;
    }
    if (seg.session) {
      // 已在播:起点为 0 时 cutTail 自会退化成「播放位 + 写入领先量」处收束
      this.cutTail(seg, startMs, result.durationMs, '超大静默段止损', '静默止损');
      return;
    }
    // 起点为 0 却够不着整片作废的门:裁到起点等于全部丢掉,可能连有声部分一起丢——放过
    if (startMs <= 0) return;
    const keepBytes = Math.round((startMs / 1000) * seg.sampleRate) * 2;
    const trimmed: Uint8Array[] = [];
    let kept = 0;
    for (const c of seg.chunks) {
      const room = (keepBytes - kept) & ~1; // PCM16 必须偶数对齐
      if (room <= 0) break;
      const take = Math.min(room, c.length);
      trimmed.push(take === c.length ? c : c.subarray(0, take));
      kept += take;
    }
    seg.chunks = trimmed;
    const keptMs = (kept / 2 / seg.sampleRate) * 1000;
    const droppedMs = result.durationMs - keptMs;
    result.durationMs = keptMs;
    this.trace(
      'TTS',
      // “这一片音频尚未开始播放”仅描述本地音频，避免使用会被理解为直播间状态的“还没开播”。
      `超大静默段止损:这一段尚未开始播放,${Math.round(droppedMs)}ms 死气未进声卡`
        + `(保留 ${Math.round(keptMs)}ms)`,
      { detail: `「${seg.text.slice(0, 24)}」`, level: 'warn', tally: '静默止损' },
    );
  }

  /**
   * 把在播这一段未播出的尾巴切掉。
   * 切点取 fromMs(垃圾段起点的估计)与「播放位 + 写入领先量」之大者 ——
   * 后者保证切在还改得动的区域。这一段不在播(还压在队列里没开声)就不动它:
   * 调用方各自处置。切走不了(cut 不可用/切点越界)同样放过,与打断路的回落
   * 不同,这里没有"必须收束"的语义,不值得为它硬停整路音频。
   */
  private cutTail(
    seg: StreamSeg,
    fromMs: number | null,
    durationMs: number,
    why: string,
    tally: string,
  ): void {
    const playing = this.currentPlayback;
    if (!playing || playing.seg !== seg || playing.piece.played) return;
    const posMs = this.now() - playing.startedAt;
    const atMs = Math.max(fromMs ?? 0, posMs + CUT_LEAD_MS);
    if (atMs >= durationMs) return; // 尾巴已经不剩什么
    const plan = this.planCutFor(playing, atMs);
    if (plan && (this.d.audio.cut?.(atMs, plan) ?? false)) {
      this.trace(
        'TTS',
        `${why},${Math.round(durationMs)}ms 音频在 ${Math.round(atMs)}ms 收束` +
          `(切在${CUT_CLASS_LABEL[plan.cls]}上,省 ${Math.round(durationMs - atMs)}ms)`,
        {
          detail: `「${seg.text.slice(0, 24)}」`,
          level: 'warn',
          tally,
          event: 'tail-cut',
          data: { audioMs: Math.round(durationMs), atMs: Math.round(atMs), cls: plan.cls, savedMs: Math.round(durationMs - atMs) },
        },
      );
    }
  }

  /** 从在播音频的原始 PCM 规划切断;拿不到 PCM 或切点越界返回 null(回落固定淡出) */
  private planCutFor(playing: CurrentPlayback, atMs: number): CutPlan | null {
    const seg = playing.seg;
    if (seg) {
      if (seg.sampleRate <= 0 || seg.pcmBytes === 0) return null;
      return planCut(pcm16ToFloat(seg.pcm, seg.pcmBytes), seg.sampleRate, atMs);
    }
    const tts = playing.piece.tts;
    if (!tts) return null;
    try {
      const decoded = decodeWav(tts.wav);
      return planCut(decoded.samples, decoded.sampleRate, atMs);
    } catch {
      return null;
    }
  }

  /**
   * 停顿点搜寻:posMs 之后、窗口之内,第一个"单元间隙 ≥150ms"的单元末尾
   * (再加一点余音)。没有对齐信息或窗口内没有合格停顿就原地收束。
   */
  private findYieldBoundary(playing: CurrentPlayback, posMs: number, windowMs: number): number {
    if (windowMs <= 0) return posMs;
    const units = playing.seg?.result?.units ?? playing.piece.tts?.units;
    if (!units || units.length < 2) return posMs;
    for (let i = 0; i < units.length - 1; i++) {
      const endMs = units[i].end * 1000;
      if (endMs <= posMs) continue;
      if (endMs > posMs + windowMs) break;
      if (units[i + 1].start * 1000 - endMs >= YIELD_GAP_MS) return endMs + YIELD_TAIL_MS;
    }
    return posMs;
  }

  /** 一轮的外流账本:逐拍逐片记"播没播、播到哪" */
  private roundOutcome(r: Round, playing: CurrentPlayback | null, cutMs: number | null): RoundOutcome {
    const pieces: PieceOutcome[] = [];
    let complete = r.ended;
    for (const b of r.beats) {
      const tags = b.beat.commands.map((c) => (c.kind === 'reset' ? 'Reset' : c.entry.word));
      if (b.pieces.length === 0) {
        pieces.push({ text: '', tags, spoken: b.cuesFired ? 'all' : 'none' });
        if (!b.cuesFired) complete = false;
        continue;
      }
      b.pieces.forEach((p, i) => {
        let spoken: PieceOutcome['spoken'];
        // 被切片的记账先于 played 标志:切断把 session 在切点收尾,等待衰减
        // 走完的间隙里 played 就翻真了,它不代表全片播出
        if (playing !== null && p === playing.piece && cutMs !== null) {
          const n = this.spokenCharsOfPiece(p, playing.seg, cutMs);
          spoken = n >= p.text.length ? 'all' : n;
        } else if (p.played) {
          spoken = 'all';
        } else {
          spoken = 'none';
        }
        if (spoken !== 'all') complete = false;
        const partial = playing !== null && p === playing.piece && cutMs !== null;
        const units = playing?.seg?.result?.units ?? p.tts?.units;
        const precision = partial ? (units?.length ? 'aligned' : 'estimated') : 'playback-state';
        pieces.push({ text: p.text, tags: i === 0 ? tags : [], spoken, precision });
      });
    }
    return { roundId: r.id, callId: r.callId, complete, pieces };
  }

  /** 被切片实际播出的字符数(片内文本坐标;多段片先折算此前整段) */
  private spokenCharsOfPiece(piece: PerfPiece, seg: StreamSeg | undefined, cutMs: number): number {
    if (piece.segs && seg) {
      let cursor = 0;
      for (const s of piece.segs) {
        const at = piece.text.indexOf(s.text, cursor);
        const start = at < 0 ? cursor : at;
        if (s === seg) {
          const inner = this.spokenCharsInText(s.text, s.result?.units, s.result?.durationMs ?? null, cutMs);
          return Math.min(piece.text.length, start + inner);
        }
        cursor = at < 0 ? cursor : at + s.text.length;
      }
      return cursor;
    }
    return this.spokenCharsInText(piece.text, piece.tts?.units, piece.tts?.durationMs ?? null, cutMs);
  }

  /** 时刻 → 文本字符位:有单元表按"末尾早于切点的单元"反查,否则按时长比例估 */
  private spokenCharsInText(
    text: string,
    units: AlignedUnit[] | undefined,
    durationMs: number | null,
    cutMs: number,
  ): number {
    if (units && units.length > 0) {
      const spoken = units.filter((u) => u.end * 1000 <= cutMs + YIELD_TAIL_MS + 1).length;
      if (spoken === 0) return 0;
      const ends = unitCharEnds(text, units.map((u) => u.text));
      return ends[Math.min(spoken, ends.length) - 1] ?? 0;
    }
    const dur = durationMs ?? this.estimateSpeechMs(text);
    return Math.max(0, Math.min(text.length, Math.round((text.length * cutMs) / Math.max(1, dur))));
  }

  /**
   * 这一刻的语速口径。全编排器只有这一个入口:字幕 estimate 档、跑飞门预算、
   * 锚点死线、积压估计、回执时长全从这儿取,不许再有第二个 ms/单元。
   *
   * World 返回不合法数(NaN、0、负数、离谱大)时按没接处理,回落常数——估计路径
   * 出错的代价是字幕错位,不该让它变成除零或天文数字的定时器。
   */
  private rateHint(): SpeechRateHint {
    const hint = this.d.speechRate?.();
    const ms = hint?.msPerUnit;
    if (!hint || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 60 || ms > 3000) {
      return { msPerUnit: BUDGET_MS_PER_UNIT, measured: false, samples: hint?.samples ?? 0 };
    }
    return hint;
  }

  /** 未合成文本的时长估计(与锚点时间轴、字幕估计同一套速率) */
  private estimateSpeechMs(text: string): number {
    return SPEECH_LEAD_IN_MS + segmentUnits(text).length * this.rateHint().msPerUnit;
  }

  /**
   * 一段台本要说多久(ms)。解析只为数出语音片,不产生任何演出副作用——回执要在
   * 这段还没轮到播之前就把"这段多长"告诉agent。
   */
  estimateScriptMs(script: string): number {
    let total = 0;
    const parser = new ScriptParser({
      onBeat: () => {},
      onSpeech: (_beatIndex, piece) => {
        if (piece.text) total += this.estimateSpeechMs(piece.text);
      },
      onEnd: () => {},
    }, this.d.pack());
    parser.feed(script);
    parser.end();
    return Math.round(total);
  }

  /**
   * 语音积压(ms):当前播放剩余时长加排队片段时长;未合成片段使用校准估值。
   * World 的积压闸与回执都用它;session 永不为此阻塞。
   */
  speechBacklogMs(): number {
    const now = this.now();
    let total = 0;
    for (const p of this.livePieces()) {
      if (p.played || p.failed || p.text === '') continue;
      const dur = this.pieceDurationMs(p);
      if (this.currentPlayback?.piece === p) {
        total += Math.max(0, dur - (now - this.currentPlayback.startedAt));
      } else {
        total += dur;
      }
    }
    return Math.round(total);
  }

  private pieceDurationMs(p: PerfPiece): number {
    if (p.tts) return p.tts.durationMs;
    if (p.segs && p.segs.length > 0) {
      let total = 0;
      for (const s of p.segs) total += s.result?.durationMs ?? this.estimateSpeechMs(s.text);
      return total;
    }
    return this.estimateSpeechMs(p.text);
  }


  /** 外部刺激(弹幕等)到达的打点:杂谈自动回落与 sinceLastEventMs 的基准 */
  noteActivity(): void {
    this.lastEventAt = this.now();
  }


  private onBeat(round: Round, beat: Beat): void {
    if (round.dropped) return;
    for (const cmd of beat.commands) {
      if (cmd.kind === 'reset') continue;
    }
    const prev = round.beats[round.beats.length - 1];
    if (prev) prev.open = false;
    round.beats.push({ round, beat, pieces: [], open: true, cuesFired: false });
    this.gate.pulse();
    void this.pump();
    void this.synthPump();
  }

  private onSpeech(round: Round, beatIndex: number, piece: SpeechPiece): void {
    if (round.dropped) return;
    const pb = round.beats.find((b) => b.beat.index === beatIndex);
    if (!pb) return;
    pb.pieces.push({
      round,
      beatIndex,
      text: piece.text,
      endsWithEllipsis: piece.endsWithEllipsis,
      anchors: piece.anchors,
      preCommands: [],
      tts: null,
      synthing: false,
      failed: false,
      played: false,
      segs: null,
    });
    this.gate.pulse();
    void this.synthPump();
  }


  /** 本片走不走流式(逐片定夺,开关热切只影响之后的片) */
  private streamingMode(): boolean {
    return this.d.tts.synthStream !== undefined && (this.d.streamEnabled?.() ?? true);
  }

  /**
   * 流式片的分段决策(每片一次):逐字对齐开着整片一段(锚点走时间轴);
   * 关着沿 <> 剪开,接缝处触发锚点指令。
   */
  private ensureSegs(p: PerfPiece): void {
    if (p.segs !== null || p.text === '' || p.tts !== null || p.synthing) return;
    if (!this.streamingMode()) return;
    const mk = (text: string): StreamSeg => ({
      text,
      seamCommands: [],
      sampleRate: 0,
      envelope: null,
      chunks: [],
      pcm: [],
      pcmBytes: 0,
      session: null,
      synthing: false,
      synthDone: false,
      failed: false,
      dead: false,
      result: null,
      abort: null,
      prefix: null,
      prefixInFlight: null,
      prefixTriedAtMs: Number.NEGATIVE_INFINITY,
    });
    if ((this.d.alignEnabled?.() ?? false) || p.anchors.length === 0) {
      p.segs = [mk(p.text)];
      return;
    }
    const segs: StreamSeg[] = [];
    let prev = 0;
    for (const a of p.anchors) {
      const text = p.text.slice(prev, a.charOffset).trim();
      if (text) {
        const seg = mk(text);
        seg.seamCommands = [...a.commands];
        segs.push(seg);
      } else if (segs.length > 0) {
        segs[segs.length - 1].seamCommands.push(...a.commands);
      } else {
        p.preCommands.push(...a.commands);
      }
      prev = a.charOffset;
    }
    const tail = p.text.slice(prev).trim();
    if (tail) segs.push(mk(tail));
    p.segs = segs;
  }

  /** 可以进入播放(流式片:首段已开声或已有定论) */
  private pieceReady(p: PerfPiece): boolean {
    if (p.text === '') return true;
    if (p.segs) {
      const first = p.segs[0];
      return first === undefined || first.envelope !== null || first.synthDone || first.failed;
    }
    return p.tts !== null;
  }

  private async synthPump(): Promise<void> {
    if (this.synthPumping || this.stopped) return;
    this.synthPumping = true;
    try {
      for (;;) {
        const pieces = this.livePieces();
        for (const p of pieces) this.ensureSegs(p);
        const ready = pieces.filter((p) => !p.played && p.text !== '' && this.pieceReady(p)).length;
        if (ready >= TTS_PREFETCH) return;
        // 合成任务按演出顺序串行；TTS 服务端队列可预热下一片的 TTFA。
        let job: (() => Promise<void>) | null = null;
        for (const p of pieces) {
          if (p.text === '' || p.failed || p.played) continue;
          if (p.segs) {
            const seg = p.segs.find((s) => !s.synthing && !s.synthDone && !s.failed);
            if (seg) {
              job = () => this.driveSegSynth(p, seg);
              break;
            }
            continue;
          }
          if (p.tts === null && !p.synthing) {
            job = () => this.driveWholeSynth(p);
            break;
          }
        }
        if (!job) return;
        await job();
        this.gate.pulse();
      }
    } finally {
      this.synthPumping = false;
    }
  }

  private async driveWholeSynth(next: PerfPiece): Promise<void> {
    next.synthing = true;
    const t0 = this.now();
    try {
      next.tts = await this.d.tts.synth(next.text);
      // 非流式没有流可掐:这一路只把预算与实测记下来,音频照原样播完。
      const hint = this.rateHint();
      const b = overrunBudget(next.text, hint.msPerUnit);
      this.traceBudget(next.text, next.tts.durationMs, next.tts.durationMs > b.cutMs, b, hint);
      const synthMs = this.now() - t0;
      const audioMs = Math.round(next.tts.durationMs);
      this.trace('TTS', `合成 ${synthMs}ms → ${audioMs}ms 音频`, {
        durMs: synthMs,
        detail: `「${next.text.slice(0, 24)}」`,
        event: 'synth',
        data: { synthMs, audioMs, units: b.units },
      });
    } catch (err) {
      next.failed = true;
      this.trace('TTS', `合成失败,跳过:「${next.text.slice(0, 18)}」 ${String(err).slice(0, 80)}`);
      this.d.log.warn('TTS 合成失败,该片跳过', { text: next.text.slice(0, 30), err: String(err) });
    } finally {
      next.synthing = false;
    }
  }

  private async driveSegSynth(piece: PerfPiece, seg: StreamSeg): Promise<void> {
    const synthStream = this.d.tts.synthStream;
    if (!synthStream) {
      seg.failed = true;
      return;
    }
    seg.synthing = true;
    const ac = new AbortController();
    seg.abort = () => ac.abort();
    const t0 = this.now();
    try {
      const sink: TtsStreamSink = {
        begin: ({ sampleRate, envelope }) => {
          seg.sampleRate = sampleRate;
          seg.envelope = envelope;
          this.gate.pulse();
        },
        pcm: (chunk) => {
          seg.pcm.push(chunk);
          seg.pcmBytes += chunk.length;
          if (seg.session) seg.session.push(chunk);
          else seg.chunks.push(chunk);
        },
      };
      const hint = this.rateHint();
      const b = overrunBudget(seg.text, hint.msPerUnit);
      const result = await synthStream(seg.text, sink, ac.signal, b.cutMs);
      seg.result = result;
      seg.synthDone = true;
      const silence = result.silence;
      const silenceCut = silence?.triggered === true;
      if (silenceCut) {
        /*
         * 错误生产的唯一签名:音频里出现了超大连续静默段(判据与依据见
         * silence-scan.ts)。流已经在静默段之后不久被掐,server 不再白烧;
         * 下面再把这段死气从**还没播出去的**部分里去掉。
         */
        this.trace(
          'TTS',
          `超大静默段:${describeSilence(silence!)};实测 ${Math.round(result.durationMs)}ms,`
            + '流已掐断,server 不再白烧',
          {
            detail: `「${seg.text.slice(0, 24)}」`,
            level: 'warn',
            tally: '静默掐流',
            event: 'silence-cut',
            data: { ...silenceData(silence!), audioMs: Math.round(result.durationMs) },
          },
        );
      } else if (result.truncated) {
        // 三个数一起印:只印预算会被读成超出量,由此推出「预算≈0」这种反向结论。
        this.trace(
          'TTS',
          `跑飞的片:预算 ${Math.round(b.estMs)}ms / 实测 ${Math.round(result.durationMs)}ms` +
            ` / 超出 ${Math.round(result.durationMs - b.estMs)}ms,` +
            `过了宽容界 ${Math.round(b.cutMs)}ms,流已掐断,server 不再白烧`,
          {
            detail: `「${seg.text.slice(0, 24)}」`,
            level: 'warn',
            tally: '掐流',
            event: 'overrun-cut',
            data: {
              budgetMs: Math.round(b.estMs),
              actualMs: Math.round(result.durationMs),
              overMs: Math.round(result.durationMs - b.estMs),
              cutMs: Math.round(b.cutMs),
            },
          },
        );
      } else if (silence && silence.longestMs >= silence.minSilenceMs / 2) {
        // 平时不吵:只有攒到门的一半才记一行,复盘看得见门与实际的距离
        this.trace('TTS静默', `接近门:${describeSilence(silence)}`, {
          detail: `「${seg.text.slice(0, 24)}」`,
          event: 'near-gate',
          data: silenceData(silence),
        });
      }
      // 掐流即止损全部:已经收到的音频原样播完,不再拿被自己截断的时长回头判「还该再裁」。
      // silenceCut 不进这条埋点:它掐的理由与预算无关,记在上面那行里。
      this.traceBudget(seg.text, result.durationMs, result.truncated === true && !silenceCut, b, hint);
      if (silenceCut) this.dropSilentTail(seg, silence!);
      seg.session?.end(seg.result.durationMs);
      const recvMs = this.now() - t0;
      const audioMs = Math.round(result.durationMs);
      this.trace('TTS', `流式收流 ${recvMs}ms → ${audioMs}ms 音频`, {
        durMs: recvMs,
        detail: `「${seg.text.slice(0, 24)}」`,
        event: 'stream-received',
        data: { recvMs, audioMs, units: b.units, truncated: result.truncated === true, silenceCut },
      });
      /*
       * 末级时长兜底须同时满足：对齐判废、未被本地截流、音频达到 server 硬上限、实测时长超过文本预算。仅有对齐失败或估计偏差不足以触发裁剪，截流后的时长不能再作为二次裁剪证据。
       * 该分支覆盖静默检测无法识别的持续杂音尾部；长文本本就需要该时长时由预算条件放行。
       * 切点仍取该对齐表的 lastGoodEndMs；整表已判废时，该局部切点的可信性仍是未解决的限制。
       */
      if (
        result.alignBad
        && !result.truncated
        && result.durationMs >= TTS_SERVER_MAX_AUDIO_MS
        && result.durationMs > b.estMs
      ) {
        this.cutTail(seg, result.alignBad.lastGoodEndMs, result.durationMs, '跑飞止损:对齐判废+撞 server 时长上限', '跑飞止损');
      }
      // 这一段已经在播(流式路的常态):开播时字幕走的是校准估计,对齐到手后重发时间轴
      if (!seg.dead) this.reemitSubtitle(seg);
    } catch (err) {
      seg.failed = true;
      seg.session?.abort();
      if (!piece.round.dropped && !this.stopped) {
        this.trace('TTS', `流式合成失败,该段跳过:「${seg.text.slice(0, 18)}」 ${String(err).slice(0, 80)}`);
        this.d.log.warn('TTS 流式合成失败,该段跳过', { text: seg.text.slice(0, 30), err: String(err) });
      }
    } finally {
      seg.synthing = false;
      seg.abort = null;
    }
  }

  /**
   * 片段用满六成宽容界或被截断时记录预算分项，其余片段不记录此埋点。
   */
  private traceBudget(
    text: string,
    actualMs: number,
    cut: boolean,
    b: OverrunBreakdown,
    hint: SpeechRateHint,
  ): void {
    if (!cut && actualMs < b.cutMs * 0.6) return;
    this.trace(
      'TTS预算',
      `${cut ? '掐' : '接近门'}:实测 ${Math.round(actualMs)}ms / 预算 ${Math.round(b.estMs)}ms` +
        ` / 超出 ${Math.round(actualMs - b.estMs)}ms;宽容界 ${Math.round(b.cutMs)}ms;速率=${describeSpeechRate(hint)}`,
      {
        detail: `「${text.slice(0, 24)}」`,
        event: cut ? 'cut' : 'near-gate',
        data: {
          actualMs: Math.round(actualMs),
          budgetMs: Math.round(b.estMs),
          overMs: Math.round(actualMs - b.estMs),
          cutMs: Math.round(b.cutMs),
          tolerance: OVERRUN_ESTIMATE_TOLERANCE,
          units: b.units,
          msPerUnit: Math.round(b.msPerUnit),
          pauseMs: b.pauseMs,
          endPunct: b.endPunct,
          midPunct: b.midPunct,
          voiceTags: b.voiceTags,
          leadInMs: SPEECH_LEAD_IN_MS,
          rateMeasured: hint.measured,
          rateSamples: hint.samples,
        },
      },
    );
  }

  private livePieces(): PerfPiece[] {
    const out: PerfPiece[] = [];
    for (const r of this.rounds) {
      if (r.dropped) continue;
      for (const b of r.beats) for (const p of b.pieces) out.push(p);
    }
    return out;
  }


  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.stopped) return;
        const pb = this.nextBeat();
        if (!pb) {
          this.pruneRounds();
          await this.gate.wait();
          continue;
        }
        await this.performBeat(pb);
      }
    } catch (err) {
      this.d.log.error('演出泵异常退出', { err: String(err) });
    } finally {
      this.pumping = false;
    }
  }

  private nextBeat(): PerfBeat | null {
    for (const r of this.rounds) {
      if (r.dropped) continue;
      for (const b of r.beats) {
        if (!b.cuesFired) return b;
      }
    }
    return null;
  }

  /** 移除已完成或作废的旧轮;最新轮可能仍在接收 script。 */
  private pruneRounds(): void {
    const newest = this.rounds[this.rounds.length - 1];
    this.rounds = this.rounds.filter(
      (r) => r === newest || (!r.dropped && r.beats.some((b) => !b.cuesFired)),
    );
  }

  private async performBeat(pb: PerfBeat): Promise<void> {
    const commands = pb.beat.commands;
    const hasState = commands.some((c) => c.kind === 'perform' && c.entry.lifecycle === 'state');
    const gestures = commands.filter(
      (c): c is Extract<BeatCommand, { kind: 'perform' }> => c.kind === 'perform' && c.entry.channel === 'gesture',
    );
    const gestureDelay = hasState && gestures.length > 0 ? SAME_BEAT_GESTURE_DELAY_MS : 0;

    // 锚点:上片结束,且不早于播出延迟地板(反应不先于观众看到的画面)
    const anchor = Math.max(this.now(), this.prevEnd, this.d.broadcastFloorMs?.() ?? 0);
    await this.sleepUntil(anchor);
    if (pb.round.dropped || this.stopped) return;

    const tagWords = commands
      .map((c) => (c.kind === 'reset' ? 'Reset' : c.entry.word))
      .join(',');
    this.trace('拍', `#${pb.round.id} b${pb.beat.index} [${tagWords || '空'}]`, {
      detail: `gestureDelay=${gestureDelay}ms${pb.beat.aloneOnLine ? ' 独行' : ''}${pb.beat.atLineStart ? ' 行首' : ''}`,
    });
    this.fireCues(pb, anchor, gestureDelay);
    pb.cuesFired = true;

    // gap:boundary_base 与阻断等待取大,再让位音频就绪。
    // 【】阻断块等待完整 clip 时长;<> 动作与语音并行。GAP_CAP 只封顶边界停顿。
    let maxOnset = 0;
    for (const c of commands) {
      if (c.kind !== 'perform') continue;
      if (c.entry.channel === 'gesture') {
        maxOnset = Math.max(maxOnset, gestureDelay + (this.d.pack().pulse[c.entry.clipId]?.durationMs ?? 0));
      } else if (c.entry.channel === 'gaze') {
        maxOnset = Math.max(maxOnset, GAZE_ONSET_MS);
      }
    }
    let base = pb.beat.atLineStart ? BOUNDARY_NEW_LINE_MS : BOUNDARY_SAME_LINE_MS;
    if (this.prevEndedWithEllipsis) base += ELLIPSIS_COMP_MS;
    const jitter = 1 - GAP_JITTER + 2 * GAP_JITTER * this.rng();
    const gap = Math.max(Math.min(GAP_CAP_MS, base) * jitter, maxOnset);
    const speechAt = anchor + gap;

    // 句首(前面有过一段静默)才做:排在开口之前,不占 gap
    if (pb.pieces.length > 0 || pb.open) {
      if (speechAt - this.prevEnd >= SPEECH_ONSET_PAUSE_MS) {
        this.d.mixer.prosodyCue({
          clipId: 'speech_onset',
          startTs: speechAt - SPEECH_ONSET_LEAD_MS,
          intensity: 1,
        });
      }
    }

    // 逐片播放;beat 仍开放时等待流式追加
    let played = 0;
    for (;;) {
      const pending = pb.pieces.filter((p) => !p.failed);
      if (played >= pending.length) {
        if (!pb.open) break;
        await this.gate.wait();
        if (pb.round.dropped || this.stopped) return;
        continue;
      }
      const current = pending[played];
      // 纯锚点片(空文本):没有语音,指令即刻触发
      if (current.text === '') {
        this.fireCommands(
          [...current.preCommands, ...current.anchors.flatMap((a) => a.commands)],
          this.now(),
          '空片',
        );
        current.played = true;
        played++;
        continue;
      }
      if (!this.pieceReady(current)) {
        void this.synthPump();
        await this.gate.wait();
        if (pb.round.dropped || this.stopped) return;
        continue;
      }
      if (played === 0) await this.sleepUntil(speechAt);
      if (pb.round.dropped || this.stopped) return;
      if (current.segs) await this.playStreamPiece(current);
      else await this.playPiece(current);
      played++;
      void this.synthPump();
    }

    if (played === 0) {
      // 纯演出 beat:停一拍(有 pulse 等其做完,没有给个短占位)
      let hold = SILENT_BEAT_MS;
      for (const g of gestures) hold = Math.max(hold, gestureDelay + (this.d.pack().pulse[g.entry.clipId]?.durationMs ?? 0));
      this.prevEnd = anchor + hold;
      this.prevEndedWithEllipsis = false;
    }
  }

  /** 指令束实际触发的旁路通知(fireCues / fireCommands 两个触发点共用) */
  private noteCues(commands: BeatCommand[]): void {
    if (commands.length === 0 || !this.d.onCue) return;
    this.d.onCue(
      commands.map((c) =>
        c.kind === 'reset'
          ? { word: 'Reset', channel: 'reset' as const }
          : { word: c.entry.word, channel: c.entry.channel },
      ),
    );
  }

  private fireCues(pb: PerfBeat, anchor: number, gestureDelay: number): void {
    this.noteCues(pb.beat.commands);
    for (const cmd of pb.beat.commands) {
      const ts = cmd.kind === 'perform' && cmd.entry.channel === 'gesture'
        ? anchor + gestureDelay
        : anchor;
      this.applyCommand(cmd, ts);
    }
  }

  private applyCommand(cmd: BeatCommand, ts: number): void {
    if (cmd.kind === 'reset') {
      this.states.resetAll(ts);
      return;
    }
    const e = cmd.entry;
    switch (e.channel) {
      case 'gesture':
        this.d.mixer.gestureCue({
          clipId: e.clipId,
          startTs: ts,
          intensity: e.intensity ?? 1,
        } satisfies GestureCue);
        break;
      case 'pose':
      case 'emotion':
        this.states.set(e.channel, e.clipId, ts);
        break;
      case 'gaze':
        this.states.set('gaze', e.clipId, ts);
        break;
      case 'fx':
        this.d.backend.fx(e.clipId);
        break;
    }
  }

  private async playPiece(piece: PerfPiece): Promise<void> {
    const tts = piece.tts;
    if (!tts) return;
    try {
      const { startedAt, ended } = await this.d.audio.play(tts);
      this.playing = true;
      this.currentPlayback = { piece, startedAt };
      this.emitSubtitle(piece.text, tts.units ?? null, tts.durationMs, startedAt, 'open');
      this.d.mixer.speechStart((ms) => tts.envelope.at(ms), startedAt);
      this.scheduleAccentProsody(tts, startedAt);
      this.scheduleWholeAnchors(piece, tts, startedAt);
      const endTs = await ended;
      this.prevEnd = endTs;
    } catch (err) {
      this.trace('播', `播放失败,按时长占位推进:${String(err).slice(0, 60)}`);
      this.d.log.warn('语音播放失败,按时长占位推进', { err: String(err) });
      this.prevEnd = this.now() + tts.durationMs;
      await this.sleepUntil(this.prevEnd);
    } finally {
      this.playing = false;
      this.currentPlayback = null;
      piece.played = true;
      this.d.mixer.speechEnd();
      this.prevEndedWithEllipsis = piece.endsWithEllipsis;
    }
  }

  /**
   * 交出这片的字幕时间轴。cue 时刻先按开播坐标算,再换到订阅端的接收坐标:加上
   * (startedAt − now),开播尚在未来为正、已开播为负——负值那条正在念,订阅端立即
   * 上屏并从 |atMs| 处续增量。只发显示区间还没过完的 cue;一条不剩就不发,空批会被
   * 订阅端当「整句直出」兜底,发出去反而把在屏字幕顶掉。
   *
   * kind 是发送时机:open=开播;track=播放中前缀对齐到手;realign=收流后全量对齐到手。
   * 后两种是重发,订阅端以最新一批为准。
   */
  private emitSubtitle(
    text: string,
    units: AlignedUnit[] | null,
    durationMs: number | null,
    startedAt: number,
    kind: 'open' | 'track' | 'realign',
  ): void {
    const on = this.d.onSubtitle;
    if (!on) return;
    const totalUnits = segmentUnits(text).length;
    const basis =
      units && units.length > 0
        ? units.length < totalUnits
          ? 'prefix'
          : 'align'
        : durationMs != null && durationMs > 0
          ? 'duration'
          : 'estimate';
    const hint = this.rateHint();
    const cues = computeSubtitleCues(text, {
      units,
      durationMs,
      leadInMs: SPEECH_LEAD_IN_MS,
      msPerUnit: hint.msPerUnit,
      pausePriors: PAUSE_PRIORS,
    });
    const detail = `「${text.slice(0, 24)}」`;
    const note =
      basis === 'estimate' ? describeSpeechRate(hint) : basis === 'prefix' ? `${units!.length}/${totalUnits} 单元` : undefined;
    const digest = summarizeSubtitleCues(cues);
    const event = kind === 'open' ? 'timeline' : 'resend';
    // 时间轴一行的结构化字段:摘要的七个数 + 时刻来源 + 估计档的速率 + 前缀档的覆盖
    const data: Record<string, unknown> = {
      ...digest,
      basis,
      kind,
      msPerUnit: Math.round(hint.msPerUnit),
      rateMeasured: hint.measured,
      units: units?.length ?? null,
      totalUnits,
    };
    // 字幕摘要按批记录，时间数值使用开播坐标；有台词却没有 cue 时记录 warn。
    if (cues.length === 0) {
      this.trace('字幕', describeSubtitleCues(digest, basis, note), {
        detail,
        level: 'warn',
        tally: '字幕空轨',
        event,
        data,
      });
      return;
    }
    const shiftMs = Math.round(startedAt - this.now());
    data.shiftMs = shiftMs;
    const head = kind === 'open' ? '' : `${kind === 'track' ? '跟播' : '收流'}重发(已过 ${Math.max(0, -shiftMs)}ms):`;
    const live = cues.filter((c) => c.atMs + c.durMs + shiftMs > 0).map((c) => ({ ...c, atMs: c.atMs + shiftMs }));
    data.live = live.length;
    if (live.length === 0) {
      this.trace('字幕', `${head}作罢:显示区间全部已过,屏上时间轴保持原样`, { detail, event, data });
      return;
    }
    on({ text, cues: live, basis });
    const tail = kind === 'open' ? `;开播于 ${shiftMs >= 0 ? '+' : ''}${shiftMs}ms` : '';
    this.trace('字幕', `${head}${describeSubtitleCues(digest, basis, note)}${tail}`, { detail, event, data });
  }

  /**
   * 收流后把字幕时间轴换到全量对齐重发。流式路开播那一刻 seg.result 恒为 null
   * (对齐在 synthStream 内部最后一步才出生),开播只能走校准估计,播放中靠跟播
   * (startSubtitleTracker)逐段换成前缀对齐;全量 units 到手、这一段还在播时,
   * 把仍在显示区间内的 cue 重排到真实时刻。
   */
  private reemitSubtitle(seg: StreamSeg): void {
    const playing = this.currentPlayback;
    if (!playing || playing.seg !== seg || playing.piece.played) return;
    const units = seg.result?.units;
    if (!units || units.length === 0) return;
    this.emitSubtitle(seg.text, units, seg.result?.durationMs ?? null, playing.startedAt, 'realign');
  }

  /**
   * 流式片播放中的字幕跟播。合成头领先播放头(RTF≈0.55),下一条 cue 的音频在它
   * 该上屏之前多半已经收到:按锚点抢跑同一套条件——cue 边界的估计时刻进入
   * ANCHOR_PREFIX_WINDOW_MS、已合成时长盖过它 ANCHOR_ALIGN_MARGIN_MS——把截到该
   * 边界的前缀送对齐,可采信的单元数长了就重发时间轴(已对齐部分按真实时刻,其余
   * 从末单元终点外推)。收流后全量对齐接管,跟播在那之前停。
   */
  private startSubtitleTracker(seg: StreamSeg, startedAt: number): { stop(): void } {
    const units = segmentUnits(seg.text);
    const chunks = subtitleChunks(seg.text);
    // 边界 = 每条 cue 的起点与终点单元;对齐盖过一个边界,时间轴才多出一个真实时刻
    const boundaries = [...new Set(chunks.flatMap((c) => [c.startUnit, c.endUnit]))]
      .filter((b) => b > 0)
      .sort((a, b) => a - b);
    const msPerUnit = this.rateHint().msPerUnit;
    let trusted: AlignedUnit[] = [];
    let closed = false;
    let busy = false;
    const boundaryMs = (boundary: number): number => {
      const cues = computeSubtitleCues(seg.text, {
        units: trusted,
        leadInMs: SPEECH_LEAD_IN_MS,
        msPerUnit,
        pausePriors: PAUSE_PRIORS,
      });
      const i = chunks.findIndex((c) => c.startUnit === boundary);
      if (i >= 0) return cues[i].atMs;
      const j = chunks.findIndex((c) => c.endUnit === boundary);
      return cues[j].atMs + cues[j].speakMs;
    };
    const poll = async (): Promise<void> => {
      if (closed || busy || seg.synthDone || !seg.envelope) return;
      const boundary = boundaries.find((b) => b > trusted.length);
      if (boundary === undefined) return;
      const atMs = boundaryMs(boundary);
      if (startedAt + atMs - this.now() > ANCHOR_PREFIX_WINDOW_MS) return;
      if (seg.envelope.coveredMs() < atMs + ANCHOR_ALIGN_MARGIN_MS) return;
      busy = true;
      try {
        // 边界单元本身也送去对齐:cue 的起点要它的 start,不是前一个单元的 end
        const pa = await this.alignSegPrefix(seg, units, boundary + 1);
        if (!pa || closed || seg.synthDone) return;
        const n = trustedPrefixCount(pa);
        if (n <= trusted.length) return;
        trusted = pa.units.slice(0, n);
        this.emitSubtitle(seg.text, trusted, null, startedAt, 'track');
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void poll(), ANCHOR_POLL_MS);
    timer.unref?.();
    return {
      stop: () => {
        closed = true;
        clearInterval(timer);
      },
    };
  }

  /**
   * 播放中的前缀对齐:把这一段已收的 PCM 连同截到 count 个单元的单元表送对齐器。
   * 锚点抢跑与字幕跟播共用:一段同时只有一次在途,后来者等同一个结果;覆盖时长自
   * 上次以来没长出 ANCHOR_REALIGN_GROWTH_MS 就给上次的结果——采信闸刚拒过的前缀,
   * PCM 没多覆盖出内容,重发只会拿到同样拒掉的结果。对齐不可用或失败给 null。
   */
  private alignSegPrefix(seg: StreamSeg, units: string[], count: number): Promise<PrefixAlign | null> {
    const alignPcm = this.d.tts.alignPcm;
    const envelope = seg.envelope;
    if (!alignPcm || !envelope) return Promise.resolve(null);
    if (seg.prefixInFlight) return seg.prefixInFlight;
    const covered = envelope.coveredMs();
    if (covered - seg.prefixTriedAtMs < ANCHOR_REALIGN_GROWTH_MS) return Promise.resolve(seg.prefix);
    seg.prefixTriedAtMs = covered;
    const run = (async (): Promise<PrefixAlign | null> => {
      try {
        const res = await alignPcm(concatPcm(seg.pcm), seg.sampleRate, units.slice(0, Math.min(units.length, count)));
        if (!res || res.length === 0) return null;
        seg.prefix = { units: res, coveredMs: covered };
        return seg.prefix;
      } catch {
        return null;
      } finally {
        seg.prefixInFlight = null;
      }
    })();
    seg.prefixInFlight = run;
    return run;
  }

  /**
   * 非流式片的 <> 锚点:时长已知,units 在手(开对齐)按对齐时间点排,
   * 否则按字符比例估计。都是绝对时刻定时器,打断时统一清掉。
   */
  private scheduleWholeAnchors(piece: PerfPiece, tts: TtsPiece, startedAt: number): void {
    for (const a of piece.anchors) {
      let ms: number;
      let how: string;
      if (tts.units && tts.units.length > 0) {
        const idx = segmentUnits(piece.text.slice(0, a.charOffset)).length;
        ms = this.unitStartMs(tts.units, idx, tts.durationMs);
        how = '对齐';
      } else {
        ms = piece.text.length > 0 ? (a.charOffset / piece.text.length) * tts.durationMs : 0;
        how = '估计';
      }
      this.scheduleCommands(a.commands, startedAt + ms, how);
    }
  }

  /** 流式片:逐段开会话播放,接缝触发锚点;单段(开对齐)锚点走时间轴 runner */
  private async playStreamPiece(piece: PerfPiece): Promise<void> {
    if (piece.preCommands.length > 0) this.fireCommands(piece.preCommands, this.now(), '接缝');
    const segs = piece.segs ?? [];
    try {
      for (const seg of segs) {
        for (;;) {
          if (piece.round.dropped || this.stopped) return;
          if (seg.failed || seg.envelope !== null || seg.synthDone) break;
          void this.synthPump();
          await this.gate.wait();
        }
        if (seg.failed) {
          this.trace('播', `流式段失败跳过:「${seg.text.slice(0, 18)}」`);
        } else {
          await this.playSeg(piece, seg);
          if (piece.round.dropped || this.stopped) return;
        }
        if (seg.seamCommands.length > 0) this.fireCommands(seg.seamCommands, this.now(), '接缝');
      }
    } finally {
      piece.played = true;
      this.prevEndedWithEllipsis = piece.endsWithEllipsis;
      // 前缀对齐的原始 PCM 用完即弃
      for (const seg of segs) {
        seg.pcm = [];
        seg.chunks = [];
      }
    }
  }

  private async playSeg(piece: PerfPiece, seg: StreamSeg): Promise<void> {
    // 整片死气已作废(见 dropSilentTail):不开播放会话、不发字幕,直接跳过
    if (seg.dead) return;
    const session = this.d.audio.beginStream(seg.sampleRate, seg.text);
    seg.session = session;
    const backlog = seg.chunks;
    seg.chunks = [];
    for (const c of backlog) session.push(c);
    if (seg.synthDone && seg.result) session.end(seg.result.durationMs);
    const startedAt = await session.started;
    if (piece.round.dropped || this.stopped) {
      session.abort();
      return;
    }
    this.playing = true;
    this.currentPlayback = { piece, startedAt, seg };
    this.emitSubtitle(seg.text, seg.result?.units ?? null, seg.result?.durationMs ?? null, startedAt, 'open');
    const envelope = seg.envelope;
    let accents: { stop(): void } | null = null;
    let anchors: { finish(): void } | null = null;
    let tracker: { stop(): void } | null = null;
    try {
      if (envelope) {
        this.d.mixer.speechStart((ms) => envelope.at(ms), startedAt);
        accents = this.startStreamAccents(seg, startedAt);
      }
      if (piece.anchors.length > 0 && (piece.segs?.length ?? 0) === 1) {
        anchors = this.startAnchorRunner(piece, seg, startedAt);
      }
      if (!seg.synthDone && (this.d.alignEnabled?.() ?? false)) {
        tracker = this.startSubtitleTracker(seg, startedAt);
      }
      const endTs = await session.ended;
      this.prevEnd = endTs;
    } finally {
      this.playing = false;
      this.currentPlayback = null;
      this.d.mixer.speechEnd();
      accents?.stop();
      anchors?.finish();
      tracker?.stop();
    }
  }

  /**
   * 组合④的锚点 runner:三级时间来源(全量对齐 > 前缀对齐 > 估计死线)。
   * 死线定时器先武装:估计时刻到点还没有更好的答案就按估计触发——宁可略偏,
   * 不可漏做。对齐结果先到则按对齐时刻排程并解除死线。
   */
  private startAnchorRunner(
    piece: PerfPiece,
    seg: StreamSeg,
    startedAt: number,
  ): { finish(): void } {
    const units = segmentUnits(piece.text);
    // 死线估计与字幕/预算同一口径:整片取一次,片内不随样本增长漂移。
    const msPerUnit = this.rateHint().msPerUnit;
    interface AnchorState {
      unitIndex: number;
      estimateMs: number;
      commands: BeatCommand[];
      fired: boolean;
      deadline: ReturnType<typeof setTimeout> | null;
    }
    const states: AnchorState[] = piece.anchors.map((a) => {
      const unitIndex = segmentUnits(piece.text.slice(0, a.charOffset)).length;
      return {
        unitIndex,
        estimateMs: SPEECH_LEAD_IN_MS + unitIndex * msPerUnit,
        commands: a.commands,
        fired: false,
        deadline: null,
      };
    });
    let closed = false;
    let aligning = false;
    const fire = (st: AnchorState, ms: number, how: string): void => {
      if (st.fired) return;
      st.fired = true;
      if (st.deadline) {
        clearTimeout(st.deadline);
        this.anchorTimers.delete(st.deadline);
        st.deadline = null;
      }
      this.scheduleCommands(st.commands, startedAt + ms, how);
    };
    const armDeadline = (st: AnchorState, delayMs: number, graceLeft: boolean): void => {
      st.deadline = this.armTimer(delayMs, () => {
        st.deadline = null;
        if (closed || st.fired) return;
        if (aligning && graceLeft) {
          armDeadline(st, ANCHOR_DEADLINE_GRACE_MS, false);
          return;
        }
        fire(st, st.estimateMs, '估计死线');
      });
    };
    for (const st of states) {
      armDeadline(st, Math.max(0, startedAt + st.estimateMs - this.now()), true);
    }
    const poll = async (): Promise<void> => {
      if (closed || aligning) return;
      const pending = states.filter((s) => !s.fired);
      if (pending.length === 0) {
        clearInterval(timer);
        return;
      }
      // 收流后 World 附上了全量 units:一次解决所有未决锚点
      const full = seg.result?.units;
      if (full && full.length > 0) {
        for (const st of pending) fire(st, this.unitStartMs(full, st.unitIndex, seg.result?.durationMs ?? 0), '对齐');
        return;
      }
      const envelope = seg.envelope;
      if (!this.d.tts.alignPcm || !envelope || seg.synthDone) return;
      // 抢跑:锚点单元已确定进了音频,且离死线不远(否则等全量对齐更省)
      const now = this.now();
      const ready = pending.filter(
        (s) =>
          envelope.coveredMs() >= s.estimateMs + ANCHOR_ALIGN_MARGIN_MS &&
          startedAt + s.estimateMs - now < ANCHOR_PREFIX_WINDOW_MS,
      );
      if (ready.length === 0) return;
      aligning = true;
      try {
        const maxIdx = Math.max(...ready.map((s) => s.unitIndex));
        const pa = await this.alignSegPrefix(seg, units, maxIdx + 1);
        if (pa && !closed) {
          // 采信闸见 trustedPrefixCount:单元没完整落在送去对齐的音频里就留给全量对齐或死线
          const trusted = trustedPrefixCount(pa);
          for (const st of ready) {
            if (st.fired || st.unitIndex >= trusted) continue;
            fire(st, pa.units[st.unitIndex].start * 1000, '前缀对齐');
          }
        }
      } finally {
        aligning = false;
      }
    };
    const timer = setInterval(() => void poll(), ANCHOR_POLL_MS);
    timer.unref?.();
    return {
      finish: () => {
        closed = true;
        clearInterval(timer);
        // 片已播完还没触发的(片尾锚点/彻底没赶上的)现在补上
        for (const st of states) {
          if (st.deadline) {
            clearTimeout(st.deadline);
            this.anchorTimers.delete(st.deadline);
            st.deadline = null;
          }
          if (!st.fired) {
            st.fired = true;
            this.fireCommands(st.commands, this.now(), '片尾');
          }
        }
      },
    };
  }

  /**
   * 流式片的增量重音:包络随分块增长,边覆盖边扫(领先播放头 1s+,抬眉的
   * 提前量足够)。与整段版的差异:挤近时不回溯换更强的、强重音排名只对已见
   * 重音——流式下都无法未卜先知,偏差在概率排程的噪声量级之内。
   */
  private startStreamAccents(seg: StreamSeg, startedAt: number): { stop(): void } {
    let scannedMs = ACCENT_SCAN_HOP_MS;
    let lastAccentMs = Number.NEGATIVE_INFINITY;
    const seen: number[] = [];
    let motions = 0;
    let brows = 0;
    const tick = (): void => {
      const env = seg.envelope;
      if (!env) return;
      // 局部极大要右邻在手,留一个 hop 的余量
      const upTo = env.coveredMs() - ACCENT_SCAN_HOP_MS;
      for (; scannedMs + ACCENT_SCAN_HOP_MS <= upTo; scannedMs += ACCENT_SCAN_HOP_MS) {
        const v = env.at(scannedMs);
        if (v < ACCENT_LEVEL_MIN) continue;
        if (v <= env.at(scannedMs - ACCENT_SCAN_HOP_MS) || v < env.at(scannedMs + ACCENT_SCAN_HOP_MS)) continue;
        if (scannedMs - lastAccentMs < ACCENT_MIN_GAP_MS) continue;
        lastAccentMs = scannedMs;
        seen.push(v);
        const at = startedAt + scannedMs;
        if (this.rng() < ACCENT_MOTION_P) {
          const prim = this.pickAccentPrimitive();
          const amp = 0.7 + 0.5 * v;
          const sign = prim.mirrored && this.rng() < 0.5 ? -1 : 1;
          this.d.mixer.prosodyCue({ clipId: prim.clipId, startTs: at, intensity: amp * sign });
          motions++;
        }
        const ranked = [...seen].sort((x, y) => y - x);
        const strongCut = ranked[Math.max(0, Math.ceil(ranked.length * ACCENT_BROW_TOP_RATIO) - 1)];
        if (v >= strongCut && this.rng() < ACCENT_BROW_P) {
          const jitter = (this.rng() - 0.5) * 2 * ACCENT_BROW_JITTER_MS;
          this.d.mixer.prosodyCue({
            clipId: 'accent_brow',
            startTs: at - ACCENT_BROW_LEAD_MS + jitter,
            intensity: 0.8 + 0.4 * v,
          });
          brows++;
        }
      }
    };
    const timer = setInterval(tick, STREAM_ACCENT_SCAN_MS);
    timer.unref?.();
    return {
      stop: () => {
        clearInterval(timer);
        tick();
        if (seen.length > 0) {
          this.trace('韵律', `流式重音 ${seen.length} 处 → 头动 ${motions} / 抬眉 ${brows}`);
        }
      },
    };
  }

  private preparedLeadMs(commands: readonly BeatCommand[]): number {
    const hasState = commands.some((c) => c.kind === 'perform' && c.entry.lifecycle === 'state');
    const gestureDelay = hasState && commands.some(
      (c) => c.kind === 'perform' && c.entry.channel === 'gesture',
    )
      ? SAME_BEAT_GESTURE_DELAY_MS
      : 0;
    let lead = 0;
    for (const command of commands) {
      if (command.kind !== 'perform') continue;
      if (command.entry.channel === 'gesture') {
        lead = Math.max(
          lead,
          gestureDelay + (this.d.pack().pulse[command.entry.clipId]?.durationMs ?? 0),
        );
      } else if (command.entry.channel === 'gaze') {
        lead = Math.max(lead, GAZE_ONSET_MS);
      }
    }
    return lead;
  }

  private commandDurationMs(command: BeatCommand): number {
    if (command.kind === 'reset') return 0;
    if (command.entry.channel === 'gesture') {
      return this.d.pack().pulse[command.entry.clipId]?.durationMs ?? 0;
    }
    if (command.entry.channel === 'fx') {
      return this.d.backend.fxDurationMs(command.entry.clipId);
    }
    return 0;
  }

  private preparedTailMs(
    commands: readonly BeatCommand[],
    piece: SpeechPiece,
    tts: TtsPiece | null,
    leadMs: number,
  ): number {
    const bodyMs = tts?.durationMs ?? 0;
    let tail = 0;
    for (const command of commands) {
      tail = Math.max(tail, this.commandDurationMs(command) - leadMs - bodyMs);
    }
    for (const anchor of piece.anchors) {
      let anchorMs = 0;
      if (tts) {
        if (tts.units && tts.units.length > 0) {
          const unitIndex = segmentUnits(piece.text.slice(0, anchor.charOffset)).length;
          anchorMs = this.unitStartMs(tts.units, unitIndex, tts.durationMs);
        } else if (piece.text.length > 0) {
          anchorMs = (anchor.charOffset / piece.text.length) * tts.durationMs;
        }
      }
      for (const command of anchor.commands) {
        tail = Math.max(tail, anchorMs + this.commandDurationMs(command) - bodyMs);
      }
    }
    return Math.max(0, tail);
  }

  private firePreparedCommands(
    commands: readonly BeatCommand[],
    anchor: number,
    timers: Set<ReturnType<typeof setTimeout>>,
    signal?: AbortSignal,
  ): void {
    if (commands.length === 0) return;
    const hasState = commands.some((c) => c.kind === 'perform' && c.entry.lifecycle === 'state');
    const gestureDelay = hasState && commands.some(
      (c) => c.kind === 'perform' && c.entry.channel === 'gesture',
    )
      ? SAME_BEAT_GESTURE_DELAY_MS
      : 0;
    for (const command of commands) {
      const ts = command.kind === 'perform' && command.entry.channel === 'gesture'
        ? anchor + gestureDelay
        : anchor;
      this.schedulePreparedCommands([command], ts, timers, signal);
    }
  }

  private schedulePreparedAnchors(
    piece: PreparedActPiece,
    playback: PreparedPlayback,
    timers: Set<ReturnType<typeof setTimeout>>,
    signal?: AbortSignal,
  ): void {
    const tts = piece.tts;
    if (!tts) return;
    for (const anchor of piece.anchors) {
      let ms: number;
      if (tts.units && tts.units.length > 0) {
        const unitIndex = segmentUnits(piece.text.slice(0, anchor.charOffset)).length;
        ms = this.unitStartMs(tts.units, unitIndex, tts.durationMs);
      } else {
        ms = piece.text.length > 0
          ? (anchor.charOffset / piece.text.length) * tts.durationMs
          : 0;
      }
      if (playback.positionMs) {
        this.schedulePreparedCommandsAtPosition(anchor.commands, ms, playback.positionMs, timers, signal);
      } else {
        this.schedulePreparedCommands(anchor.commands, playback.startedAt + ms, timers, signal);
      }
    }
  }

  private schedulePreparedCommandsAtPosition(
    commands: readonly BeatCommand[],
    atMs: number,
    positionMs: () => number,
    timers: Set<ReturnType<typeof setTimeout>>,
    signal?: AbortSignal,
  ): void {
    if (commands.length === 0 || signal?.aborted) return;
    const poll = (): void => {
      if (signal?.aborted) return;
      const remaining = atMs - positionMs();
      if (remaining <= 0) {
        this.fireCommands([...commands], this.now(), '预编译片');
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        poll();
      }, Math.min(remaining, 20));
      timer.unref?.();
      timers.add(timer);
    };
    poll();
  }

  private schedulePreparedCommands(
    commands: readonly BeatCommand[],
    atTs: number,
    timers: Set<ReturnType<typeof setTimeout>>,
    signal?: AbortSignal,
  ): void {
    if (commands.length === 0 || signal?.aborted) return;
    const fire = () => {
      if (signal?.aborted) return;
      this.fireCommands([...commands], atTs, '预编译片');
    };
    const delayMs = Math.max(0, atTs - this.now());
    if (delayMs === 0) {
      fire();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      fire();
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
  }

  /** 锚点/接缝指令落地:与 fireCues 同一套通道分发,但发生在语音进行中的任意时刻 */
  private fireCommands(commands: BeatCommand[], ts: number, how: string): void {
    if (commands.length === 0) return;
    const words = commands.map((c) => (c.kind === 'reset' ? 'Reset' : c.entry.word)).join(',');
    this.trace('锚点', `[${words}] ${how}`);
    this.noteCues(commands);
    for (const cmd of commands) this.applyCommand(cmd, ts);
  }

  private scheduleCommands(commands: BeatCommand[], atTs: number, how: string): void {
    this.armTimer(Math.max(0, atTs - this.now()), () => this.fireCommands(commands, this.now(), how));
  }

  private armTimer(delayMs: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.anchorTimers.delete(t);
      fn();
    }, delayMs);
    t.unref?.();
    this.anchorTimers.add(t);
    return t;
  }

  private unitStartMs(units: AlignedUnit[], unitIndex: number, fallbackMs: number): number {
    const u = units[unitIndex];
    return u ? u.start * 1000 : fallbackMs;
  }

  /**
   * 语音开播时预排重音对应的头动与抬眉绝对时刻。抬眉起势早于重音,
   * 逐帧检测无法满足该提前量。
   */
  private scheduleAccentProsody(tts: TtsPiece, startedAt: number): void {
    const accents = findAccents(tts, ACCENT_LEVEL_MIN, ACCENT_MIN_GAP_MS);
    if (accents.length === 0) return;
    // 片内排名定"强重音"的门槛
    const ranked = accents.map((a) => a.level).sort((x, y) => y - x);
    const strongCut = ranked[Math.max(0, Math.ceil(ranked.length * ACCENT_BROW_TOP_RATIO) - 1)];
    let motions = 0;
    let brows = 0;
    for (const a of accents) {
      const at = startedAt + a.ms;
      if (this.rng() < ACCENT_MOTION_P) {
        const prim = this.pickAccentPrimitive();
        // 幅度随重音强度;甩动随机甩向两侧(负 intensity = 镜像)
        const amp = 0.7 + 0.5 * a.level;
        const sign = prim.mirrored && this.rng() < 0.5 ? -1 : 1;
        this.d.mixer.prosodyCue({ clipId: prim.clipId, startTs: at, intensity: amp * sign });
        motions++;
      }
      if (a.level >= strongCut && this.rng() < ACCENT_BROW_P) {
        const jitter = (this.rng() - 0.5) * 2 * ACCENT_BROW_JITTER_MS;
        this.d.mixer.prosodyCue({
          clipId: 'accent_brow',
          startTs: at - ACCENT_BROW_LEAD_MS + jitter,
          intensity: 0.8 + 0.4 * a.level,
        });
        brows++;
      }
    }
    this.trace('韵律', `重音 ${accents.length} 处 → 头动 ${motions} / 抬眉 ${brows}`, {
      durMs: tts.durationMs,
      // 重音时刻(相对开播)是"字头微动对不对得上"的唯一凭据
      detail: `重音@${accents.map((a) => Math.round(a.ms)).join(',')}ms`,
    });
  }

  private pickAccentPrimitive(): (typeof ACCENT_PRIMITIVES)[number] {
    let roll = this.rng();
    for (const p of ACCENT_PRIMITIVES) {
      roll -= p.weight;
      if (roll <= 0) return p;
    }
    return ACCENT_PRIMITIVES[0];
  }


  private tick(): void {
    const t = this.now();
    if (t - this.lastTickAt < MIN_FRAME_MS) return;
    this.lastTickAt = t;
    this.states.tick(t);
    this.d.backend.sendFrame(this.d.mixer.frame(t));
    this.checkBacklog(t);

    // 状态快照由诊断报表按需获取，不写入周期性时间线事件。
  }

  /**
   * 语音见底在下降沿立即通知,分辨率独立于心跳周期。每次见底只通知一次;
   * 新语音将水位顶回后才允许再次触发。
   */
  private checkBacklog(now: number): void {
    if (now - this.lastBacklogAt < BACKLOG_POLL_MS) return;
    this.lastBacklogAt = now;
    const level = this.speechBacklogMs() <= 0 ? 'empty' : 'ample';
    if (level === this.backlogLevel) return;
    this.backlogLevel = level;
    if (level === 'empty') this.d.onDrained?.();
  }

  private drained(): boolean {
    if (this.playing) return false;
    for (const round of this.rounds) {
      if (round.dropped) continue;
      if (!round.ended) return false;
      for (const beat of round.beats) {
        if (beat.open || !beat.cuesFired) return false;
        if (beat.pieces.some((piece) => !piece.played && !piece.failed)) return false;
      }
    }
    return true;
  }

  private sleepUntil(ts: number): Promise<void> {
    const delay = ts - this.now();
    if (delay <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, delay));
  }

  private sleepUntilOrAbort(ts: number, signal?: AbortSignal): Promise<boolean> {
    const delay = ts - this.now();
    if (signal?.aborted) return Promise.resolve(false);
    if (delay <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const abort = () => finish(false);
      const finish = (completed: boolean) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(completed);
      };
      timer = setTimeout(() => finish(true), delay);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private async awaitOrAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ completed: true; value: T } | { completed: false }> {
    if (!signal) return { completed: true, value: await promise };
    if (signal.aborted) return { completed: false };
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        resolve({ completed: false });
      };
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve({ completed: true, value });
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
}
