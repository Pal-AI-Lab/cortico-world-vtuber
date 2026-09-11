/**
 * `cortico.profile.json` 的边界校验:模型目录里的文件是部署者(或编码 AI)手写的,
 * 每个字段在这里逐项核对,错误信息带字段路径。
 *
 * 形状错误(类型不对、缺字段、未知字段)是错误,档案不加载。与演出包的对不上
 * (换算了包里没有的参数、声明了包里没有的特效)是警告:档案照样加载,多出来的
 * 条目原样保留、运行时用不到;包里有而档案没写的特效按 null 处理。这样档案与包
 * 可以各自演进,换包不用重写所有档案。
 */
import type { FxEntry, ModelProfile, ParamWiring } from './contract.ts';

class ProfileError extends Error {}

/** 档案校验需要知道的演出包事实 */
export interface ProfileContext {
  paramIds: readonly string[];
  fxIds: readonly string[];
}

export interface ParsedProfile {
  profile: ModelProfile;
  /** 与演出包对不上的地方;不阻止加载 */
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string, opts: { nonEmpty?: boolean } = {}): string {
  if (typeof v !== 'string') throw new ProfileError(`${path} 必须是字符串`);
  if (opts.nonEmpty && v.trim() === '') throw new ProfileError(`${path} 不能为空`);
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProfileError(`${path} 必须是有限数字`);
  return v;
}

function strList(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) throw new ProfileError(`${path} 必须是字符串数组`);
  return v.map((x, i) => str(x, `${path}[${i}]`, { nonEmpty: true }));
}

function wiring(v: unknown, path: string): ParamWiring {
  if (!isRecord(v)) throw new ProfileError(`${path} 必须是对象`);
  const out: ParamWiring = {};
  for (const key of Object.keys(v)) {
    const p = `${path}.${key}`;
    switch (key) {
      case 'neutral':
        out.neutral = num(v[key], p);
        break;
      case 'scale':
        out.scale = num(v[key], p);
        break;
      case 'invert':
        if (typeof v[key] !== 'boolean') throw new ProfileError(`${p} 必须是 true/false`);
        out.invert = v[key];
        break;
      case 'clamp': {
        const c = v[key];
        if (!Array.isArray(c) || c.length !== 2) throw new ProfileError(`${p} 必须是 [下限, 上限]`);
        const lo = num(c[0], `${p}[0]`);
        const hi = num(c[1], `${p}[1]`);
        if (lo > hi) throw new ProfileError(`${p} 下限大于上限`);
        out.clamp = [lo, hi];
        break;
      }
      case 'aliasTo': {
        const list = strList(v[key], p);
        if (list.length === 0) throw new ProfileError(`${p} 不能为空数组`);
        out.aliasTo = list;
        break;
      }
      default:
        throw new ProfileError(`${p} 不是换算字段(可用:neutral/scale/clamp/invert/aliasTo)`);
    }
  }
  return out;
}

function fxEntry(v: unknown, path: string): FxEntry | null {
  if (v === null) return null;
  if (!isRecord(v)) throw new ProfileError(`${path} 必须是 null 或 {file, durationMs}`);
  const file = str(v.file, `${path}.file`, { nonEmpty: true });
  if (!file.endsWith('.exp3.json')) throw new ProfileError(`${path}.file 必须是 .exp3.json 表情文件名`);
  const durationMs = num(v.durationMs, `${path}.durationMs`);
  if (durationMs <= 0) throw new ProfileError(`${path}.durationMs 必须大于 0`);
  for (const key of Object.keys(v)) {
    if (key !== 'file' && key !== 'durationMs') throw new ProfileError(`${path}.${key} 不是 FX 字段`);
  }
  return { file, durationMs };
}

const TOP_KEYS = new Set([
  'id', 'label', 'backend', 'vtsModelName', 'wiring', 'unsupported', 'fx',
  'keepExpressions', 'idleBlinks', 'caveat',
]);

/** 解析并校验一份档案;`source` 只用于错误信息。 */
export function parseProfile(raw: unknown, source: string, ctx: ProfileContext): ParsedProfile {
  const warnings: string[] = [];
  const known = new Set(ctx.paramIds);
  const knownFx = new Set(ctx.fxIds);
  try {
    if (!isRecord(raw)) throw new ProfileError('顶层必须是 JSON 对象');
    for (const key of Object.keys(raw)) {
      if (!TOP_KEYS.has(key)) throw new ProfileError(`未知字段 ${key}`);
    }
    for (const key of ['id', 'label', 'backend', 'vtsModelName', 'wiring', 'unsupported', 'fx', 'keepExpressions', 'idleBlinks']) {
      if (!(key in raw)) throw new ProfileError(`缺少字段 ${key}`);
    }
    const id = str(raw.id, 'id', { nonEmpty: true });
    if (id === 'auto' || id === 'VTS-Default') throw new ProfileError(`id 不能是保留值 ${id}`);
    const label = str(raw.label, 'label', { nonEmpty: true });
    if (raw.backend !== 'vts') throw new ProfileError('backend 目前只能是 "vts"');
    const vtsModelName = str(raw.vtsModelName, 'vtsModelName', { nonEmpty: true });

    if (!isRecord(raw.wiring)) throw new ProfileError('wiring 必须是对象');
    const wired: Record<string, ParamWiring> = {};
    for (const [key, v] of Object.entries(raw.wiring)) {
      wired[key] = wiring(v, `wiring.${key}`);
      if (!known.has(key)) warnings.push(`wiring.${key} 不是当前演出包里的参数,这条换算用不上`);
    }

    const unsupported = strList(raw.unsupported, 'unsupported');
    for (const u of unsupported) {
      if (!known.has(u)) warnings.push(`unsupported 里的 ${u} 不是当前演出包里的参数`);
    }

    if (!isRecord(raw.fx)) throw new ProfileError('fx 必须是对象');
    const fx: Record<string, FxEntry | null> = {};
    for (const [key, v] of Object.entries(raw.fx)) {
      fx[key] = fxEntry(v, `fx.${key}`);
      if (!knownFx.has(key)) warnings.push(`fx.${key} 不是当前演出包里的特效 id,这条用不上`);
    }

    const keepExpressions = strList(raw.keepExpressions, 'keepExpressions');
    if (typeof raw.idleBlinks !== 'boolean') throw new ProfileError('idleBlinks 必须是 true/false');
    const caveat = raw.caveat === undefined ? undefined : str(raw.caveat, 'caveat');

    return {
      profile: {
        id, label, backend: 'vts', vtsModelName,
        wiring: wired, unsupported, fx, keepExpressions,
        idleBlinks: raw.idleBlinks,
        ...(caveat === undefined ? {} : { caveat }),
      },
      warnings,
    };
  } catch (err) {
    if (err instanceof ProfileError) throw new Error(`${source}: ${err.message}`);
    throw err;
  }
}
