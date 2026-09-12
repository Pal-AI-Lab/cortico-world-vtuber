# VoxCPM2 最小可用 server 包

随包运行时目录：编译好的 `llama-tts-server` / `voxcpm2-cli`（CUDA 构建）。GGUF
权重和声线库可放在仓库外，由 `worlds.vtuber` 的路径配置接入。

## 布局

```text
voxcpm2-server/
  bin/                  llama-tts-server.exe, voxcpm2-cli.exe, ggml/llama *.dll
  models/               未配置外置路径时的兼容目录
  voices/               未配置外置声线库时的兼容目录
  outputs/              冒烟 wav / 日志
  start.ps1             前台启动 OpenAI 兼容服务（默认 :8001）
  smoke.ps1             拉起 → /health → /v1/audio/speech → 退出
  README.md
```

`bin/` 不进源码历史，但由发行包白名单叠加；`models/`、`voices/`、`outputs/` 均不随包。
日常启停走控制台的「TTS server」
面板；本目录脚本用于脱离控制台的冒烟与独立调试。
固定 revision 见下面的「来源」；随包二进制的许可与归档义务见根目录
[`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md)。

来源：

- 二进制：`Desktop/llama.cpp-omni/build-win-cuda/bin`（`llama-tts-server.exe` 依赖
  `mtmd.dll`，对齐器的音频塔走 mtmd 的 qwen3a 通路）
- TTS 权重：[`DennisHuang648/VoxCPM2-GGUF`](https://huggingface.co/DennisHuang648/VoxCPM2-GGUF/tree/169f64d8b98bbaab1761e4ca3a83e6af653456cc)
  revision `169f64d8b98bbaab1761e4ca3a83e6af653456cc`
- 对齐权重：[`Qwen/Qwen3-ForcedAligner-0.6B-hf`](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf/tree/c07281df297b9905d24a508279258cccf987a064)
  revision `c07281df297b9905d24a508279258cccf987a064` 的 safetensors，经
  `scripts/aligner-gguf.ts` 转成两个 GGUF

## 依赖

- Windows + NVIDIA 驱动
- `bin/` 当前包含 CUDA 13 `cublas` DLL，并从系统 CUDA 路径补齐其余依赖；发行包必须
  按实际 DLL 来源附 NVIDIA 许可与 notice
- ffmpeg（可选）：只在控制台导入非 wav 的参考音频时用到。放进 `bin/` 或加进 PATH 均可

## 启动

```powershell
cd src/voxcpm2-server
powershell -File .\start.ps1
# → http://127.0.0.1:8001
```

外置模型目录或逐文件路径：

```powershell
powershell -File .\start.ps1 `
  -ModelsDir "C:\path\to\Cortico-Resources\models\vtuber-tts"

powershell -File .\start.ps1 `
  -BaseLmFile "D:\models\VoxCPM2-BaseLM-Q8_0.gguf" `
  -AcousticFile "D:\models\VoxCPM2-Acoustic-F16.gguf"
```

`smoke.ps1` 接受相同的 `ModelsDir`、`BaseLmFile`、`AcousticFile`、
`AlignerLmFile` 与 `AlignerAudioFile` 参数。参数全留空时仍使用本目录的 `models/`。

健康检查：`GET http://127.0.0.1:8001/health`

合成示例：

```powershell
curl.exe -X POST http://127.0.0.1:8001/v1/audio/speech `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"voxcpm2\",\"input\":\"你好\",\"voice\":\"default\",\"response_format\":\"wav\"}" `
  --output out.wav
```

## 流式合成

`POST /v1/audio/speech/stream`(请求体同上,含 `reference_audio`/`prompt_text` 的克隆
与续写都支持)返回 chunked wav:44 字节头(长度字段是占位值)后跟边合成边推的 PCM16
分块(每块约 160ms,一个 patch)。TTFA 实测 0.8-1.1s,RTF≈0.55(整段约 0.4)。

实现要点(`tools/omni/voxcpm2/voxcpm2_runtime.cpp`):

- `generate_with_clone_streaming` / `generate_with_continuation_streaming`:prefill 与
  整段克隆完全一致,解码接 `decode_streaming_from_ready_state`;
- 流式 AudioVAE 解码按滑窗只解最近 4 个 patch(`streaming_prefix_len`,同 Python 默认)、
  只吐最新一块,前面的 patch 当 VAE 上下文——全池重解是 O(n²),实测把 RTF 推过 1;
- 分块回调返回 `false` 表示消费方取消(HTTP 客户端断开):解码环停在当前步,
  不算错误,下一次 prefill 重置全部状态。打断演出时靠它立即释放 GPU;
- server 侧生成上锁(runtime 是有状态单例,并发生成会互相踩),对齐器自带锁**不经**
  生成锁:流式合成进行中照常受理 `/v1/audio/align`(io-vtuber 的前缀对齐靠这一点)。

`GET /health` 回 `{"streaming": true, "aligner": <bool>, ...}`,io-vtuber 用 `streaming`
标志做能力探测,老 server 自动回落整段合成。

CLI 冒烟:`voxcpm2-cli --stream`(可配 `-r`/`--prompt-wav --prompt-text`)走同一套
流式解码,输出仍拼成完整 wav 落盘。

## 冒烟

```powershell
powershell -File .\smoke.ps1
# 默认用 :8011，避免撞上已在跑的 :8001
```

成功会在 `outputs/smoke.wav` 写出非空 wav。


## 对齐模型（选配）

`llama-tts-server` 除了 TTS，还能加载 Qwen3-ForcedAligner 做逐单元时间标注。两个 GGUF
可在控制台分别选择；路径都留空时按 `models/` 中的旧文件名查找。旧目录缺任一个时只启动
TTS；任一路径显式配置后，两项都必须存在，否则启动状态直接报告缺失路径。

权重不入库，从上面固定 revision 的官方 safetensors 转换（约 1.84 GB 下载，转出
610 MB + 630 MB）。上游没有运行所需的派生 GGUF 直链：

```powershell
# 先把 Qwen/Qwen3-ForcedAligner-0.6B-hf 的 config.json / tokenizer.json /
# model.safetensors 放进 ../Cortico-Resources/models/vtuber-tts/aligner/
npx tsx scripts/aligner-gguf.ts
```

转换脚本只用 Node，不需要 Python 或 torch。产出：

| 文件 | 内容 |
|------|------|
| `Qwen3-Aligner-LM-Q8_0.gguf` | Qwen3 0.6B 主干（llama.cpp `qwen3` 架构）+ 词表 |
| `Qwen3-Aligner-Audio-F16.gguf` | 音频塔（mtmd `qwen3a`）+ 多模态投影 + 5000 类时间桶头 |

主干权重矩阵使用 Q8_0，归一化层保留 F32，显存约为 F16 方案的一半。分类输出的时间桶宽
为几十毫秒。音频塔与多模态投影使用 F16，时间桶头使用 F32。

时间桶头（`score.weight`）与音频 GGUF 同存。主干加载器拒绝额外张量；音频加载器允许未知
张量，对齐器按名称读取该张量。原始权重不含音频塔位置编码，转换器按 Whisper 正弦公式生成。

手动启动时加：

```powershell
--aligner-lm ..\models\Qwen3-Aligner-LM-Q8_0.gguf `
--aligner-audio ..\models\Qwen3-Aligner-Audio-F16.gguf
```

标注示例：

```powershell
curl.exe -X POST http://127.0.0.1:8001/v1/audio/align `
  -H "Content-Type: application/json" `
  -d "{\"audio\":\"<base64 wav>\",\"units\":[\"你\",\"好\"]}"
```

回 `{sample_rate, duration, units:[{text,start,end}]}`，时间单位是秒。单元怎么切由调用方
决定（见 io-vtuber 的 README），server 原样收下。

不经 HTTP 的冒烟：

```powershell
cd bin
.\llama-aligner-cli.exe --lm ..\models\Qwen3-Aligner-LM-Q8_0.gguf `
  --audio-model ..\models\Qwen3-Aligner-Audio-F16.gguf `
  --audio ..\outputs\smoke.wav --units "你|好" -ngl 99
```

非 ASCII 单元用 `--units-file`（UTF-8）：Windows 的 `char argv` 走 ANSI 代码页，中文
直接写在命令行上会被改写。

## CLI（不经 HTTP）

```powershell
cd bin
.\voxcpm2-cli.exe -t "Hello" -o ..\outputs\cli.wav `
  ..\models\VoxCPM2-BaseLM-Q8_0.gguf `
  ..\models\VoxCPM2-Acoustic-F16.gguf
```
