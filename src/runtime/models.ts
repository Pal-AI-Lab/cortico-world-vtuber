/**
 * 权重下载:落在 `<模型根>/vtuber/`,文件名固定。
 *
 * VoxCPM2 的两个 GGUF 来自 HuggingFace 上钉住 revision 的直链。对齐器全网没有现成的
 * GGUF 发布,本项目也不转发它的权重:自己用 `scripts/aligner-gguf.ts` 从 Qwen 的原始
 * 权重转出来,放进同一个目录,或在配置里指到别处。见 README「对齐器权重」。
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { downloadFile } from './archive.ts';

/** VoxCPM2 GGUF 的来源与固定 revision */
const VOXCPM2_REPO = 'DennisHuang648/VoxCPM2-GGUF';
const VOXCPM2_REV  = '169f64d';

export type ModelId = 'baseLm' | 'acoustic' | 'alignerLm' | 'alignerAudio';

export interface ModelSpec {
  id: ModelId;
  file: string;
  /** 自备的权重没有下载地址 */
  url: string | null;
  /** 大致字节数,面板用来显示进度;不做校验 */
  approxBytes: number;
  /** 对齐器缺了只是没有逐字时间点,TTS 照常 */
  required: boolean;
  source: string;
}

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'baseLm',
    file: 'VoxCPM2-BaseLM-F16.gguf',
    url: `https://huggingface.co/${VOXCPM2_REPO}/resolve/${VOXCPM2_REV}/VoxCPM2-BaseLM-F16.gguf`,
    approxBytes: 3_247_980_544,
    required: true,
    source: `${VOXCPM2_REPO}@${VOXCPM2_REV}`,
  },
  {
    id: 'acoustic',
    file: 'VoxCPM2-Acoustic-F16.gguf',
    url: `https://huggingface.co/${VOXCPM2_REPO}/resolve/${VOXCPM2_REV}/VoxCPM2-Acoustic-F16.gguf`,
    approxBytes: 1_825_096_352,
    required: true,
    source: `${VOXCPM2_REPO}@${VOXCPM2_REV}`,
  },
  {
    id: 'alignerLm',
    file: 'Qwen3-Aligner-LM-F16.gguf',
    url: null,
    approxBytes: 1_198_442_816,
    required: false,
    source: 'Qwen/Qwen3-ForcedAligner-0.6B-hf,自己用 scripts/aligner-gguf.ts 转,见 README',
  },
  {
    id: 'alignerAudio',
    file: 'Qwen3-Aligner-Audio-F16.gguf',
    url: null,
    approxBytes: 660_152_736,
    required: false,
    source: 'Qwen/Qwen3-ForcedAligner-0.6B-hf,自己用 scripts/aligner-gguf.ts 转,见 README',
  },
] as const;

export type ModelPhase = 'absent' | 'downloading' | 'present' | 'error';

export interface ModelState {
  id: ModelId;
  file: string;
  path: string;
  phase: ModelPhase;
  bytes: number;
  done: number;
  total: number | null;
  detail: string | null;
  required: boolean;
  /** 有下载地址的才给下载按钮;自备的只报在不在 */
  downloadable: boolean;
  source: string;
}

export class ModelStore {
  private active: { id: ModelId; done: number; total: number | null } | null = null;
  private readonly failures = new Map<ModelId, string>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  path(id: ModelId): string {
    const spec = MODELS.find((m) => m.id === id);
    if (!spec) throw new Error(`未知模型 ${id}`);
    return join(this.dir, spec.file);
  }

  present(id: ModelId): boolean {
    return existsSync(this.path(id));
  }

  states(): ModelState[] {
    return MODELS.map((spec) => {
      const path = this.path(spec.id);
      const here = existsSync(path);
      const bytes = here ? statSync(path).size : 0;
      if (this.active?.id === spec.id) {
        return { ...base(spec, path, bytes), phase: 'downloading', done: this.active.done, total: this.active.total };
      }
      const failure = this.failures.get(spec.id);
      if (failure) return { ...base(spec, path, bytes), phase: 'error', detail: failure };
      return { ...base(spec, path, bytes), phase: here ? 'present' : 'absent' };
    });
  }

  /** 下到 `<文件>.partial` 再改名,中断不会留下半个文件冒充装好了。 */
  async download(id: ModelId): Promise<void> {
    const spec = MODELS.find((m) => m.id === id);
    if (!spec) throw new Error(`未知模型 ${id}`);
    if (!spec.url) throw new Error(`${spec.file} 要自己转出来放进 ${this.dir},见 README「对齐器权重」`);
    if (this.active) throw new Error('已经有一个权重在下载了,等它结束');
    this.failures.delete(id);

    const dest = this.path(id);
    const partial = `${dest}.partial`;
    mkdirSync(this.dir, { recursive: true });
    rmSync(partial, { force: true });
    this.active = { id, done: 0, total: null };
    this.log.info(`TTS 权重下载 ${spec.file}`);

    try {
      await downloadFile(spec.url, partial, {
        fetchImpl: this.fetchImpl,
        onProgress: (done, total) => {
          if (this.active?.id === id) Object.assign(this.active, { done, total });
        },
      });
      rmSync(dest, { force: true });
      renameSync(partial, dest);
      this.log.info(`TTS 权重已就位 ${dest}`);
    } catch (error) {
      rmSync(partial, { force: true });
      const detail = error instanceof Error ? error.message : String(error);
      this.failures.set(id, detail);
      this.log.warn(`TTS 权重下载失败 ${spec.file}: ${detail}`);
      throw error instanceof Error ? error : new Error(detail);
    } finally {
      this.active = null;
    }
  }
}

function base(spec: ModelSpec, path: string, bytes: number): ModelState {
  return {
    id: spec.id,
    file: spec.file,
    path,
    phase: 'absent',
    bytes,
    done: 0,
    total: null,
    detail: null,
    required: spec.required,
    downloadable: spec.url !== null,
    source: spec.source,
  };
}
