/**
 * 演出包:参数集 + 词表 + 曲线,人格的表达空间。数据来自一个目录
 * (`params.json` + `vocab.json` + `clips.json`),由 bot 提供;worlds-vtuber 自带
 * `examples/vtuber-pack/` 作缺省与范例。包对所有模型相同,模型差异在 L4 的档案里(`models/`)。
 *
 * 参数集是包自己声明的:曲线只能驱动包里声明的参数,档案的换算也只对这些参数有意义。
 * 混音台的内建行为(头部漂移与注视跟随、口型、眨眼、眼球)依赖 `CORE_PARAMS`,
 * 这一组每个包都必须声明;其余参数(尾巴、翅膀、腮帮……)由包自由增删。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EASES, type GazeTarget, type HoldSpec, type Key, type PulseClip, type SustainClip } from './clips.ts';

export type Channel = 'gesture' | 'pose' | 'emotion' | 'gaze' | 'fx';
export type Lifecycle = 'pulse' | 'state';

export interface VocabEntry {
  word: string;
  channel: Channel;
  clipId: string;
  lifecycle: Lifecycle;
  /** gesture 幅度档(缺省 1);同一 clip 借强弱档拆成不同词 */
  intensity?: number;
}

/** 解析出的单个标签指令 */
export type TagCommand =
  | { kind: 'perform'; entry: VocabEntry }
  | { kind: 'reset' };

/** 一个语义参数的声明:曲线在这个量程里写,混音台按它钳位,自检按它取探针幅度。 */
export interface ParamSpec {
  /** 语义量的单位与含义,给写档案的人看 */
  unit: string;
  /** 混音台输出钳位区间 */
  range: readonly [number, number];
  /** 首选 Live2D 参数(建议) */
  suggests?: string;
  /** 模型接不上这个参数时会失去什么 */
  losesIfMissing?: string;
  /** 接线自检的探针幅度;缺省取量程最大绝对值的 2/3 */
  probe?: number;
}

export interface PackData {
  params: Record<string, ParamSpec>;
  entries: VocabEntry[];
  /** 解析期归一化:别名 → 词表里的词 */
  aliases: Record<string, string>;
  pulse: Record<string, PulseClip>;
  sustain: Record<string, SustainClip>;
  gaze: Record<string, GazeTarget>;
}

export const EXAMPLE_PACK_DIR = fileURLToPath(new URL('./examples/vtuber-pack/', import.meta.url));

/** 混音台内建行为写死的参数:注视(眼球四轴 + 头部跟随)、口型、眨眼、环境头部漂移。 */
export const CORE_PARAMS: readonly string[] = [
  'FaceAngleX', 'FaceAngleY', 'FaceAngleZ',
  'MouthOpen',
  'EyeOpenLeft', 'EyeOpenRight',
  'EyeLeftX', 'EyeLeftY', 'EyeRightX', 'EyeRightY',
];

const CHANNELS: readonly Channel[] = ['gesture', 'pose', 'emotion', 'gaze', 'fx'];
const CHANNEL_DICT: Record<Channel, 'pulse' | 'sustain' | 'gaze' | null> = {
  gesture: 'pulse', pose: 'sustain', emotion: 'sustain', gaze: 'gaze', fx: null,
};

export class PerformancePack {
  private readonly byWord = new Map<string, VocabEntry>();
  /** 同一 clip 有强弱档多个词时,取先声明的做代表词(控制台显示用) */
  private readonly byClip = new Map<string, VocabEntry>();

  constructor(readonly data: PackData, readonly dir: string = '') {
    for (const e of data.entries) {
      this.byWord.set(e.word, e);
      if (!this.byClip.has(e.clipId)) this.byClip.set(e.clipId, e);
    }
  }

  get params(): Readonly<Record<string, ParamSpec>> {
    return this.data.params;
  }

  get paramIds(): string[] {
    return Object.keys(this.data.params);
  }

  get entries(): readonly VocabEntry[] {
    return this.data.entries;
  }

  get pulse(): Readonly<Record<string, PulseClip>> {
    return this.data.pulse;
  }

  get sustain(): Readonly<Record<string, SustainClip>> {
    return this.data.sustain;
  }

  get gaze(): Readonly<Record<string, GazeTarget>> {
    return this.data.gaze;
  }

  /** 词表里 fx 通道的 clipId;模型档案的 fx 表用这些做键 */
  get fxIds(): string[] {
    return this.data.entries.filter((e) => e.channel === 'fx').map((e) => e.clipId);
  }

  /** 参数的钳位区间;包里没声明的参数不钳 */
  range(param: string): readonly [number, number] | null {
    return this.data.params[param]?.range ?? null;
  }

  entryByClipId(clipId: string): VocabEntry | undefined {
    return this.byClip.get(clipId);
  }

  /** 解析一个标签词;未知词返回 null,首尾空白忽略 */
  resolveTag(raw: string): TagCommand | null {
    const word = raw.trim();
    if (!word) return null;
    if (word === 'Reset' || word === 'reset') return { kind: 'reset' };
    const entry = this.byWord.get(this.data.aliases[word] ?? word);
    return entry ? { kind: 'perform', entry } : null;
  }

  /** 形状警告(不阻止生效):加性偏移首尾必须归零,关键帧不越过 durationMs */
  lint(): string[] {
    const out: string[] = [];
    for (const clip of Object.values(this.data.pulse)) {
      for (const [param, keys] of Object.entries(clip.tracks)) {
        if (keys.length === 0) continue;
        if (keys[0][1] !== 0) out.push(`${clip.id}.${param} 首帧不为 0(会跳变入场)`);
        if (keys[keys.length - 1][1] !== 0) out.push(`${clip.id}.${param} 尾帧不为 0(会留残余偏移)`);
        if (keys[keys.length - 1][0] > clip.durationMs) {
          out.push(`${clip.id}.${param} 尾帧 ${keys[keys.length - 1][0]}ms 超出 durationMs=${clip.durationMs}(曲线被截断)`);
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 加载与校验

class PackError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PackError(`${path} 必须是有限数字`);
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new PackError(`${path} 必须是非空字符串`);
  return v;
}

function paramSpec(v: unknown, path: string): ParamSpec {
  if (!isRecord(v)) throw new PackError(`${path} 必须是对象`);
  const r = v.range;
  if (!Array.isArray(r) || r.length !== 2) throw new PackError(`${path}.range 必须是 [下限, 上限]`);
  const lo = num(r[0], `${path}.range[0]`);
  const hi = num(r[1], `${path}.range[1]`);
  if (lo >= hi) throw new PackError(`${path}.range 下限必须小于上限`);
  const out: ParamSpec = { unit: str(v.unit, `${path}.unit`), range: [lo, hi] };
  for (const key of Object.keys(v)) {
    switch (key) {
      case 'unit': case 'range': break;
      case 'suggests': out.suggests = str(v[key], `${path}.suggests`); break;
      case 'losesIfMissing': out.losesIfMissing = str(v[key], `${path}.losesIfMissing`); break;
      case 'probe': {
        const p = num(v[key], `${path}.probe`);
        if (p <= 0) throw new PackError(`${path}.probe 必须大于 0`);
        out.probe = p;
        break;
      }
      default: throw new PackError(`${path}.${key} 不是参数声明字段(可用:unit/range/suggests/losesIfMissing/probe)`);
    }
  }
  return out;
}

function keys(v: unknown, path: string): Key[] {
  if (!Array.isArray(v)) throw new PackError(`${path} 必须是关键帧数组`);
  return v.map((k, i) => {
    const p = `${path}[${i}]`;
    if (!Array.isArray(k) || k.length < 2 || k.length > 3) throw new PackError(`${p} 必须是 [ms, value] 或 [ms, value, ease]`);
    const ms = num(k[0], `${p}[0]`);
    const value = num(k[1], `${p}[1]`);
    if (k.length === 3) {
      if (typeof k[2] !== 'string' || !(k[2] in EASES)) throw new PackError(`${p}[2] 缓动名必须是 ${Object.keys(EASES).join('/')}`);
      return [ms, value, k[2] as keyof typeof EASES];
    }
    return [ms, value];
  });
}

function pulseClip(v: unknown, id: string, path: string, paramIds: ReadonlySet<string>): PulseClip {
  if (!isRecord(v)) throw new PackError(`${path} 必须是对象`);
  if (v.id !== id) throw new PackError(`${path}.id 必须等于键名 ${id}`);
  const durationMs = num(v.durationMs, `${path}.durationMs`);
  if (durationMs <= 0) throw new PackError(`${path}.durationMs 必须大于 0`);
  const speechOnsetMs = num(v.speechOnsetMs, `${path}.speechOnsetMs`);
  if (!isRecord(v.tracks)) throw new PackError(`${path}.tracks 必须是对象`);
  const tracks: Record<string, Key[]> = {};
  for (const [param, k] of Object.entries(v.tracks)) {
    if (!paramIds.has(param)) throw new PackError(`${path}.tracks 的参数 ${param} 没在 params.json 里声明`);
    tracks[param] = keys(k, `${path}.tracks.${param}`);
  }
  return { id, durationMs, speechOnsetMs, tracks };
}

function holdSpec(v: unknown, path: string): HoldSpec {
  if (!isRecord(v)) throw new PackError(`${path} 必须是对象`);
  const out: HoldSpec = { v: num(v.v, `${path}.v`) };
  for (const key of Object.keys(v)) {
    switch (key) {
      case 'v': break;
      case 'settleTo': out.settleTo = num(v[key], `${path}.settleTo`); break;
      case 'settleMs': out.settleMs = num(v[key], `${path}.settleMs`); break;
      case 'noiseAmp': out.noiseAmp = num(v[key], `${path}.noiseAmp`); break;
      case 'noiseHz': out.noiseHz = num(v[key], `${path}.noiseHz`); break;
      case 'phase': out.phase = num(v[key], `${path}.phase`); break;
      case 'noiseKind':
        if (v[key] !== 'sine' && v[key] !== 'drift') throw new PackError(`${path}.noiseKind 必须是 sine 或 drift`);
        out.noiseKind = v[key];
        break;
      default:
        throw new PackError(`${path}.${key} 不是保持位字段`);
    }
  }
  return out;
}

function sustainClip(v: unknown, id: string, path: string, paramIds: ReadonlySet<string>): SustainClip {
  if (!isRecord(v)) throw new PackError(`${path} 必须是对象`);
  if (v.id !== id) throw new PackError(`${path}.id 必须等于键名 ${id}`);
  if (!isRecord(v.hold)) throw new PackError(`${path}.hold 必须是对象`);
  const hold: Record<string, HoldSpec> = {};
  for (const [param, h] of Object.entries(v.hold)) {
    if (!paramIds.has(param)) throw new PackError(`${path}.hold 的参数 ${param} 没在 params.json 里声明`);
    hold[param] = holdSpec(h, `${path}.hold.${param}`);
  }
  return { id, hold };
}

function gazeTarget(v: unknown, id: string, path: string): GazeTarget {
  if (!isRecord(v)) throw new PackError(`${path} 必须是对象`);
  if (v.id !== id) throw new PackError(`${path}.id 必须等于键名 ${id}`);
  const out: GazeTarget = {
    id,
    eyeX: num(v.eyeX, `${path}.eyeX`),
    eyeY: num(v.eyeY, `${path}.eyeY`),
    headX: num(v.headX, `${path}.headX`),
    headY: num(v.headY, `${path}.headY`),
  };
  if (v.scanRadiusDeg !== undefined) out.scanRadiusDeg = num(v.scanRadiusDeg, `${path}.scanRadiusDeg`);
  return out;
}

function dict<T>(v: unknown, path: string, one: (item: unknown, id: string, p: string) => T): Record<string, T> {
  if (!isRecord(v)) throw new PackError(`${path} 必须是对象`);
  const out: Record<string, T> = {};
  for (const [id, item] of Object.entries(v)) out[id] = one(item, id, `${path}.${id}`);
  return out;
}

/** 校验三份 JSON 并合成包;`source` 只用于错误信息 */
export function parsePack(paramsRaw: unknown, vocabRaw: unknown, clipsRaw: unknown, source: string): PackData {
  try {
    if (!isRecord(paramsRaw)) throw new PackError('params.json 顶层必须是对象');
    if (!isRecord(vocabRaw)) throw new PackError('vocab.json 顶层必须是对象');
    if (!isRecord(clipsRaw)) throw new PackError('clips.json 顶层必须是对象');

    const params = dict(paramsRaw, 'params', (item, id, p) => paramSpec(item, p));
    const missingCore = CORE_PARAMS.filter((id) => !(id in params));
    if (missingCore.length > 0) {
      throw new PackError(`params.json 缺少混音台依赖的参数 ${missingCore.join('、')}(注视/口型/眨眼/头部漂移写死用它们)`);
    }
    const paramIds = new Set(Object.keys(params));

    if (!Array.isArray(vocabRaw.entries)) throw new PackError('vocab.json 缺 entries 数组');
    const entries: VocabEntry[] = vocabRaw.entries.map((e, i) => {
      const p = `vocab.entries[${i}]`;
      if (!isRecord(e)) throw new PackError(`${p} 必须是对象`);
      const word = str(e.word, `${p}.word`);
      if (word === 'Reset' || word === 'reset') throw new PackError(`${p}.word 不能是保留词 Reset`);
      if (!CHANNELS.includes(e.channel as Channel)) throw new PackError(`${p}.channel 必须是 ${CHANNELS.join('/')}`);
      if (e.lifecycle !== 'pulse' && e.lifecycle !== 'state') throw new PackError(`${p}.lifecycle 必须是 pulse 或 state`);
      const out: VocabEntry = { word, channel: e.channel as Channel, clipId: str(e.clipId, `${p}.clipId`), lifecycle: e.lifecycle };
      if (e.intensity !== undefined) {
        const it = num(e.intensity, `${p}.intensity`);
        if (it <= 0) throw new PackError(`${p}.intensity 必须大于 0`);
        out.intensity = it;
      }
      return out;
    });
    const words = new Set<string>();
    for (const e of entries) {
      if (words.has(e.word)) throw new PackError(`vocab.entries 里的词「${e.word}」重复`);
      words.add(e.word);
    }
    const aliases: Record<string, string> = {};
    if (vocabRaw.aliases !== undefined) {
      if (!isRecord(vocabRaw.aliases)) throw new PackError('vocab.aliases 必须是对象');
      for (const [alias, target] of Object.entries(vocabRaw.aliases)) {
        if (typeof target !== 'string' || !words.has(target)) throw new PackError(`vocab.aliases.${alias} 指向的「${String(target)}」不在词表里`);
        if (words.has(alias)) throw new PackError(`vocab.aliases.${alias} 与词表里的词同名`);
        aliases[alias] = target;
      }
    }
    const pulse = dict(clipsRaw.pulse, 'clips.pulse', (item, id, p) => pulseClip(item, id, p, paramIds));
    const sustain = dict(clipsRaw.sustain, 'clips.sustain', (item, id, p) => sustainClip(item, id, p, paramIds));
    const gaze = dict(clipsRaw.gaze, 'clips.gaze', gazeTarget);
    const dicts = { pulse, sustain, gaze };
    for (const e of entries) {
      const d = CHANNEL_DICT[e.channel];
      if (d && !dicts[d][e.clipId]) throw new PackError(`词「${e.word}」对应的 clip「${e.clipId}」不在 clips.${d} 里`);
    }
    return { params, entries, aliases, pulse, sustain, gaze };
  } catch (err) {
    if (err instanceof PackError) throw new Error(`${source}: ${err.message}`);
    throw err;
  }
}

/** 从目录读 `params.json` + `vocab.json` + `clips.json`;任何问题抛错,错误信息带路径 */
export function loadPack(dir: string): PerformancePack {
  const read = (name: string): unknown => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`${file}: 文件不存在`);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return new PerformancePack(parsePack(read('params.json'), read('vocab.json'), read('clips.json'), dir), dir);
}

const CHANNEL_ROWS: ReadonlyArray<[Channel, string, string]> = [
  ['gesture', '动作', '做一下就结束'],
  ['pose', '姿态', '会保持一阵子'],
  ['emotion', '表情', '会挂在脸上一阵子'],
  ['gaze', '看向', '视线会停在那里'],
  ['fx', '特效', '头上/脸上弹出小挂件'],
];

/** 环境提示词里「可用演出标记」表的正文行(不含表头),按通道分组 */
export function vocabTableRows(pack: PerformancePack): string {
  const rows: string[] = [];
  for (const [channel, label, desc] of CHANNEL_ROWS) {
    const words = pack.entries.filter((e) => e.channel === channel).map((e) => `\`${e.word}\``);
    if (words.length === 0) continue;
    rows.push(`| ${label} | ${desc} | ${words.join('、')} |`);
  }
  return rows.join('\n');
}
