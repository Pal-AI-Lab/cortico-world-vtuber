/**
 * 档案发现:`<live2dDir>/<模型目录>/cortico.profile.json`,每个模型目录最多一份。
 * `live2dDir` 是 VTube Studio 加载模型的目录(`StreamingAssets/Live2DModels`)。
 * 坏文件记进 `errors`,不影响其余档案;同 id 的后来者被拒。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROFILE, type ModelProfile } from './contract.ts';
import { parseProfile, type ProfileContext } from './schema.ts';

export const PROFILE_FILE = 'cortico.profile.json';

export interface ProfileSource {
  profile: ModelProfile;
  /** 模型目录(含模型文件与档案) */
  dir: string;
  /** 档案文件完整路径 */
  file: string;
  /** 与当前演出包对不上的地方(不阻止加载),见 schema.ts */
  warnings: string[];
}

export interface ProfileRegistry {
  live2dDir: string;
  profiles: ProfileSource[];
  errors: Array<{ file: string; message: string }>;
}

/** `ctx` 是当前演出包的参数集与特效 id,档案校验用 */
export function loadProfiles(live2dDir: string, ctx: ProfileContext): ProfileRegistry {
  const root = live2dDir.trim();
  const reg: ProfileRegistry = { live2dDir: root, profiles: [], errors: [] };
  if (!root) return reg;
  if (!existsSync(root)) {
    reg.errors.push({ file: root, message: 'Live2D 目录不存在' });
    return reg;
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    reg.errors.push({ file: root, message: err instanceof Error ? err.message : String(err) });
    return reg;
  }
  for (const name of entries.sort()) {
    const dir = join(root, name);
    const file = join(dir, PROFILE_FILE);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
    } catch {
      continue;
    }
    try {
      const { profile, warnings } = parseProfile(JSON.parse(readFileSync(file, 'utf8')), file, ctx);
      const dup = reg.profiles.find((p) => p.profile.id === profile.id);
      if (dup) {
        reg.errors.push({ file, message: `id「${profile.id}」已被 ${dup.file} 占用` });
        continue;
      }
      reg.profiles.push({ profile, dir, file, warnings });
    } catch (err) {
      reg.errors.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return reg;
}

export function profileById(reg: ProfileRegistry, id: string): ProfileSource | null {
  return reg.profiles.find((p) => p.profile.id === id) ?? null;
}

/** 按 VTS 的 `CurrentModelRequest.modelName` 找档案 */
export function profileByModelName(reg: ProfileRegistry, name: string): ProfileSource | null {
  const n = name.trim();
  if (!n) return null;
  return reg.profiles.find((p) => p.profile.vtsModelName === n) ?? null;
}

export interface ProfileResolution {
  profile: ModelProfile;
  /**
   * 档案来源。`missing` = 配置指了一个不存在的 id:此时按模型名匹配或退到默认档案
   * 照样出画面,但这是配置错误,上层必须报出来。
   */
  how: 'configured' | 'matched' | 'fallback' | 'missing';
  /** VTS 侧当前模型名(拿不到时空串) */
  vtsModelName: string;
  /** 生效档案所在的模型目录;默认档案没有 */
  source: ProfileSource | null;
}

/**
 * 定档。`configured` 是配置值('auto' 或某个档案 id),`vtsModelName` 是实机报回来的模型名。
 */
export function resolveProfile(reg: ProfileRegistry, configured: string, vtsModelName: string): ProfileResolution {
  const wanted = configured.trim();
  const explicit = wanted && wanted !== 'auto' ? profileById(reg, wanted) : null;
  if (explicit) return { profile: explicit.profile, how: 'configured', vtsModelName, source: explicit };
  const matched = profileByModelName(reg, vtsModelName);
  const missing = Boolean(wanted && wanted !== 'auto');
  if (matched) return { profile: matched.profile, how: missing ? 'missing' : 'matched', vtsModelName, source: matched };
  return { profile: DEFAULT_PROFILE, how: missing ? 'missing' : 'fallback', vtsModelName, source: null };
}

/** 控制台下拉用:'auto' + 各档案 */
export function profileChoices(reg: ProfileRegistry): Array<{ value: string; label: string; vtsModelName: string }> {
  return [
    { value: 'auto', label: '自动(按 VTS 报的模型名)', vtsModelName: '' },
    ...reg.profiles.map((p) => ({ value: p.profile.id, label: p.profile.label, vtsModelName: p.profile.vtsModelName })),
  ];
}
