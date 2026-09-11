/**
 * 字幕时间轴分拆:把一片长文本切成若干条 cue,各配一个相对开播时刻的显示区间。
 * 时间来源:对齐 units(逐单元真实时刻;可以只是前缀,前缀之外按校准速率外推)>
 * 已知片时长(按单元数比例)> 校准估计(leadIn + 单元数 × msPerUnit + 停顿先验,
 * 与锚点估计同一套校准量)。
 *
 * 切分只看文本:句末标点必断,长句在逗号族就近断,实在没有标点按单元数硬切。
 * 显示文本移除仅供 TTS 使用的 [] 语气词；时间映射仍按原文单元下标计算，
 * 与对齐器共用 `segmentUnits` 切分。
 */
import { countPauses, pauseMs, segmentUnits, type AlignedUnit, type PausePriors } from './align.ts';

export interface SubtitleCue {
  /** 展示文本([] 语气词已剥) */
  text: string;
  /** 相对本片开播时刻(ms) */
  atMs: number;
  /** 显示时长(ms);下一条 cue 到来会直接顶替,这是没有下一条时的自然消隐点 */
  durMs: number;
  /**
   * 这条 cue 的发声时长(ms,不含收尾停留等垫时):订阅端按它把文本增量放出,
   * 字幕跟着嘴走,不整句先行(没念出来的字不上屏)。
   */
  speakMs: number;
}

export interface SubtitleCueOptions {
  /**
   * 对齐 units;在手时时间按真实时刻排。可以只是前缀(流式片播放中的前缀对齐):
   * 前缀之外的单元从末对齐单元的终点起按 msPerUnit 外推,并补前缀之外的停顿先验。
   */
  units?: AlignedUnit[] | null;
  /** 片时长(ms);无 units 时按单元数比例分摊 */
  durationMs?: number | null;
  /** 与锚点共用的校准估计；units 与 durationMs 均缺失时使用。 */
  leadInMs: number;
  msPerUnit: number;
  /**
   * 外推区间的停顿先验(ms/个):句末、句中标点与 [] 语音标签在 TTS 那边是真停顿,
   * 线性外推不为它们建模就逐条累积成滞后。常数由调用方传入,与跑飞预算和语速样本的
   * 净速率同一套(净速率已按同一组先验把停顿扣掉,估计再补回来才不重复)。缺省不补;
   * 全量对齐/时长两级真实时间源不用它。
   */
  pausePriors?: PausePriors;
}

/** 句末标点:必断 */
const HARD_BREAK = /[。!?!?…;;\n]/u;
/** 逗号族:长句的可断点 */
const SOFT_BREAK = /[,,、::·]/u;
/** 一条 cue 的目标单元数上限;超过就找逗号断,连逗号都没有才硬切 */
const MAX_UNITS = 22;
/** 软断点生效的最小前缀单元数:开头两三个字就断出去反而碎 */
const MIN_UNITS = 5;
/** 没有下一条 cue 时的收尾停留(ms) */
const TAIL_HOLD_MS = 1200;
/** 单条 cue 的显示时长下限(ms):再短的句子也别一闪而过 */
const MIN_DUR_MS = 1000;
/** 句间长停顿时字幕最多多留这么久(ms),不无限等下一句 */
const GAP_HOLD_MS = 2000;

/** [] 语气词(给 TTS 的发声指令)不进观众看的字幕 */
const VOICE_TAG_RE = /\[[^\[\]\n]{1,31}\]/gu;

interface Chunk {
  /** 原文片段(未剥标签;单元下标按它算) */
  raw: string;
  startUnit: number;
  endUnit: number;
}

/** 按标点切成 chunk;每个 chunk 记录自己覆盖的单元下标区间 */
function chunkText(text: string): Chunk[] {
  const cps = [...text];
  // 先按标点切成原子:标点(连同后续的引号/空白)归前一个原子
  const atoms: Array<{ raw: string; hard: boolean }> = [];
  let buf = '';
  let pendingHard = false;
  const flush = (hard: boolean): void => {
    if (buf.trim()) atoms.push({ raw: buf, hard });
    else if (buf && atoms.length > 0) atoms[atoms.length - 1].raw += buf;
    buf = '';
    pendingHard = false;
  };
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    buf += ch;
    if (HARD_BREAK.test(ch)) pendingHard = true;
    else if (SOFT_BREAK.test(ch)) flush(false);
    else if (pendingHard && !/[\s"」』)】]/u.test(ch)) {
      // 句末标点串(……」这类)吃完才断
      buf = buf.slice(0, buf.length - ch.length);
      flush(true);
      buf = ch;
    }
  }
  flush(pendingHard);

  // 原子聚合成 cue:句末必断;够长就在逗号断;单原子超长按单元数硬切
  const chunks: Chunk[] = [];
  let acc = '';
  let accUnits = 0;
  let unitCursor = 0;
  const emit = (raw: string): void => {
    const n = segmentUnits(raw).length;
    chunks.push({ raw, startUnit: unitCursor, endUnit: unitCursor + n });
    unitCursor += n;
  };
  const emitAcc = (): void => {
    if (acc) emit(acc);
    acc = '';
    accUnits = 0;
  };
  for (const atom of atoms) {
    const n = segmentUnits(atom.raw).length;
    if (n > MAX_UNITS && !acc) {
      // 整段没有可断标点:按单元数硬切
      for (const piece of hardSplit(atom.raw)) emit(piece);
      continue;
    }
    if (accUnits >= MIN_UNITS && accUnits + n > MAX_UNITS) emitAcc();
    acc += atom.raw;
    accUnits += n;
    if (atom.hard) emitAcc();
  }
  emitAcc();
  return chunks;
}

/** 无标点长串:每 MAX_UNITS 个单元切一刀(按码点扫描,单元边界处下刀) */
function hardSplit(raw: string): string[] {
  const out: string[] = [];
  const cps = [...raw];
  let piece = '';
  for (const ch of cps) {
    piece += ch;
    if (segmentUnits(piece).length >= MAX_UNITS) {
      out.push(piece);
      piece = '';
    }
  }
  if (piece) out.push(piece);
  return out;
}

/** 单元下标 → 时刻(ms);对齐前缀之外从末对齐单元的终点按速率外推 */
function unitAtMs(idx: number, total: number, o: SubtitleCueOptions): number {
  const units = o.units;
  if (units && units.length > 0) {
    if (idx <= 0) return Math.max(0, units[0].start * 1000);
    if (idx < units.length) return units[idx].start * 1000;
    return units[units.length - 1].end * 1000 + (idx - units.length) * o.msPerUnit;
  }
  if (typeof o.durationMs === 'number' && o.durationMs > 0 && total > 0) {
    return (idx / total) * o.durationMs;
  }
  return o.leadInMs + idx * o.msPerUnit;
}

/** 区间终点:对齐单元用它的 end,其余与下个下标的起点一致 */
function unitEndMs(endIdx: number, total: number, o: SubtitleCueOptions): number {
  const units = o.units;
  if (units && units.length > 0 && endIdx <= units.length) {
    return units[Math.max(0, endIdx - 1)].end * 1000;
  }
  return unitAtMs(endIdx, total, o);
}

/** 一条 cue 在原文里覆盖的单元下标区间;与 computeSubtitleCues 的返回逐条对应 */
export interface SubtitleChunk {
  startUnit: number;
  endUnit: number;
}

/** cue 的单元区间(显示文本被剥空的纯语音标签 chunk 已滤掉,与 cue 列表同序同长) */
export function subtitleChunks(text: string): SubtitleChunk[] {
  if (!text.trim()) return [];
  return chunkText(text)
    .filter((c) => c.raw.replace(VOICE_TAG_RE, (m) => (segmentUnits(m).length === 1 ? '' : m)).trim().length > 0)
    .map((c) => ({ startUnit: c.startUnit, endUnit: c.endUnit }));
}

export function computeSubtitleCues(text: string, opts: SubtitleCueOptions): SubtitleCue[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const totalUnits = segmentUnits(text).length;
  // 停顿先验只补在外推区间:按 chunk 前缀累加(在 display 过滤之前算,被剥空的
  // 纯语音标签 chunk 的 1.5 秒也要计入)。chunk 尾的停顿落在它末单元之后:末单元
  // 之后仍在外推时,计入自己的终点,也就是下一条的起点——与音频里停顿实际发生的
  // 位置一致;末单元的下一个单元已对齐时,停顿已在真实时刻里,不再补。
  const alignedUnits = opts.units?.length ?? 0;
  const byDuration = alignedUnits === 0 && typeof opts.durationMs === 'number' && opts.durationMs > 0;
  const priors = alignedUnits < totalUnits && !byDuration ? opts.pausePriors : undefined;
  let pauseAcc = 0;
  const raw = chunkText(text)
    .map((c) => {
      const pauseBeforeMs = pauseAcc;
      if (priors && c.endUnit >= alignedUnits) pauseAcc += pauseMs(countPauses(c.raw), priors);
      return {
        display: c.raw.replace(VOICE_TAG_RE, (m) => (segmentUnits(m).length === 1 ? '' : m)).trim(),
        startUnit: c.startUnit,
        endUnit: c.endUnit,
        pauseBeforeMs,
        // 末单元本身已对齐(endUnit ≤ 前缀长度)时终点是真实的,自己的停顿只影响后面的 chunk
        pauseThroughMs: c.endUnit > alignedUnits ? pauseAcc : pauseBeforeMs,
      };
    })
    .filter((c) => c.display.length > 0);
  if (raw.length === 0) return [];

  const cues: SubtitleCue[] = [];
  let prevAt = 0;
  for (const c of raw) {
    // 单调:估计/对齐偶有倒挂,后一条至少不早于前一条
    const at = Math.max(prevAt, unitAtMs(c.startUnit, totalUnits, opts) + c.pauseBeforeMs);
    const rawEnd = unitEndMs(c.endUnit, totalUnits, opts) + c.pauseThroughMs;
    const end = Math.max(at + MIN_DUR_MS, rawEnd);
    cues.push({
      text: c.display,
      atMs: Math.round(at),
      durMs: Math.round(end - at),
      speakMs: Math.max(0, Math.round(rawEnd - at)),
    });
    prevAt = at;
  }
  // 显示区间顺延到下一条起点(中途不留黑),但长停顿最多多留 GAP_HOLD_MS;末条加收尾停留
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (next) {
      const hold = Math.min(next.atMs, cue.atMs + cue.durMs + GAP_HOLD_MS);
      cue.durMs = Math.max(cue.durMs, hold - cue.atMs);
    } else {
      cue.durMs += TAIL_HOLD_MS;
    }
  }
  return cues;
}

/**
 * 一批 cue 的观测摘要；纯读函数，不参与显示决策。
 */
export interface SubtitleCueDigest {
  /** cue 条数;0 = 这一片观众一个字都看不到 */
  cues: number;
  /** 显示字数合计(按码点) */
  chars: number;
  /** 首条上屏时刻(ms,相对开播) */
  firstAtMs: number;
  /** 整批占屏跨度(ms):末条消隐 − 首条上屏 */
  spanMs: number;
  /** 发声区间合计(ms):订阅端的增量跟播按它放字 */
  speakMs: number;
  /** 垫时合计(ms):占屏时长里没有语音的那部分(最短显示/句间停留/收尾停留) */
  padMs: number;
  /** speakMs 为 0 的条数:这些条的增量跟播退化成整句直出 */
  noSpeak: number;
}

export function summarizeSubtitleCues(cues: readonly SubtitleCue[]): SubtitleCueDigest {
  const d: SubtitleCueDigest = {
    cues: cues.length,
    chars: 0,
    firstAtMs: 0,
    spanMs: 0,
    speakMs: 0,
    padMs: 0,
    noSpeak: 0,
  };
  if (cues.length === 0) return d;
  let end = 0;
  for (const c of cues) {
    d.chars += [...c.text].length;
    d.speakMs += c.speakMs;
    d.padMs += Math.max(0, c.durMs - c.speakMs);
    if (c.speakMs <= 0) d.noSpeak += 1;
    end = Math.max(end, c.atMs + c.durMs);
  }
  d.firstAtMs = cues[0].atMs;
  d.spanMs = Math.max(0, end - d.firstAtMs);
  return d;
}

/** 时间源的中文名;埋点行里说清这批 cue 的时刻是哪一级来源给的 */
const BASIS_LABEL: Record<string, string> = {
  align: '对齐',
  prefix: '前缀对齐',
  duration: '时长比例',
  estimate: '校准估计',
};

/**
 * 摘要 → 一条能读的日志行(埋点专用;调用方自己决定 level)。
 * rate 只在估计档给:同是「校准估计」,速率来自实测分位还是常数回落,复盘要能分开。
 */
export function describeSubtitleCues(d: SubtitleCueDigest, basis: string, rate?: string): string {
  const src = BASIS_LABEL[basis] ?? basis;
  const head = `时间轴(${src}${rate ? `,${rate}` : ''}):${d.cues} 条 / ${d.chars} 字`;
  if (d.cues === 0) return `${head}——这一片没有任何字上屏`;
  const tail = d.noSpeak > 0 ? `;${d.noSpeak} 条零发声(跟播退化成整句直出)` : '';
  return (
    `${head},首条 +${d.firstAtMs}ms,跨度 ${d.spanMs}ms` +
    `(发声 ${d.speakMs}ms / 垫时 ${d.padMs}ms)${tail}`
  );
}
