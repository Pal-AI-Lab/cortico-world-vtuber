/**
 * VTuber 演出 World 的面板 bundle —— 挂载 / 模型档案 / Overlay / 动作调参 / 声线档案 /
 * 时间点标注 / 离线歌曲 / 演出日志 / 演出诊断九个面板。
 *
 * 这个文件只做两件事:**装配**(把面板接到局部 id 上)与**共享 helper**
 * (类型、错误措辞、几个输入与资源生命周期包装)。面板本体各在自己的文件里。
 *
 * 与外界的依赖只有一条:`cortico/web/shared/client-panel.ts` 里的**类型**——浏览器侧
 * 只 `import type`,运行时的值(`toDisposable`、图标)在包内自带。没有
 * import 控制台内部模块,没有 `fetch`,没有 `document.body`,没有 `window.__*`——
 * 数据面一律走 `ctx.invoke` / `ctx.invokeBinary`,DOM 一律用 `ctx.ui` 的原语,
 * 定时器一律走 `ctx.interval`,RAF 走 `ctx.frame`,ObjectURL / AudioContext /
 * ResizeObserver / `<audio>` 一律交给 `ctx.own`。
 *
 * `style.css` 是本 provider 自己的样式:只放 `ctx.ui` 没有对应原语的那几块
 * (挂载行、几个要定宽的数字框、色板输入、overlay 预览窗、波形画布),用 `vt-`
 * 前缀避开控制台的通用 class,颜色取自控制台的主题变量,所以浅深色两套皮都跟着走。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
  Disposable,
} from 'cortico/web/shared/client-panel.ts';
import { toDisposable } from './disposable.ts';
import './style.css';
import { mountPanel } from './mount.ts';
import { modelPanel } from './model.ts';
import { overlayPanel } from './overlay.ts';
import { clipsPanel } from './clips.ts';
import { ttsPanel } from './tts.ts';
import { alignPanel } from './align.ts';
import { logPanel } from './log.ts';
import { diagPanel } from './diag.ts';

// ---------------------------------------------------------------------------
// 共享类型:服务端 `VtuberWorldProxy.invokePanel` 各方法的返回形状
// ---------------------------------------------------------------------------

/** `mount.vtsState`(也是 `mount.state` 里的 `vts` 一支) */
export interface VtsState {
  connected: boolean;
  url: string;
  /** 已持有授权 token;没有的话连接时 VTS 会弹授权窗 */
  tokenSet: boolean;
  model: { name: string; id: string } | null;
}

/**
 * TTS 子进程当前加载的资源(`tts.state` 的 `local.resources`,`mount.ttsState` 不带)。
 *
 * 路径 `ready` 与 `configured` 都要看:前者说文件在不在,后者说这个路径是不是配置给的
 * ——自备目录里的权重与随包目录的同名文件在面板上是两回事。
 */
export interface TtsResources {
  server: { path: string; ready: boolean };
  baseLm: { path: string; ready: boolean; configured: boolean };
  acoustic: { path: string; ready: boolean; configured: boolean };
  alignerLm: { path: string; ready: boolean; configured: boolean };
  alignerAudio: { path: string; ready: boolean; configured: boolean };
  /** 任一对齐路径显式配置后,对齐模型成为本次启动的必需资源 */
  alignerRequired: boolean;
  alignerReady: boolean;
  ready: boolean;
}

/**
 * 本地进程的启停状态与它加载的资源。
 *
 * `tts.state` 的 `local` 带 `resources`(面板要报"缺哪个权重");`mount.ttsState`
 * 只带其中的就绪读数,所以那几项在挂载行上是可缺席的。
 */
export interface TtsLocalProcess {
  phase: string;
  url: string;
  pid: number | null;
  detail: string | null;
  resources?: TtsResources;
}

/** `tts.state` 的 `local`:本地进程状态 + 探得通与否。external 服务为 null。 */
export interface TtsLocalState extends TtsLocalProcess {
  reachable: boolean;
  resources: TtsResources;
}

/** 本地 llama-tts-server 的运行状态(旧的 `mount.ttsState` 形状)。 */
export interface TtsState extends TtsLocalProcess {
  reachable?: boolean;
  resources: TtsResources;
}

/** `mount.ttsState`(也是 `mount.state` 里的 `tts` 一支)。 */
export interface TtsMountState {
  serviceId: string;
  serviceName: string;
  protocol: string;
  /** 已落盘的配置版本 */
  savedRevision: number;
  /** 演出子进程确认应用到的版本 */
  appliedRevision: number;
  /** 已保存,但子进程还没确认应用 */
  pendingApply: boolean;
  /** 当前服务由 World 管本地进程时为真;external 服务没有启停可言 */
  managed: boolean;
  /** managed 服务的进程状态;external 服务为 null */
  local: TtsLocalProcess | null;
  /** 本地进程的阶段;external 服务是 `external`,不是错误 */
  phase: string;
  pid: number | null;
  detail: string | null;
  url: string;
  reachable: boolean;
}

/** `mount.state`:三条链路一次问齐。某一条拿不到就是 null(那一行显示"不可用")。 */
export interface MountState {
  vts: VtsState | null;
  tts: TtsMountState | null;
  stream: { up: boolean; url: string | null } | null;
}

/** `model.state` */
export interface ModelState {
  configured: string;
  activeId: string;
  activeLabel: string;
  how: 'configured' | 'matched' | 'fallback' | 'missing';
  vtsModelName: string;
  vtsConnected: boolean;
  /** VTube Studio 的 Live2DModels 目录;档案在它的子目录里发现 */
  live2dDir: string;
  profileFile: string | null;
  registryErrors: Array<{ file: string; message: string }>;
  modelFile: { vtubeFile: string | null; warnings: string[] } | null;
  /** 当前演出包目录 */
  packDir: string;
  /** 生效档案与演出包对不上的条目 */
  profileWarnings: string[];
  choices: Array<{ value: string; label: string; vtsModelName: string }>;
  caveat: string | null;
  unsupported: string[];
  lastCheck: WiringReport | null;
}

export interface WiringRow {
  id: string;
  status: string;
  hits?: Array<{ param: string; gain: number }>;
  losesIfMissing: string;
}

export interface WiringReport {
  rows: WiringRow[];
  dead: string[];
  vtsModelName?: string;
  elapsedMs?: number;
}

/** `overlay.state` */
export interface OverlayState {
  url: string | null;
  streamUp: boolean;
  config: OverlayConfig;
}

export interface OverlaySubtitleStyle {
  scale: number;
  weight: number;
  maxLines: number;
  color: string;
  strokeColor: string;
  strokeW: number;
  plate: number;
  fontFamily: string;
}

export interface OverlayConfig {
  subtitles: boolean;
  cues: boolean;
  danmaku: boolean;
  subtitle: OverlaySubtitleStyle;
}

/** `clips.state` */
export interface ClipsItem {
  clipId: string;
  word: string;
  kind: string;
  durationMs?: number;
}

export interface ClipsState {
  vtsConnected: boolean;
  file: string;
  groups: Array<{ label: string; items: ClipsItem[] }>;
}

/**
 * 声线档案(`tts.setProfile` 收的、`tts.state` 里回的那份)。
 *
 * 字段名与 World 的 `TtsProfile` 一字不差:面板把整份表单原样交回去,服务端钳制后
 * 回一份生效值。这里不复制那些上下界——钳制归 World,面板只负责如实读出来。
 */
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

/** voices/ 里的一条声线:wav 文件 + 同名 .txt 的转写(没有则空) */
export interface TtsVoiceInfo {
  file: string;
  text: string;
}

export type TtsProtocol = 'openai-speech' | 'voxcpm-legacy';
export type TtsManagement = 'external' | 'managed-voxcpm';
export type TtsResponseFormat = 'wav' | 'pcm' | 'mp3' | 'opus' | 'aac' | 'flac';
export type TtsDelivery = 'auto' | 'buffered';

/** JSON 值;扩展参数(`extraBody`)只收这一集。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** raw PCM 输出的音频描述;不声明时服务端按 24 kHz 单声道。 */
export interface TtsPcmConfig {
  sampleRate: number;
  channels: 1 | 2;
  encoding: 's16le';
}

/** legacy 运行时路径集合;只对 voxcpm-legacy 服务有意义。 */
export interface TtsLegacyRuntime {
  runtimeDir: string;
  runtimeRelease: string;
  baseLmFile: string;
  acousticFile: string;
  alignerLmFile: string;
  alignerAudioFile: string;
  voicesDir: string;
}

/**
 * 一条 TTS 服务。`speechPath` / `speed` / `instructions` / `extraBody` / `headers` /
 * `pcm` / `legacy` 都是可缺席的:省略就是"这一条没有它",`normalizeService` 落盘时
 * 也不会补一个空壳上去。
 */
export interface TtsServiceConfig {
  id: string;
  name: string;
  protocol: TtsProtocol;
  management: TtsManagement;
  /** API 前缀(通常含 /v1);不是完整 speech 地址 */
  baseUrl: string;
  /** 相对 API 前缀的路径;缺省 audio/speech */
  speechPath?: string;
  auth: TtsServiceAuth;
  model: string;
  voice: string | { id: string };
  responseFormat: TtsResponseFormat;
  delivery: TtsDelivery;
  timeoutMs: number;
  speed?: number;
  instructions?: string;
  extraBody?: Record<string, JsonValue>;
  /** 非敏感扩展头;鉴权头走 auth */
  headers?: Record<string, string>;
  pcm?: TtsPcmConfig;
  legacy?: { profile: TtsProfile; runtime: TtsLegacyRuntime };
}

/**
 * 面板交回去的鉴权。密钥名由服务端按服务 id 派生,所以表单只在**换服务时**
 * 带上已经生效的那个 `secretRef`;其余情况下传 `{ type: 'bearer' }`,
 * 由 `normalizeService` 沿用原值或派生一个新的。
 */
export type TtsServiceAuth =
  | { type: 'none' }
  | { type: 'bearer'; secretRef?: string };

/** `services.state` 里那一条:密钥材料已被剥掉,只剩"是否已设置"。 */
export type PublicTtsService = Omit<TtsServiceConfig, 'auth'> & {
  auth: { type: 'none' } | { type: 'bearer'; secretRef: string; apiKeyConfigured: boolean };
};

/** `tts.services` 里那几只"已保存 / 已应用"的读数;`tts.state` 只回其中的 appliedRevision。 */
export interface TtsApplyState {
  savedRevision: number;
  appliedRevision: number;
  appliedServiceId: string;
  pendingApply: boolean;
}

/** `tts.services`:服务表(已脱敏)连同"已保存 / 已应用"的差别。 */
export interface TtsServicesState extends TtsApplyState {
  version: number;
  /** 已落盘的配置版本;保存时要原样回传作 baseRevision */
  revision: number;
  activeServiceId: string;
  services: PublicTtsService[];
  /** 读写这条注册表时攒下的诊断(虚拟迁移、地址异常等) */
  notes: string[];
  /** 配置读不出来时的错误;此时 services 为空 */
  error?: string;
  protectedIds: string[];
}

/** `tts.saveService` / `activateService` / `deleteService` 的回执。 */
export interface TtsSaveReceipt extends TtsApplyState {
  message: string;
}

/** `tts.state`:当前服务、本地进程、生效档案与声线库一次问齐 */
export interface TtsPanelState {
  registry: Omit<TtsServicesState, keyof TtsApplyState>;
  /** 子进程当前应用的配置版本;小于 revision 即"已保存未应用" */
  appliedRevision: number;
  /** 本地 llama-tts-server 的进程状态;当前服务是 external 时为 null(没有本地资源不是错误) */
  local: TtsLocalState | null;
  /** 当前服务是否由 World 管理本地进程 */
  managed: boolean;
  /** 当前服务是否是内置 legacy 条目(声线与本地运行时区域只对它展示) */
  legacy: boolean;
  /** World 实际当作内置 legacy 条目的那一条 id;空串 = 没有 legacy 条目 */
  builtinServiceId: string;
  /** 内置 legacy 条目的声线档案 */
  profile: TtsProfile;
  voices: TtsVoiceInfo[];
  /** voices/ 的绝对路径,提示人参考音频缓存在哪 */
  voicesDir: string;
}

/** `tts.saveVoice` 的回执 */
export interface SavedVoice {
  file: string;
  path: string;
  /** 转码前的源格式;输入为 WAV 时是 null */
  converted: string | null;
}

/** `tts.test` / `tts.testService` 的回执(wav 是 base64) */
export interface TtsTestResult {
  message: string;
  wav: string | null;
}

/** `align.state` */
export interface AlignState {
  /** 演出流水线里每片都标注(配置项「逐分片时间点标注」) */
  enabled: boolean;
  /** 当前 TTS 服务有没有对齐能力;false 是"没有配置对齐",不是"对齐失败" */
  capable: boolean;
  /** 对齐器随 TTS server 加载了 */
  available: boolean;
  lastOk: boolean | null;
}

/** 一个对齐单元:中日文逐字,英文逐词,标点不参与 */
export interface AlignUnit {
  text: string;
  /** 秒,相对音频起点 */
  start: number;
  end: number;
}

/** `align.align` 的回执 */
export interface AlignRun {
  units: AlignUnit[];
  duration: number;
  verdict: { ok: boolean; reasons: string[]; coverage: number };
  elapsedMs: number;
}

/** `log.entries` */
export interface PerfLogEntry {
  seq: number;
  ts: string;
  area: string;
  msg: string;
}

/** `diag.state`:落盘状态与当前报表一起回 */
export interface DiagState {
  state: { dir: string | null; autoDumpSec: number; lastDump: string | null };
  report: DiagReport;
}

/** 报表只有面板要读的那几支写成类型,其余原样进 JSON 抽屉 */
export interface DiagReport {
  window?: { evalHz?: number };
  inject?: {
    sentHz?: number;
    dropPct?: number;
    droppedBusy?: number;
    rejectedParams?: string[];
  };
  state?: {
    performer?: {
      mode?: string;
      queuedBeats?: number;
      playing?: boolean;
      states?: Record<string, number | string | null | undefined>;
    } | null;
  };
  params?: Record<string, { jumps?: DiagJump[] }>;
}

export interface DiagJump {
  from: number;
  to: number;
  delta: number;
  dtMs: number;
  dBy?: Record<string, number>;
  duck?: [number, number];
}

// ---------------------------------------------------------------------------
// 共享 helper
// ---------------------------------------------------------------------------

/** 错误 → 一句人话。`ConsoleInvokeError` 带的就是服务端的中文措辞。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 改写一条 `msgline` 的正文与配色。
 *
 * `ui.msgline(text, bad)` 只管建节点;面板上那一行消息是活的(每次操作都改),
 * 所以要有一条改写路径。`bad` 是 `styles.css` 里 `.msgline.bad` 的那个 class,
 * 与原语建节点时用的是同一个。
 */
export function setMsg(el: HTMLElement, text: string, bad = false): void {
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

/**
 * 带上下界与步长的数字输入。
 *
 * `ConsoleInputOptions` 有 `type: 'number'` 但没有 `min` / `max` / `step` / 宽度,
 * 而这几个面板上的数字框(幅度、字号、行数、录制秒数)全都要。原语返回的是真
 * `<input>`,所以这里补设原生属性;宽度走本 provider 自己的 class。
 */
export function numField(
  ctx: ConsolePanelContext,
  opts: {
    value: number;
    min: number;
    max: number;
    step?: number;
    /** 追加到 `field` 之后的本 provider class(定宽用) */
    cls?: string;
    onChange?: (value: number) => void;
  },
): HTMLInputElement {
  const onChange = opts.onChange;
  const el = ctx.ui.input({
    type: 'number',
    value: String(opts.value),
    cls: opts.cls ?? 'vt-num',
    ...(onChange ? { onChange: (v: string) => onChange(Number(v)) } : {}),
  });
  el.min = String(opts.min);
  el.max = String(opts.max);
  el.step = String(opts.step ?? 1);
  return el;
}

/**
 * 色板输入。`ConsoleInputOptions.type` 的枚举里没有 `color`(它是个跨 provider 少见的
 * 类型),所以这里拿原语建出节点后改 `type`——这样 `field` 的皮、以及 `onChange`
 * 那条**带 `signal` 的监听**都还是原语给的,面板不必自己装监听。
 */
export function colorField(
  ctx: ConsolePanelContext,
  value: string,
  onChange: (value: string) => void,
): HTMLInputElement {
  const el = ctx.ui.input({ value, cls: 'vt-color', onChange });
  el.type = 'color';
  return el;
}

/** 一行灰色小注(导入提示、单元预览这类)。 */
export function dimLine(ctx: ConsolePanelContext, text = ''): HTMLElement {
  return ctx.ui.h('div', 'pagedesc vt-dim', text);
}

/** 「最终请求地址」的默认路径段;服务端 `speechUrlOf` 同值。 */
export const TTS_SPEECH_PATH_DEFAULT = 'audio/speech';

/** 单片合成超时的上下界与默认值;与 `TTS_TIMEOUT_*` 同值,钳制仍归服务端。 */
export const TTS_TIMEOUT_MIN_MS = 1_000;
export const TTS_TIMEOUT_MAX_MS = 90_000;
export const TTS_TIMEOUT_DEFAULT_MS = 60_000;

/**
 * 合成请求的最终地址。与 World 的 `speechUrlOf` 同一套拼法:纯字符串接缝,
 * 不用 `new URL(rel, base)`——反向代理前缀(`https://host/tts/v1`)会被它吃掉。
 */
export function speechUrlOf(service: Pick<TtsServiceConfig, 'baseUrl' | 'speechPath'>): string {
  const base = service.baseUrl.trim().replace(/\/+$/, '');
  const path = (service.speechPath ?? '').trim().replace(/^\/+/, '') || TTS_SPEECH_PATH_DEFAULT;
  return `${base}/${path}`;
}

// ---------------------------------------------------------------------------
// 二进制:base64 ⇄ 字节
// ---------------------------------------------------------------------------

/** 一次 `String.fromCharCode` 的实参上限。整段铺开会爆调用栈(几 MB 的 wav 是常态)。 */
const B64_CHUNK = 0x8000;

/** 字节 → base64(上传参考音频、把本地文件交给对齐器)。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

/**
 * base64 → 字节(合成回来的 wav:要播、要存、还要解码画波形)。
 *
 * 回的是 `Uint8Array<ArrayBuffer>` 而不是默认的 `ArrayBufferLike`:`Blob` 的
 * `BlobPart` 不收后者(那里面还含 `SharedArrayBuffer`),而这几段字节的去处
 * 恰恰全是 Blob。
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// 生命周期:ObjectURL 槽位与 `<audio>` 元素
// ---------------------------------------------------------------------------

/**
 * **单槽** ObjectURL:一个槽里同时只挂一份 URL,换新的先撤旧的,面板卸载时撤干净。
 *
 * 为什么是槽而不是"每建一个就 `ctx.own` 一份":试听/下载是可以按一百次的按钮,
 * 每次登记一份就是一条只增不减的账本(旧值早就没人引用了,却要留到面板卸载)。
 * 槽只登记一次,后面每次 `set` 自己顶掉前一份。
 *
 * 一个面板可以开多个槽——播放器与下载各用各的:共用一个的话,点一次"保存 wav"
 * 会把正在播的那份 URL 撤掉,播放当场断。
 */
export interface UrlSlot {
  /** 换一份内容,返回新 URL(上一份当场 revoke)。 */
  set(blob: Blob): string;
  /** 提前撤下(不必调;面板卸载时自动撤)。 */
  clear(): void;
}

export function urlSlot(ctx: ConsolePanelContext): UrlSlot {
  let url: string | null = null;
  const clear = (): void => {
    if (!url) return;
    URL.revokeObjectURL(url);
    url = null;
  };
  ctx.own(toDisposable(clear));
  return {
    set(blob: Blob): string {
      clear();
      url = URL.createObjectURL(blob);
      return url;
    },
    clear,
  };
}

/**
 * 一个随面板收场的 `<audio>`。
 *
 * **不登记就是最难发现的那种泄漏**:离开面板后 DOM 被清空,但那个元素还在解码、
 * 还在出声——用户听得见一个已经不存在的页面在放音。所以卸载时暂停、摘 `src`、
 * 再 `load()` 一次让它真的松开那份资源(光 `pause()` 不摘 src 的话缓冲还挂着)。
 */
export function ownedAudio(ctx: ConsolePanelContext): HTMLAudioElement {
  const el = ctx.ui.h('audio');
  el.preload = 'auto';
  ctx.own(toDisposable(() => {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }));
  return el;
}

/**
 * 等 `ms` 毫秒。**不用裸 `setTimeout`**:那条计时器不认 `ctx.signal`,面板卸了
 * 它还在,`await` 之后那段代码会往一棵已经被清空的 DOM 里写。
 *
 * `ctx.interval` 登记过、卸载自动停;这里跑一拍就自己撤下。面板卸载时 promise
 * 落在 `false` 上(而不是永挂),调用方 `await` 之后照常走它的收尾。
 */
export function delay(ctx: ConsolePanelContext, ms: number): Promise<boolean> {
  if (ctx.signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let timer: Disposable | null = null;
    const stop = (ok: boolean): void => {
      timer?.dispose();
      resolve(ok);
    };
    ctx.signal.addEventListener('abort', () => stop(false), { once: true });
    timer = ctx.interval(() => stop(true), ms);
  });
}

// ---------------------------------------------------------------------------

const bundle: ConsoleClientBundle = {
  /**
   * 键是**局部** panel id,与服务端 `console().panels[].id` 一一对应
   * (`src/world.ts` 的 `VTUBER_PANEL_DECLS`)。
   *
   * 声明与面板 bundle**同进同退**:这里少一个键,控制台就给一张"面板产物缺这个面板"的错误卡;
   * 那边少一条声明,面板就在导航里够不着。八个面板两处必须逐条对上——
   * `tests/web/worlds-vtuber-console.test.ts` 拿这两份清单对咬。
   */
  panels: {
    mount: mountPanel,
    model: modelPanel,
    overlay: overlayPanel,
    clips: clipsPanel,
    tts: ttsPanel,
    align: alignPanel,
    log: logPanel,
    diag: diagPanel,
  },
};

export default bundle;
