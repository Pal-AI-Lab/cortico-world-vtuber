/**
 * TTS 配置模型:类型、校验、旧配置解析与公开状态脱敏。
 *
 * 新结构 `worlds.vtuber.tts` 是唯一权威;旧扁平字段(ttsUrl / ttsProfile /
 * runtime 路径)只能经本模块的映射读入,不再各自被消费。旧部署没有 `tts` 时
 * 在内存合成一条 legacy 服务,读操作不改盘。
 *
 * 两种协议与两种管理的组合:
 * - protocol:  openai-speech(标准 Speech 请求)/ voxcpm-legacy(旧请求与私有流式)
 * - management: external(用户自己跑)/ managed-voxcpm(允许 World 用原管理器管本地进程)
 */

/** VoxCPM2 声线档案:参考音频 + 生成参数。 */
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

export const TTS_PROFILE_LIMITS = {
  seed: [0, 2 ** 31 - 2],
  cfgValue: [0.1, 10],
  inferenceTimesteps: [1, 100],
  maxSteps: [10, 2000],
  temperature: [0.05, 2],
} as const;

export type TtsProtocol = 'openai-speech' | 'voxcpm-legacy';
export type TtsManagement = 'external' | 'managed-voxcpm';
export type TtsResponseFormat = 'wav' | 'pcm' | 'mp3' | 'opus' | 'aac' | 'flac';
export type TtsDelivery = 'auto' | 'buffered';
export type TtsAuth = { type: 'none' } | { type: 'bearer'; secretRef: string };

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** raw PCM 输出的音频描述;标准协议下服务商不声明时按 24 kHz 单声道。 */
export interface TtsPcmConfig {
  sampleRate: number;
  channels: 1 | 2;
  encoding: 's16le';
}

/** legacy 运行时路径集合;原扁平字段的完整投影。 */
export interface TtsLegacyRuntimeConfig {
  runtimeDir: string;
  runtimeRelease: string;
  baseLmFile: string;
  acousticFile: string;
  alignerLmFile: string;
  alignerAudioFile: string;
  voicesDir: string;
}

export interface TtsServiceConfig {
  /** 稳定标识;不随改名改变 */
  id: string;
  name: string;
  protocol: TtsProtocol;
  management: TtsManagement;
  /** API 前缀(通常含 /v1);不是完整 speech URL */
  baseUrl: string;
  /** 相对 API 前缀的路径;默认 audio/speech */
  speechPath?: string;
  auth: TtsAuth;
  model: string;
  voice: string | { id: string };
  responseFormat: TtsResponseFormat;
  delivery: TtsDelivery;
  timeoutMs: number;
  speed?: number;
  instructions?: string;
  extraBody?: Record<string, JsonValue>;
  /** 非敏感扩展头;鉴权头必须走 auth */
  headers?: Record<string, string>;
  pcm?: TtsPcmConfig;
  /** 只对 voxcpm-legacy 有意义:旧声线档案与本地运行时路径 */
  legacy?: {
    profile: TtsProfile;
    runtime: TtsLegacyRuntimeConfig;
  };
}

export interface TtsRegistryConfig {
  version: number;
  /** 服务端维护;用于并发修改与子进程应用确认 */
  revision: number;
  activeServiceId: string;
  services: TtsServiceConfig[];
}

export const TTS_REGISTRY_VERSION = 1;
/** 虚拟迁移出来的内置条目 id;旧声线编辑写回这一条 */
export const LEGACY_SERVICE_ID = 'legacy-default';
/** 内置条目受保护:不可删除,保证至少一条可选服务 */
export const PROTECTED_SERVICE_IDS: readonly string[] = [LEGACY_SERVICE_ID];

/** 旧扁平字段;新配置缺席时从这里做兼容映射。 */
export interface TtsLegacySource {
  ttsUrl?: unknown;
  ttsProfile?: unknown;
  ttsRuntimeDir?: unknown;
  ttsRuntimeRelease?: unknown;
  ttsBaseLmFile?: unknown;
  ttsAcousticFile?: unknown;
  ttsAlignerLmFile?: unknown;
  ttsAlignerAudioFile?: unknown;
  ttsVoicesDir?: unknown;
}

export interface TtsSectionSource extends TtsLegacySource {
  tts?: unknown;
}

export type TtsRegistryRead =
  | { ok: true; registry: TtsRegistryConfig; virtual: boolean; notes: string[] }
  | { ok: false; error: string };

/**
 * 面板读到的公开状态。密钥永不出现在这里,只报"是否已设置"。
 * `revision` 与 `activeServiceId` 供面板判断"已保存"与"已应用"的差别。
 */
export interface PublicTtsService extends Omit<TtsServiceConfig, 'auth'> {
  auth: { type: 'none' } | { type: 'bearer'; secretRef: string; apiKeyConfigured: boolean };
}

export interface PublicTtsRegistry {
  version: number;
  revision: number;
  activeServiceId: string;
  services: PublicTtsService[];
  /** 读写这条注册表时攒下的诊断(虚拟迁移、地址异常等) */
  notes: string[];
  /** 配置读不出来时的面向操作者错误;此时 services 为空 */
  error?: string;
  protectedIds: string[];
}

const FORMATS: readonly TtsResponseFormat[] = ['wav', 'pcm', 'mp3', 'opus', 'aac', 'flac'];
const PROTOCOLS: readonly TtsProtocol[] = ['openai-speech', 'voxcpm-legacy'];
const MANAGEMENTS: readonly TtsManagement[] = ['external', 'managed-voxcpm'];
const DELIVERIES: readonly TtsDelivery[] = ['auto', 'buffered'];
const SECRET_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVICE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** 这些头由适配器自己决定,不接受用户在 headers 里覆盖 */
const RESERVED_HEADERS = new Set(['authorization', 'content-length', 'host', 'content-type']);
/** 顶层已受控的键;extraBody 与它们冲突时直接失败,不做后写覆盖 */
const RESERVED_BODY_KEYS = new Set([
  'input', 'model', 'voice', 'response_format', 'stream_format', 'speed', 'instructions',
  'reference_audio', 'prompt_text', 'seed', 'cfg_value', 'inference_timesteps', 'max_steps',
  'temperature',
]);
const EXTRA_BODY_MAX_DEPTH = 8;
const EXTRA_BODY_MAX_BYTES = 4096;
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 单片合成超时的边界。面板 RPC 的死线是 120s,而一次试听最多是
 * 「HTTP 一次 + 压缩格式转码一次」:60s + 30s 留出对齐与排队余量,
 * 所以这里不放开到贴着死线。
 */
export const TTS_TIMEOUT_MIN_MS = 1_000;
export const TTS_TIMEOUT_MAX_MS = 60_000;
export const TTS_TIMEOUT_DEFAULT_MS = 60_000;
/** 压缩格式输出转码的预算;与 HTTP 超时成套,合计不越过面板死线 */
export const TTS_TRANSCODE_BUDGET_MS = 30_000;
const SPEED_LIMITS = [0.25, 4] as const;
const PCM_SAMPLE_RATE_LIMITS = [8_000, 192_000] as const;
const INSTRUCTIONS_MAX = 1_000;

function clampNum(v: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 声线档案钳制;控制台、迁移与兼容入口共用同一条路径。 */
export function clampTtsProfile(patch: Partial<TtsProfile>, base: TtsProfile = TTS_PROFILE_DEFAULTS): TtsProfile {
  const p = { ...base, ...patch };
  // refAudio 只接受 voices/ 中的裸文件名,拒绝路径穿越
  const refAudio =
    typeof p.refAudio === 'string' && p.refAudio.trim() && !/[\\/]/.test(p.refAudio) ? p.refAudio.trim() : null;
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

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** 去掉末尾斜杠;空串原样返回。 */
export function trimSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 旧 `ttsUrl` → 新 API 前缀:旧语义是"服务根 + /v1/audio/speech",新语义是
 * "API 前缀 + audio/speech",所以纯追加一层 `/v1` 就能保证最终地址逐字等价。
 * 旧值本身以 `/v1` 结尾时会产生重复段——那是旧配置的既有行为,这里保持等价并
 * 由 `legacyNotes()` 报出来,不静默改写。
 */
export function apiPrefixFromLegacyUrl(ttsUrl: string): string {
  return `${trimSlashes(ttsUrl)}/v1`;
}

/**
 * API 前缀 → 旧服务根:移除恰好一层末尾 `/v1`。对齐器与本地管理器要的是服务根,
 * 反向代理前缀必须留住,所以只剥一层。
 */
export function serviceRootFromApiPrefix(apiPrefix: string): string {
  const trimmed = trimSlashes(apiPrefix);
  return /\/v1$/i.test(trimmed) ? trimmed.slice(0, -3) : trimmed;
}

/** 服务根是否指向本机回环地址;决定虚拟迁移用 managed 还是 external。 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** 合成请求的最终地址;`speechPath` 缺省 audio/speech。 */
export function speechUrlOf(service: Pick<TtsServiceConfig, 'baseUrl' | 'speechPath'>): string {
  const base = trimSlashes(service.baseUrl);
  const path = str(service.speechPath, '').trim().replace(/^\/+/, '') || 'audio/speech';
  return `${base}/${path}`;
}

/** 旧私有流式地址;只对 voxcpm-legacy 有意义。 */
export function legacyStreamUrlOf(service: Pick<TtsServiceConfig, 'baseUrl' | 'speechPath'>): string {
  return `${speechUrlOf(service)}/stream`;
}

export function voiceSpecOf(voice: string | { id: string }): string | { id: string } {
  return typeof voice === 'string' ? voice : { id: voice.id };
}

/** 校验 URL:只收 http/https,拒绝内嵌凭据、fragment 与 query。 */
export function validateBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Base URL 不能为空。';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Base URL 不是合法地址。';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Base URL 只支持 http 或 https。';
  if (url.username || url.password) return 'Base URL 不能内嵌用户名或密码;凭据请走鉴权配置。';
  if (url.hash) return 'Base URL 不能带 fragment。';
  if (url.search) {
    return 'Base URL 不支持 query 参数:请在服务端用反向代理固定它们,或把它写进扩展头。';
  }
  return null;
}

function validateSpeechPath(raw: string): string | null {
  if (!raw) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return 'speechPath 必须是相对路径,不能带协议。';
  if (raw.startsWith('//')) return 'speechPath 不能是协议相对地址。';
  if (raw.includes('..')) return 'speechPath 不能包含 .. 穿越。';
  return null;
}

function validateHeaders(headers: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  if (headers === undefined) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) {
      out.push(`扩展头名不合法:${JSON.stringify(name.slice(0, 40))}。`);
      continue;
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      out.push(`扩展头 ${name} 由适配器自己设置,不接受覆盖。`);
      continue;
    }
    if (/[\r\n]/.test(value)) out.push(`扩展头 ${name} 的值不能含换行。`);
  }
  return out;
}

/** extraBody 必须是可序列化的普通 JSON;函数、NaN/Infinity、循环、污染键一律拒绝。 */
export function sanitizeExtraBody(input: unknown): { ok: true; value: Record<string, JsonValue> } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '扩展参数必须是一个 JSON 对象。' };
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > EXTRA_BODY_MAX_DEPTH) return `扩展参数嵌套超过 ${EXTRA_BODY_MAX_DEPTH} 层。`;
    if (node === null) return null;
    const t = typeof node;
    if (t === 'string' || t === 'boolean') return null;
    if (t === 'number') return Number.isFinite(node as number) ? null : '扩展参数里的数字必须是有限值。';
    if (t !== 'object') return `扩展参数只收 JSON 值,收到 ${t}。`;
    if (seen.has(node)) return '扩展参数存在循环引用。';
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const err = walk(item, depth + 1);
        if (err) return err;
      }
    } else {
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) return '扩展参数只收普通对象。';
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (POLLUTION_KEYS.has(key)) return `扩展参数含危险键 ${key}。`;
        const err = walk(value, depth + 1);
        if (err) return err;
      }
    }
    seen.delete(node);
    return null;
  };
  const err = walk(input, 1);
  if (err) return { ok: false, error: err };
  const value = input as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    if (RESERVED_BODY_KEYS.has(key)) {
      return { ok: false, error: `扩展参数与受控字段 ${key} 冲突:请改用表单上的对应项。` };
    }
  }
  let size: number;
  try {
    size = JSON.stringify(value).length;
  } catch {
    return { ok: false, error: '扩展参数无法序列化。' };
  }
  if (size > EXTRA_BODY_MAX_BYTES) return { ok: false, error: `扩展参数超过 ${EXTRA_BODY_MAX_BYTES} 字节上限。` };
  return { ok: true, value };
}

/**
 * 单条服务的语义校验。返回的错误直接面向操作者,不做二次包装。
 * `all` 用于 id 唯一性;保存时传入"除本条之外"的其余条目即可。
 */
export function validateService(service: TtsServiceConfig, all: readonly TtsServiceConfig[] = []): string[] {
  const out: string[] = [];
  if (!SERVICE_ID_RE.test(service.id)) {
    out.push('服务 ID 只能用 1-64 位小写字母、数字、点、下划线与连字符,且以字母或数字开头。');
  } else if (all.some((s) => s.id === service.id)) {
    out.push(`服务 ID 重复:${service.id}。`);
  }
  if (!service.name.trim()) out.push('服务名不能为空。');
  if (!PROTOCOLS.includes(service.protocol)) out.push(`未知协议:${String(service.protocol)}。`);
  if (!MANAGEMENTS.includes(service.management)) out.push(`未知管理方式:${String(service.management)}。`);
  if (service.protocol === 'openai-speech' && service.management === 'managed-voxcpm') {
    out.push('通用 OpenAI 协议没有本地托管进程可管,management 只能是 external。');
  }
  if (!FORMATS.includes(service.responseFormat)) out.push(`未知输出格式:${String(service.responseFormat)}。`);
  if (!DELIVERIES.includes(service.delivery)) out.push(`未知交付方式:${String(service.delivery)}。`);
  const urlError = validateBaseUrl(str(service.baseUrl));
  if (urlError) out.push(urlError);
  else {
    const pathError = validateSpeechPath(str(service.speechPath, '').trim());
    if (pathError) out.push(pathError);
  }
  if (!service.model.trim()) out.push('model 不能为空。');
  const voice = service.voice;
  if (typeof voice === 'string') {
    if (!voice.trim()) out.push('voice 不能为空。');
  } else if (!voice || typeof voice.id !== 'string' || !voice.id.trim()) {
    out.push('voice 用对象形式时必须给出非空的 id。');
  }
  if (service.auth.type === 'bearer' && !SECRET_REF_RE.test(String(service.auth.secretRef ?? ''))) {
    out.push('鉴权引用的密钥名只能由字母、数字与下划线组成,且不以数字开头。');
  }
  if (!Number.isFinite(service.timeoutMs)) out.push('超时必须是数字。');
  else if (service.timeoutMs < TTS_TIMEOUT_MIN_MS || service.timeoutMs > TTS_TIMEOUT_MAX_MS) {
    out.push(`超时要在 ${TTS_TIMEOUT_MIN_MS / 1000}s 到 ${TTS_TIMEOUT_MAX_MS / 1000}s 之间。`);
  }
  if (service.speed !== undefined) {
    const [lo, hi] = SPEED_LIMITS;
    if (typeof service.speed !== 'number' || !Number.isFinite(service.speed) || service.speed < lo || service.speed > hi) {
      out.push(`speed 要在 ${lo} 到 ${hi} 之间。`);
    }
  }
  if (service.instructions !== undefined && service.instructions.length > INSTRUCTIONS_MAX) {
    out.push(`instructions 超过 ${INSTRUCTIONS_MAX} 字上限。`);
  }
  out.push(...validateHeaders(service.headers));
  const body = sanitizeExtraBody(service.extraBody);
  if (!body.ok) out.push(body.error);
  if (service.responseFormat === 'pcm') {
    const pcm = service.pcm;
    if (!pcm) out.push(`输出格式为 pcm 时必须给出采样率与声道数,不能靠猜。`);
    else {
      if (!Number.isFinite(pcm.sampleRate)
        || pcm.sampleRate < PCM_SAMPLE_RATE_LIMITS[0] || pcm.sampleRate > PCM_SAMPLE_RATE_LIMITS[1]) {
        out.push(`PCM 采样率要在 ${PCM_SAMPLE_RATE_LIMITS[0]} 到 ${PCM_SAMPLE_RATE_LIMITS[1]} 之间。`);
      }
      if (pcm.channels !== 1 && pcm.channels !== 2) out.push('PCM 声道数只支持 1 或 2。');
      if (pcm.encoding !== 's16le') out.push('PCM 编码只支持 s16le。');
    }
  }
  if (service.protocol === 'openai-speech' && service.legacy !== undefined) {
    out.push('通用 OpenAI 协议不接受 legacy 段(参考音频与本地运行时只属于旧服务)。');
  }
  return out;
}

/** 注册表整体校验:版本、引用完整性、至少一条服务。 */
export function validateRegistry(registry: TtsRegistryConfig): string[] {
  const out: string[] = [];
  if (registry.version !== TTS_REGISTRY_VERSION) {
    out.push(`未知的 TTS 配置版本 ${String(registry.version)};本版本只认 ${TTS_REGISTRY_VERSION}。`);
  }
  if (!Number.isInteger(registry.revision) || registry.revision < 0) out.push('revision 必须是非负整数。');
  if (!Array.isArray(registry.services) || registry.services.length === 0) {
    out.push('至少要有一条 TTS 服务。');
    return out;
  }
  const seen = new Set<string>();
  registry.services.forEach((s, i) => {
    const rest = registry.services.filter((_, j) => j !== i);
    for (const err of validateService(s, rest)) out.push(`服务 #${i + 1}(${str(s?.id, '?')}):${err}`);
    if (seen.has(s?.id)) out.push(`服务 ID 重复:${String(s?.id)}。`);
    seen.add(s?.id);
  });
  if (!registry.services.some((s) => s.id === registry.activeServiceId)) {
    out.push(`activeServiceId 指向不存在的服务:${String(registry.activeServiceId)}。`);
  }
  /*
   * 本地管理器一次只带一个实例:第二条 managed-voxcpm 会让"启动"指向不明。
   * 复制内置条目时要另起一条 external,或明确拒绝——这里选拒绝。
   */
  const managed = registry.services.filter((s) => s.management === 'managed-voxcpm');
  if (managed.length > 1) {
    out.push(`只允许一条 managed-voxcpm 服务(当前 ${managed.length} 条:${managed.map((s) => s.id).join('、')});第二条请改成 external。`);
  }
  return out;
}

/** 一条新服务的草稿默认值;添加入口用它,不触碰网络。 */
export function newServiceDraft(id: string, name: string): TtsServiceConfig {
  return {
    id,
    name,
    protocol: 'openai-speech',
    management: 'external',
    baseUrl: 'http://127.0.0.1:8020/v1',
    auth: { type: 'none' },
    model: 'my-tts-model',
    voice: 'my-voice',
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
  };
}

function readLegacyRuntime(src: TtsLegacySource): TtsLegacyRuntimeConfig {
  return {
    runtimeDir: str(src.ttsRuntimeDir),
    runtimeRelease: str(src.ttsRuntimeRelease),
    baseLmFile: str(src.ttsBaseLmFile),
    acousticFile: str(src.ttsAcousticFile),
    alignerLmFile: str(src.ttsAlignerLmFile),
    alignerAudioFile: str(src.ttsAlignerAudioFile),
    voicesDir: str(src.ttsVoicesDir),
  };
}

/** 旧 `ttsProfile` 的部分字段(可能来自配置文件)钳制成完整档案。 */
export function legacyProfileFrom(src: unknown): TtsProfile {
  const p = (typeof src === 'object' && src !== null ? src : {}) as Partial<TtsProfile>;
  return clampTtsProfile(p);
}

/** 迁移期诊断:地址异常等需要在控制台上说明,但不改值。 */
export function legacyNotes(ttsUrl: string): string[] {
  const out: string[] = [];
  const trimmed = trimSlashes(ttsUrl);
  if (/\/v1$/i.test(trimmed)) {
    out.push(`旧 ttsUrl 已经以 /v1 结尾(${trimmed});迁移后的 API 前缀是 ${trimmed}/v1,最终合成地址与原行为逐字一致,没有替你改写。`);
  }
  if (validateBaseUrl(trimmed)) {
    out.push(`旧 ttsUrl 不是标准 http(s) 地址(${trimmed});已原样保留,合成时会报出具体错误。`);
  }
  if (trimmed && !isLoopbackUrl(trimmed)) {
    out.push(`旧 ttsUrl 指向远程主机(${trimmed}),这条服务按 external 处理:不会再探测或启停本机进程,原来地运行设置作为休眠的兼容数据保留。`);
  }
  return out;
}

/**
 * 虚拟迁移:没有 `tts` 时在内存生成唯一 legacy 条目,并从旧字段完整映射。
 * 返回的 `notes` 面向操作者;读操作绝不写盘。
 */
export function virtualLegacyRegistry(src: TtsLegacySource, ttsUrl: string): { registry: TtsRegistryConfig; notes: string[] } {
  const notes = legacyNotes(ttsUrl);
  const root = trimSlashes(ttsUrl);
  const service: TtsServiceConfig = {
    id: LEGACY_SERVICE_ID,
    name: '默认配置(VoxCPM2)',
    protocol: 'voxcpm-legacy',
    // 远程地址不能沿用"取它的端口去启停本机进程"的旧错误
    management: root && isLoopbackUrl(root) ? 'managed-voxcpm' : 'external',
    baseUrl: apiPrefixFromLegacyUrl(ttsUrl),
    auth: { type: 'none' },
    model: 'voxcpm2',
    voice: 'default',
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
    legacy: {
      profile: legacyProfileFrom(src.ttsProfile),
      runtime: readLegacyRuntime(src),
    },
  };
  return {
    registry: { version: TTS_REGISTRY_VERSION, revision: 0, activeServiceId: LEGACY_SERVICE_ID, services: [service] },
    notes,
  };
}

/**
 * 读取注册表。有 `tts` 时它是唯一权威:版本不符或结构不合法一律报错,
 * 不回退到别的服务。没有 `tts` 时做虚拟迁移。
 */
export function readTtsRegistry(src: TtsSectionSource, ttsUrl: string): TtsRegistryRead {
  const raw = src.tts;
  if (raw === undefined || raw === null) {
    const { registry, notes } = virtualLegacyRegistry(src, ttsUrl);
    return { ok: true, registry, virtual: true, notes };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'worlds.vtuber.tts 必须是一个对象。' };
  }
  const candidate = raw as Partial<TtsRegistryConfig>;
  if (candidate.version !== TTS_REGISTRY_VERSION) {
    return {
      ok: false,
      error: `未知的 TTS 配置版本 ${JSON.stringify(candidate.version)};本版本只认 ${TTS_REGISTRY_VERSION},不替你改选别的服务。`,
    };
  }
  const registry: TtsRegistryConfig = {
    version: TTS_REGISTRY_VERSION,
    revision: Number.isInteger(candidate.revision) ? (candidate.revision as number) : 0,
    activeServiceId: str(candidate.activeServiceId),
    services: Array.isArray(candidate.services) ? (candidate.services as TtsServiceConfig[]) : [],
  };
  const errors = validateRegistry(registry);
  if (errors.length > 0) return { ok: false, error: `worlds.vtuber.tts 配置不合法:${errors.join(' ')}` };
  const notes: string[] = [];
  for (const s of registry.services) {
    if (s.protocol === 'voxcpm-legacy' && !isLoopbackUrl(trimSlashes(s.baseUrl))) {
      notes.push(`服务「${s.name}」指向非本机地址;本地运行时管理对它无效。`);
    }
  }
  return { ok: true, registry, virtual: false, notes };
}

/**
 * 新结构 → 旧扁平字段的兼容投影。旧入口(旧 UI、旧方法)只经这一条路径回写,
 * 两处都能独立编辑、互相覆盖的情形因此不会出现。
 */
export function projectLegacyFields(registry: TtsRegistryConfig): Partial<TtsLegacySource> {
  const legacy = registry.services.find((s) => s.protocol === 'voxcpm-legacy' && s.legacy);
  if (!legacy?.legacy) return {};
  const root = serviceRootFromApiPrefix(legacy.baseUrl);
  const rt = legacy.legacy.runtime;
  return {
    ttsUrl: root,
    ttsProfile: { ...legacy.legacy.profile },
    ttsRuntimeDir: rt.runtimeDir,
    ttsRuntimeRelease: rt.runtimeRelease,
    ttsBaseLmFile: rt.baseLmFile,
    ttsAcousticFile: rt.acousticFile,
    ttsAlignerLmFile: rt.alignerLmFile,
    ttsAlignerAudioFile: rt.alignerAudioFile,
    ttsVoicesDir: rt.voicesDir,
  };
}

/** 公开状态:剥掉密钥材料,只保留"是否已设置"。 */
export function publicRegistry(
  registry: TtsRegistryConfig,
  hasSecret: (ref: string) => boolean,
  notes: readonly string[],
): PublicTtsRegistry {
  return {
    version: registry.version,
    revision: registry.revision,
    activeServiceId: registry.activeServiceId,
    protectedIds: [...PROTECTED_SERVICE_IDS],
    notes: [...notes],
    services: registry.services.map((s) => {
      const { auth, ...rest } = s;
      const publicAuth = auth.type === 'bearer'
        ? { type: 'bearer' as const, secretRef: auth.secretRef, apiKeyConfigured: hasSecret(auth.secretRef) }
        : { type: 'none' as const };
      return { ...rest, auth: publicAuth };
    }),
  };
}

/** 保存用:把面板交回来的服务对象规整成落盘形状(不含任何密钥明文)。 */
export function normalizeService(input: unknown, base?: TtsServiceConfig): TtsServiceConfig | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: '服务配置必须是一个对象。' };
  const raw = input as Record<string, unknown>;
  const protocol = (base?.protocol ?? raw.protocol) as TtsProtocol;
  const management = (base?.management ?? raw.management) as TtsManagement;
  const authRaw = raw.auth ?? base?.auth ?? { type: 'none' };
  let auth: TtsAuth = { type: 'none' };
  if (typeof authRaw === 'object' && authRaw !== null) {
    const a = authRaw as Record<string, unknown>;
    if (a.type === 'bearer') {
      auth = { type: 'bearer', secretRef: str(a.secretRef, base?.auth.type === 'bearer' ? base.auth.secretRef : '') };
    } else if (a.type === 'none') {
      auth = { type: 'none' };
    } else {
      return { error: `未知的鉴权类型:${JSON.stringify(a.type)}。` };
    }
  } else {
    return { error: '鉴权配置必须是一个对象。' };
  }
  const voiceRaw = raw.voice ?? base?.voice ?? '';
  let voice: string | { id: string };
  if (typeof voiceRaw === 'string') voice = voiceRaw;
  else if (typeof voiceRaw === 'object' && voiceRaw !== null && typeof (voiceRaw as { id?: unknown }).id === 'string') {
    voice = { id: (voiceRaw as { id: string }).id };
  } else {
    return { error: 'voice 只能是字符串,或带 id 字符串的对象。' };
  }
  const bodyResult = sanitizeExtraBody(raw.extraBody === undefined ? base?.extraBody : raw.extraBody);
  if (!bodyResult.ok) return { error: bodyResult.error };
  const keepLegacy = protocol === 'voxcpm-legacy';
  const service: TtsServiceConfig = {
    id: str(raw.id, base?.id ?? ''),
    name: str(raw.name, base?.name ?? ''),
    protocol,
    management,
    baseUrl: str(raw.baseUrl, base?.baseUrl ?? ''),
    auth,
    model: str(raw.model, base?.model ?? ''),
    voice,
    responseFormat: (raw.responseFormat ?? base?.responseFormat ?? 'wav') as TtsResponseFormat,
    delivery: (raw.delivery ?? base?.delivery ?? 'auto') as TtsDelivery,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : (base?.timeoutMs ?? TTS_TIMEOUT_DEFAULT_MS),
    ...(Object.keys(bodyResult.value).length > 0 ? { extraBody: bodyResult.value } : {}),
  };
  const speechPath = raw.speechPath === null ? '' : str(raw.speechPath, base?.speechPath ?? '').trim();
  if (speechPath) service.speechPath = speechPath;
  if (raw.speed !== undefined && raw.speed !== null) service.speed = raw.speed as number;
  else if (raw.speed === undefined && base?.speed !== undefined) service.speed = base.speed;
  if (raw.instructions !== undefined && raw.instructions !== null) service.instructions = str(raw.instructions);
  else if (raw.instructions === undefined && base?.instructions !== undefined) service.instructions = base.instructions;
  const headersRaw = raw.headers === null ? undefined : raw.headers ?? base?.headers;
  if (headersRaw !== undefined) {
    if (typeof headersRaw !== 'object' || headersRaw === null || Array.isArray(headersRaw)) {
      return { error: '扩展头必须是一个对象。' };
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
      if (typeof v !== 'string') return { error: `扩展头 ${k} 的值必须是字符串。` };
      headers[k] = v;
    }
    if (Object.keys(headers).length > 0) service.headers = headers;
  }
  if (service.responseFormat === 'pcm') {
    const pcmRaw = raw.pcm ?? base?.pcm;
    if (typeof pcmRaw === 'object' && pcmRaw !== null) {
      const p = pcmRaw as Record<string, unknown>;
      service.pcm = {
        sampleRate: typeof p.sampleRate === 'number' ? p.sampleRate : 0,
        channels: (p.channels === 2 ? 2 : 1) as 1 | 2,
        encoding: 's16le',
      };
    }
  }
  if (keepLegacy) {
    const legacyRaw = (raw.legacy ?? base?.legacy) as { profile?: unknown; runtime?: unknown } | undefined;
    const profile = legacyProfileFrom(legacyRaw?.profile ?? base?.legacy?.profile);
    const runtimeRaw = (legacyRaw?.runtime ?? {}) as Partial<TtsLegacyRuntimeConfig>;
    const baseRt = base?.legacy?.runtime;
    service.legacy = {
      profile,
      runtime: {
        runtimeDir: str(runtimeRaw.runtimeDir, baseRt?.runtimeDir ?? ''),
        runtimeRelease: str(runtimeRaw.runtimeRelease, baseRt?.runtimeRelease ?? ''),
        baseLmFile: str(runtimeRaw.baseLmFile, baseRt?.baseLmFile ?? ''),
        acousticFile: str(runtimeRaw.acousticFile, baseRt?.acousticFile ?? ''),
        alignerLmFile: str(runtimeRaw.alignerLmFile, baseRt?.alignerLmFile ?? ''),
        alignerAudioFile: str(runtimeRaw.alignerAudioFile, baseRt?.alignerAudioFile ?? ''),
        voicesDir: str(runtimeRaw.voicesDir, baseRt?.voicesDir ?? ''),
      },
    };
  }
  const errors = validateService(service);
  if (errors.length > 0) return { error: errors.join(' ') };
  return service;
}
