/**
 * TTS 运行时的发布表。
 *
 * 上游 llama.cpp-omni 不发 `llama-tts-server` 的可执行文件,二进制来自项目自己的 fork
 * (Phantivia/llama.cpp-omni,`tts-*` tag)。Windows 的 CUDA 运行库不重复打包,
 * 直接取 ggml-org 的 cudart 包,与 Cortico 的 llamacpp provider 共用同一份。
 */

/** 钉住的运行时版本;配置里的 ttsRuntime.release 可以覆盖。 */
export const PINNED_RELEASE = 'tts-b64d092c-2';

/** cudart 取自 ggml-org 的这个 build,CUDA 版本与我们的构建一致。 */
const GGML_RELEASE = 'b10930';

const OUR_BASE  = 'https://github.com/Phantivia/llama.cpp-omni/releases/download';
const GGML_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download';

export type Backend = 'cuda' | 'cpu';

export interface ReleaseArchive {
  file: string;
  url: string;
  format: 'zip' | 'tgz';
  stripComponents: number;
}

export interface ReleasePlan {
  /** 安装目录名,也是平台后端的标识 */
  key: string;
  archives: ReleaseArchive[];
  /** 解压目录下 server 可执行文件的相对路径 */
  serverExe: string;
  /** 对齐器冒烟 CLI,诊断用 */
  alignerCli: string;
}

export function defaultBackend(): Backend {
  return 'cuda';
}

/** 本平台是否有现成的构建;没有的话只能自备目录。 */
export function planFor(release: string, backend: Backend, platform: NodeJS.Platform = process.platform): ReleasePlan | null {
  if (platform === 'win32') {
    if (backend !== 'cuda') return null;
    const key = 'win-cuda-13.3-x64';
    return {
      key,
      serverExe: 'llama-tts-server.exe',
      alignerCli: 'llama-aligner-cli.exe',
      archives: [
        {
          file: `llama-tts-server-${key}.zip`,
          url: `${OUR_BASE}/${release}/llama-tts-server-${key}.zip`,
          format: 'zip',
          stripComponents: 0,
        },
        {
          file: `cudart-llama-bin-win-cuda-13.3-x64.zip`,
          url: `${GGML_BASE}/${GGML_RELEASE}/cudart-llama-bin-win-cuda-13.3-x64.zip`,
          format: 'zip',
          stripComponents: 0,
        },
      ],
    };
  }

  if (platform === 'linux') {
    if (backend !== 'cuda') return null;
    const key = 'ubuntu-cuda-12.8-x64';
    return {
      key,
      serverExe: 'llama-tts-server',
      alignerCli: 'llama-aligner-cli',
      archives: [
        {
          file: `llama-tts-server-${key}.tar.gz`,
          url: `${OUR_BASE}/${release}/llama-tts-server-${key}.tar.gz`,
          format: 'tgz',
          stripComponents: 1,
        },
      ],
    };
  }

  return null;
}
