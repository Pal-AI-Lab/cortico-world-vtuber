# cortico-world-vtuber

[Cortico](https://github.com/Phantivia/Cortico) 的 VTuber 演出 World,以独立 npm 包发布。

模组把一段台本变成**连续演出**:文本经流式 TTS 出声,同一段文本解析出的动作记号驱动
Live2D 模型(经 VTube Studio 的 Public API 注入参数),字幕按强制对齐器给出的时间点
跟着念,OBS 里的 overlay 画面由模组自带的演出流服务直接推。控制台里它有八个面板:
挂载、模型档案、Overlay、动作调参、声线档案、时间点标注、演出日志、演出诊断。

模组内部的分层、演出包格式、台本记号与 Live2D 适配写在 [`src/README.md`](src/README.md)、
[`src/vtuber_performance_module_design.md`](src/vtuber_performance_module_design.md) 与
[`src/models/LIVE2D-ADAPTATION.md`](src/models/LIVE2D-ADAPTATION.md)。

## 与 Cortico 的关系

这是一个**插件包**,不是 Cortico 的一部分。它按 Cortico 的插件契约声明自己:

```jsonc
"cortico": { "kind": "world", "api": 1, "consoleClient": "dist/console.js", "consoleStyle": "dist/console.css" }
```

运行时它以 `cortico/<框架 src 下的路径>` import 框架(`cortico/worlds.ts`、
`cortico/core/types.ts` …)。这些 specifier 由框架 `src/plugins/runtime.ts` 注册的模块
钩子解析到框架源码本身,**同一份实例**——插件与框架共用一个 `WorldAssembly`、一套
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

- 控制台「插件」页手动安装,填本目录的绝对路径;
- 或在 `<Cortico>/plugins/` 下 `corepack pnpm add --ignore-workspace <本目录绝对路径>`。

**装完要整进程重启 Cortico**:模组定义在装配表里,热激活开关管不到插件的装载。

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

`src/voxcpm2-server/` 是 TTS 服务端的启动脚本与说明;二进制与模型权重都在它自己的
`.gitignore` 里,不入库。

## 第三方资产

**Live2D 模型、TTS 声学/对齐模型权重、参考声线音频一律不入库。**

`src/models/examples/cortico.profile.json` 是一份写完的接线档案(适配 Type-H1),当读物用;
它**不会被加载**,见 [`src/models/examples/README.md`](src/models/examples/README.md)。
Type-H1 的许可 §4.5 禁止 AI 用途,模型文件本身从不出现在这个仓库里。

## 发布到 npm

`main` 现在指向 `./src/index.ts`:框架进程跑在 tsx 下,TS 入口可直接 import,开发期
省一次构建。真要发到 npm 时把它改成 JS 产物(并把 `src` 换成 `dist` 进 `files`),
否则装到没有 tsx 的宿主上会起不来。
