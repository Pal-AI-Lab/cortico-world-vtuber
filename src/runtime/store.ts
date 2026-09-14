/**
 * 运行时安装:装到 `<运行时根>/llama.cpp-omni/<release>/<key>/`。
 *
 * 下载与解压都落在 `<目录>.partial`,写完标记再整个改名到位;下次安装先清掉残留的
 * 临时目录。目录里有 `cortico-runtime.json` 才算装好。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { downloadFile, extractArchive } from './archive.ts';
import type { ReleasePlan } from './release.ts';

export const RUNTIME_MARKER = 'cortico-runtime.json';
const RUNTIME_ID = 'llama.cpp-omni';

export type InstallPhase = 'absent' | 'downloading' | 'extracting' | 'installed' | 'error';

export interface InstallState {
  phase: InstallPhase;
  /** 正在下载或解压的那个压缩包 */
  file: string | null;
  done: number;
  total: number | null;
  detail: string | null;
}

export interface RuntimeMarker {
  runtime: typeof RUNTIME_ID;
  release: string;
  key: string;
  archives: string[];
  installedAt: string;
}

export class RuntimeStore {
  private active: { dir: string; phase: InstallPhase; file: string | null; done: number; total: number | null } | null = null;
  private readonly failures = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly root: string,
    private readonly log: Logger,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  dir(release: string, plan: ReleasePlan): string {
    return join(this.root, RUNTIME_ID, release, plan.key);
  }

  installed(dir: string): boolean {
    return existsSync(join(dir, RUNTIME_MARKER));
  }

  marker(dir: string): RuntimeMarker | null {
    try {
      return JSON.parse(readFileSync(join(dir, RUNTIME_MARKER), 'utf8')) as RuntimeMarker;
    } catch {
      return null;
    }
  }

  state(dir: string): InstallState {
    if (this.active?.dir === dir) {
      const { phase, file, done, total } = this.active;
      return { phase, file, done, total, detail: null };
    }
    const failure = this.failures.get(dir);
    if (failure) return { phase: 'error', file: null, done: 0, total: null, detail: failure };
    return { phase: this.installed(dir) ? 'installed' : 'absent', file: null, done: 0, total: null, detail: null };
  }

  /** 按计划把每个压缩包下下来解开;同时只允许一个安装在跑。 */
  async install(release: string, plan: ReleasePlan): Promise<void> {
    const dir = this.dir(release, plan);
    if (this.active) throw new Error('已经有一个运行时在安装了,等它结束');
    this.failures.delete(dir);

    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    this.active = { dir, phase: 'downloading', file: null, done: 0, total: null };

    try {
      for (const archive of plan.archives) {
        const file = join(partial, archive.file);
        this.active = { dir, phase: 'downloading', file: archive.file, done: 0, total: null };
        this.log.info(`TTS 运行时下载 ${archive.url}`);
        try {
          await downloadFile(archive.url, file, {
            fetchImpl: this.fetchImpl,
            onProgress: (done, total) => {
              if (this.active?.dir === dir) Object.assign(this.active, { done, total });
            },
          });
        } catch (error) {
          throw new Error(`下载 ${archive.file} 失败: ${message(error)}`);
        }

        this.active = { dir, phase: 'extracting', file: archive.file, done: 0, total: null };
        try {
          await extractArchive(file, archive.format, partial, archive.stripComponents);
        } catch (error) {
          throw new Error(`解压 ${archive.file} 失败: ${message(error)}`);
        }
        unlinkSync(file);
      }

      const marker: RuntimeMarker = {
        runtime: RUNTIME_ID,
        release,
        key: plan.key,
        archives: plan.archives.map((a) => a.file),
        installedAt: new Date().toISOString(),
      };
      writeFileSync(join(partial, RUNTIME_MARKER), JSON.stringify(marker, null, 2) + '\n');
      mkdirSync(join(dir, '..'), { recursive: true });
      renameSync(partial, dir);
      this.log.info(`TTS 运行时已安装 ${dir}`);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      const detail = message(error);
      this.failures.set(dir, detail);
      this.log.warn(`TTS 运行时安装失败: ${detail}`);
      throw error instanceof Error ? error : new Error(detail);
    } finally {
      this.active = null;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
