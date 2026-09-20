import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
/**
 * VtuberWorld — 直播演出 World。
 *
 * 分层(设计 vtuber_performance_module_design.md):
 * - L1 暴露台本演出与打断工具;
 * - outputTap 流式捕获工具参数,识别到调用头即逐字符送 L2,不等调用完成;
 *   若 assistant content 误写【】演出标签,urgent 投递提醒改走 vtuber_act;
 * - L2 Performer 编排 beat/TTS/cue,L3 Mixer 逐帧求值,L4 注入 VTS;
 * - 语音经 DeviceAudioSink 直接写本机声卡;对外只有演出流(SSE 出)与
 *   弹幕输入(WS 进)两个自有接口,见 perform-stream.ts。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConfigGroup,
  EventStoreReader,
  World,
  WorldHost,
  Logger,
  WorldConsoleDecl,
  WorldPanelDecl,
  OutputTap,
  ToolDef,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { FFMPEG_EXE, findFfmpeg, formatLabel, sniffAudioFormat, transcodeToWav } from './audio-convert.ts';
import { Mixer } from './mixer.ts';
import { VtsBackend } from './backend.ts';
import {
  checkModelFile,
  loadProfiles,
  profileChoices,
  resolveProfile,
  type ModelFileCheck,
  type ProfileRegistry,
  type ProfileResolution,
} from './models/index.ts';
import { formatWiringReport, runWiringSelfCheck, type WiringReport } from './models/selfcheck.ts';
import { JsonScriptStream, stripUnknownTags } from './parser.ts';
import {
  BUDGET_MS_PER_UNIT,
  PAUSE_PRIORS,
  Performer,
  SPEECH_LEAD_IN_MS,
  type RoundOutcome,
  type SpeechRateHint,
} from './orchestrator.ts';
import { PerfDiagnostics, type TraceOptions } from './diagnostics.ts';
import { PerformStream } from './perform-stream.ts';
import { describeSilence, silenceData } from './silence-scan.ts';
import { DEFAULT_TIMEOUT_RANGE_MS, type StateChannel } from './states.ts';
import { computeSubtitleCues } from './subtitle-cues.ts';
import { DeviceAudioSink } from './device-audio.ts';
import { AlignerClient, countPauses, segmentUnits, type AlignedUnit, type AlignResult } from './align.ts';
import {
  decodeWav,
  pcm16ToWav,
  StreamingEnvelope,
  TtsClient,
  type TtsPiece,
  type TtsStreamSink,
  type TtsSynthProfile,
} from './tts.ts';
import { TtsServerManager, type TtsServerState } from './tts-server.ts';
import { modelsRoot, runtimesRoot } from 'cortico/paths.ts';
import { ModelStore, type ModelId, type ModelState } from './runtime/models.ts';
import { PINNED_RELEASE, defaultBackend, planFor, type Backend, type ReleasePlan } from './runtime/release.ts';
import { RuntimeStore, type InstallState } from './runtime/store.ts';
import { VtsClient } from './vts-client.ts';
import { EXAMPLE_PACK_DIR, loadPack, vocabTableRows, type PerformancePack } from './pack.ts';
import { resolveVoiceTag } from './voice-tags.ts';
import {
  netUnitMsQuantile,
  SpeechRateLog,
  SPEECH_RATE_WINDOW,
  type SpeechRateSample,
} from './speech-rate-log.ts';
import {
  ExternalActScriptStreamNormalizer,
  invalidActScriptShapeReceipt,
  normalizeExternalActScript,
  type ExternalActScriptResult,
} from './act-script.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 权重目录:`<模型根>/vtuber/`,与 docs/runtimes.md 的约定一致(owner 用 World id) */
const TTS_MODELS_DIR = join(modelsRoot(), 'vtuber');


/** overlay 字幕样式;控制台面板改,经装配层回写 config.json,SSE 热推给所有 overlay 页 */
export interface OverlaySubtitleStyle {
  /** 字号倍率(0.5–2.5) */
  scale: number;
  /** 字重(100–900) */
  weight: number;
  /** 最大行数(1–8);超行先缩字号再生长 */
  maxLines: number;
  color: string;
  strokeColor: string;
  /** 描边宽(px,0–4) */
  strokeW: number;
  /** 底板不透明度(0–0.85) */
  plate: number;
  /** CSS font-family;'' = overlay 页默认。OBS 机器上已安装的字体按名字写 */
  fontFamily: string;
}

/** overlay 画面配置:图层开关 + 字幕样式。URL 参数可按订阅方覆盖图层开关。 */
export interface OverlayConfig {
  subtitles: boolean;
  /** 动作标签气泡(排练観察用;正式合成可关或用 ?cues=0 的链接) */
  cues: boolean;
  danmaku: boolean;
  subtitle: OverlaySubtitleStyle;
}

export const OVERLAY_CONFIG_DEFAULTS: OverlayConfig = {
  subtitles: true,
  cues: true,
  danmaku: true,
  subtitle: {
    scale: 1,
    weight: 400,
    maxLines: 2,
    color: '#fffef8',
    strokeColor: '#000000',
    strokeW: 1,
    plate: 0,
    fontFamily: '',
  },
};

export const VTUBER_DEFAULTS = {
  // enabled 由Persona的装配层显式开启。
  enabled: false,
  vtsWsUrl: 'ws://127.0.0.1:8001',
  /** 演出流服务(SSE /stream + WS /danmaku)的偏好端口;被占顺延 */
  streamPort: 7792,
  /** VoxCPM2 server;VTS 占 8001,TTS 用 8010 */
  ttsUrl: 'http://127.0.0.1:8010',
  /** 自备运行时目录;空 = 走面板的托管下载 */
  ttsRuntimeDir: '',
  /** 运行时版本;空 = 包里钉住的那个 */
  ttsRuntimeRelease: '',
  /** 自定的权重与资产路径;空 = 权重目录下的固定文件名。 */
  ttsBaseLmFile: '',
  ttsAcousticFile: '',
  ttsAlignerLmFile: '',
  ttsAlignerAudioFile: '',
  ttsVoicesDir: '',
  /** VTube Studio 已部署模型的记录位置； World 不直接加载 Live2D 文件。 */
  live2dDir: '',
  /** 演出包目录;空 = 随 World 的范例包。bot 的层 2 默认通常指向自己的 vtuber-pack/。 */
  packDir: '',
  /** 禁播词(| 分隔多条):台本流里出现的子串整段滤掉,不进 TTS、不上字幕 */
  mutedTexts: '',
  /** 主输出设备名子串(如 CABLE Input 走虚拟线进 OBS);'' = 系统默认,'none' = 不出声 */
  audioDevice: 'CABLE Input',
  /** 副输出开关;关则只走主设备 */
  audioMirrorSystem: true,
  /** 副输出设备;`default` = 当前系统默认 */
  audioSecondary: 'default',
  /**
   * 逐字对齐:每片过 Qwen3-ForcedAligner 拿逐单元时间点,<> 锚点按标注时刻
   * 触发,同时兼当 TTS 质量门。需要 TTS server 带 --aligner-lm/--aligner-audio
   * 起来;拿不到时锚点退化为字符比例估计,不拦演出。
   */
  alignEnabled: true,
  /**
   * 流式输出:合成边出边播(TTFA 从整段 3s+ 降到 1s 内)。需要 server 带
   * /v1/audio/speech/stream(health 报 streaming:true);不可用自动回落整段。
   */
  streamEnabled: true,
  /**
   * 语音积压上限(秒)。剩余时长超过该值时拒绝新的 vtuber_act;
   * 心跳演出状态行报告队列是否为空。
   */
  speechCapSec: 20,
  /**
   * 同一轮 LLM 回复里最多开的演出轮数(复读风暴保险)。同轮追加豁免积压闸,
   * 但按次数封顶;正常分段远用不满。取值依据见 maxActRounds() 上的注释。
   */
  maxActRoundsPerTurn: 8,
  /**
   * 静默提醒三级的触发秒数(都按总静默时长算)。见底后安静满一级秒数投第一级,
   * 仍不开口则在二级/三级秒数再各投一级,措辞逐级加强(模拟空窗压力累积);
   * 二三级设 0 或不大于前一级即停用。新台词入队后的下一次见底重新计时。
   */
  silenceRemindSec: 15,
  silenceRemind2Sec: 30,
  silenceRemind3Sec: 60,
  /** 各级措辞:留空用内置措辞池;多个变体用 | 分隔,{sec} 处代入静默秒数 */
  silenceLine1: '',
  silenceLine2: '',
  silenceLine3: '',
  /**
   * 播出延迟:OBS 对游戏画面设固定延迟 N 秒后,演出反应不得早于观众
   * 看到的画面。0=未标定不设地板。哪些 World 的画面被延迟见 delayedSources。
   */
  obsDelaySec: 0,
  /** 被 OBS 延迟的画面对应的 World id;地板只看这些来源的近期事件(信封 core 字段) */
  delayedSources: [] as string[],
  /**
    * 礼让收束的停顿搜索窗口(ms)。窗口内无单元间隙时立即淡出;0 始终立即淡出。
   */
  yieldWindowMs: 500,
  /** 礼让收束的回落淡出时长(ms;正常走音素感知切断,切不了才用它) */
  yieldFadeMs: 150,
  /** State 通道无新指令后滑回中性的随机区间(秒) */
  decayGazeSec: [4, 6] as [number, number],
  decayPoseSec: [10, 15] as [number, number],
  decayEmotionSec: [20, 30] as [number, number],
  /**
   * 模型档案(见 `models/`):'auto' = 按 VTS 报的模型名自动定档,
   * 否则是某个档案 id。档案里装的是这个模型的接线换算、演不出来的参数、
   * FX 表情文件名与复位保留名单。
   */
  modelProfile: 'auto',
  /** overlay 画面配置(图层开关 + 字幕样式);控制台面板热改 */
  overlay: OVERLAY_CONFIG_DEFAULTS,
} as const;

/**
 * 静默提醒按级别加强并在同级随机选取，包含实际安静秒数；第一级允许继续沉默。只陈述本地没有新语音入队的时长，不推断观众端播放、等待或直播状态。
 */
const SILENCE_LINES: ReadonlyArray<ReadonlyArray<(sec: number) => string>> = [
  [
    (sec) => `[演出] 已经安静 ${sec} 秒了。有话现在可以说;继续沉默也行。`,
    (sec) => `[演出] 安静了 ${sec} 秒。想说什么随时开口,不说也行。`,
  ],
  [
    (sec) => `[演出] 已经安静 ${sec} 秒了,这段时间没有新语音入队。要说就说,聊聊手头的事也行。`,
    (sec) => `[演出] 安静 ${sec} 秒了,本地一直没有新台词进来。说点什么吧,哪怕只是正在做什么。`,
  ],
  [
    (sec) => `[演出] 已经安静整整 ${sec} 秒,这段里一句台词都没入队。现在就开口:在干嘛、在想什么、接下来做什么,都行。`,
    (sec) => `[演出] 安静满 ${sec} 秒,本地 ${sec} 秒没有新语音入队。随便说点什么都比继续沉默强。`,
  ],
];

/**
 * 按级别选择静默提醒，越界使用最高级。custom 以 | 分隔变体，{sec} 代入秒数，空值使用内置池。
 * stalls 来自 WorldHost.llmStalls，大于零时注明这段安静包含模型调用阻塞，区分未发言与未获得发言机会。
 */
export function silenceReminder(tier: number, sec: number, custom?: string, stalls = 0): string {
  const why =
    stalls > 0
      ? `(这段里你卡住了 ${stalls} 次,那几次是没能说出去,不是你没说)`
      : '';
  const variants = (custom ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  if (variants.length > 0) {
    const line = variants[Math.floor(Math.random() * variants.length)].replaceAll('{sec}', String(sec));
    return (line.startsWith('[演出]') ? line : `[演出] ${line}`) + why;
  }
  const pool = SILENCE_LINES[Math.min(Math.max(tier, 0), SILENCE_LINES.length - 1)];
  return pool[Math.floor(Math.random() * pool.length)](sec) + why;
}

/** 持续状态的回落时间配置(秒);装配层从活配置读回 */
export interface VtuberDecaySec {
  gaze: [number, number];
  pose: [number, number];
  emotion: [number, number];
}

export const VTUBER_SECRET = 'VTS_AUTH_TOKEN';

/** VoxCPM2 声线档案:参考音频 + 生成参数。控制台改,经装配层回写 config.json。 */
export interface TtsProfile {
  /** voices/ 下的 wav 文件名;null = 不带参考音频 */
  refAudio: string | null;
  /** 参考音频转写;空串 + 有参考音频 = 纯克隆模式 */
  refText: string;
  seed: number;
  cfgValue: number;
  inferenceTimesteps: number;
  maxSteps: number;
  temperature: number;
}

export const TTS_PROFILE_DEFAULTS: TtsProfile = {
  refAudio: null,
  refText: '',
  seed: 42,
  cfgValue: 2.0,
  inferenceTimesteps: 10,
  maxSteps: 200,
  temperature: 1.0,
};

const TTS_PROFILE_LIMITS = {
  // 上界比 int32 最大少一格:静默重试要拿 seed+1 再发一次请求,+1 也必须落在区间内
  seed: [0, 2 ** 31 - 2],
  cfgValue: [0.1, 10],
  inferenceTimesteps: [1, 100],
  maxSteps: [10, 2000],
  temperature: [0.05, 2],
} as const;

function clampNum(v: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
}

const CSS_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/** overlay 配置钳制:数值入界、颜色只收 hex、字体名剥掉能逃出 CSS 声明的字符 */
function clampOverlay(patch: Partial<OverlayConfig> | undefined, base: OverlayConfig): OverlayConfig {
  const p = patch ?? {};
  const ps: Partial<OverlaySubtitleStyle> = p.subtitle ?? {};
  const bs = base.subtitle;
  const color = (v: unknown, fallback: string): string =>
    typeof v === 'string' && CSS_COLOR_RE.test(v) ? v : fallback;
  return {
    subtitles: typeof p.subtitles === 'boolean' ? p.subtitles : base.subtitles,
    cues: typeof p.cues === 'boolean' ? p.cues : base.cues,
    danmaku: typeof p.danmaku === 'boolean' ? p.danmaku : base.danmaku,
    subtitle: {
      scale: clampNum(ps.scale, [0.5, 2.5], bs.scale),
      weight: Math.round(clampNum(ps.weight, [100, 900], bs.weight)),
      maxLines: Math.round(clampNum(ps.maxLines, [1, 8], bs.maxLines)),
      color: color(ps.color, bs.color),
      strokeColor: color(ps.strokeColor, bs.strokeColor),
      strokeW: clampNum(ps.strokeW, [0, 4], bs.strokeW),
      plate: clampNum(ps.plate, [0, 0.85], bs.plate),
      fontFamily:
        typeof ps.fontFamily === 'string' ? ps.fontFamily.replace(/[;{}<>]/g, '').trim().slice(0, 100) : bs.fontFamily,
    },
  };
}

export const VTUBER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:vtuber',
  owner: 'world:vtuber',
  schema: {
    type: 'object',
    title: 'VTuber · 演出',
    description: 'VTube Studio、演出流与 TTS 地址;改完重启生效。',
    properties: {
      'worlds.vtuber.vtsWsUrl': {
        type: 'string',
        title: 'VTS WebSocket',
        'x-hot': false,
        description: '默认 ws://127.0.0.1:8001',
      },
      'worlds.vtuber.streamPort': {
        type: 'integer',
        title: '演出流端口(偏好)',
        minimum: 0,
        maximum: 65535,
        'x-hot': false,
        description: '/overlay(演出画面页)、SSE /stream 与 WS /danmaku(观众弹幕入)。被占用时自动顺延。',
      },
      'worlds.vtuber.ttsUrl': {
        type: 'string',
        title: 'TTS(VoxCPM2)',
        'x-hot': false,
        description: '默认 http://127.0.0.1:8010(VTS 占了 8001)',
      },
      'worlds.vtuber.ttsRuntimeDir': {
        type: 'string',
        title: 'TTS 运行时目录(自备)',
        'x-hot': false,
        'x-path': { kind: 'directory' },
        description:
          '留空走面板里的托管下载。填了就用这个目录里的 llama-tts-server,不再下载:'
          + '自编译的构建、签过名的构建、或者别处装好的一份都走这里。',
      },
      'worlds.vtuber.ttsRuntimeRelease': {
        type: 'string',
        title: 'TTS 运行时版本',
        'x-hot': false,
        description: '留空用包里钉住的那个 release。改了要重新安装运行时。',
      },
      'worlds.vtuber.ttsBaseLmFile': {
        type: 'string',
        title: 'VoxCPM2 BaseLM',
        'x-hot': false,
        'x-path': {
          kind: 'file',
          extensions: ['.gguf'],
          recommendedDir: '<模型根>/vtuber',
        },
        'x-download': {
          href: 'https://huggingface.co/DennisHuang648/VoxCPM2-GGUF/resolve/169f64d8b98bbaab1761e4ca3a83e6af653456cc/VoxCPM2-BaseLM-F16.gguf?download=true',
          label: '下载 GGUF',
        },
        description: '留空用权重目录下的 VoxCPM2-BaseLM-F16(面板可一键下载)。gguf。已运行的服务需停掉再启动。',
      },
      'worlds.vtuber.ttsAcousticFile': {
        type: 'string',
        title: 'VoxCPM2 Acoustic',
        'x-hot': false,
        'x-path': {
          kind: 'file',
          extensions: ['.gguf'],
          recommendedDir: '<模型根>/vtuber',
        },
        'x-download': {
          href: 'https://huggingface.co/DennisHuang648/VoxCPM2-GGUF/resolve/169f64d8b98bbaab1761e4ca3a83e6af653456cc/VoxCPM2-Acoustic-F16.gguf?download=true',
          label: '下载 GGUF',
        },
        description: '留空用权重目录下的 VoxCPM2-Acoustic-F16(面板可一键下载)。gguf。已运行的服务需停掉再启动。',
      },
      'worlds.vtuber.ttsAlignerLmFile': {
        type: 'string',
        title: 'ForcedAligner LM',
        'x-hot': false,
        'x-path': {
          kind: 'file',
          extensions: ['.gguf'],
          recommendedDir: '<模型根>/vtuber',
        },
        'x-download': {
          href: 'https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf/tree/c07281df297b9905d24a508279258cccf987a064',
          label: '下载源权重并转换',
        },
        description:
          '可选。留空用权重目录下的 Qwen3-Aligner-LM-F16(面板可一键下载)。gguf；上游只有 safetensors，需运行 scripts/aligner-gguf.ts 转换。',
      },
      'worlds.vtuber.ttsAlignerAudioFile': {
        type: 'string',
        title: 'ForcedAligner Audio',
        'x-hot': false,
        'x-path': {
          kind: 'file',
          extensions: ['.gguf'],
          recommendedDir: '<模型根>/vtuber',
        },
        'x-download': {
          href: 'https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf/tree/c07281df297b9905d24a508279258cccf987a064',
          label: '下载源权重并转换',
        },
        description:
          '可选。留空沿用旧文件名；上游只有 safetensors，需运行 scripts/aligner-gguf.ts 转换并与 LM 成对使用。',
      },
      'worlds.vtuber.ttsVoicesDir': {
        type: 'string',
        title: '声线库目录',
        'x-hot': true,
        'x-path': {
          kind: 'directory',
          recommendedDir: '../Cortico-Resources/vtuber/voices',
        },
        description: '参考音频 wav 与同名 .txt 转写的目录。留空沿用 voxcpm2-server/voices。',
      },
      'worlds.vtuber.packDir': {
        type: 'string',
        title: '演出包目录',
        'x-hot': false,
        'x-path': { kind: 'directory' },
        description:
          '演出词表与曲线(params.json + vocab.json + clips.json)所在目录,人格资产。' +
          '留空按三层找:本部署的 vtuber-pack/ > 人格包的 vtuber-pack/ > 随 World 的范例包。' +
          '填了就压过这三层——指到仓库外的包时用它。' +
          '换目录重启生效;改目录里的文件用「动作调参」的重载。',
      },
      'worlds.vtuber.mutedTexts': {
        type: 'string',
        title: '禁播词',
        'x-hot': true,
        description: '| 分隔多条。台本流里出现这些子串的整段不进 TTS、不上字幕。留空不过滤。',
      },
      'worlds.vtuber.live2dDir': {
        type: 'string',
        title: 'VTube Studio 模型目录',
        'x-hot': true,
        'x-path': {
          kind: 'directory',
          recommendedDir: 'C:/Program Files (x86)/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels',
        },
        description:
          'VTube Studio 加载模型的目录(StreamingAssets/Live2DModels)。模型档案按 <模型目录>/cortico.profile.json 在这里发现;' +
          '复检时只读模型目录里的 .vtube.json 与表情/动画文件,模型仍由 VTS 加载。',
      },
      'worlds.vtuber.audioDevice': {
        type: 'string',
        title: '音频主输出',
        'x-hot': true,
        'x-options': 'playback-primary',
        description: 'TTS 主设备。虚拟线(CABLE Input)给 OBS 采;系统默认或 none=不出声。热改下一片语音生效。',
      },
      'worlds.vtuber.audioMirrorSystem': {
        type: 'boolean',
        title: '副输出',
        'x-hot': true,
        description: '再写一份到下面选的设备。主副落到同一设备时不重复。热改下一片语音生效。',
      },
      'worlds.vtuber.audioSecondary': {
        type: 'string',
        title: '副输出设备',
        'x-hot': true,
        'x-options': 'playback-secondary',
        description: '副输出的目标。系统默认会跟当前默认播放设备(换耳机在下一片或约 0.5s 内切)。',
      },
      'worlds.vtuber.streamEnabled': {
        type: 'boolean',
        title: '流式输出',
        'x-hot': true,
        description:
          'TTS 边合成边播,首声延迟从整段合成的 3 秒级降到 1 秒内。需要 TTS server 支持流式端点;' +
          '不支持或临时不可用时自动回落为整段合成,不用手动关。',
      },
      'worlds.vtuber.speechCapSec': {
        type: 'integer',
        title: '语音积压上限(秒)',
        minimum: 3,
        maximum: 120,
        'x-suffix': 's',
        'x-hot': true,
        description:
          '排队闸:嘴里没说完的超过这个秒数,新台词不排入(回执告知,说完后再开口)。',
      },
      'worlds.vtuber.maxActRoundsPerTurn': {
        type: 'integer',
        title: '同轮演出封顶(次)',
        minimum: 1,
        maximum: 100,
        'x-hot': true,
        description:
          '复读风暴保险:同一次 LLM 回复里最多开这么多演出轮,之后的 vtuber_act 拒收。' +
          '同轮追加豁免积压闸,失控回复靠这个次数上限兜住;正常分段远用不满。',
      },
      'worlds.vtuber.silenceRemindSec': {
        type: 'integer',
        title: '静默一级(秒)',
        minimum: 1,
        maximum: 600,
        'x-suffix': 's',
        'x-hot': true,
        description: '安静满该秒数投第一级提醒;开口后重新计。',
      },
      'worlds.vtuber.silenceRemind2Sec': {
        type: 'integer',
        title: '静默二级(秒)',
        minimum: 0,
        maximum: 600,
        'x-suffix': 's',
        'x-hot': true,
        description: '总静默达到该秒数投第二级(措辞更急);0 或不大于一级 = 停用此级。',
      },
      'worlds.vtuber.silenceRemind3Sec': {
        type: 'integer',
        title: '静默三级(秒)',
        minimum: 0,
        maximum: 600,
        'x-suffix': 's',
        'x-hot': true,
        description: '总静默达到该秒数投第三级(最急);0 或不大于二级 = 停用此级。',
      },
      'worlds.vtuber.silenceLine1': {
        type: 'string',
        title: '一级措辞',
        'x-hot': true,
        description: '留空用内置措辞池;多个变体用 | 分隔,{sec} 处代入静默秒数。',
      },
      'worlds.vtuber.silenceLine2': {
        type: 'string',
        title: '二级措辞',
        'x-hot': true,
        description: '同上;这一级该有点催促感了。',
      },
      'worlds.vtuber.silenceLine3': {
        type: 'string',
        title: '三级措辞',
        'x-hot': true,
        description: '同上;最后一级,不留台阶。',
      },
      'worlds.vtuber.obsDelaySec': {
        type: 'number',
        title: 'OBS 播出延迟(秒)',
        minimum: 0,
        maximum: 30,
        'x-suffix': 's',
        'x-hot': true,
        description:
          'OBS 对游戏画面设的固定延迟:延迟源近期有事件时,演出反应不早于观众看到的画面。0=未标定不设地板。',
      },
      'worlds.vtuber.delayedSources': {
        type: 'array',
        title: '延迟画面的 World',
        'x-hot': true,
        description:
          '被 OBS 延迟的画面对应的 World id 数组(如 ["minecraft"]);地板只看这些来源的事件。' +
          '控制台只读展示,改 config.json 生效。',
      },
      'worlds.vtuber.yieldWindowMs': {
        type: 'integer',
        title: '打断收束窗口(ms)',
        minimum: 0,
        maximum: 2000,
        'x-suffix': 'ms',
        'x-hot': true,
        description:
          '打断/抢占时在这个窗口内找最近的自然停顿(单元间隙)收住旧话,找不到就立即淡出。' +
          '0 = 不找停顿,永远立即淡出。',
      },
      'worlds.vtuber.yieldFadeMs': {
        type: 'integer',
        title: '打断回落淡出(ms)',
        minimum: 30,
        maximum: 1000,
        'x-suffix': 'ms',
        'x-hot': true,
        description:
          '收束正常走音素感知切断:按切点处的信号(浊音/擦音/静音)给 6-70ms 的衰减,不用这个值。' +
          '这里是回落档——舞台页未连或切点处 PCM 不在手时,退回整体线性淡出的时长。',
      },
      'worlds.vtuber.alignEnabled': {
        type: 'boolean',
        title: '逐字对齐',
        'x-hot': true,
        description:
          '每个 TTS 分片过 Qwen3-ForcedAligner 拿逐字/逐词起止时间:<> 片内动作按标注时刻触发,' +
          '对齐退化顺带当 TTS 质量门。需要 server 带对齐模型;拿不到时片内动作退化为按字符比例估计。' +
          '关闭时流式片沿 <> 剪开、在接缝处触发动作。',
      },
      'worlds.vtuber.modelProfile': {
        type: 'string',
        title: '模型档案',
        'x-hot': true,
        description:
          '档案 id(模型目录里 cortico.profile.json 的 id)或 auto。同一套演出资产接不同 Live2D 模型时的接线换算表:' +
          '头部转多少度、眼睑"正常睁眼"是多少输入量、左右眉是不是共用一路,每个模型作者的接法都不同;' +
          '换算全在档案里,词表与动作曲线不随模型变。auto = 按 VTS 报的模型名认;指了不存在的 id 会大声报错。',
      },
      'worlds.vtuber.decayGazeSec': {
        type: 'array',
        title: '注视回落(秒)',
        items: { type: 'number', minimum: 1, maximum: 600 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 's',
        'x-hot': true,
        description: '「看向…」之后无新指令,随机等这么久滑回默认注视。',
      },
      'worlds.vtuber.decayPoseSec': {
        type: 'array',
        title: '姿态回落(秒)',
        items: { type: 'number', minimum: 1, maximum: 600 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 's',
        'x-hot': true,
        description: '歪头/前倾这类保持姿态的持续时间区间。',
      },
      'worlds.vtuber.decayEmotionSec': {
        type: 'array',
        title: '表情回落(秒)',
        items: { type: 'number', minimum: 1, maximum: 600 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 's',
        'x-hot': true,
        description: '挂在脸上的表情(微笑/大笑…)多久没被重新点名就淡回中性。',
      },
    },
  },
};

/**
 * 控制台面板声明。**id 是局部 id**(`mount`,不是 `vtuber-mount`):World 不把自己的
 * 名字编进面板 id 里,控制台按 provider + 局部 id 路由,渲染由 `console/client.ts`
 * 的自有面板 bundle 负责。
 *
 * 声明与面板 bundle**同进同退**:这里声明了而 `console/client.ts` 的 `panels` 里没有对应
 * 键,控制台就渲染一张"面板产物缺这个面板"的错误卡;反过来 bundle 写了却不声明,面板在
 * 导航里根本够不着。九条与那份键表逐条对齐。
 */
export const VTUBER_PANEL_DECLS: readonly WorldPanelDecl[] = [
  {
    id: 'mount',
    title: '挂载',
    description: '形象 / 声音 / 演出流三条链路的状态与启停。',
    getMethods: ['state', 'vtsState', 'ttsState'],
  },
  {
    id: 'model',
    title: '模型档案',
    description: '换 Live2D 模型时的接线换算表与接线自检。',
    getMethods: ['state'],
  },
  {
    id: 'overlay',
    title: 'Overlay 画面',
    description: '推流链接、图层开关、字幕样式与预览。',
    getMethods: ['state'],
  },
  {
    id: 'clips',
    title: '动作调参',
    description: '逐条试跳动作 / 姿态 / 表情 / 看向 / 特效。',
    getMethods: ['state'],
  },
  {
    id: 'tts',
    title: '声线档案',
    description: '运行时与权重的安装;参考音频、参考转写与生成参数;合成试听。',
    getMethods: ['state', 'voiceWav', 'runtime'],
  },
  {
    id: 'align',
    title: '时间点标注',
    description: '音频 + 逐字稿 → 逐单元起止时间的波形核对。',
    getMethods: ['state', 'units'],
  },
  {
    id: 'log',
    title: '演出日志',
    description: '轮 / 拍 / TTS / 音频回执等关键事件。',
    getMethods: ['entries'],
  },
  {
    id: 'diag',
    title: '演出诊断',
    description: '台本演出、分层归因与逐帧录制导出。',
    getMethods: ['state', 'report', 'presets'],
  },
];

export interface VtuberWorldOptions {
  timezone?: string;
  botName?: string;
  vtsWsUrl?: string;
  /** 演出流服务的偏好端口(0 = 随机空闲口;测试用) */
  streamPort?: number;
  ttsUrl?: string;
  /** 自备的运行时目录;非空就不走托管下载(自编译、签过名的构建走这里) */
  ttsRuntimeDir?: () => string;
  /** 托管下载钉住的 release;留空用包里钉的那个 */
  ttsRuntimeRelease?: () => string;
  /** 输出设备名子串;开流时求值('' 默认设备 / 'none' 不出声) */
  audioDevice?: () => string;
  /** 副输出开关;开流时求值 */
  audioMirrorSystem?: () => boolean;
  /** 副输出设备;`default` = 系统默认。开流时求值 */
  audioSecondary?: () => string;
  /** 逐字对齐开关;每次合成时求值以支持控制台热调 */
  alignEnabled?: () => boolean;
  /** 流式输出开关;每片求值。真流式还要 server 能力在场(health 的 streaming 标志) */
  streamEnabled?: () => boolean;
  /** 语音积压上限(秒);每次 vtuber_act 求值(x-hot) */
  speechCapSec?: () => number;
  /** 同轮演出封顶(次);每次 vtuber_act 求值(x-hot) */
  maxActRoundsPerTurn?: () => number;
  /** 静默一级(秒);见底后安静满该时长投第一级提醒(x-hot) */
  silenceRemindSec?: () => number;
  /** 静默二/三级触发秒数(总静默时长;0 或不大于前一级 = 停用;x-hot) */
  silenceRemind2Sec?: () => number;
  silenceRemind3Sec?: () => number;
  /** 三级措辞(留空用内置池;| 分变体,{sec} 代秒数;x-hot) */
  silenceLines?: () => [string, string, string];
  /**
   * 禁播词以 | 分隔，在台本流入口过滤匹配片段，使其不进入 TTS、字幕或动作 cue。handler 回执闸无法撤回已流出的内容。
   */
  mutedText?: () => string;
  /** 播出延迟(秒)与延迟源 World id;每拍求值(x-hot) */
  obsDelaySec?: () => number;
  delayedSources?: () => string[];
  /** 礼让收束找停顿的窗口(ms);每次打断求值(x-hot) */
  yieldWindowMs?: () => number;
  /** 礼让收束的音量淡出时长(ms);每次打断求值(x-hot) */
  yieldFadeMs?: () => number;
  /** 自定的 TTS/对齐 GGUF 路径；留空用权重目录下的固定文件名。 */
  ttsBaseLmFile?: () => string;
  ttsAcousticFile?: () => string;
  ttsAlignerLmFile?: () => string;
  ttsAlignerAudioFile?: () => string;
  /** 声线库（部署私有资产）；留空放在权重目录旁边。 */
  ttsVoicesDir?: () => string;
  /** VTube Studio 部署目录的记录值； World 不直接加载其中的文件。 */
  live2dDir?: () => string;
  /** 演出包目录(params.json + vocab.json + clips.json);空 = worlds-vtuber 自带的范例包。启动时读一次,控制台「动作调参」可重载同一目录。 */
  packDir?: string;
  /** Initial voice profile. */
  ttsProfile?: Partial<TtsProfile>;
  /** Called after the active voice profile changes. */
  onTtsProfile?: (profile: TtsProfile) => void;
  /** Initial overlay configuration. */
  overlay?: Partial<OverlayConfig>;
  /** Called after the overlay configuration changes. */
  onOverlayConfig?: (config: OverlayConfig) => void;
  /** 持续状态回落时间(秒);连接时求值以支持控制台热调 */
  decaySec?: () => VtuberDecaySec;
  /** 模型档案 id 或 'auto';每帧求值以支持控制台热换 */
  modelProfile?: () => string;
  /**
   * 模型档案改变后回调(装配层写回 config.json)。与 `onTtsProfile` / `onOverlayConfig`
   * 同一形状:World 只管说"现在该是这个值",落盘归装配层。
   *
   * 不给 = 面板上的档案下拉不可切换(会显式报错,而不是改完悄悄回弹)。
   */
  onModelProfile?: (profile: string) => void;
  /** Directory for rolling diagnostic reports; omitted disables disk reports. */
  diagDir?: string;
  vtsAuthToken?: string;
  onVtsToken?: (token: string) => void;
}

/** voices/ 里的一条声线:wav 文件 + 同名 .txt 的转写(没有则空) */
export interface TtsVoiceInfo {
  file: string;
  text: string;
}

/** 一次参考音频导入的结果 */
export interface SavedVoice {
  file: string;
  path: string;
  /** 转码前的源格式；输入为 WAV 时是 null。 */
  converted: string | null;
}

export interface VtuberVtsConsole {
  state(): Promise<{
    connected: boolean;
    url: string;
    /** 已持有授权 token(没有的话连接时 VTS 会弹授权窗) */
    tokenSet: boolean;
    model: { name: string; id: string } | null;
  }>;
  /** 手动连接 + 复位残留反应表情;失败带 error 文案 */
  connect(): Promise<{ connected: boolean; error?: string; cleared?: string[] }>;
  disconnect(): Promise<{ connected: false }>;
  /** 排入一个可见动作(点头+星星特效),走完整演出链路;返回结果文案 */
  test(): string;
}

export interface VtuberOverlayConsole {
  state(): { url: string | null; streamUp: boolean; config: OverlayConfig };
  /** 改配置(部分字段);钳制后热推给所有 overlay 页并经装配层落盘,返回生效值 */
  setConfig(patch: Partial<OverlayConfig>): { config: OverlayConfig; message: string };
  /** 往演出流投一条试显事件,所有订阅中的 overlay(含 OBS 里的)一起看到 */
  demo(kind: 'subtitle' | 'cue' | 'danmaku'): string;
}

export interface VtuberTtsConsole {
  state(): Promise<
    TtsServerState & { reachable: boolean; profile: TtsProfile; voices: TtsVoiceInfo[]; voicesDir: string }
  >;
  /** 运行时与权重的安装状态 */
  runtime(): {
    release: string;
    key: string | null;
    dir: string;
    /** 目录是配置给的(自备)还是托管装的 */
    own: boolean;
    /** 本平台有没有现成的构建 */
    supported: boolean;
    install: InstallState;
    models: ModelState[];
  };
  /** 装(或重装)运行时 */
  installRuntime(): Promise<void>;
  /** 下一个权重文件 */
  downloadModel(id: ModelId): Promise<void>;
  start(): TtsServerState;
  stop(): Promise<TtsServerState>;
  /** 改声线档案(部分字段);钳制后持久化(连同转写侧车)并返回生效值 */
  setProfile(patch: Partial<TtsProfile>): TtsProfile;
  /**
   * 本地选的参考音频存进 voices/(缓存):非 wav 先经 ffmpeg 转码,文件名消毒。
   * `converted` 是转码前的源格式，WAV 输入为 null；转写由 `setProfile` 写入。
   */
  saveVoice(name: string, audioBase64: string): Promise<SavedVoice>;
  /** 读一条声线的 wav 字节(base64;面板试听用)。找不到返回 null。 */
  voiceWav(file: string): string | null;
  /**
   * 合成一句(缺省用固定测试句)。给了 profile 就按它合成而不动生效档案——
   * 面板上改了声线还没保存时,试听听到的是面板上那条。
   * wav 带回给面板就地播放;舞台页在线时同步送出去一份(顺带验证舞台链路)。
   */
  test(text?: string, profile?: Partial<TtsProfile>): Promise<{ message: string; wav: string | null }>;
}

/** 演出日志条目:结构化事件环的文本投影(seq 单调递增供面板增量拉取) */
export interface PerfLogEntry {
  seq: number;
  ts: string;
  area: string;
  msg: string;
}

/** 诊断报表自动落盘的间隔。总是覆盖同一个 latest.json,方便随时直接读 */
const DIAG_AUTODUMP_MS = 5000;
/**
 * 失真滚动摘要的窗口。10 分钟是「一段直播的节奏」:短到还能对上刚才那段的记忆,
 * 长到不会把控制台刷满。
 */
const WARN_SUMMARY_MS = 10 * 60_000;
/**
 * 演出通道名 → 运行日志区域后缀(worlds.vtuber.<后缀>)。表外的通道名原样作后缀。
 * 通道名是控制台日志面板的显示名,区域是 grep 与 logging.areas 门槛用的稳定名。
 */
const LANE_AREA: Record<string, string> = {
  '音频': 'audio',
  'TTS': 'tts',
  '字幕': 'subtitle',
  '韵律': 'prosody',
  '轮': 'round',
  '播': 'play',
  '打断': 'interrupt',
  '锚点': 'anchor',
  '状态': 'state',
  '拍': 'beat',
  'TTS静默': 'tts-silence',
  '注入': 'inject',
  '摘要': 'summary',
  '对齐': 'align',
  '诊断': 'diag',
  '测试': 'test',
  '自检': 'selfcheck',
  '调参': 'tune',
  'TTS预算': 'tts-budget',
  '语速': 'speech-rate',
  '台本边界': 'script-shape',
  '闸门': 'gate',
  '禁播': 'muted',
  '提醒': 'remind',
  '空台本': 'empty-script',
  '关机': 'shutdown',
  '水位': 'backlog',
};
/** 高频状态机通道,不给级别时落 trace(默认不落盘);其余通道落 debug */
const LANE_TRACE = new Set(['状态', '拍', '注入', '锚点']);
/** 录制默认抓这些参数:头三轴 + 眼球 + 嘴 + 眼睑,够复算两类症状 */
const DIAG_CAPTURE_PARAMS = [
  'FaceAngleX', 'FaceAngleY', 'FaceAngleZ',
  'EyeRightX', 'EyeRightY',
  'MouthOpen', 'MouthSmile',
  'EyeOpenLeft', 'BrowLeftY',
];
/**
 * 对拍读回的 watch 名单:录制窗口内同步轮询 VTS,把合成后真正落在模型上的
 * 输出参数值与 VTS 输入参数实时值录进同一份报表。IR 平滑而读回值跳,
 * 跳变就生在 VTS 侧(映射/idle 让位/表情/物理);输入默认值顺带验证注入基线。
 */
const PROBE_OUTPUT_PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX',
  'ParamMouthForm', 'ParamMouthOpenY',
  'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeBallX', 'ParamEyeBallY',
  'ParamBrowLY', 'ParamBrowRY', 'ParamEyeLSmile', 'ParamCheekPuff',
];
const PROBE_INPUT_PARAMS = [
  'FaceAngleX', 'FaceAngleY', 'FaceAngleZ',
  'MouthSmile', 'MouthOpen',
  'EyeOpenLeft', 'EyeOpenRight', 'EyeRightX', 'EyeRightY',
  'BrowLeftY', 'BrowRightY', 'CheekPuff',
];
/** 轮询自身还有 ~25ms 的 VTS 往返垫底,实际节奏约 20-25Hz */
const PROBE_INTERVAL_MS = 20;

export interface VtuberDiagConsole {
  state(): { dir: string | null; autoDumpSec: number; lastDump: string | null };
  /** 当前报表(不落盘,面板直接看) */
  report(): Record<string, unknown>;
  /** 录 ms 毫秒的逐帧原始值,导出成文件 */
  record(ms: number, params?: string[]): Promise<{ path: string | null; message: string }>;
}

export interface VtuberAlignConsole {
  state(): Promise<{ enabled: boolean; available: boolean; lastOk: boolean | null }>;
  /** 按当前切分策略预览单元表(面板显示要对齐哪些单元) */
  units(text: string): string[];
  /** 对一段音频做标注;units 缺省按 text 切 */
  align(audioBase64: string, text: string, units?: string[]): Promise<AlignResult & { elapsedMs: number }>;
  /** 用 TTS 现合一段测试音频(面板"用 TTS 输出测试"用) */
  synth(text: string): Promise<{ wav: string; durationMs: number }>;
}

export interface VtuberLogConsole {
  /** 取 seq > after 的条目(增量轮询);after 缺省 0 = 全量 */
  entries(after?: number): PerfLogEntry[];
}

export interface VtuberPerformConsole {
  presets(): Array<{ label: string; script: string }>;
  /** 整段演出一个台本;返回带断链警告的回执文案 */
  perform(script: string): string;
}

/** 调参面板里的一条可试跳资产 */
export interface ClipsPanelItem {
  clipId: string;
  /** 词表中文词;词表外资产回落到 clipId */
  word: string;
  kind: 'pulse' | 'pose' | 'emotion' | 'gaze' | 'fx';
  durationMs?: number;
}

export interface VtuberClipsConsole {
  state(): {
    vtsConnected: boolean;
    /** 资产源文件(面板提示人往哪儿改) */
    file: string;
    groups: Array<{ label: string; items: ClipsPanelItem[] }>;
  };
  /** 从磁盘重读演出包并整体替换;失败旧包保持 */
  reload(): Promise<{ ok: boolean; message: string; warnings: string[] }>;
  /**
   * 将单个 cue 直接注入 L3/L4,用于独立检查效果。
   * pose/emotion/gaze 是保持型,试完用 reset 撤掉。
   */
  trigger(kind: string, clipId: string, intensity?: number): string;
  /** 三个 State 通道全部回中性 */
  reset(): string;
}

export interface VtuberModelConsole {
  state(): {
    /** 配置里选的值('auto' 或档案 id) */
    configured: string;
    /** 实际生效的档案 */
    activeId: string;
    activeLabel: string;
    /** missing = 配置指了不存在的档案 id,画面按匹配/默认档出,但这是配置错误 */
    how: 'configured' | 'matched' | 'fallback' | 'missing';
    /** VTS 侧当前模型名(对齐用:选档时能看到实机加载的是哪个) */
    vtsModelName: string;
    vtsConnected: boolean;
    /** VTube Studio 的 Live2DModels 目录;档案在它的子目录里发现 */
    live2dDir: string;
    /** 生效档案的文件路径;默认档案时 null */
    profileFile: string | null;
    /** 目录里读坏的档案 */
    registryErrors: Array<{ file: string; message: string }>;
    /** 档案与模型文件的只读复检结果(默认档案时 null) */
    modelFile: ModelFileCheck | null;
    choices: Array<{ value: string; label: string; vtsModelName: string }>;
    /** 这个档案已知的表现力缺口 */
    caveat: string | null;
    unsupported: string[];
    /** 演出包声明的参数集:建议模型至少接上这些 */
    contract: Array<{ id: string; unit: string; suggests: string; losesIfMissing: string }>;
    /** 当前演出包目录 */
    packDir: string;
    /** 生效档案与演出包对不上的地方(换算了包里没有的参数、声明了包里没有的特效) */
    profileWarnings: string[];
    /** 上一次自检的结果(没跑过是 null) */
    lastCheck: WiringReport | null;
  };
  /**
   * 跑一遍接线自检。期间会停掉发帧、逐个注入探针,约一分钟;
   * 跑完形象回中性。
   */
  selfCheck(): Promise<{ ok: boolean; message: string; report: WiringReport | null }>;
}

/**
 * 演出测试预置台本(词表内标签;演示各通道与断句用法)。
 * 「对拍」组每条盯一个判别假设,配合「录制并演出」在对拍读回里逐帧对差;
 * 台本设计与预期观察见 README「演出诊断」。
 */
export const PERFORM_PRESETS: Array<{ label: string; script: string }> = [
  {
    label: '输棋复盘',
    script:
      '【叹气,叹气特效】哎[sigh]还是输了啊。你攻势太猛了,我全程都在堵堵堵,<翻白眼>最后漏了一手。【微笑,看向屏幕】不过挺过瘾的!再来一局不?',
  },
  {
    label: '赢棋得意',
    script:
      '【得意,星星特效,眼镜特效】嘿嘿,这波打得漂亮![laughing]<看向镜头,微笑>谢谢大家陪我下完这局,<脸红特效>爱你们哦~',
  },
  {
    label: '受惊思考',
    script:
      '【惊吓后仰,流汗特效】\n[Surprise-wa]等等,这步棋什么意思?【前倾,歪头疑惑】让我想想……[Uhm]<灯泡特效>哦!我看懂了。',
  },
  {
    label: '听弹幕互动',
    script:
      '【看一眼弹幕,轻轻摇摆】来看看弹幕都在聊什么~<大笑>[laughing]谁说我是人机?[Dissatisfaction-hnn]<摇头,怒气特效>我可是有感情的。',
  },
  {
    label: 'Reset 收场',
    script: '【可怜】呜,今天状态不太行[sigh]【Reset】\n好,调整好了!【看向镜头,微笑】继续继续。',
  },
  {
    label: '片内动作混排',
    script:
      '【前倾】其实我今天没怎么<看一眼弹幕>没怎么吃饭吧,也就吃了一点点[sigh]<看向镜头>你们今天在干嘛呢?没吃饭吗?',
  },
  {
    label: '对拍①嘴角眉毛半区',
    script:
      '【微笑】\n嘿嘿,今天心情很好哦,注意看我的嘴角。\n【生气】\n可恶!居然有人说我是人机!\n【可怜】\n呜……大家不要这样嘛……\n【Reset】\n好啦,回到平常的样子。',
  },
  {
    label: '对拍②眼睑接管',
    script:
      '【瞪大眼睛,惊讶特效】\n诶?!这是什么东西!\n【大笑,星星特效】\n哈哈哈哈,太好笑了吧!\n【困倦】\n唔……说着说着突然有点困了……\n【Reset】\n好!清醒了!',
  },
  {
    label: '对拍③怒气特效副作用',
    script:
      '【微笑】\n我现在笑得可开心了,大家盯紧我的嘴角哦。\n【怒气特效】\n哼!我生气了!……才怪,我脸上明明还笑着呢。\n【微笑,怒气特效】\n再来一次,笑容配怒气,看看谁赢!',
  },
  {
    label: '对拍④头部大动作',
    script:
      '【拼命摇头】\n不对不对不对,完全不对!\n【用力点头】\n对!就是这样,我确定!\n【惊吓后仰,流汗特效】\n哇啊!吓我一跳!\n【歪头疑惑,问号特效】\n诶……刚刚到底发生了什么?',
  },
  {
    label: '对拍⑤注视眼球',
    script:
      '【看向弹幕】\n让我看看弹幕都在聊什么~\n【看向屏幕】\n再瞧瞧棋盘这边的局势。\n【看向镜头,微笑】\n最后,看着大家说句话!\n【看一眼弹幕,眨单眼】\n临走再瞟一眼弹幕,嘿嘿。',
  },
];

/**
 * 停机等待整个演出队列（在播与排队）的时限。SHUTDOWN_RPC_TIMEOUT_MS 须覆盖此期限，且二者均须小于 SHUTDOWN_BUDGET_MS.worlds 的全部 IO 收尾预算，为其他 World 保留收尾时间。
 */
export const SHUTDOWN_DRAIN_MAX_MS = 10_000;

/**
 * 连续多少次注入超时算 VTS 僵死,报到她的上下文里。
 *
 * 这只是**告知**阈值,故意排在客户端熔断阈值(连续 3 次超时即 terminate 重连)之后:
 * 先自救,救不回来再打断她。注入超时 2s、最多两帧在途,所以到这个数时确实已经
 * 连着几秒一帧没落地——短于这个数的抖动客户端自己就吞掉了。
 */
export const VTS_STALL_STREAK = 4;

/**
 * 交接后推进她上下文的开口提示(internal worlds.note,flush 档)。交接归档把她自己的
 * 演出调用整条摘掉,新 session 里没有一条 vtuber_act 的用法示范;这一条替代示范,
 * 把「上文没有不等于没说过」和「现在就开口」说在她读到新一批事件之前。
 */
export const HANDOFF_NOTE =
  '[演出] 上下文刚交接。你之前的 vtuber_act 调用和回执已随上文清空,交接笔记里也没有它们,' +
  '看不到不等于没说过。观众还在听,现在就调 vtuber_act 开口和他们互动。';

/** 已注册的演出工具声明(schema);World 与子进程代理共用,handler 各自绑定。
 * 用法说明只写在 ENV_PROMPT.md(可编辑)与这里的 description,不再另开前缀段。 */
export const VTUBER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'vtuber_act',
    tags: ['speak'],
    description:
      'ONLY way the audience hears or sees you. Put speech and performance tags (【】 blocking, <> inline, [] vocal) in the script argument; never put them in assistant message content (content is silent on stream).',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            'Performance script for the audience: speech text with 【tag】 blocks. To stay silent, end the turn without calling this tool; do not pass an empty or placeholder script. Do not put this text in message content.',
        },
      },
      required: ['script'],
    },
  },
  {
    name: 'vtuber_interrupt',
    tags: ['speak'],
    description:
      'Cut off your own ongoing speech at the nearest natural pause (within ~0.5s). The unspoken part is removed from history — records keep only what the audience actually heard.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/**
 * 在逐字符台本流中过滤禁播子串：仅暂存可能组成禁播词的尾部，其余字符立即放行。过滤发生在音频、字幕与动作 cue 分流前，不能依赖 handler 回执闸撤回已流出的内容。
 */
export class StreamRedactor {
  private pend = '';
  constructor(
    private readonly banned: () => readonly string[],
    private readonly out: (text: string) => void,
    private readonly onHit: (banned: string) => void,
  ) {}

  feed(text: string): void {
    this.pend += text;
    const list = this.banned().filter((b) => b.length > 0);
    if (list.length === 0) {
      this.out(this.pend);
      this.pend = '';
      return;
    }
    for (;;) {
      const hit = list.find((b) => this.pend.includes(b));
      if (!hit) break;
      const i = this.pend.indexOf(hit);
      if (i > 0) this.out(this.pend.slice(0, i));
      this.pend = this.pend.slice(i + hit.length);
      this.onHit(hit);
    }
    // 只扣住还可能补成禁播词的最长尾缀,前面的字符即刻放行
    let hold = 0;
    for (const b of list) {
      for (let k = Math.min(b.length - 1, this.pend.length); k > hold; k--) {
        if (this.pend.endsWith(b.slice(0, k))) {
          hold = k;
          break;
        }
      }
    }
    if (this.pend.length > hold) {
      this.out(this.pend.slice(0, this.pend.length - hold));
      this.pend = this.pend.slice(this.pend.length - hold);
    }
  }

  /** 流收尾:扣着的尾巴终究没长成禁播词,原样放行 */
  flush(): void {
    if (this.pend) {
      this.out(this.pend);
      this.pend = '';
    }
  }

  /** 丢弃仍可能长成禁播词的尾缀；断流不得把它作为完整台本放行。 */
  discard(): void {
    this.pend = '';
  }
}

interface StreamingCall {
  index: number;
  /** tool_call id:与 handler 的 ctx.callId 同源,是"这一次调用已流式开演"的去重键 */
  callId: string;
  json: JsonScriptStream;
  boundary: ExternalActScriptStreamNormalizer;
  redact: StreamRedactor;
  handle: { feed(text: string): void; end(): void };
  script: string;
  ended: boolean;
}

/** 一次 vtuber_act 的排队裁决 */
interface SpeechDecision {
  kind: 'queued' | 'rejected';
  backlogMs: number;
  /** 拒收的由头:积压超上限,还是同一轮回复开轮开过了头 */
  reason?: 'backlog' | 'turn-cap';
}

/**
 * 单个 LLM 轮内的演出轮数上限。轮首之后免受积压闸的分段调用仍受此上限约束，
 * 且上限不得超过 recentStreamed 的去重容量。
 */

/**
 * 从本地播放账本重组台本前缀，供结果事件与字幕收束使用。
 * 部分播出的片段保留前缀，未播出的片段留空；中断说明进入追加事件。
 */
export function composeAiredScript(o: RoundOutcome): { script: string; note: string } {
  const parts: string[] = [];
  let anyAudio = false;
  for (const p of o.pieces) {
    if (p.spoken === 'none') break;
    const tagPrefix = p.tags.length > 0 ? `【${p.tags.join(',')}】` : '';
    if (p.spoken === 'all') {
      parts.push(tagPrefix + p.text);
      if (p.text) anyAudio = true;
      continue;
    }
    if (p.spoken > 0) {
      parts.push(tagPrefix + p.text.slice(0, p.spoken));
      anyAudio = true;
    } else if (tagPrefix) {
      parts.push(tagPrefix);
    }
    break;
  }
  if (!anyAudio) {
    return { script: '', note: '[播放结果] 这段尚未进入本地音频输出就被打断' };
  }
  return {
    script: parts.join(''),
    note: '[播放结果] 本地播放在此前缀附近中断，未播放尾句已丢弃',
  };
}

export class VtuberWorld implements World {
  readonly id = 'vtuber';

  private host: WorldHost | null = null;
  /** host 在 start() 才挂上;构造期就要日志的部件拿这一份,调用刻现取 host.log */
  private readonly log: Logger = forwardLogger(() => this.host?.log);
  private readonly timezone: string;
  private readonly botName: string;
  private readonly vts: VtsClient;
  private readonly stream: PerformStream;
  private streamUp = false;
  /** overlay 画面配置;控制台改动即热推(overlay.config 事件)并经装配层落盘 */
  private overlayCfg: OverlayConfig;
  private readonly onOverlayConfig?: (config: OverlayConfig) => void;
  private readonly ttsClient: TtsClient;
  private readonly aligner: AlignerClient;
  private readonly alignEnabled?: () => boolean;
  private alignOk: boolean | null = null;
  private readonly streamEnabledOpt?: () => boolean;
  private readonly speechCapSecOpt?: () => number;
  private readonly maxActRoundsPerTurnOpt?: () => number;
  private readonly silenceRemindSecOpt?: () => number;
  private readonly silenceRemind2SecOpt?: () => number;
  private readonly silenceRemind3SecOpt?: () => number;
  private readonly silenceLinesOpt?: () => [string, string, string];
  private readonly mutedTextOpt?: () => string;
  private readonly obsDelaySecOpt?: () => number;
  private readonly delayedSourcesOpt?: () => string[];
  private readonly yieldWindowMsOpt?: () => number;
  private readonly yieldFadeMsOpt?: () => number;
  /** server 流式能力(health 的 streaming 标志);null=没探到 */
  private streamOk: boolean | null = null;
  private streamProbeAt = 0;
  private readonly ttsUrl: string;
  private readonly mixer: Mixer;
  private readonly backend: VtsBackend;
  private readonly audio: DeviceAudioSink;
  private performer: Performer | null = null;
  /** 演出包:词表与曲线。人格资产,由 bot 目录提供 */
  private pack: PerformancePack;
  private readonly packDir: string;
  /**
   * 当前声线的实测样本(每片的单元数与实测时长);字幕/跑飞门/锚点的估计取净速率
   * p75(speechRateHint)。
   */
  private readonly speechRateSamples: SpeechRateSample[] = [];
  private readonly speechRateLog: SpeechRateLog | null;
  private speechRateLogWarned = false;
  /** 本声线是否已经报过一次「估计切到实测」;换声线时随 epoch 复位 */
  private speechRateAnnounced = false;
  private readonly ttsServer: TtsServerManager;
  private readonly runtimeStore: RuntimeStore;
  private readonly modelStore: ModelStore;
  /** 本平台的发布计划;null = 没有现成构建,只能自备目录 */
  private readonly releasePlan: ReleasePlan | null;
  private readonly ttsRuntimeDirOpt?: () => string;
  private readonly ttsRuntimeReleaseOpt?: () => string;
  private readonly ttsVoicesDirOpt?: () => string;
  private readonly live2dDirOpt?: () => string;
  private readonly ttsProfile: TtsProfile;
  private readonly onTtsProfile?: (profile: TtsProfile) => void;
  private readonly decaySec?: () => VtuberDecaySec;
  private readonly modelProfileOpt?: () => string;
  /** live2dDir 下发现的档案;连接期与控制台读状态时重扫,目录可热改 */
  private registry: ProfileRegistry;
  /** VTS 侧当前模型名;每次连上都问一次,用来自动定档 */
  private vtsModelName = '';
  /** 「连上了」的订阅;stop() 退订,不留监听器 */
  private vtsConnectedUnsub: (() => void) | null = null;
  /** VTS 里换模型的订阅;换了就重新定档 */
  private vtsModelLoadedUnsub: (() => void) | null = null;
  /** 在跑的那一次定档+名单同步;并发调用合并,同一次连接只查一遍 */
  private knownSyncing: Promise<void> | null = null;
  /** 上一次接线自检的结果(面板回看用) */
  private lastWiringReport: WiringReport | null = null;
  private wiringCheckRunning = false;
  /** 当前参考音频的 base64；声线目录热换后同名文件也必须重读。 */
  private refAudioCache: { path: string; b64: string } | null = null;

  private vtsOk: boolean | null = null;
  private ttsOk: boolean | null = null;

  private readonly streaming = new Map<number, StreamingCall>();
  /** tap 已完整流过的调用及其外部形状判定；handler 不再二次演出。 */
  private readonly recentStreamed = new Map<string, ExternalActScriptResult>();
  /** 本轮 LLM 直接输出(content)的累积;含【】则在收尾时提醒改走工具 */
  private roundContent = '';
  /** 本 LLM 轮已开的 act 数；分段调用免积压闸，仍受同轮次数上限限制。 */
  private turnActCalls = 0;
  /**
   * 本 LLM 轮的 tap 是否已见到 vtuber_interrupt。同轮工具串行执行，interrupt 可在 act handler 前清空积压，tap 缓存的积压水位因此不能用于拒绝该 act。
   * interrupt 因零积压早退时同样不设此闸；标志随 turnActCalls 在 finishTapRound 清零。
   */
  private turnInterruptSeen = false;
  /** 每次调用的排队裁决(tap 时刻定夺,handler 取走出回执);按 callId 存 */
  private readonly callDecisions = new Map<string, SpeechDecision>();
  /**
   * 按 callId 记录 interrupt 在 tap 见到调用头时的轮号，作为打断栅栏。后续 act 可经流式 tap 先于 interrupt handler 开始演出，栅栏必须使用调用时刻以保护新轮内容。
   */
  private readonly interruptFences = new Map<string, number>();
  /** 演出诊断:事件环 + 逐帧分层归因 + 录制导出 */
  private readonly diag = new PerfDiagnostics();
  private readonly diagDir: string | null;
  private lastDumpPath: string | null = null;
  private diagTimer: ReturnType<typeof setInterval> | null = null;
  /** 静默提醒计时;见底时武装,新台词后的到点检查落空 */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  /** 杂谈/游戏模式的弹幕攒批(听弹幕模式逐条即时,不进这里) */

  constructor(opts: VtuberWorldOptions = {}) {
    this.timezone = opts.timezone ?? 'Asia/Shanghai';
    this.botName = opts.botName ?? 'bot';
    this.decaySec = opts.decaySec;
    this.vts = new VtsClient({
      url: opts.vtsWsUrl ?? VTUBER_DEFAULTS.vtsWsUrl,
      authToken: opts.vtsAuthToken,
      onToken: opts.onVtsToken,
      onAuthRejected: (rejected) => this.noteVtsAuthRejected(rejected),
      // 熔断/重连/恢复各一条:皮套冻结的现场只有这三条能还原发生了什么。
      // 排定重连在断线期每几秒一条,窗口内的重复由运行日志 sink 按 (区域, event) 折叠。
      log: (event, msg, fields) => {
        this.tracePerf('注入', msg, { level: 'warn', tally: 'VTS重连', event, data: fields });
      },
    });
    this.overlayCfg = clampOverlay(opts.overlay, OVERLAY_CONFIG_DEFAULTS);
    this.onOverlayConfig = opts.onOverlayConfig;
    this.stream = new PerformStream({
      preferredPort: opts.streamPort ?? VTUBER_DEFAULTS.streamPort,
      snapshot: () => ({
        status: this.statusLine(),
        // 初始快照包含当前 overlay 配置;后续变更通过 overlay.config 事件发送。
        overlay: this.overlayCfg,
      }),
      onDanmakuIn: (text, from) => this.onDanmakuIn(text, from),
    });
    const ttsUrl = opts.ttsUrl ?? VTUBER_DEFAULTS.ttsUrl;
    this.ttsUrl = ttsUrl;
    this.ttsProfile = this.clampProfile({ ...TTS_PROFILE_DEFAULTS, ...opts.ttsProfile });
    this.onTtsProfile = opts.onTtsProfile;
    this.ttsClient = new TtsClient({ url: ttsUrl, profile: () => this.synthProfileOf(this.ttsProfile) });
    // 对齐器与 TTS 同进程同端口:一个 llama-tts-server 同时驮着 VoxCPM2 和对齐模型
    this.aligner = new AlignerClient({ url: ttsUrl });
    this.alignEnabled = opts.alignEnabled;
    this.streamEnabledOpt = opts.streamEnabled;
    this.speechCapSecOpt = opts.speechCapSec;
    this.maxActRoundsPerTurnOpt = opts.maxActRoundsPerTurn;
    this.silenceRemindSecOpt = opts.silenceRemindSec;
    this.silenceRemind2SecOpt = opts.silenceRemind2Sec;
    this.silenceRemind3SecOpt = opts.silenceRemind3Sec;
    this.silenceLinesOpt = opts.silenceLines;
    this.mutedTextOpt = opts.mutedText;
    this.obsDelaySecOpt = opts.obsDelaySec;
    this.delayedSourcesOpt = opts.delayedSources;
    this.yieldWindowMsOpt = opts.yieldWindowMs;
    this.yieldFadeMsOpt = opts.yieldFadeMs;
    let ttsPort = 8010;
    try {
      ttsPort = Number(new URL(ttsUrl).port) || ttsPort;
    } catch {
      /* 非法 URL 用默认端口,synth 时自会报错 */
    }
    this.ttsRuntimeDirOpt = opts.ttsRuntimeDir;
    this.ttsRuntimeReleaseOpt = opts.ttsRuntimeRelease;
    this.ttsVoicesDirOpt = opts.ttsVoicesDir;
    this.live2dDirOpt = opts.live2dDir;
    this.releasePlan = planFor(this.runtimeRelease(), defaultBackend());
    this.runtimeStore = new RuntimeStore(runtimesRoot(), this.log);
    this.modelStore = new ModelStore(TTS_MODELS_DIR, this.log);
    this.ttsServer = new TtsServerManager({
      runtimeDir: () => this.runtimeDir(),
      serverExe: () => this.releasePlan?.serverExe ?? (process.platform === 'win32' ? 'llama-tts-server.exe' : 'llama-tts-server'),
      modelsDir: TTS_MODELS_DIR,
      baseLmFile: opts.ttsBaseLmFile,
      acousticFile: opts.ttsAcousticFile,
      alignerLmFile: opts.ttsAlignerLmFile,
      alignerAudioFile: opts.ttsAlignerAudioFile,
      port: ttsPort,
      log: this.log,
    });
    this.modelProfileOpt = opts.modelProfile;
    this.packDir = opts.packDir?.trim() || EXAMPLE_PACK_DIR;
    this.pack = loadPack(this.packDir);
    this.registry = loadProfiles(this.live2dDirOpt?.() ?? VTUBER_DEFAULTS.live2dDir, { paramIds: this.pack.paramIds, fxIds: this.pack.fxIds });
    // 眼睑所有权按模型档案定:idle 不眨眼的模型由混音台全程接管(见 Mixer.applyBlink)
    this.mixer = new Mixer({ pack: () => this.pack, idleBlinks: () => this.resolvedProfile().profile.idleBlinks ?? false });
    this.diagDir = opts.diagDir ?? null;
    this.speechRateLog = this.diagDir ? new SpeechRateLog(join(this.diagDir, 'speech-rate.jsonl')) : null;
    this.backend = new VtsBackend(this.vts, {
      onError: (err) => {
        this.noteVtsInjectWarn(err);
        this.noteVtsInjectError(err);
      },
      profile: () => this.resolvedProfile().profile,
      onInjectStat: (stat) => this.diag.noteInject(stat),
      onInjectOk: () => this.noteVtsInjectOk(),
      // 名单由这一份重建:它连模型定档一起重跑,backend 不再自己查一遍
      resyncKnown: () => this.syncKnownParameters(),
    });
    this.mixer.attachDiagnostics(this.diag);
    this.audio = new DeviceAudioSink(this.log.child('audio'), {
      device: opts.audioDevice,
      secondary: () => {
        if ((opts.audioMirrorSystem?.() ?? true) === false) return 'off';
        const d = (opts.audioSecondary?.() ?? 'default').trim();
        return d || 'default';
      },
      trace: (area, msg, o) => this.tracePerf(area, msg, o),
    });
    this.restoreSpeechRate();
  }

  /** 词表段由演出包渲染;人物设定与演出范例在 ENV_PROMPT.md 里。 */
  envPromptVars(): Record<string, string> {
    return { 'vtuber.vocab': vocabTableRows(this.pack) };
  }

  console(): WorldConsoleDecl {
    const vtsTone = this.vtsOk === true ? 'on' : this.vtsOk === false ? 'off' : 'plain';
    const ttsTone = this.ttsOk === true ? 'on' : this.ttsOk === false ? 'off' : 'plain';
    // 三条链路各一颗:形象(VTS)、声音(TTS)、画面(演出流)。三条各坏各的——
    // VTS 断了她还在说话,TTS 挂了她还在动,分开报才知道该去修哪个。
    // `null` 是"还没试过",归启动中。
    return {
      lamps: [
        {
          label: 'VTS',
          ...(this.vtsOk === true
            ? { state: 'online' as const }
            : this.vtsOk === false
              ? { state: 'error' as const, hint: '未连' }
              : { state: 'loading' as const, hint: '待试' }),
        },
        {
          label: 'TTS',
          ...(this.ttsOk === true
            ? { state: 'online' as const }
            : this.ttsOk === false
              ? { state: 'error' as const, hint: '异常' }
              : { state: 'loading' as const, hint: '待试' }),
        },
        {
          label: '演出流',
          ...(this.streamUp
            ? { state: 'online' as const, hint: `:${this.stream.port}` }
            : { state: 'offline' as const, hint: '未启动' }),
        },
      ],
      badges: [
        { label: 'VTS', value: this.vtsOk === true ? '已连' : this.vtsOk === false ? '未连' : '待试', tone: vtsTone },
        { label: '演出流', value: this.streamUp ? `:${this.stream.port}` : '未启动', tone: this.streamUp ? 'on' : 'off' },
        { label: 'TTS', value: this.ttsOk === true ? '正常' : this.ttsOk === false ? '异常' : '待试', tone: ttsTone },
      ],
      panels: [...VTUBER_PANEL_DECLS],
      links: this.streamUp ? [{ label: '打开 overlay', href: this.overlayUrl }] : [],
      // 进程内与 proxy 使用相同的提示文档声明。
      promptDocs: [
        {
          key: 'worlds.vtuber.envPrompt',
          title: 'VTuber · 环境提示词',
          description: '人物设定、动作与嗓音词表、演出范例、说话节奏。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{
            name: 'vtuber.vocab',
            description: '演出包词表按通道分组的表格行(动作/姿态/表情/看向/特效),来自 bot 的 vtuber-pack/vocab.json。',
            multiline: true,
          }],
        },
      ],
      config: [VTUBER_CONFIG_GROUP],
    };
  }

  /** 通道的运行日志 logger,按通道缓存(区域 = worlds.vtuber.<LANE_AREA[lane]>) */
  private readonly laneLogs = new Map<string, Logger>();

  /**
   * 诊断事件环是演出关键事件的权威存储;控制台文本与运行日志是投影。
   * 运行日志一条:区域按 LANE_AREA,级别显式给的优先、否则按 LANE_TRACE,
   * durMs 进 durMs,detail 与 data 合进 data。
   */
  private tracePerf(lane: string, msg: string, opts: TraceOptions = {}): void {
    const e = this.diag.trace(lane, msg, opts);
    const level = opts.level ?? (LANE_TRACE.has(lane) ? 'trace' : 'debug');
    if ((level === 'warn' || level === 'error') && opts.tally) {
      this.warnTally.set(opts.tally, (this.warnTally.get(opts.tally) ?? 0) + 1);
    }
    let log = this.laneLogs.get(lane);
    if (!log) {
      log = this.log.child(LANE_AREA[lane] ?? lane);
      this.laneLogs.set(lane, log);
    }
    const data = opts.data || e.detail ? { ...opts.data, ...(e.detail ? { detail: e.detail } : {}) } : undefined;
    log.emit(level, msg, { event: opts.event, durMs: e.durMs, data });
  }

  /*
   * VTS 注入持续失败时投递一次报障，恢复时再投递解除；任一成功注入清零失败计数。
   */
  private vtsTimeoutStreak = 0;
  private vtsStalled = false;

  /**
   * 每次注入失败均写 warn 并计入滚动摘要；同一窗口内重复文案由日志 sink 折叠，桶计数不得随折叠丢失。
   */
  private noteVtsInjectWarn(err: Error): void {
    this.tracePerf('注入', `注入失败:${err.message.slice(0, 80)}`, { level: 'warn', tally: '注入失败' });
  }

  private noteVtsInjectError(err: Error): void {
    if (!err.message.includes('请求超时')) return;
    this.vtsTimeoutStreak++;
    if (this.vtsStalled || this.vtsTimeoutStreak < VTS_STALL_STREAK) return;
    this.vtsStalled = true;
    const n = this.vtsTimeoutStreak;
    this.tracePerf('注入', `VTS 连续 ${n} 次没有响应,皮套画面可能已冻结`, {
      level: 'error',
      tally: 'VTS无响应',
    });
    this.pushPerfFault(`[演出] VTS 连续 ${n} 次没有响应,皮套画面可能已冻结。`);
  }

  private noteVtsInjectOk(): void {
    this.vtsTimeoutStreak = 0;
    if (!this.vtsStalled) return;
    this.vtsStalled = false;
    this.tracePerf('注入', 'VTS 重新开始回执', { level: 'warn' });
    this.pushPerfFault('[演出] VTS 重新开始回执,皮套注入已恢复。');
  }

  /*
   * token 被 VTS 判无效之后自动重连就永久停了。vtsStalled 那条报的是「没回执」,
   * 这一条报的是「不会再连了」:没有人工重新授权,皮套会一直静默冻着,
   * 而注入超时的连击在连接根本没建起来时也未必攒得到 VTS_STALL_STREAK。
   */
  private vtsAuthRejected = false;

  private noteVtsAuthRejected(rejected: boolean): void {
    if (rejected === this.vtsAuthRejected) return;
    this.vtsAuthRejected = rejected;
    if (rejected) {
      this.tracePerf('注入', 'VTS 拒绝了已存的认证令牌,自动重连已停止', {
        level: 'error',
        tally: 'VTS认证被拒',
      });
      this.pushPerfFault('[演出] VTS 拒绝了已存的认证令牌,自动重连已停止,需要人工在 VTS 里重新授权。');
      return;
    }
    this.tracePerf('注入', 'VTS 重新认证成功', { level: 'warn' });
    this.pushPerfFault('[演出] VTS 重新认证成功,自动重连已恢复。');
  }

  onHandoffEnded(): void {
    this.pushPerfFault(HANDOFF_NOTE);
  }

  /**
   * 播出链路的故障告知。origin internal:这是 World 报自己这一侧机制的话,进 user 区
   * 而不是事件帧——她对 external_event_frame 的内容是按"保持怀疑"读的,报障不该落在那里。
   */
  private pushPerfFault(text: string): void {
    void this.host
      ?.pushEvent(
        { ts: nowIso(this.timezone), source: this.id, type: 'worlds.note', origin: 'internal', text },
        { trigger: 'flush' },
      )
      .catch((e) => this.host?.log.warn('演出故障事件投递失败', { err: String(e) }));
  }

  /**
   * 滑动窗口内各类失真的计数摘要，沿 tracePerf 写入诊断事件环与 host.log。摘要行不带 tally，避免自计数。
   */
  private readonly warnTally = new Map<string, number>();
  private tallyTimer: ReturnType<typeof setInterval> | null = null;

  private flushWarnSummary(): void {
    if (this.warnTally.size === 0) return; // 全零不发:平安无事不该占控制台一行
    const parts = [...this.warnTally].map(([k, n]) => `${k} ${n}`).join(' / ');
    const tally = Object.fromEntries(this.warnTally);
    this.warnTally.clear();
    this.tracePerf('摘要', `最近 ${Math.round(WARN_SUMMARY_MS / 60_000)} 分钟:${parts}`, {
      level: 'warn',
      event: 'summary',
      data: { windowMs: WARN_SUMMARY_MS, tally },
    });
  }

  /** 托管下载钉住的版本;配置可覆盖 */
  private runtimeRelease(): string {
    return this.ttsRuntimeReleaseOpt?.().trim() || PINNED_RELEASE;
  }

  /** 自备目录优先(自编译、签过名的构建走这里);否则用托管装好的那份,没装就是空串 */
  private runtimeDir(): string {
    const own = this.ttsRuntimeDirOpt?.().trim();
    if (own) return own;
    if (!this.releasePlan) return '';
    const dir = this.runtimeStore.dir(this.runtimeRelease(), this.releasePlan);
    return this.runtimeStore.installed(dir) ? dir : '';
  }

  /** 控制台的运行时面板 */
  ttsRuntimeState(): {
    release: string;
    key: string | null;
    dir: string;
    /** 目录是配置给的还是托管装的 */
    own: boolean;
    supported: boolean;
    install: InstallState;
  } {
    const own = (this.ttsRuntimeDirOpt?.().trim() ?? '').length > 0;
    const release = this.runtimeRelease();
    const dir = this.releasePlan ? this.runtimeStore.dir(release, this.releasePlan) : '';
    return {
      release,
      key: this.releasePlan?.key ?? null,
      dir: own ? this.runtimeDir() : dir,
      own,
      supported: this.releasePlan !== null,
      install: own
        ? { phase: 'installed', file: null, done: 0, total: null, detail: null }
        : this.runtimeStore.state(dir),
    };
  }

  /** 控制台的权重面板 */
  ttsModelStates(): ModelState[] {
    return this.modelStore.states();
  }

  async installTtsRuntime(): Promise<void> {
    if (!this.releasePlan) {
      throw new Error(`这个平台(${process.platform})没有现成的构建,请在配置里给出自备的运行时目录`);
    }
    await this.runtimeStore.install(this.runtimeRelease(), this.releasePlan);
  }

  async downloadTtsModel(id: ModelId): Promise<void> {
    await this.modelStore.download(id);
  }

  private alignOn(): boolean {
    return this.alignEnabled?.() ?? VTUBER_DEFAULTS.alignEnabled;
  }

  /**
   * 非流式单片合成，可同时生成对齐标注。仅连续超大静默触发一次重合成；重试换一个 seed 取另一条 take，
   * 两次仍含静默时选静默更短者播放并记录。
   * 对齐判废本身不触发重合成：放弃该单元表，字幕和锚点使用估计，并记录降级。
   */
  private async synthAligned(text: string, signal?: AbortSignal): Promise<TtsPiece> {
    /*
     * 档案与重试 seed 一起取:两条 take 的差别只有 seed,且都取自同一刻的生效档案。
     * 服务端认 seed(同一份档案发两遍拿回同一条 take,真机实测逐字节相同),所以「换采样」必须换它;
     * 换的是请求里那份——生效档案含 seed 参与 speechProfileKey,动它等于每片样本一个新键。
     */
    const profile = this.synthProfileOf(this.ttsProfile);
    const retrySeed = this.ttsProfile.seed + 1;
    let piece = await this.ttsClient.synth(text, profile, signal);
    if (signal?.aborted) throw signal.reason;
    const first = piece.silence;
    if (first) {
      if (first.triggered) {
        this.tracePerf('TTS静默', `超大静默段,重合成一次换采样:${describeSilence(first)}`, {
          detail: `「${text.slice(0, 24)}」`,
          level: 'warn',
          tally: '静默重合成',
          event: 'resynth',
          data: { ...silenceData(first), seed: profile.seed, retrySeed },
        });
        const retry = await this.ttsClient.synth(text, { ...profile, seed: retrySeed }, signal);
        if (signal?.aborted) throw signal.reason;
        const second = retry.silence;
        // 取死气更短的那条:两条都不干净时不该盲信后来的
        if (!second || second.longestMs < first.longestMs) piece = retry;
        if (second?.triggered) {
          this.tracePerf('TTS静默', `重合成仍有超大静默段,照常播出:${describeSilence(second)}`, {
            detail: `「${text.slice(0, 24)}」`,
            level: 'warn',
            tally: '静默重合成',
            event: 'resynth-still-silent',
            data: { ...silenceData(second), seed: retrySeed },
          });
        }
      } else if (first.longestMs >= first.minSilenceMs / 2) {
        this.tracePerf('TTS静默', `接近门:${describeSilence(first)}`, {
          detail: `「${text.slice(0, 24)}」`,
          event: 'near-gate',
          data: silenceData(first),
        });
      }
    }
    if (!this.alignOn()) return piece;
    const firstAlign = await this.alignPiece(piece, text);
    if (signal?.aborted) throw signal.reason;
    if (!firstAlign) return piece;
    if (firstAlign.verdict.ok) {
      piece.units = firstAlign.units;
      return piece;
    }
    this.tracePerf('对齐', '分片不过门(照常播出,单元表不采信)', {
      detail: firstAlign.verdict.reasons.join('、'),
      level: 'warn',
      tally: '对齐降级',
    });
    /*
     * 与流式路统一:不过门的单元表一格也不留。
     *
     * 旧注释「units 仍赋上:<> 锚点没有别的时间源可用」是事实错误——退路一直在:
     * orchestrator 的 scheduleWholeAnchors / schedulePreparedAnchors 在 units 缺席时
     * 按 charOffset / text.length × durationMs 定锚(orchestrator.test.ts「组合①非流式
     * 无对齐:按字符比例估计触发」就在测这条退路),emitSubtitle 缺席时回落 estimate 档。
     * 两条路对同一个「不可信」结论做相反处置,靠的正是这句不成立的理由;真正的道理
     * 写在流式路那边:把系统自己判定不可信的时间点喂进去,观众看到的就是字幕与锚点
     * 跟语音对不上,而按比例均分不准但不会错位。
     */
    return piece;
  }

  /**
   * 流式合成一片。收流后跑一次全量对齐附 units(<> 锚点与口径都靠它);
   * 音频已经播出去了,质量门在这条路上只记录不重试。
   * 流式端点失败(老 server/中途异常)回落整段合成,以"单块流"的形状交回,
   * 演出无感;主动打断(signal)原样上抛。
   */
  private async synthStreamAligned(text: string, sink: TtsStreamSink, signal: AbortSignal, maxDurationMs?: number): Promise<TtsPiece> {
    let piece: TtsPiece;
    try {
      piece = await this.ttsClient.synthStream(text, sink, { signal, maxDurationMs });
      this.ttsOk = true;
    } catch (err) {
      if (signal.aborted) throw err;
      this.tracePerf('TTS', `流式失败,回落整段:${String(err).slice(0, 60)}`);
      try {
        piece = await this.ttsClient.synth(text);
        this.ttsOk = true;
      } catch (err2) {
        this.ttsOk = false;
        throw err2;
      }
      const decoded = decodeWav(piece.wav);
      const envelope = new StreamingEnvelope(decoded.sampleRate);
      envelope.append(decoded.samples);
      envelope.finish();
      sink.begin?.({ sampleRate: decoded.sampleRate, envelope });
      // server 的 wav 就是 44 字节头 + PCM16,数据段原样当一大块推
      sink.pcm(piece.wav.subarray(44));
      piece = { ...piece, envelope };
    }
    if (!this.alignOn()) return piece;
    const alignRes = await this.alignPiece(piece, text);
    if (!alignRes) return piece;
    // 不过门的单元表一格也不留:音频已经播出去了拦不住,但 units 是字幕与锚点时间轴的
    // 第一级时间源(subtitle-cues.ts unitAtMs),把系统自己判定不可信的时间点喂进去,
    // 观众看到的就是字幕跟语音对不上。留空则回落到按音频时长均分,不准但不会错位。
    if (alignRes.verdict.ok) {
      piece.units = alignRes.units;
    } else {
      this.tracePerf('对齐', '流式片不过门(音频已播出,单元表不采信)', {
        detail: alignRes.verdict.reasons.join('、'),
        level: 'warn',
        tally: '对齐降级',
      });
      // 判废详情交给演出层,只为那道最后兜底提供切点(撞上 server 32s 硬上限时)。
      // 判废本身不再触发任何破坏性动作——笑腔怪调照样判废,那是节目效果。
      // 「最后对得上的单元末尾」= 垃圾段的起点估计;零长跨度是没找到,不算数。
      let lastGoodEndMs: number | null = null;
      for (const u of alignRes.units) {
        if (u.end > u.start) lastGoodEndMs = Math.max(lastGoodEndMs ?? 0, u.end * 1000);
      }
      piece.alignBad = { reasons: [...alignRes.verdict.reasons], lastGoodEndMs };
    }
    return piece;
  }

  /** 前缀对齐(<> 锚点抢时间):对已合成的 PCM 前缀标注给定单元表 */
  private async alignPcmPrefix(pcm: Uint8Array, sampleRate: number, units: string[]): Promise<AlignedUnit[] | null> {
    if (!this.alignOn() || units.length === 0) return null;
    const t0 = Date.now();
    try {
      const res = await this.aligner.align(pcm16ToWav([pcm], sampleRate), '', units);
      this.alignOk = true;
      this.tracePerf('对齐', `前缀对齐 ${units.length} 单元`, {
        durMs: Date.now() - t0,
        event: 'prefix-align',
        data: { units: units.length },
      });
      return res.units;
    } catch (err) {
      this.alignOk = false;
      this.tracePerf('对齐', '前缀对齐失败', { detail: String(err).slice(0, 80), event: 'prefix-align-failed' });
      return null;
    }
  }

  /** server 流式能力:health 的 streaming 标志,30s 缓存后台刷新 */
  private streamCapable(): boolean {
    const now = Date.now();
    if (now - this.streamProbeAt > 30_000) {
      this.streamProbeAt = now;
      void this.probeStreaming();
    }
    return this.streamOk === true;
  }

  /**
   * 流式能力直接问端点:送一个缺 input 的请求,404 说明这个 server 没有流式路由,
   * 其他回码(参数错)说明路由在。不靠 /health 里的自述标志,那样每换一个后端都要它配合。
   */
  private async probeStreaming(): Promise<void> {
    try {
      const res = await fetch(`${this.ttsUrl}/v1/audio/speech/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(1500),
      });
      void res.body?.cancel();
      this.streamOk = res.status !== 404;
    } catch {
      this.streamOk = null;
    }
  }

  /** 对齐不可用或失败时返回 null，演出继续。 */
  private async alignPiece(piece: TtsPiece, text: string): Promise<AlignResult | null> {
    const t0 = Date.now();
    try {
      const result = await this.aligner.align(piece.wav, text);
      this.alignOk = true;
      this.tracePerf('对齐', `${result.units.length} 个单元`, {
        durMs: Date.now() - t0,
        event: 'align',
        data: { units: result.units.length },
      });
      return result;
    } catch (err) {
      this.alignOk = false;
      this.tracePerf('对齐', '对齐失败', { detail: String(err).slice(0, 80), event: 'align-failed' });
      return null;
    }
  }

  alignConsole(): VtuberAlignConsole {
    return {
      state: async () => ({
        enabled: this.alignOn(),
        available: await this.aligner.available(),
        lastOk: this.alignOk,
      }),
      units: (text) => segmentUnits(text),
      align: async (audioBase64, text, units) => {
        const audio = Buffer.from(audioBase64, 'base64');
        const t0 = Date.now();
        const result = await this.aligner.align(audio, text, units);
        return { ...result, elapsedMs: Date.now() - t0 };
      },
      synth: async (text) => {
        const piece = await this.ttsClient.synth(text.slice(0, 200));
        return { wav: Buffer.from(piece.wav).toString('base64'), durationMs: piece.durationMs };
      },
    };
  }

  /** 结构化演出事件投影为文本行。 */
  logConsole(): VtuberLogConsole {
    return {
      entries: (after = 0) =>
        this.diag.eventsAfter(after).map((e) => ({
          seq: e.seq,
          ts: new Date(e.tsMs).toLocaleTimeString('zh-CN', { hour12: false, timeZone: this.timezone }),
          area: e.lane,
          msg: e.durMs !== undefined ? `${e.label} (${e.durMs}ms)${e.detail ? ' ' + e.detail : ''}`
            : e.detail ? `${e.label} ${e.detail}` : e.label,
        })),
    };
  }

  diagConsole(): VtuberDiagConsole {
    return {
      state: () => ({ dir: this.diagDir, autoDumpSec: DIAG_AUTODUMP_MS / 1000, lastDump: this.lastDumpPath }),
      report: () => this.diag.report(this.stateSnapshot()),
      /** 录 N 秒逐帧原始值 + VTS 对拍读回,录完连同报表写一个带时间戳的文件 */
      record: async (ms, params) => {
        const span = Math.min(30_000, Math.max(500, ms));
        this.diag.startCapture(span, params && params.length > 0 ? params : DIAG_CAPTURE_PARAMS);
        const probe = this.vts.connected ? this.runVtsProbe(span) : Promise.resolve(0);
        const [, probeRows] = await Promise.all([new Promise((r) => setTimeout(r, span + 200)), probe]);
        const path = this.writeDiag(`capture-${Date.now()}.json`);
        const probeNote = this.vts.connected ? `,对拍读回 ${probeRows} 行` : ',VTS 未连无对拍';
        return { path, message: path ? `已录 ${span}ms${probeNote},导出:${path}` : '导出失败(见运行日志)' };
      },
    };
  }

  /**
   * 对拍轮询在录制窗口内采集 VTS 输入和输出参数供诊断使用。
   * 串行自节流(每轮等两个请求的往返再歇 PROBE_INTERVAL_MS);
   * VTS 断开时停止轮询,不延迟录制完成。返回读取行数。
   */
  private async runVtsProbe(spanMs: number): Promise<number> {
    const t0 = Date.now();
    let outNames: string[] = [];
    let inNames: string[] = [];
    let rows = 0;
    while (Date.now() - t0 < spanMs) {
      let outs;
      let ins;
      try {
        [outs, ins] = await Promise.all([this.vts.live2dParameters(), this.vts.inputParameters()]);
      } catch (err) {
        this.tracePerf('诊断', `对拍轮询中断:${String(err).slice(0, 60)}`);
        break;
      }
      const now = Date.now();
      if (rows === 0) {
        outNames = PROBE_OUTPUT_PARAMS.filter((n) => outs.some((p) => p.name === n));
        inNames = PROBE_INPUT_PARAMS.filter((n) => ins.some((p) => p.name === n));
        const defaults: Record<string, number> = {};
        for (const p of ins) if (inNames.includes(p.name)) defaults[p.name] = p.defaultValue;
        this.diag.beginProbe(outNames, inNames, defaults);
      }
      this.diag.probeOutputRow(now, outNames.map((n) => outs.find((p) => p.name === n)?.value ?? 0));
      this.diag.probeInputRow(now, inNames.map((n) => ins.find((p) => p.name === n)?.value ?? 0));
      rows++;
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
    if (rows > 0) this.tracePerf('诊断', `对拍读回 ${rows} 行(输出 ${outNames.length} / 输入 ${inNames.length} 参数)`);
    return rows;
  }

  private stateSnapshot(): Record<string, unknown> {
    return {
      vtsConnected: this.vts.connected,
      streamUp: this.streamUp,
      ttsOk: this.ttsOk,
      performer: this.performer?.snapshot() ?? null,
      mixer: this.mixer.snapshot(),
    };
  }

  private writeDiag(name: string): string | null {
    if (!this.diagDir) return null;
    try {
      mkdirSync(this.diagDir, { recursive: true });
      const path = join(this.diagDir, name);
      writeFileSync(path, JSON.stringify(this.diag.report(this.stateSnapshot()), null, 1), 'utf8');
      this.lastDumpPath = path;
      return path;
    } catch (err) {
      this.log.warn('诊断导出失败', { err: String(err) });
      return null;
    }
  }

  performConsole(): VtuberPerformConsole {
    return {
      presets: () => PERFORM_PRESETS.map((p) => ({ ...p })),
      perform: (script) => {
        if (!this.performer) return '[失败] World 未启动';
        const text = script.trim();
        if (!text) return '[失败] 台本为空';
        this.tracePerf('测试', `控制台演出测试:「${text.slice(0, 30)}…」`);
        this.performer.perform(text);
        const warns = [
          !this.vts.connected ? '⚠ VTS 未连,看不到动作' : '',
          this.ttsOk === false ? '⚠ TTS 上次合成异常' : '',
        ].filter(Boolean);
        return `已排入演出。${this.performer.statusLine()}${warns.length ? ' ' + warns.join(';') : ''}`;
      },
    };
  }

  modelConsole(): VtuberModelConsole {
    return {
      state: () => {
        this.reloadRegistry();
        const r = this.resolvedProfile();
        return {
          configured: this.modelProfileOpt?.() ?? VTUBER_DEFAULTS.modelProfile,
          activeId: r.profile.id,
          activeLabel: r.profile.label,
          how: r.how,
          vtsModelName: this.vtsModelName,
          vtsConnected: this.vts.connected,
          live2dDir: this.registry.live2dDir,
          profileFile: r.source?.file ?? null,
          registryErrors: this.registry.errors.map((e) => ({ ...e })),
          modelFile: r.source ? checkModelFile(r.profile, r.source.dir) : null,
          choices: profileChoices(this.registry),
          caveat: r.profile.caveat ?? null,
          unsupported: [...r.profile.unsupported],
          contract: Object.entries(this.pack.params).map(([id, p]) => ({ id, unit: p.unit, suggests: p.suggests ?? '', losesIfMissing: p.losesIfMissing ?? '' })),
          packDir: this.packDir,
          profileWarnings: [...(r.source?.warnings ?? [])],
          lastCheck: this.lastWiringReport,
        };
      },
      selfCheck: async () => {
        if (!this.vts.connected) return { ok: false, message: 'VTS 未连接', report: null };
        if (this.wiringCheckRunning) return { ok: false, message: '自检已在进行中', report: null };
        this.wiringCheckRunning = true;
        // 混音台的帧会盖住探针,自检期间停发
        this.backend.beginParameterSync();
        try {
          const report = await runWiringSelfCheck(this.vts, this.pack, {
            onProgress: (done, total, id) => {
              if (id) this.tracePerf('自检', `${done + 1}/${total} ${id}`);
            },
          });
          this.lastWiringReport = report;
          this.tracePerf('自检', formatWiringReport(report));
          const dead = report.dead.length;
          return {
            ok: true,
            report,
            message: dead === 0
              ? `接线自检通过:契约里的 ${report.rows.length} 项都接上了`
              : `接线自检:${dead} 项断开(${report.dead.join('、')})——写进模型档案的 unsupported 或 aliasTo`,
          };
        } catch (err) {
          return { ok: false, message: `自检失败:${err instanceof Error ? err.message : String(err)}`, report: null };
        } finally {
          this.wiringCheckRunning = false;
          // 恢复发帧:名单原样交回(setKnownParameters 会解除 beginParameterSync 的暂停)
          await this.syncKnownParameters();
        }
      },
    };
  }

  clipsConsole(): VtuberClipsConsole {
    const word = (clipId: string): string => this.pack.entryByClipId(clipId)?.word ?? clipId;
    return {
      state: () => ({
        vtsConnected: this.vts.connected,
        file: this.packDir,
        groups: [
          {
            label: '动作',
            items: Object.values(this.pack.pulse).map((c) => ({
              clipId: c.id, word: word(c.id), kind: 'pulse' as const, durationMs: c.durationMs,
            })),
          },
          {
            label: '姿态',
            items: Object.values(this.pack.sustain)
              .filter((c) => this.pack.entryByClipId(c.id)?.channel !== 'emotion')
              .map((c) => ({ clipId: c.id, word: word(c.id), kind: 'pose' as const })),
          },
          {
            label: '表情',
            items: Object.values(this.pack.sustain)
              .filter((c) => this.pack.entryByClipId(c.id)?.channel === 'emotion')
              .map((c) => ({ clipId: c.id, word: word(c.id), kind: 'emotion' as const })),
          },
          {
            label: '看向',
            items: Object.values(this.pack.gaze).map((c) => ({ clipId: c.id, word: word(c.id), kind: 'gaze' as const })),
          },
          {
            label: '特效',
            items: this.pack.fxIds.map((id) => ({
              clipId: id, word: word(id), kind: 'fx' as const, durationMs: this.backend.fxDurationMs(id),
            })),
          },
        ],
      }),
      reload: async () => {
        let fresh: PerformancePack;
        try {
          fresh = loadPack(this.packDir);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.tracePerf('调参', `重载失败:${error.slice(0, 160)}`);
          return { ok: false, message: `重载失败,旧演出包保持生效:${error}`, warnings: [] };
        }
        this.pack = fresh;
        this.reloadRegistry();
        const warnings = fresh.lint();
        this.tracePerf('调参', `演出包已重载${warnings.length > 0 ? `,${warnings.length} 条警告` : ''}`);
        return {
          ok: true,
          message: `已重载:动作 ${Object.keys(fresh.pulse).length} / 姿态表情 ${Object.keys(fresh.sustain).length} / 看向 ${Object.keys(fresh.gaze).length} / 特效 ${fresh.fxIds.length}`,
          warnings,
        };
      },
      trigger: (kind, clipId, intensity = 1) => {
        const level = Math.min(1.5, Math.max(0.1, Number.isFinite(intensity) ? intensity : 1));
        const t = Date.now();
        const vtsWarn = this.vts.connected ? '' : ';⚠ VTS 未连,看不到效果';
        switch (kind) {
          case 'pulse': {
            if (!this.pack.pulse[clipId]) return `[失败] 动作「${clipId}」不存在`;
            this.mixer.gestureCue({ clipId, startTs: t, intensity: level });
            this.tracePerf('调参', `试跳动作 ${word(clipId)} ×${level}`);
            return `已触发「${word(clipId)}」(幅度 ${level})${vtsWarn}`;
          }
          case 'pose':
          case 'emotion': {
            if (!this.pack.sustain[clipId]) return `[失败] ${kind === 'pose' ? '姿态' : '表情'}「${clipId}」不存在`;
            this.mixer.stateCue({ channel: kind, clipId, startTs: t, intensity: level, fadeInMs: 400 });
            this.tracePerf('调参', `试挂 ${kind} ${word(clipId)} ×${level}`);
            return `已挂上「${word(clipId)}」(幅度 ${level}),按「回中性」撤掉${vtsWarn}`;
          }
          case 'gaze': {
            if (!this.pack.gaze[clipId]) return `[失败] 注视目标「${clipId}」不存在`;
            this.mixer.stateCue({ channel: 'gaze', clipId, startTs: t, intensity: 1, fadeInMs: 300 });
            this.tracePerf('调参', `试注视 ${word(clipId)}`);
            return `视线已移向「${word(clipId)}」,按「回中性」撤掉${vtsWarn}`;
          }
          case 'fx': {
            if (!this.pack.fxIds.includes(clipId)) return `[失败] 特效「${clipId}」不存在`;
            const has = this.backend.fxDurationMs(clipId) > 0;
            this.backend.fx(clipId);
            this.tracePerf('调参', `试放特效 ${word(clipId)}`);
            return has ? `已弹出「${word(clipId)}」${vtsWarn}` : `当前档案没有「${word(clipId)}」,已按丢弃处理`;
          }
          default:
            return `[失败] 未知资产类型「${kind}」`;
        }
      },
      reset: () => {
        const t = Date.now();
        for (const channel of ['pose', 'emotion', 'gaze'] as const) {
          this.mixer.stateCue({ channel, clipId: null, startTs: t, intensity: 1, fadeInMs: 400 });
        }
        this.tracePerf('调参', 'State 通道全部回中性');
        return '姿态 / 表情 / 看向已回中性';
      },
    };
  }

  /** 通道回落区间(秒配置 → ms);配置缺失或不成区间时退回默认档 */
  private stateTimeoutMs(channel: StateChannel): [number, number] {
    const sec = this.decaySec?.()[channel];
    if (!Array.isArray(sec) || sec.length !== 2) return DEFAULT_TIMEOUT_RANGE_MS[channel];
    const lo = Number(sec[0]);
    const hi = Number(sec[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
      return DEFAULT_TIMEOUT_RANGE_MS[channel];
    }
    return [lo * 1000, hi * 1000];
  }

  vtsConsole(): VtuberVtsConsole {
    return {
      state: async () => {
        let model: { name: string; id: string } | null = null;
        if (this.vts.connected) {
          try {
            model = await this.vts.currentModel();
          } catch {
            model = null;
          }
        }
        return {
          connected: this.vts.connected,
          url: this.vts.address,
          tokenSet: this.vts.tokenSet,
          model,
        };
      },
      connect: async () => {
        // 参数名单到手前不发帧:连接刚成到名单到手之间照发会撞 453 整包被拒
        this.backend.beginParameterSync();
        try {
          await this.vts.connect();
          this.vtsOk = true;
        } catch (err) {
          this.backend.cancelParameterSync();
          this.vtsOk = false;
          return { connected: false, error: err instanceof Error ? err.message : String(err) };
        }
        await this.syncKnownParameters();
        let cleared: string[] = [];
        try {
          cleared = await this.resetExpressions();
        } catch {
          /* 复位失败不影响连接结论 */
        }
        return { connected: true, cleared };
      },
      disconnect: async () => {
        await this.vts.close();
        this.vtsOk = false;
        return { connected: false as const };
      },
      test: () => {
        if (!this.performer) return '[失败] World 未启动';
        if (!this.vts.connected) return '[失败] VTS 未连接,先点「连接」';
        this.performer.perform('【点头,星星特效】');
        return '已排入测试动作:点头 + 星星特效,看形象';
      },
    };
  }

  /**
   * 配置显式档案优先，其次按 VTS 模型名自动匹配；未匹配时使用默认档案。
   * 每帧重新解析(注册表在内存里),使控制台换档立即生效。
   */
  private resolvedProfile(): ProfileResolution {
    return resolveProfile(
      this.registry,
      this.modelProfileOpt?.() ?? VTUBER_DEFAULTS.modelProfile,
      this.vtsModelName,
    );
  }

  /** 重扫 live2dDir 下的档案;目录是热配置,档案文件也可能刚被改过 */
  private reloadRegistry(): void {
    this.registry = loadProfiles(this.live2dDirOpt?.() ?? VTUBER_DEFAULTS.live2dDir, { paramIds: this.pack.paramIds, fxIds: this.pack.fxIds });
  }

  /** 清除残留反应表情，并保留当前模型档案声明的装扮与道具。 */
  private async resetExpressions(): Promise<string[]> {
    const { profile } = this.resolvedProfile();
    return this.vts.clearActiveExpressions({ keepFiles: [...profile.keepExpressions] });
  }

  /**
   * 每次连上都要跑的定档+名单同步;并发调用合并成一次。
   *
   * start() 的显式补齐、backend 的 resyncKnown、以及 vts.onConnected 那一份订阅
   * 会在同一次连接上一起落到这里;不合并就是三份 CurrentModelRequest 与三行定档日志。
   */
  private syncKnownParameters(): Promise<void> {
    if (this.knownSyncing) return this.knownSyncing;
    const run = this.runKnownParameterSync().finally(() => {
      if (this.knownSyncing === run) this.knownSyncing = null;
    });
    this.knownSyncing = run;
    return run;
  }

  /** 仅注入当前模型公开的参数；未知参数会导致 VTS 拒绝整批数据。 */
  private async runKnownParameterSync(): Promise<void> {
    try {
      const model = await this.vts.currentModel();
      this.vtsModelName = model?.name ?? '';
    } catch {
      this.vtsModelName = '';
    }
    this.reloadRegistry();
    // 定档与名单每次模型加载各一趟,逐条读得下去:显式 info,不落通道默认的 trace
    for (const e of this.registry.errors) this.tracePerf('注入', `⚠ 档案读取失败 ${e.file}:${e.message}`, { level: 'info' });
    const r = this.resolvedProfile();
    const how = r.how === 'configured' ? '配置指定' : r.how === 'matched' ? '按模型名匹配' : '未识别,使用默认档案';
    if (r.how === 'missing') {
      this.tracePerf('注入', `⚠ 配置指定的档案「${this.modelProfileOpt?.() ?? ''}」在 ${this.registry.live2dDir || '(未设置目录)'} 下不存在,暂用 ${r.profile.label}`, { level: 'info', event: 'profile' });
    } else {
      this.tracePerf('注入', `模型「${this.vtsModelName || '未加载'}」→ 档案 ${r.profile.label}(${how})`, {
        level: 'info',
        event: 'profile',
        data: { model: this.vtsModelName, profile: r.profile.id, how: r.how },
      });
    }
    if (r.profile.caveat) this.tracePerf('注入', `档案提示:${r.profile.caveat}`, { level: 'info' });
    const check = r.source ? checkModelFile(r.profile, r.source.dir) : null;
    for (const w of check?.warnings ?? []) this.tracePerf('注入', `⚠ 模型复检:${w}`, { level: 'info' });
    try {
      const names = await this.vts.inputParameterNames();
      // VTS 正常模型必有内置参数；空名单按查询失败处理，不执行过滤。
      if (names.size === 0) {
        this.backend.setKnownParameters(null);
        this.tracePerf('注入', '⚠ 输入参数名单为空,按查不到处理(不过滤)', { level: 'info' });
        return;
      }
      this.backend.setKnownParameters(names);
      this.tracePerf('注入', `实机输入参数 ${names.size} 个,已按名单过滤`, { level: 'info', data: { params: names.size } });
    } catch (err) {
      this.backend.setKnownParameters(null); // 查不到就照发,行为回到过滤前
      this.tracePerf('注入', `⚠ 输入参数名单查询失败,不做过滤:${String(err).slice(0, 60)}`, { level: 'info' });
    }
  }

  ttsConsole(): VtuberTtsConsole {
    return {
      state: async () => ({
        ...this.ttsServer.state(),
        reachable: await this.ttsServer.probe(),
        profile: { ...this.ttsProfile },
        voices: this.listVoices(),
        voicesDir: this.voicesDir(),
      }),
      runtime: () => ({ ...this.ttsRuntimeState(), models: this.ttsModelStates() }),
      installRuntime: () => this.installTtsRuntime(),
      downloadModel: (id) => this.downloadTtsModel(id),
      start: () => {
        const state = this.ttsServer.start();
        // server 刚拉起:下一次合成时重探流式能力,不吃 30s 缓存
        this.streamProbeAt = 0;
        return state;
      },
      stop: () => this.ttsServer.stop(),
      saveVoice: (name, audioBase64) => this.saveVoice(name, audioBase64),
      voiceWav: (file) => {
        const path = this.voicePath(file);
        if (!path || !existsSync(path)) return null;
        return readFileSync(path).toString('base64');
      },
      setProfile: (patch) => {
        const next = this.clampProfile({ ...this.ttsProfile, ...patch });
        const changed = JSON.stringify(next) !== JSON.stringify(this.ttsProfile);
        Object.assign(this.ttsProfile, next);
        if (changed) this.resetSpeechRate();
        this.writeTranscript(this.ttsProfile);
        this.onTtsProfile?.({ ...this.ttsProfile });
        return { ...this.ttsProfile };
      },
      test: async (text?: string, profile?: Partial<TtsProfile>) => {
        const line = (text ?? '').trim().slice(0, 200) || '语音链路测试,一二三。';
        // 试听 profile 仅用于本次合成，不写回生效档案。
        const audition = profile ? this.clampProfile({ ...this.ttsProfile, ...profile }) : null;
        const t0 = Date.now();
        let piece;
        try {
          piece = await this.ttsClient.synth(line, audition ? this.synthProfileOf(audition) : undefined);
          this.ttsOk = true;
        } catch (err) {
          this.ttsOk = false;
          return { message: `合成失败: ${err instanceof Error ? err.message : String(err)}`, wav: null };
        }
        const synthMs = Date.now() - t0;
        void this.audio.play(piece).then(({ ended }) => ended).catch(() => {});
        const voice = audition?.refAudio ?? this.ttsProfile.refAudio;
        return {
          message: `合成 OK:${Math.round(piece.durationMs)}ms 音频,耗时 ${synthMs}ms;声线 ${
            voice ?? '(无参考音频)'
          };本页播放中,声卡同步播出`,
          wav: Buffer.from(piece.wav).toString('base64'),
        };
      },
    };
  }

  overlayConsole(): VtuberOverlayConsole {
    return {
      state: () => ({
        url: this.streamUp ? this.overlayUrl : null,
        streamUp: this.streamUp,
        config: this.overlayCfg,
      }),
      setConfig: (patch) => {
        this.overlayCfg = clampOverlay(patch, this.overlayCfg);
        this.stream.emit('overlay.config', { config: this.overlayCfg });
        this.onOverlayConfig?.(this.overlayCfg);
        return { config: this.overlayCfg, message: 'overlay 配置已生效并落盘;订阅中的页面已热更新' };
      },
      demo: (kind) => {
        if (!this.streamUp) return '演出流未启动,试显发不出去';
        if (kind === 'cue') {
          this.stream.emit('cue', {
            cues: [
              { word: '微笑', channel: 'emotion' },
              { word: '点头', channel: 'gesture' },
              { word: '看向镜头', channel: 'gaze' },
              { word: '星星特效', channel: 'fx' },
            ],
          });
          return '已投一组动作标签试显';
        }
        if (kind === 'danmaku') {
          this.stream.emit('danmaku', { text: '试显弹幕:前排围观', from: 'demo' });
          this.stream.emit('danmaku', { text: '自己回的这条是高亮的', from: this.botName, self: true });
          return '已投两条试显弹幕';
        }
        const text =
          '字幕试显:这一条比较长,按标点切成好几条 cue 依次上屏,顺带看看描边、底板和字号缩放的效果。最后一句停留一会儿再淡出。';
        // 试显也走同一套速率口径:控制台上看到的节奏就是直播里的节奏
        const cues = computeSubtitleCues(text, {
          leadInMs: SPEECH_LEAD_IN_MS,
          msPerUnit: this.speechRateHint().msPerUnit,
        });
        this.stream.emit('subtitle', { text, cues, basis: 'estimate' });
        return `已投字幕试显(${cues.length} 条 cue)`;
      },
    };
  }

  /** 参考音频是部署私有资产,不是模型;留空就放在权重目录旁边 */
  private voicesDir(): string {
    return this.ttsVoicesDirOpt?.().trim() || join(TTS_MODELS_DIR, 'voices');
  }

  /** 裸文件名 → voices/ 下的绝对路径;带路径分隔符的一律拒绝 */
  private voicePath(file: string): string | null {
    const name = file.trim();
    if (!name || /[\\/]/.test(name)) return null;
    return join(this.voicesDir(), name);
  }

  /**
   * 声线的转写侧车。写它的只有 setProfile:转写是档案的一部分,存档案时连同落盘,
   * 下次选中这条声线自动带回来。清空转写就删掉侧车(纯克隆模式)。
   */
  private writeTranscript(p: TtsProfile): void {
    if (!p.refAudio) return;
    const path = this.voicePath(p.refAudio.replace(/\.wav$/i, '.txt'));
    if (!path) return;
    if (p.refText) writeFileSync(path, p.refText, 'utf8');
    else rmSync(path, { force: true });
  }

  /** 本地上传的参考音频落盘缓存;声线库只存 wav,别的格式先转码 */
  private async saveVoice(name: string, audioBase64: string): Promise<SavedVoice> {
    const bytes = new Uint8Array(Buffer.from(audioBase64, 'base64'));
    if (bytes.length === 0) throw new Error('音频数据为空');
    if (bytes.length > 30 * 1024 * 1024) throw new Error('参考音频过大(>30MB);几秒的干净人声就够');
    const format = sniffAudioFormat(bytes);
    let wav: Uint8Array = bytes;
    let converted: string | null = null;
    if (format !== 'wav') {
      const ffmpeg = findFfmpeg();
      if (!ffmpeg) {
        throw new Error(
          `${formatLabel(format)} 要转成 wav 才能进声线库,但本机找不到 ffmpeg。` +
            `装一个加进 PATH,也可以自己先转成 wav 再导入。`,
        );
      }
      wav = await transcodeToWav(bytes, { ffmpeg, sourceExt: format ?? undefined });
      converted = formatLabel(format);
    }
    decodeWav(wav); // 直接给的 wav 与转码产物都过一遍解析
    // 文件名消毒:只留基本字符,去掉源扩展名后强制 .wav
    const base = (name.replace(/\.[^.]{1,5}$/, '').replace(/[^\w一-鿿-]+/g, '_').slice(0, 60) || 'voice');
    const file = `${base}.wav`;
    const dir = this.voicesDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(path, wav);
    if (this.refAudioCache?.path === path) this.refAudioCache = null;
    if (this.ttsProfile.refAudio === file) this.resetSpeechRate();
    return { file, path, converted };
  }

  /** voices/ 目录:每个 wav 一条声线,同名 .txt 是它的转写 */
  private listVoices(): TtsVoiceInfo[] {
    const dir = this.voicesDir();
    if (!existsSync(dir)) return [];
    const out: TtsVoiceInfo[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.toLowerCase().endsWith('.wav')) continue;
      const txt = join(dir, name.replace(/\.wav$/i, '.txt'));
      out.push({ file: name, text: existsSync(txt) ? readFileSync(txt, 'utf8').trim() : '' });
    }
    return out;
  }

  private clampProfile(p: TtsProfile): TtsProfile {
    // refAudio 仅接受 voices/ 中的文件名,拒绝路径穿越。
    const refAudio =
      typeof p.refAudio === 'string' && p.refAudio.trim() && !/[\\/]/.test(p.refAudio)
        ? p.refAudio.trim()
        : null;
    return {
      refAudio,
      refText: typeof p.refText === 'string' ? p.refText.trim().slice(0, 500) : '',
      seed: Math.round(clampNum(p.seed, TTS_PROFILE_LIMITS.seed, TTS_PROFILE_DEFAULTS.seed)),
      cfgValue: clampNum(p.cfgValue, TTS_PROFILE_LIMITS.cfgValue, TTS_PROFILE_DEFAULTS.cfgValue),
      inferenceTimesteps: Math.round(
        clampNum(p.inferenceTimesteps, TTS_PROFILE_LIMITS.inferenceTimesteps, TTS_PROFILE_DEFAULTS.inferenceTimesteps),
      ),
      maxSteps: Math.round(clampNum(p.maxSteps, TTS_PROFILE_LIMITS.maxSteps, TTS_PROFILE_DEFAULTS.maxSteps)),
      temperature: clampNum(p.temperature, TTS_PROFILE_LIMITS.temperature, TTS_PROFILE_DEFAULTS.temperature),
    };
  }

  /** 组装一次合成的请求档案;参考音频按文件名缓存 base64 */
  private synthProfileOf(p: TtsProfile): TtsSynthProfile {
    const out: TtsSynthProfile = {
      seed: p.seed,
      cfgValue: p.cfgValue,
      inferenceTimesteps: p.inferenceTimesteps,
      maxSteps: p.maxSteps,
      temperature: p.temperature,
    };
    if (p.refAudio) {
      const path = this.voicePath(p.refAudio);
      if (this.refAudioCache?.path !== path) {
        try {
          this.refAudioCache = path
            ? { path, b64: readFileSync(path).toString('base64') }
            : null;
        } catch {
          this.refAudioCache = null; // 文件没了:退回无参考音频
        }
      }
      if (this.refAudioCache) {
        out.referenceAudioB64 = this.refAudioCache.b64;
        if (p.refText) out.refText = p.refText;
      }
    }
    return out;
  }

  /**
   * 输出旁路接收器。装配层把它填进主 session 声明后,
   * vtuber_act 的参数流边生成边开演;不接 tap 时工具 handler 整段演出,行为一致。
   * 另:若本轮 assistant content 里出现【】演出标签,urgent 投递提醒——
   * 那段正文没进直播间,应改用 vtuber_act。
   */
  outputTap(): OutputTap {
    return {
      onEvent: (event: StreamEvent) => this.onTapEvent(event),
      externalizes: event => event.type === 'response.output_item.added' && event.item?.type === 'function_call'
        && event.item.name === 'vtuber_act',
      onAbort: () => this.finishTapRound(true),
      onRoundEnd: () => this.finishTapRound(),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    await this.stream.start(host.log);
    this.streamUp = true;
    void this.probeStreaming();
    this.performer = new Performer({
      pack: () => this.pack,
      tts: {
        synth: async (text, signal) => {
          const profileKey = this.speechProfileKey();
          try {
            const piece = await this.synthAligned(text, signal);
            this.ttsOk = true;
            this.noteSpeechRate(text, piece.durationMs, profileKey);
            return piece;
          } catch (err) {
            this.ttsOk = false;
            throw err;
          }
        },
        synthStream: async (text, sink, signal, maxDurationMs) => {
          const profileKey = this.speechProfileKey();
          const result = await this.synthStreamAligned(text, sink, signal, maxDurationMs);
          if (!result.truncated) this.noteSpeechRate(text, result.durationMs, profileKey);
          return result;
        },
        alignPcm: (pcm, sampleRate, units) => this.alignPcmPrefix(pcm, sampleRate, units),
      },
      streamEnabled: () =>
        (this.streamEnabledOpt?.() ?? VTUBER_DEFAULTS.streamEnabled) && this.streamCapable(),
      alignEnabled: () => this.alignOn(),
      speechRate: () => this.speechRateHint(),
      yieldWindowMs: () => {
        const v = this.yieldWindowMsOpt?.();
        return typeof v === 'number' && Number.isFinite(v)
          ? Math.min(2000, Math.max(0, Math.round(v)))
          : VTUBER_DEFAULTS.yieldWindowMs;
      },
      yieldFadeMs: () => {
        const v = this.yieldFadeMsOpt?.();
        return typeof v === 'number' && Number.isFinite(v)
          ? Math.min(1000, Math.max(30, Math.round(v)))
          : VTUBER_DEFAULTS.yieldFadeMs;
      },
      audio: this.audio,
      mixer: this.mixer,
      backend: this.backend,
      log: host.log,
      broadcastFloorMs: () => this.broadcastFloor(),
      onDrained: () => this.armSilenceRemind(),
      stateTimeouts: (channel) => this.stateTimeoutMs(channel),
      trace: (area, msg, opts) => this.tracePerf(area, msg, opts),
      onCue: (cues) => this.stream.emit('cue', { cues }),
      onSubtitle: (payload) => this.stream.emit('subtitle', payload),
      onSubtitleCut: () => this.emitSubtitleCut('外部播放被截断'),
    });
    this.performer.start();
    // 失真滚动摘要:每窗口一行,计数全零那一窗不发。
    this.warnTally.clear();
    this.tallyTimer = setInterval(() => this.flushWarnSummary(), WARN_SUMMARY_MS);
    this.tallyTimer.unref?.();
    // 诊断报表定期覆盖 latest.json,为故障现场保留最近快照。
    if (this.diagDir) {
      this.diagTimer = setInterval(() => this.writeDiag('latest.json'), DIAG_AUTODUMP_MS);
      this.diagTimer.unref?.();
    }
    /*
     * 每次连上都重新识别模型,首连也算:bot 先于 VTS 启动时 connect() 抛
     * ECONNREFUSED,之后自动连上的那一次是本进程第一次认证成功;不补跑定档就
     * 整场回落默认档(眼睑中性错位、FX 文件名错)。VTS 里换模型同样重新定档。
     */
    this.vtsConnectedUnsub?.();
    this.vtsConnectedUnsub = this.vts.onConnected(() => {
      // 首连失败之后自己连上的那一次:灯还停在「未连」上,顺手翻回来
      this.vtsOk = true;
      void this.syncKnownParameters();
    });
    this.vtsModelLoadedUnsub?.();
    this.vtsModelLoadedUnsub = this.vts.onModelLoaded(() => {
      this.tracePerf('注入', 'VTS 换了模型,重新定档', { level: 'info', event: 'model-loaded' });
      void this.syncKnownParameters();
    });
    // 参数名单到手前不发帧(挂在 beginParameterSync 上),连接失败时解除
    this.backend.beginParameterSync();
    try {
      await this.vts.connect();
      this.vtsOk = true;
      host.log.info('VTube Studio 已连接');
      await this.syncKnownParameters();
      // 复位开局残留的反应表情;保留装扮与道具
      try {
        const cleared = await this.resetExpressions();
        if (cleared.length > 0) host.log.info('已复位激活表情', { cleared });
      } catch (err) {
        host.log.warn('复位表情失败(不影响演出)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      this.backend.cancelParameterSync();
      this.vtsOk = false;
      host.log.warn('VTube Studio 未连上(参数注入会在重连后恢复)', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stop(): Promise<void> {
    // 停机前等待整个演出队列，包括正在播放与尚未播放的片段。
    if (this.performer) {
      const waited = await this.performer.drainQueue(SHUTDOWN_DRAIN_MAX_MS);
      if (waited > 0) {
        this.tracePerf(
          '关机',
          waited >= SHUTDOWN_DRAIN_MAX_MS
            ? `等演出队列说完超过 ${SHUTDOWN_DRAIN_MAX_MS / 1000}s,照断`
            : `等演出队列说完:${Math.round(waited)}ms`,
          { level: 'info', event: 'drain', durMs: waited, data: { timedOut: waited >= SHUTDOWN_DRAIN_MAX_MS } },
        );
      }
      // 超时没说完的部分接下来会被 stop() 丢弃:丢了多少,记成事实
      const leftMs = this.performer.speechBacklogMs();
      const leftPieces = this.performer.unplayedPieces();
      if (leftMs > 0 || leftPieces > 0) {
        this.tracePerf(
          '关机',
          `关机丢词:还有 ${leftPieces} 片、约 ${Math.round(leftMs / 1000)} 秒台词没播出,停机丢弃`,
          { level: 'warn', tally: '关机丢词', event: 'drop', data: { pieces: leftPieces, backlogMs: Math.round(leftMs) } },
        );
      }
    }
    if (this.diagTimer) clearInterval(this.diagTimer);
    this.diagTimer = null;
    if (this.tallyTimer) clearInterval(this.tallyTimer);
    this.tallyTimer = null;
    // 停机前把最后一窗攒着的计数交出去(host 还在,这一行还发得出去)
    this.flushWarnSummary();
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.diagDir) this.writeDiag('latest.json'); // 收尾也留一份,便于事后回看
    this.host = null;
    this.performer?.stop();
    this.performer = null;
    this.audio.close();
    this.streamUp = false;
    this.vtsConnectedUnsub?.();
    this.vtsConnectedUnsub = null;
    this.vtsModelLoadedUnsub?.();
    this.vtsModelLoadedUnsub = null;
    // 上一场没跑完的那次同步不许被下一场认领(合并只在同一次连接内成立)
    this.knownSyncing = null;
    await this.stream.stop();
    await this.ttsServer.stop();
    await this.vts.close();
    this.vtsOk = null;
  }

  /** 播出延迟地板:每拍现问,配置热改即生效 */
  private broadcastFloor(): number {
    const host = this.host;
    if (!host) return 0;
    const delaySec = this.obsDelaySecOpt?.() ?? VTUBER_DEFAULTS.obsDelaySec;
    return broadcastFloorMs(host.store, this.delayedSourcesOpt?.() ?? [], delaySec * 1000, Date.now());
  }

  /** 演出流(SSE)地址;start 之后跟实际端口对齐。订阅端词表见 perform-stream.ts */
  get streamUrl(): string {
    return this.stream.streamUrl;
  }

  /** 观众弹幕输入通道(WS)地址 */
  get danmakuUrl(): string {
    return this.stream.danmakuUrl;
  }

  /** overlay 页地址:演出画面的唯一渲染实现,OBS browser source 与测试台 iframe 都指这里 */
  get overlayUrl(): string {
    return this.stream.overlayUrl;
  }

  /** 演出状态一行(在播/排队);代理侧把它作为投递成文事件随批送出(proxy.armStatus) */
  statusLine(): string | null {
    return this.performer?.statusLine() ?? null;
  }

  /**
   * 正在直播 = 演出链路起着且 overlay 有消费者(OBS browser source / 测试台
   * iframe 连着 SSE)。只看引擎在不在会把"进程起了但没人在播"也当直播,
   * 快拍心跳就 7×24 常开。
   */
  get live(): boolean {
    return this.performer !== null && this.stream.subscriberCount > 0;
  }

  tools(): ToolDef[] {
    const [act, interrupt] = VTUBER_TOOL_DECLS;
    return [
      {
        ...act,
        handler: async (args, ctx) => {
          if (typeof args.script !== 'string') return '[vtuber_act 失败] script 必须是字符串，本轮没有播出。';
          return this.handleAct(args.script, ctx.callId ?? null, ctx.signal);
        },
      },
      {
        ...interrupt,
        handler: async (_args, ctx) => this.handleInterrupt(ctx.callId ?? null),
      },
    ];
  }


  private onTapEvent(event: StreamEvent): void {
    if (event.type === 'response.created') { this.finishTapRound(true); return; }
    if (event.type === 'response.output_text.delta') {
      this.roundContent += event.delta;
      return;
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const item = event.item;
      if (item.name !== 'vtuber_act') {
        if (item.name === 'vtuber_interrupt') {
          this.noteInterruptFence(item.call_id);
          this.turnInterruptSeen = true;
        }
        return;
      }
      if (!this.performer) return;
      // 排队裁决在流开始的这一刻定夺:拒收就不开轮,增量直接不接
      const decision = this.decideSpeech(item.call_id);
      if (decision.kind === 'rejected') return;
      const handle = this.performer.beginRound({ callId: item.call_id });
      const redact = new StreamRedactor(
        () => this.mutedTexts(),
        (text) => {
          call.script += text;
          handle.feed(text);
        },
        (hit) =>
          this.tracePerf('禁播', `台本里滤掉禁播词:「${hit.slice(0, 30)}」`, { level: 'warn', tally: '禁播' }),
      );
      const boundary = new ExternalActScriptStreamNormalizer((text) => redact.feed(text));
      const call: StreamingCall = {
        index: event.output_index,
        callId: item.call_id,
        handle,
        redact,
        script: '',
        ended: false,
        boundary,
        json: new JsonScriptStream((text) => boundary.feed(text)),
      };
      this.streaming.set(event.output_index, call);
      return;
    }
    if (event.type === 'response.function_call_arguments.delta') {
      this.streaming.get(event.output_index)?.json.feed(event.delta);
      return;
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (event.item.status === 'completed') this.closeStreaming(event.output_index);
      else this.abortStreaming(event.output_index);
    }
  }

  /** 一轮流式响应收尾，再检查 content 是否误写了演出标签。 */
  private finishTapRound(aborted = false): void {
    if (aborted) this.abortStreaming();
    else this.closeStreaming();
    this.turnActCalls = 0;
    this.turnInterruptSeen = false;
    const leaked = this.roundContent;
    this.roundContent = '';
    this.remindIfContentLeaked(leaked);
  }

  /**
   * 排队裁决(每次 vtuber_act 一次,轮内首个调用才看策略)。
   *
   * 新台词始终追加,不自动抢占当前播放。积压超过上限时拒收;抢占只能由
   * vtuber_interrupt 显式触发。
   */
  private decideSpeech(callId: string | null, firstOfTurn?: boolean): SpeechDecision {
    const performer = this.performer;
    if (!performer) return { kind: 'queued', backlogMs: 0 };
    const backlogMs = performer.speechBacklogMs();
    const first = firstOfTurn ?? this.turnActCalls === 0;
    // 轮内计数只由流式 tap 推进——只有它认识"一轮回复"的边界(finishTapRound 清零)。
    // handler 兜底路径显式按轮首处理(firstOfTurn=true),它不隶属任何流式轮:让它
    // 也加一,下一轮真正的轮首就会被误判成"同轮续说"而整个绕过积压闸。
    const nth = firstOfTurn === undefined ? ++this.turnActCalls : this.turnActCalls + 1;
    const capMs = this.speechCapMs();
    let kind: SpeechDecision['kind'] = 'queued';
    let reason: SpeechDecision['reason'];
    if (first && this.turnInterruptSeen && backlogMs > 0 && backlogMs > capMs) {
      // 同轮先有 vtuber_interrupt:此刻读到的积压是打断执行前的旧水位,backlog 闸不成立
      this.tracePerf(
        '闸门',
        `放行:同轮已有 vtuber_interrupt,tap 时刻的积压读数(${Math.round(backlogMs / 1000)}s)按定义陈旧`,
      );
    } else if (first && backlogMs > 0 && backlogMs > capMs) {
      kind = 'rejected';
      reason = 'backlog';
      this.tracePerf('闸门', `拒收:积压 ${Math.round(backlogMs / 1000)}s 超上限`, {
        level: 'warn',
        tally: '拒收',
        event: 'reject',
        data: { reason, backlogMs: Math.round(backlogMs), capMs },
      });
    } else if (!first && nth > this.maxActRounds()) {
      // 同轮豁免的硬边界:一条回复复读工具调用时,这条是唯一还拦得住的闸
      kind = 'rejected';
      reason = 'turn-cap';
      this.tracePerf('闸门', `拒收:同一轮回复已开 ${this.maxActRounds()} 次演出,后续调用不再开轮`, {
        level: 'warn',
        tally: '拒收',
        event: 'reject',
        data: { reason, nth, maxActRounds: this.maxActRounds() },
      });
    }
    const decision: SpeechDecision = { kind, backlogMs, reason };
    if (callId) {
      this.callDecisions.set(callId, decision);
      // 最多保留 16 个近期调用决策。
      if (this.callDecisions.size > 16) {
        const first = this.callDecisions.keys().next().value;
        if (first !== undefined) this.callDecisions.delete(first);
      }
    }
    return decision;
  }

  /** tap 见到 vtuber_interrupt 调用头:把此刻的轮号记成这次打断的栅栏 */
  private noteInterruptFence(callId: string): void {
    const performer = this.performer;
    if (!performer || !callId) return;
    this.interruptFences.set(callId, performer.roundFence());
    if (this.interruptFences.size > 16) {
      const oldest = this.interruptFences.keys().next().value;
      if (oldest !== undefined) this.interruptFences.delete(oldest);
    }
  }

  /** 同轮演出封顶(可调,x-hot);垃圾值回落默认。取值依据见 SpeechDecision 上方注释。 */
  private maxActRounds(): number {
    const n = this.maxActRoundsPerTurnOpt?.() ?? VTUBER_DEFAULTS.maxActRoundsPerTurn;
    return Math.min(100, Math.max(1, Number.isFinite(n) ? Math.floor(n) : VTUBER_DEFAULTS.maxActRoundsPerTurn));
  }

  private speechProfileKey(): string {
    const ref = this.ttsProfile.refAudio;
    let refVersion: { size: number; mtimeMs: number } | null = null;
    if (ref) {
      const path = this.voicePath(ref);
      if (path) {
        try {
          const stat = statSync(path);
          refVersion = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
        } catch {
          refVersion = null;
        }
      }
    }
    return createHash('sha256')
      .update(JSON.stringify({ profile: this.ttsProfile, refVersion }))
      .digest('hex');
  }

  private restoreSpeechRate(): void {
    if (!this.speechRateLog) return;
    try {
      this.speechRateSamples.push(...this.speechRateLog.samples(this.speechProfileKey(), SPEECH_RATE_WINDOW));
    } catch (error) {
      if (!this.speechRateLogWarned) {
        this.speechRateLogWarned = true;
        this.tracePerf('语速', `历史语速日志读取失败,估计回到冷启动: ${String(error)}`, { level: 'warn' });
      }
    }
  }

  private noteSpeechRate(text: string, durationMs: number, profileKey = this.speechProfileKey()): void {
    const units = segmentUnits(text).length;
    if (units === 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
    const sample: SpeechRateSample = { units, durationMs, pauses: countPauses(text) };
    try {
      this.speechRateLog?.append(profileKey, sample);
    } catch (error) {
      if (!this.speechRateLogWarned) {
        this.speechRateLogWarned = true;
        this.tracePerf('语速', `语速样本日志写入失败: ${String(error)}`, { level: 'warn' });
      }
    }
    if (profileKey !== this.speechProfileKey()) return;
    this.speechRateSamples.push(sample);
    if (this.speechRateSamples.length > SPEECH_RATE_WINDOW) this.speechRateSamples.shift();
  }

  /**
   * 字幕估计档、跑飞门预算、锚点死线三处共用的语速口径:当前声线近期实测的净
   * 每单元时长分位(分位取法与理由见 speech-rate-log 的 SPEECH_RATE_QUANTILE)。
   * 净速率按估计式同一组引子与停顿先验扣减,估计侧再补回来,两项都只算一遍。
   *
   * 样本不足(冷启动、刚换声线、诊断目录关着)时回落 BUDGET_MS_PER_UNIT,并在
   * hint 里标明,埋点照原样印出来——「这条字幕的时刻是猜的还是量的」不该只有代码知道。
   */
  private speechRateHint(): SpeechRateHint {
    const q = netUnitMsQuantile(this.speechRateSamples, SPEECH_LEAD_IN_MS, PAUSE_PRIORS);
    if (q.msPerUnit === null) {
      return { msPerUnit: BUDGET_MS_PER_UNIT, measured: false, samples: q.samples };
    }
    if (!this.speechRateAnnounced) {
      this.speechRateAnnounced = true;
      this.tracePerf(
        '语速',
        `当前声线已有 ${q.samples} 条实测样本,估计路径切到 ${Math.round(q.msPerUnit)}ms/单元`
          + `(此前常数 ${BUDGET_MS_PER_UNIT});字幕估计档、跑飞门预算、锚点死线同源`,
        { level: 'info', event: 'measured', data: { samples: q.samples, msPerUnit: Math.round(q.msPerUnit), fallbackMsPerUnit: BUDGET_MS_PER_UNIT } },
      );
    }
    return { msPerUnit: q.msPerUnit, measured: true, samples: q.samples };
  }

  /** 换声线/换参考音频:旧声线的样本一条都不能留(profileKey 变了,估计也随之回冷启动) */
  private resetSpeechRate(): void {
    this.speechRateSamples.length = 0;
    this.speechRateAnnounced = false;
    this.restoreSpeechRate();
  }

  private speechCapMs(): number {
    const sec = this.speechCapSecOpt?.() ?? VTUBER_DEFAULTS.speechCapSec;
    return Math.min(120, Math.max(3, Number.isFinite(sec) ? sec : VTUBER_DEFAULTS.speechCapSec)) * 1000;
  }

  /** 禁播词表(| 分隔;装配层可注入 bot 专有条目,如交接占位符);空串条目剔除 */
  private mutedTexts(): string[] {
    const raw = this.mutedTextOpt?.() ?? '';
    return raw.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  private cleanMutedScript(script: string): string {
    let cleaned = script;
    for (const blocked of this.mutedTexts()) {
      if (!cleaned.includes(blocked)) continue;
      cleaned = cleaned.split(blocked).join('');
      this.tracePerf('禁播', `台本里滤掉禁播词:「${blocked.slice(0, 30)}」`, { level: 'warn', tally: '禁播' });
    }
    return cleaned;
  }

  private silenceRemindMs(): number {
    const sec = this.silenceRemindSecOpt?.() ?? VTUBER_DEFAULTS.silenceRemindSec;
    return Math.min(300, Math.max(1, Number.isFinite(sec) ? sec : VTUBER_DEFAULTS.silenceRemindSec)) * 1000;
  }

  private silenceTier = 0;

  /**
   * 静默阶梯的触发时刻表(ms,按总静默时长):一级必在,二三级要严格递增才生效。
   * 每次到点现算,x-hot 热改即时生效。
   */
  private silenceTierPlanMs(): number[] {
    const clampSec = (v: number | undefined, dft: number): number =>
      Math.min(600, Math.max(0, Number.isFinite(v as number) ? (v as number) : dft));
    const plan = [this.silenceRemindMs()];
    const t2 = clampSec(this.silenceRemind2SecOpt?.(), VTUBER_DEFAULTS.silenceRemind2Sec) * 1000;
    if (t2 > plan[0]) plan.push(t2);
    const t3 = clampSec(this.silenceRemind3SecOpt?.(), VTUBER_DEFAULTS.silenceRemind3Sec) * 1000;
    if (t3 > plan[plan.length - 1]) plan.push(t3);
    return plan;
  }

  /**
   * 见底后起静默计时,到点仍见底才投递提醒;期间有新台词则到点检查落空,
   * 下一次见底重新计时。提醒按 silenceTierPlanMs 的阶梯逐级加急
   * (默认 15/30/60s),开口后从头计。
   */
  private armSilenceRemind(): void {
    this.cancelSilenceRemind();
    if (!this.host) return;
    this.silenceTier = 0;
    this.scheduleSilenceTier(this.silenceTierPlanMs()[0]);
  }

  private scheduleSilenceTier(delayMs: number): void {
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      const host = this.host;
      if (!host || !this.performer || this.performer.speechBacklogMs() > 0) return;
      const plan = this.silenceTierPlanMs();
      const tier = Math.min(this.silenceTier, plan.length - 1);
      const totalSec = Math.round(plan[tier] / 1000);
      void this.pushSilenceRemind(host, tier, totalSec, plan[tier]).catch(() => {});
      if (tier + 1 < plan.length) {
        this.silenceTier = tier + 1;
        this.scheduleSilenceTier(Math.max(1000, plan[tier + 1] - plan[tier]));
      }
    }, delayMs);
    this.silenceTimer.unref?.();
  }

  private cancelSilenceRemind(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  /**
   * 投递静默提醒并附上 core 在该安静段内的调用阻塞次数。提醒标记 ephemeral，避免读过后持续累积在上下文。
   */
  private async pushSilenceRemind(
    host: WorldHost,
    tier: number,
    totalSec: number,
    windowMs: number,
  ): Promise<void> {
    let stalls = 0;
    try {
      stalls = (await host.llmStalls?.(windowMs)) ?? 0;
    } catch {
      // 宿主没接线或问不到:不猜,当没卡过说
      stalls = 0;
    }
    this.tracePerf(
      '水位',
      `安静满 ${totalSec}s,投递静默提醒(第 ${tier + 1} 级${stalls > 0 ? `;这段卡住 ${stalls} 次` : ''})`,
      { event: 'remind', data: { totalSec, tier: tier + 1, stalls } },
    );
    // 静默提醒是 World 自己这一侧机制的话,internal origin 进 user 区。
    await host.pushEvent(
      {
        ts: nowIso(this.timezone),
        source: this.id,
        type: 'worlds.note',
        origin: 'internal',
        ephemeral: true,
        text: silenceReminder(tier, totalSec, this.silenceLinesOpt?.()[tier], stalls),
      },
      { trigger: 'flush' },
    );
  }

  private async reportOutcomes(outcomes: RoundOutcome[]): Promise<void> {
    const host = this.host;
    if (!host) return;
    const rows = outcomes.filter(o => !o.complete && o.callId).map(o => {
      const aired = composeAiredScript(o);
      this.emitSubtitleCut(`轮#${o.roundId} 演出被打断`, aired.script);
      const precision = o.pieces.some(p => p.precision === 'estimated') ? 'estimated'
        : o.pieces.some(p => p.precision === 'aligned') ? 'aligned' : 'playback-state';
      return { callId: o.callId!, roundId: o.roundId, script: aired.script, reason: 'interrupted', precision };
    });
    if (rows.length === 0) return;
    await host.pushEvent({
      ts: nowIso(this.timezone), source: this.id, type: 'vtuber.act.outcome', origin: 'external', tags: ['speak'],
      text: '[本地演出结果] 原始调用表示拟发台词；以下记录中断时本地已播放的部分，未播放尾句已丢弃。\n' +
        rows.map(row => `vtuber_act call_id=${row.callId}，演出轮次=${row.roundId}，精度=${row.precision}：\n${row.script || '(尚未出声)'}`).join('\n\n') +
        '\n字符边界来自本地播放状态、对齐或时长估算，不表示观众端逐字接收确认。',
      meta: { outcomes: rows },
    }, { trigger: 'flush' });
  }

  /**
   * 字幕收束统一发送 SSE 并记录诊断；订阅端据此作废尚未上屏的 cue，将增量冻结在当前前缀。
   */
  private emitSubtitleCut(reason: string, script?: string): void {
    this.stream.emit('subtitle.cut', script === undefined ? {} : { script });
    const heardChars = script === undefined ? null : [...script].length;
    const heard = heardChars === null ? '' : `,已播出 ${heardChars} 字`;
    this.tracePerf('字幕', `收束:${reason}${heard};未上屏的 cue 作废,增量冻在当前前缀`, {
      event: 'cut',
      data: { reason, heardChars },
    });
  }

  private closeStreaming(index?: number): void {
    if (index === undefined) { for (const key of this.streaming.keys()) this.closeStreaming(key); return; }
    const call = this.streaming.get(index);
    if (!call) return;
    this.streaming.delete(index);
    call.ended = true;
    call.json.end();
    const normalization = call.boundary.end();
    call.redact.flush();
    call.handle.end();
    if (normalization.ok) {
      if (normalization.normalized) {
        this.tracePerf('台本边界', 'normalized_act_script:已解包 JSON 单元素字符串数组', {
          level: 'warn',
          tally: 'normalized_act_script',
        });
      }
    } else {
      this.tracePerf('台本边界', `${normalization.code}:拒绝外部容器形状`, {
        level: 'warn',
        tally: normalization.code,
      });
    }
    // 以 tool_call id 去重，确保同轮内容相同的调用仍分别演出。
    this.recentStreamed.set(call.callId, normalization);
    // 键被挤掉 = handler 认不出"这次已经流式开演过",于是再演一遍(同一段说两次)。
    // 保留量必须盖得住一整轮:开轮数已封顶(maxActRounds),再留一倍
    // 余量给已经闭合、但 handler 尚未消费的键。
    if (this.recentStreamed.size > this.maxActRounds() * 2) {
      const first = this.recentStreamed.keys().next().value;
      if (first !== undefined) this.recentStreamed.delete(first);
    }
  }

  /** 断流只结束已经送入 performer 的前缀，不释放任何解析器待定字节。 */
  private abortStreaming(index?: number): void {
    if (index === undefined) { for (const key of this.streaming.keys()) this.abortStreaming(key); return; }
    const call = this.streaming.get(index);
    if (!call) return;
    this.streaming.delete(index);
    call.ended = true;
    call.json.end();
    call.boundary.abort();
    call.redact.discard();
    call.handle.end();
    this.recentStreamed.delete(call.callId);
    this.callDecisions.clear();
  }

  /** 泄漏提醒的节流基准；每次提醒都会唤醒当前 session。 */
  private lastLeakRemindAt = 0;
  private static readonly LEAK_REMIND_COOLDOWN_MS = 60_000;

  /**
   * content 里出现演出标记 = 模型把台本当成了直接输出,观众什么都没听到。
   * 三种括号都认(与 ENV_PROMPT 的词表同源):【】本身就是演出语法;
   * <>/[] 在散文里太常见(markdown、链接),只有括出的词在词表里才算泄漏。
   */
  private contentLeaked(content: string): boolean {
    if (/【[^】]*】/.test(content)) return true;
    for (const m of content.matchAll(/<([^<>\n]{1,16})>/g)) {
      if (this.pack.resolveTag(m[1]) !== null) return true;
    }
    for (const m of content.matchAll(/\[([^\][\n]{1,16})\]/g)) {
      if (resolveVoiceTag(m[1]) !== null || this.pack.resolveTag(m[1]) !== null) return true;
    }
    return false;
  }

  private remindIfContentLeaked(content: string): void {
    if (!this.host) return;
    if (!this.contentLeaked(content)) return;
    // 内部唤醒会再次进入 agent 上下文;重复泄漏提醒按冷却节流以避免反馈循环。
    const now = Date.now();
    if (now - this.lastLeakRemindAt < VtuberWorld.LEAK_REMIND_COOLDOWN_MS) {
      this.tracePerf('提醒', '直接输出仍含演出标记,冷却中不重复提醒');
      return;
    }
    this.lastLeakRemindAt = now;
    const compact = content.replace(/\s+/g, ' ').trim();
    const quoted = compact.length > 200 ? `${compact.slice(0, 200)}…` : compact;
    this.tracePerf('提醒', `直接输出含演出标记(${compact.length}字),投递未送达提醒`);
    // 未送达提醒是 World 自己这一侧机制的话,internal origin 进 user 区。
    void this.host
      .pushEvent(
        {
          ts: nowIso(this.timezone),
          source: this.id,
          type: 'worlds.note',
          origin: 'internal',
          text:
            `[演出] 上一轮你写进直接输出的内容没有发给观众:\n「${quoted}」\n` +
            `观众只能听到 vtuber_act(script)。请用该工具把要对观众说的话重发一遍;` +
            `assistant content 不要放台词或演出标签(【】/<>/[])。`,
        },
        { trigger: 'flush' },
      )
      .catch(() => {});
  }


  private async handleAct(script: string, callId: string | null, signal?: AbortSignal): Promise<string> {
    let cleanupNote = '';
    const receipt = (text: string): string => text + cleanupNote;
    if (!this.performer) return receipt('[vtuber_act 失败] World 未启动');
    const streamedResult = callId === null ? undefined : this.recentStreamed.get(callId);
    if (callId !== null) this.recentStreamed.delete(callId);
    const normalization = streamedResult ?? normalizeExternalActScript(script);
    if (!normalization.ok) {
      if (!streamedResult) {
        this.tracePerf('台本边界', `${normalization.code}:拒绝外部容器形状`, {
          level: 'warn',
          tally: normalization.code,
        });
      }
      return receipt(invalidActScriptShapeReceipt());
    }
    const streamed = streamedResult !== undefined;
    if (normalization.normalized && !streamedResult) {
      this.tracePerf('台本边界', 'normalized_act_script:已解包 JSON 单元素字符串数组', {
        level: 'warn',
        tally: 'normalized_act_script',
      });
    }
    const cleaned = stripUnknownTags(normalization.script, this.pack);
    script = cleaned.script;
    const changes = [
      ...(normalization.normalized ? ['已解包外部 JSON 单元素字符串数组'] : []),
      ...(cleaned.dropped.length ? [`忽略词表外标记：${cleaned.dropped.join('、')}`] : []),
    ];
    cleanupNote = changes.length ? '\n[执行参数] ' + changes.join('；') + '。原始调用保留。' : '';
    /*
     * 无有效 script 内容的空调用不占播出资源，在积压与说话闸之前拒绝。回执点明空调用，不将其解释为主动沉默，并计入告警桶。
     */
    if (!script.trim()) {
      this.tracePerf('空台本', 'vtuber_act 的 script 是空串,这一轮没有任何内容播出', {
        level: 'warn',
        tally: '空台本',
      });
      return receipt((
        '[vtuber_act 没播出] 这次调用没有台词正文:script 是空串,一个字也没播出去。' +
        '要说话就把话写进 script 再调一次。'
      ));
    }
    // tap 时刻已裁决的取回;没经 tap 的(直连/测试)此刻裁决,每次都按轮首处理
    const decision = (callId ? this.callDecisions.get(callId) : undefined) ?? this.decideSpeech(callId, true);
    const backlogSec = Math.round(decision.backlogMs / 1000);
    // 这段本身要说多久:排队闸与回执都按它算,agent据此掂量一次说多少合适
    const selfSec = Math.round(this.performer.estimateScriptMs(script) / 1000);
    if (decision.kind === 'rejected') {
      if (decision.reason === 'turn-cap') {
        return receipt((
          `[未排入] 这一次回复里你已经连着开了 ${this.maxActRounds()} 次 vtuber_act,` +
          `这一段(约 ${selfSec} 秒)没有播出。一次回复把一段话说完就够了——` +
          `先结束这轮回复,等观众听完再接着说。`
        ));
      }
      return receipt((
        `[未排入] 你上一段话还有约 ${backlogSec} 秒没说完,这一段(约 ${selfSec} 秒)没有播出。` +
        `先听着,说完并安静一阵后我会提醒你;确实需要现在插话,就用 vtuber_interrupt 打断自己再说。`
      ));
    }
    if (!streamed) {
      // 没走流式 tap 的整段演出同样过禁播词滤除,两条路口径一致
      const cleaned = this.cleanMutedScript(script);
      const h = this.performer.beginRound({ callId });
      h.feed(cleaned);
      h.end();
    }
    const note =
      decision.backlogMs > 0
        ? `这段约 ${selfSec} 秒;前面还排着 ${backlogSec} 秒,` +
          `全部说完约 ${backlogSec + selfSec} 秒后。`
        : `这段约 ${selfSec} 秒。`;
    return receipt(`${streamed ? '已开演(流式)' : '已排入演出'}。${note}${this.performer.statusLine()}`);
  }

  /**
   * 主动打断在音频收束并持久化结果事件后返回。
   *
   * 只剪调用时刻已经在播/已入队的内容——栅栏见 interruptFences。晚于这次调用
   * 到达的 vtuber_act 不受影响,哪怕它先一步经 tap 开了演。
   */
  private async handleInterrupt(callId: string | null): Promise<string> {
    if (!this.performer) return '[vtuber_interrupt 失败] World 未启动';
    const fence = callId === null ? undefined : this.interruptFences.get(callId);
    if (callId !== null) this.interruptFences.delete(callId);
    const backlogMs = this.performer.speechBacklogMs();
    if (backlogMs === 0) return '嘴里没有正在说的话,无需打断。';
    this.tracePerf(
      '打断',
      `vtuber_interrupt(积压 ${Math.round(backlogMs / 1000)}s${fence === undefined ? '' : `,栅栏 #${fence}`})`,
      { event: 'interrupt', data: { backlogMs: Math.round(backlogMs), fence: fence ?? null } },
    );
    const outcomes = await this.performer.preempt(fence === undefined ? {} : { maxRoundId: fence });
    if (outcomes.length === 0) {
      this.tracePerf('打断', '调用时旧话已经说完,栅栏之后新排的台词照常播出');
      return '调用打断的时候旧话已经说完了;排在后面的是你这一轮新写的台词,没有动它。';
    }
    await this.reportOutcomes(outcomes);
    /*
     * 打断回执报告本地尚未播出的台词损失时长。
     */
    return (
      `已在停顿处收住:丢掉了还没播出的约 ${Math.round(backlogMs / 1000)} 秒台词,` +
      `实际已播放台词已通过结果事件记录。现在可以说新话了。`
    );
  }

  /** 弹幕立即写入事件；合批由核心的安静窗口与地板负责。 */
  private onDanmakuIn(text: string, from: string): void {
    // 观众弹幕的画面飘弹归 overlay:入站即广播,与注意力路由无关
    this.stream.emit('danmaku', { text, from });
    if (!this.host || !this.performer) return;
    this.performer.noteActivity();
    this.host.pushEvent({
      ts: nowIso(this.timezone),
      source: this.id,
      type: 'vtuber.danmaku',
      text: `[弹幕|${from}] ${text}`,
      senderKey: from,
    }).catch((e) => this.host?.log.warn('弹幕事件投递失败', { err: String(e) }));
  }
}

/** 播出延迟地板的常数余量:指令送达/渲染抖动 */
const BROADCAST_EPSILON_MS = 60;

/**
 * 防先知穿帮:OBS 把游戏画面延迟 N 播出,agent通过事件在 t 就知道了——
 * 反应不得早于观众看到起因。延迟源近期(N 内)有事件,地板 = 事件时刻 + N + ε。
 * 只读信封的 core 字段(source/ts),不认识任何游戏词表;扫描以 ts ≤ now−N 为界
 * 天然有界(更老的事件给出的地板已在过去)。
 */
export function broadcastFloorMs(
  store: EventStoreReader,
  sources: string[],
  delayMs: number,
  now: number,
): number {
  if (delayMs <= 0 || sources.length === 0) return 0;
  let floor = 0;
  for (let cursor = store.latestCursor(); cursor >= 0; cursor--) {
    const e = store.get(cursor);
    if (!e) break;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (ts <= now - delayMs) break;
    // 只有经延迟画面呈现的外部事件参与播出地板计算；内部项绕过画面。
    if (e.origin === 'external' && sources.includes(e.source)) {
      floor = Math.max(floor, ts + delayMs + BROADCAST_EPSILON_MS);
    }
  }
  return floor;
}

/** 调用刻现取目标 logger 的转发器;目标缺席(host 未挂载/已卸载)时记录丢弃。 */
function forwardLogger(get: () => Logger | undefined): Logger {
  return {
    trace: (m, d) => get()?.trace(m, d),
    debug: (m, d) => get()?.debug(m, d),
    info: (m, d) => get()?.info(m, d),
    warn: (m, d) => get()?.warn(m, d),
    error: (m, d) => get()?.error(m, d),
    emit: (level, m, o) => get()?.emit(level, m, o),
    child: (sub) => forwardLogger(() => get()?.child(sub)),
  };
}
