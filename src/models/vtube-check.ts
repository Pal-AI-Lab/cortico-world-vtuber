/**
 * 模型目录只读复检:档案里写的东西与模型文件对不对得上。VTS API 读不到
 * `ParameterSettings`,这里直接读 `.vtube.json`;表情与 idle 动画按文件名找。
 * 只报告,不修改。规则出处见 `LIVE2D-ADAPTATION.md`。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProfile } from './contract.ts';

export interface ModelFileCheck {
  /** 读到的 .vtube.json 路径;找不到时 null,warnings 里说明 */
  vtubeFile: string | null;
  warnings: string[];
}

/**
 * 眨眼 233ms 与逐帧口型经不起 VTS 平滑:眼睑平滑必须为 0,口型建议 0。
 * 头部三轴的平滑只让 pulse 圆一点,动作曲线本就按带平滑的模型手调,不报。
 */
const EYELID_INPUTS = ['EyeOpenLeft', 'EyeOpenRight'];
const FAST_INPUTS = ['MouthOpen'];

interface VtubeJson {
  Name?: string;
  FileReferences?: { IdleAnimation?: string };
  ParameterSettings?: Array<{ Input?: string; OutputLive2D?: string; Smoothing?: number }>;
}

function findFile(dir: string, name: string, depth = 3): string | null {
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  if (depth === 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const sub = join(dir, e);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = findFile(sub, name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** 语义参数经档案改发到哪些实机输入名 */
function wireTargets(profile: ModelProfile, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (profile.unsupported.includes(id)) continue;
    for (const t of profile.wiring[id]?.aliasTo ?? [id]) out.add(t);
  }
  return out;
}

export function checkModelFile(profile: ModelProfile, dir: string): ModelFileCheck {
  const warnings: string[] = [];
  let vtubeFile: string | null = null;
  try {
    vtubeFile = readdirSync(dir).filter((f) => f.endsWith('.vtube.json')).map((f) => join(dir, f))[0] ?? null;
  } catch (err) {
    return { vtubeFile: null, warnings: [`模型目录读不了:${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!vtubeFile) return { vtubeFile: null, warnings: ['模型目录里没有 .vtube.json(VTS 至少加载过一次才会生成)'] };

  let v: VtubeJson;
  try {
    v = JSON.parse(readFileSync(vtubeFile, 'utf8')) as VtubeJson;
  } catch (err) {
    return { vtubeFile, warnings: [`.vtube.json 解析失败:${err instanceof Error ? err.message : String(err)}`] };
  }

  if (typeof v.Name === 'string' && v.Name !== profile.vtsModelName) {
    warnings.push(`档案 vtsModelName「${profile.vtsModelName}」≠ .vtube.json 的 Name「${v.Name}」,auto 定档会认不出`);
  }

  const eyelids = wireTargets(profile, EYELID_INPUTS);
  const fast = wireTargets(profile, FAST_INPUTS);
  for (const p of v.ParameterSettings ?? []) {
    const input = p.Input ?? '';
    const s = p.Smoothing ?? 0;
    if (s <= 0) continue;
    if (eyelids.has(input)) {
      warnings.push(`${input}→${p.OutputLive2D ?? '?'} Smoothing=${s}:眨眼闭不上,必须改成 0`);
    } else if (fast.has(input)) {
      warnings.push(`${input}→${p.OutputLive2D ?? '?'} Smoothing=${s}:口型会拖后,建议 0`);
    }
  }

  const files = new Set<string>();
  for (const e of Object.values(profile.fx)) if (e) files.add(e.file);
  for (const f of profile.keepExpressions) files.add(f);
  for (const f of files) {
    if (!findFile(dir, f)) warnings.push(`表情文件 ${f} 在模型目录里找不到`);
  }

  const idle = v.FileReferences?.IdleAnimation;
  if (idle) {
    const idleFile = findFile(dir, idle);
    if (!idleFile) {
      warnings.push(`idle 动画 ${idle} 在模型目录里找不到`);
    } else {
      try {
        const m = JSON.parse(readFileSync(idleFile, 'utf8')) as { Curves?: Array<{ Id?: string }> };
        const ids = new Set((m.Curves ?? []).map((c) => c.Id));
        const blinks = ids.has('ParamEyeLOpen') || ids.has('ParamEyeROpen');
        if (blinks !== profile.idleBlinks) {
          warnings.push(
            blinks
              ? `idle 动画 ${idle} 驱动眼睑,档案却写 idleBlinks:false(空闲期会双重眨眼)`
              : `idle 动画 ${idle} 不驱动眼睑,档案却写 idleBlinks:true(空闲期不会眨眼)`,
          );
        }
      } catch {
        warnings.push(`idle 动画 ${idle} 解析失败`);
      }
    }
  } else if (profile.idleBlinks) {
    warnings.push('模型没有 idle 动画,档案却写 idleBlinks:true');
  }

  return { vtubeFile, warnings };
}
