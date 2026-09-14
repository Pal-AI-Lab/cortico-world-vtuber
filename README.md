# cortico-world-vtuber

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的 VTuber 演出 World,以独立 npm 包发布。

World 把一段台本变成**连续演出**:文本经流式 TTS 出声,同一段文本解析出的动作记号驱动
Live2D 模型(经 VTube Studio 的 Public API 注入参数),字幕按强制对齐器给出的时间点
跟着念,OBS 里的 overlay 画面由 World 自带的演出流服务直接推。控制台里它有八个面板:
挂载、模型档案、Overlay、动作调参、声线档案、时间点标注、演出日志、演出诊断。

World 内部的分层、演出包格式、台本记号与 Live2D 适配写在 [`src/README.md`](src/README.md)、
[`src/vtuber_performance_module_design.md`](src/vtuber_performance_module_design.md) 与
[`src/models/LIVE2D-ADAPTATION.md`](src/models/LIVE2D-ADAPTATION.md)。

## 与 Cortico 的关系

这是一个**扩展包**,不是 Cortico 的一部分。它按 Cortico 的扩展契约声明自己:

```jsonc
"cortico": { "kind": "world", "api": 1, "consoleClient": "dist/console.js", "consoleStyle": "dist/console.css" }
```

运行时它以 `cortico/<框架 src 下的路径>` import 框架(`cortico/worlds.ts`、
`cortico/core/types.ts` …)。这些 specifier 由框架 `src/extensions/runtime.ts` 注册的模块
钩子解析到框架源码本身,**同一份实例**——扩展与框架共用一个 `WorldAssembly`、一套
日志锚点。因此包必须是 `"type": "module"`:CommonJS 包经 require 会拿到框架源码的
第二份副本。

浏览器侧(`src/console/**`)对 `cortico/*` **只 `import type`**:框架的前端代码不随本包
发布,面板 bundle 也不该把它打进来。要用到的运行时值在包内自带(`console/disposable.ts`
的 `toDisposable`,`console/model.ts` 里那枚目录图标)。

## 安装

先在本目录构建面板产物——`dist/` 不进版本库,没有它控制台的 VTuber 页是空的:

```bash
corepack pnpm install
corepack pnpm build
```

然后二选一装进 Cortico:

- 控制台「扩展」页手动安装,填本目录的绝对路径;
- 或在 `<Cortico>/extensions/` 下 `corepack pnpm add --ignore-workspace <本目录绝对路径>`。

**装完要整进程重启 Cortico**:World 定义在装配表里,热激活开关管不到扩展的装载。

## 开发

`tsconfig.json` 的 `paths` 与 `vitest.config.ts` 的 `resolve.alias` 都把 `cortico/*` 指向
`../BOT/src/`——也就是**与本目录同级的框架 checkout**。框架放在别处时改这两处(它们必须
同步)。生产里不靠这两条:那时解析由框架的模块钩子完成。

```bash
corepack pnpm typecheck   # tsc --noEmit,Node 侧与浏览器侧一份配置一起 check
corepack pnpm test        # vitest run
corepack pnpm build       # esbuild → dist/console.{js,css}
```

测试全程 mock:不连 VTube Studio、不起真 TTS server、不开声卡。构建脚本**不给
`cortico/*` 配 alias 也不 external**——报 "Could not resolve cortico/…" 就说明浏览器侧
漏了一处运行时依赖,去把它本地化,不要在构建里放行。

## TTS 运行时与权重

World 不带二进制也不带权重,控制台的 TTS 面板负责把它们取来:

- **运行时**装到 `<运行时根>/llama.cpp-omni/<release>/<平台后端>/`。二进制来自
  [Phantivia/llama.cpp-omni](https://github.com/Phantivia/llama.cpp-omni) 的 `tts-*` release
  (上游 `tc-mb/llama.cpp-omni` 不发这几个可执行文件),Windows CUDA 版另取 ggml-org 的
  cudart 包。自己编的构建填进「TTS 运行时目录」就不再下载。
- **权重**下到 `<模型根>/vtuber/`:VoxCPM2 的两个 GGUF 走 HuggingFace 钉住的 revision,
  对齐器的两个随运行时 release 发布。来源与许可见
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- **参考音频**属于部署私有资产,放「声线库目录」,留空时落在权重目录旁边。

真机跑一遍全流程:

```bash
tsx scripts/check-tts-runtime.ts
```

它会装运行时、下权重、起 server,然后打 `/health`、流式合成、对齐各一次。联网,要显卡,
默认装在 `scratch/tts-runtime-check/` 下,不碰真部署。

对齐器缺席时 TTS 照常,只是没有逐字时间点,字幕与锚点回落按字符比例估计。

## 第三方资产

**Live2D 模型、TTS 声学/对齐模型权重、参考声线音频一律不入库。**

`src/models/examples/cortico.profile.json` 是一份写完的接线档案(适配 Type-H1),当读物用;
它**不会被加载**,见 [`src/models/examples/README.md`](src/models/examples/README.md)。
Type-H1 的许可 §4.5 禁止 AI 用途,模型文件本身从不出现在这个仓库里。

## 发布到 npm

`main` 现在指向 `./src/index.ts`:框架进程跑在 tsx 下,TS 入口可直接 import,开发期
省一次构建。真要发到 npm 时把它改成 JS 产物(并把 `src` 换成 `dist` 进 `files`),
否则装到没有 tsx 的宿主上会起不来。

## 许可

AGPL-3.0-or-later,见 [LICENSE](LICENSE)。框架 Cortico 是 MIT,两者经 HTTP 与扩展契约相连,
许可各归各。想提 PR 见 [CONTRIBUTING.md](CONTRIBUTING.md)。
