# 第三方声明

这个包自己不带二进制,也不带模型权重。下面是它在运行时会去取、或者要求操作者自己装好的东西,
以及各自的许可。

## TTS 运行时

`llama-tts-server`(VoxCPM2 推理 + Qwen3-ForcedAligner 对齐)与配套的 `voxcpm2-cli`、
`llama-aligner-cli`。

- 上游:[tc-mb/llama.cpp-omni](https://github.com/tc-mb/llama.cpp-omni),MIT
- 二进制来源:[Phantivia/llama.cpp-omni](https://github.com/Phantivia/llama.cpp-omni) 的
  `tts-*` release。上游不发这几个可执行文件,由项目自己构建发布;分支 `feat/forced-aligner`
  在上游主干之上只加对齐器,可复现。
- 许可:MIT,Copyright (c) 2023-2026 The ggml authors
- 装在 `<运行时根>/llama.cpp-omni/<release>/<平台后端>/`,目录里的 `cortico-runtime.json`
  记着它是从哪个 release 装的

### CUDA 运行库

Windows 的 CUDA 版另取 [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) 发布的
`cudart-llama-bin-win-cuda-*.zip`(NVIDIA 的运行库,随 CUDA Toolkit 的许可)。
本项目不重新分发这些 DLL,也不修改本机的驱动或运行库。

## 模型权重

都不在版本库里,放在 `<模型根>/vtuber/`。VoxCPM2 的两个由面板按固定来源下载;
对齐器的两个**本项目不转发**,由操作者自己从 Qwen 的原始权重转换。

| 文件 | 来源 | 许可 |
|---|---|---|
| `VoxCPM2-BaseLM-F16.gguf`<br>`VoxCPM2-Acoustic-F16.gguf` | [DennisHuang648/VoxCPM2-GGUF](https://huggingface.co/DennisHuang648/VoxCPM2-GGUF) @ `169f64d`,由 [openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) 转换 | 见上游模型卡 |
| `Qwen3-Aligner-LM-F16.gguf`<br>`Qwen3-Aligner-Audio-F16.gguf` | [Qwen/Qwen3-ForcedAligner-0.6B-hf](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf),操作者自己用 `scripts/aligner-gguf.ts` 转换,不随 release 分发 | Apache-2.0 |

## 其他运行时依赖

- **VTube Studio**:皮套由操作者自己安装与授权,World 只经它的 WebSocket API 注入参数,
  不读写 Live2D 文件
- **Live2D 模型**:操作者自备。多数模型的许可(例如 Type-H1)对 AI 用途另有限制,自己核对
- **参考音频**:操作者自备,属于部署私有资产
- **ffmpeg**:声线导入时用来转码,只从 PATH 找,不随包分发

## 本包的许可

AGPL-3.0-or-later,见 `LICENSE`。框架 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 是 MIT,
两者经 HTTP 与扩展契约相连,许可各归各。
