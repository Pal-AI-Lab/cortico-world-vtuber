# Live2D 模型适配指南

把一个 VTube Studio(VTS)里能加载的 Live2D 模型接到 cortico-world-vtuber 的演出层。产物只有一份
`cortico.profile.json`,放在模型自己的目录里;代码库不改一个字。整个过程可以由编码 AI
按本文逐步完成,每一步的输入都是模型目录里的文件,输出都是 JSON 字段。

## 0. 先读什么

| 文件 | 读它的目的 |
|---|---|
| [`../examples/vtuber-pack/params.json`](../examples/vtuber-pack/params.json) | 演出层会写的语义参数、单位、量程、缺了会失去什么。档案的 `wiring` / `unsupported` 用这些名字;写了演出包里没有的名字只是警告,那条用不上。 |
| [`../examples/vtuber-pack/vocab.json`](../examples/vtuber-pack/vocab.json) | 演出标签 → 通道 → clip。`fx` 通道词条的 clipId 就是档案 `fx` 表必须逐一填写的键。 |
| [`../examples/vtuber-pack/clips.json`](../examples/vtuber-pack/clips.json) | 每个标签实际驱动哪些参数、到多大。用它判断模型的输入区间够不够(§2.2 的取值范围表就是从它统计的)。 |
| [`schema.ts`](schema.ts) | 档案每个字段的合法性规则。加载失败的报错信息就来自这里。 |
| [`vtube-check.ts`](vtube-check.ts) | bot 连接时对档案与模型文件做的只读复检。写完档案后控制台看到的警告就是它报的。 |
| [`selfcheck.ts`](selfcheck.ts) | 接线自检:真机逐参数注入并读回斜率。用来核对 §2.2 算出的数字。 |
| 模型目录里的 `<模型>.vtube.json` | VTS 保存的模型设置。`ParameterSettings` 是输入→Live2D 参数的映射表,档案的换算全从它推出;`Name` 是 VTS 报回的模型名。 |
| 模型目录里的 `<模型>.cdi3.json` | Live2D 参数的显示名。判断一个表情文件是"弹出图标"还是"换装"时用。 |
| [`examples/cortico.profile.json`](examples/cortico.profile.json) | 一份写完的真档案(适配 Type-H1),当读物。照着字段表猜不如看一眼成品;它不会被加载,见 [examples/README.md](examples/README.md)。 |

表里的 vocab.json 与 clips.json 是范例演出包。bot 可以带自己的包(bot 包目录下的 `vtuber-pack/`,
或 World 选项 `packDir` 指到别处),那时读 bot 的那一份:fx 键与取值范围都以它为准。

## 1. 目录约定

`worlds.vtuber.live2dDir` 指向 VTS 的模型目录 `…/VTube Studio_Data/StreamingAssets/Live2DModels`。
bot 在它的每个子目录里找 `cortico.profile.json`;找到几份就有几个可选档案。

适配不改原模型目录。把整个模型目录复制一份,目录名加 `-Cortico` 后缀,所有改动都做在副本上:

```
Live2DModels/
  Foo/                     ← 原版,不动
  Foo-Cortico/             ← 副本
    Foo.vtube.json         ← Name 改成 "Foo (Cortico)",ModelID 换新
    cortico.profile.json   ← 本文的产物
    NOTES.md               ← 改了什么、为什么(给下一个人看)
    Expressions/ …
```

VTS 里加载副本。原版与副本同时存在于 VTS 的模型列表里,直播时选副本。

## 2. 步骤

### 2.1 复制并改名

1. 复制 `Foo/` 为 `Foo-Cortico/`。
2. 打开 `Foo-Cortico/Foo.vtube.json`:
   - `Name` 改为 `Foo (Cortico)`。这就是档案里的 `vtsModelName`,也是 VTS `CurrentModelRequest` 报回的名字。
   - `ModelID` 换成一个新的 32 位十六进制串(任意随机即可),避免与原版撞号。
3. 改 `.vtube.json` 时 VTS 不能正显示这个模型,否则 VTS 保存时会把改动覆盖回去。关掉 VTS 或先切到别的模型。

### 2.2 从 `ParameterSettings` 推 `wiring`

`ParameterSettings` 里每一条形如:

```json
{ "Input": "EyeOpenLeft", "InputRangeLower": 0.2, "InputRangeUpper": 1,
  "OutputRangeLower": 0, "OutputRangeUpper": 1.5, "OutputLive2D": "ParamEyeLOpen",
  "ClampInput": false, "Smoothing": 50 }
```

对演出包 `params.json` 里的每个参数 `P`,找 `Input === P` 的条目(一个输入可能接多个输出,取输出名最"正"的那条:
`ParamAngleX`、`ParamEyeLOpen`、`ParamMouthForm`、`ParamBrowLY` 这类)。先算两个数:

```
gain   = (OutputRangeUpper − OutputRangeLower) / (InputRangeUpper − InputRangeLower)
atZero = OutputRangeLower − InputRangeLower × gain      // 输入 0 时的输出
```

再按参数类型填档案(结果保留 4 位小数):

| 参数 | 语义量 | 档案字段 |
|---|---|---|
| `FaceAngleX/Y/Z` | 度 | `scale = 1/gain`;gain 为 1 时整条省略 |
| `MouthOpen`、`CheekPuff` | [0,1] | `scale = 1/gain`,`neutral = −atZero/gain`;都是 1 和 0 时整条省略 |
| `MouthSmile`、`BrowLeftY`、`BrowRightY` | [-1,1],中性 0 = Live2D 输出 0 | `neutral = −atZero/gain`,`scale = 1/gain`,`clamp = [InputRangeLower, InputRangeUpper]` |
| `EyeOpenLeft/Right` | [-1,1],0 = Live2D 输出 1(正常睁眼),−1 = 输出 0(全闭) | `neutral = (1 − atZero)/gain`,`scale = 1/gain`,`clamp = [InputRangeLower, InputRangeUpper]` |
| `EyeRightX/Y`、`EyeLeftX/Y` | [-1,1] | 输出区间上下颠倒(`OutputRangeLower > OutputRangeUpper`)时 `invert: true`;否则省略 |

三条特殊情况:

- **合并输入。** 模型没有 `BrowLeftY` 条目,却有一条 `Input: "Brows"` 同时接 `ParamBrowLY` 与 `ParamBrowRY`:
  两侧眉毛都写 `aliasTo: ["Brows"]`,数值按那条算。
- **没有条目。** 包里的参数在 `ParameterSettings` 里找不到任何条目,也没有可 alias 的输入:写进 `unsupported`。
  演出层会照样发这个词,注入端丢弃并提醒一次;不要为此改词表或曲线。
- **`ClampInput: false`。** VTS 会线性外推到 Live2D 参数自身上限,纸面区间算不准饱和点。
  仍按上表算,`clamp` 照填输入区间;真机自检(§3)的斜率不符时再调。

模型能收到多大的语义量,以演出包 `clips.json` 统计为准(演出曲线的极值;下表按范例包):

| 参数 | 最小 | 最大 |
|---|---|---|
| FaceAngleX | −26 | 20 |
| FaceAngleY | −28 | 19 |
| FaceAngleZ | −10 | 23 |
| MouthOpen | 0 | 0.55(口型另由 TTS 驱动到 1) |
| MouthSmile | −0.55 | 0.9 |
| EyeOpenLeft/Right | −1 | 0.95 |
| EyeLeftX/RightX | −0.65 | 0.65(注视另加) |
| EyeLeftY/RightY | −0.12 | 0.95 |
| BrowLeftY/RightY | −0.55 | 0.62 |
| CheekPuff | 0 | 0.95 |

例:点头(`nod`)在 1.4s 内把 `FaceAngleY` 压到 −26° 再回 0,同时 `MouthSmile` +0.45、双眉 +0.2;
微笑(`smile`)把 `MouthSmile` 保持在 0.6、双眉 0.12,直到换表情或超时回落。
换算正确的判据:头部一律按度数发,眼睑偏移 0 时模型正常睁眼、−1 时全闭,嘴角偏移 0 时嘴形中性。

### 2.3 `idleBlinks`

看 `FileReferences.IdleAnimation` 指向的 `.motion3.json`(在模型目录里按文件名找,可能在子目录),
其 `Curves[].Id` 里有没有 `ParamEyeLOpen` / `ParamEyeROpen`:

- 有 → `idleBlinks: true`,空闲期眨眼归 idle 动画。
- 没有,或模型没有 idle 动画 → `idleBlinks: false`,L3 在空闲期写中性眼睑并自己排眨眼。

### 2.4 `fx`

`fx` 表的键是演出包 `vocab.json` 里 `fx` 通道的 clipId(范例包是下面这十个),值是 `{ "file", "durationMs" }`。模型没有的特效可以写 `null` 或直接不写,两者等价;写了包里没有的键只是警告。

| clipId | 语义 |
|---|---|
| fx_surprise | 惊讶(瞪圆眼 / 惊叹号) |
| fx_sweat | 流汗 |
| fx_idea | 灯泡 |
| fx_question | 问号 |
| fx_star | 星星 |
| fx_loading | 加载中 |
| fx_blush | 脸红 |
| fx_anger | 怒气 |
| fx_sigh | 叹气 |
| fx_glasses | 眼镜 |

候选是 `Expressions/*.exp3.json`。判断一个文件是不是"弹出图标":打开它,看 `Parameters[].Id`,
再到 `.cdi3.json` 的 `Parameters` 里查这些 Id 的 `Name`。名字像「星星」「汗」「灯泡」「!」「?」的,
且值是把某个显示开关从 0 拨到 1 的,就是弹出图标;改发色、换装、换瞳孔的是装扮,不能当 FX。
`file` 只写文件名(不带 `Expressions/`)。`durationMs` 是弹出到收回的毫秒数,1600–3000 之间按观感取。
模型没有对应图标就不写。捏人类模型经常一个都没有,`fx` 是空对象,这是正常结果。

### 2.5 `keepExpressions`

`.vtube.json` 的 `SavedActiveExpressions` 列出 VTS 保存时激活着的表情;其中属于装扮(发色、服装、
配件)的文件名写进 `keepExpressions`。bot 连接时会关掉所有激活表情(清掉上一场残留的图标),
这份名单里的除外。

### 2.6 模型侧必须改的两行

`EyeOpenLeft` 与 `EyeOpenRight` 两条的 `Smoothing` 必须是 `0`。眨眼 233ms,平滑 50 时到点只闭到 0.16,
"眨单眼"永远闭不上。VTS API 读不到也写不到这一项,只能改 `.vtube.json`(遵守 §2.1 第 3 条)。
`MouthOpen` 的 `Smoothing` 建议 0(口型跟播)。头部三轴的平滑可以保留,曲线本就是按带平滑的模型手调的。

### 2.7 写档案

`Foo-Cortico/cortico.profile.json`,顶层字段一个不能少(`caveat` 可省;`fx` 与 `wiring` 可以是空对象):

```json
{
  "id": "VTS-Foo",
  "label": "Foo (Cortico)",
  "backend": "vts",
  "vtsModelName": "Foo (Cortico)",
  "wiring": {
    "FaceAngleX": { "scale": 0.6 },
    "MouthSmile": { "neutral": 0.55, "scale": 0.35, "clamp": [0.2, 0.9] },
    "EyeOpenLeft": { "neutral": 0.7333, "scale": 0.5333, "clamp": [0.2, 1] },
    "EyeOpenRight": { "neutral": 0.7333, "scale": 0.5333, "clamp": [0.2, 1] },
    "EyeLeftX": { "invert": true },
    "EyeRightX": { "invert": true },
    "BrowLeftY": { "aliasTo": ["Brows"], "neutral": 0.875, "scale": 0.125, "clamp": [0.75, 1] },
    "BrowRightY": { "aliasTo": ["Brows"], "neutral": 0.875, "scale": 0.125, "clamp": [0.75, 1] }
  },
  "unsupported": ["CheekPuff"],
  "fx": {
    "fx_surprise": { "file": "EyeOO.exp3.json", "durationMs": 2000 },
    "fx_idea": { "file": "Idea.exp3.json", "durationMs": 2400 },
    "fx_star": { "file": "Star.exp3.json", "durationMs": 1600 }
  },
  "keepExpressions": ["Outfit.exp3.json"],
  "idleBlinks": false,
  "caveat": "左右眉共用一路输入,单侧挑眉会变成双眉同抬;没有腮帮参数。"
}
```

上面的数字来自一个真实的捏人模型:`EyeOpenLeft` 是 in[0.2,1] → out[0,1.5],于是 gain 1.875、
atZero −0.375、neutral (1+0.375)/1.875 = 0.7333、scale 1/1.875 = 0.5333;`Brows` 是 in[0.75,1] → out[−1,1],
gain 8、atZero −7、neutral 7/8 = 0.875、scale 0.125。

`id` 是配置值,建议 `VTS-<模型名>`;不能是 `auto` 或 `VTS-Default`。`caveat` 一句话写这个模型演不出什么,
控制台会显示。

### 2.8 接上 bot

`config.json` 的 `worlds.vtuber`:

```json
"live2dDir": "L:\\…\\VTube Studio_Data\\StreamingAssets\\Live2DModels",
"modelProfile": "VTS-Foo"
```

`modelProfile` 写档案 id 而不是 `auto`:目录里没有这份档案时 bot 会明确报「配置指定的档案不存在」,
而不是静默退到默认档案。

## 3. 验证

1. VTS 加载 `Foo (Cortico)`。启动 bot(或 `dev-console` 之外的任何会连 VTS 的方式),打开控制台 →
   VTuber → 「模型档案」。
2. 头部一行应显示 `Foo (Cortico)` 与「配置指定」。显示「配置指定的档案不存在」说明 `live2dDir` 或 `id` 写错;
   显示「未识别 · 默认档案」说明 `vtsModelName` 与 `.vtube.json` 的 `Name` 不一致。
3. 「档案复检」一栏应全绿。它逐条对:模型名、`fx`/`keepExpressions` 里的文件是否存在、idle 动画是否驱动眼睑
   与 `idleBlinks` 一致、眼睑与口型的 `Smoothing`。每条警告都指明改哪个字段或哪一行。
4. 点「接线自检」(约一分钟,VTS 空闲时做)。表里每个参数的斜率应等于 §2.2 算出的 `gain`,断开的参数应
   恰好是 `unsupported` 加上 alias 前的名字。斜率对不上的,按实测值重算 `scale`。
5. 「动作调参」面板里逐个点动作、表情、注视、特效看效果。特效落空的会回「当前档案没有」,
   与 `fx` 里的 `null` 一一对应。
6. 日志里搜 `已跳过`:除了 `unsupported` 与 `null` 的 FX,不该有别的丢弃。

## 4. 症状表

| 看到 | 原因 | 改 |
|---|---|---|
| 眼睛永远半睁 / 眯着 | `EyeOpen*` 的 `neutral` 错(按别的模型的值填了) | 按 §2.2 从本模型的 `ParameterSettings` 重算 |
| 眨单眼闭不上 | `EyeOpen*` 的 `Smoothing` 不是 0 | §2.6 |
| 头一动就转过头 / 幅度太小 | `FaceAngle*` 的 `scale` 错 | `scale = 1/gain` |
| 眉毛不动,日志也不报 | 模型用合并输入(如 `Brows`),档案没写 `aliasTo` | §2.2 合并输入 |
| 表情结束时嘴角猛弹一下 | `MouthSmile` 的 `neutral` 没填(按 0 发到了中性在 0.5 的映射上) | §2.2 |
| 日志刷 `APIError 453` | 档案里的输入名 VTS 不认识 | `aliasTo` 里的名字必须出现在 `ParameterSettings.Input` |
| 日志刷 `651` / 表情文件找不到 | `fx` 里的文件名不在 `Expressions/` | 复检栏会列出,改文件名 |
| 空闲时眼睛不眨 | `idleBlinks: true` 但 idle 动画不驱动眼睑 | §2.3 |
| 空闲时眨眼像抽搐(双重眨眼) | `idleBlinks: false` 但 idle 动画自己也眨 | §2.3 |
| 头转一边、眼睛看另一边 | `EyeRightX` 没 `invert` | §2.2 最后一行 |

## 5. 不做的事

- 不为某个模型改演出包。词表与曲线是人格的表达空间,对所有模型相同;模型演不出的
  由 `unsupported` / `null` 声明,注入端丢弃并计数。
- 不把档案或模型文件放进代码库。档案与模型同目录、同进退。
- 不在原版模型目录上改任何文件。
