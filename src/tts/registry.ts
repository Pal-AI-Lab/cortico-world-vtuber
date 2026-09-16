/**
 * 服务解析器:把注册表解析成"此刻该用哪条服务"和一份不可变执行快照。
 *
 * 快照在每次开始合成一片时取一次,整片(含允许的回退)共用;切换只影响之后新
 * 发起的合成。缓存按服务 id + 配置版本 + 密钥指纹失效,绝不用密钥本身做键。
 *
 * 读不到注册表时直接报错,不静默改选另一个服务。
 */
import type { TtsAdapter, TtsCapabilities, TtsExecutionSnapshot, TtsSynthProfile } from './types.ts';
import {
  LEGACY_SERVICE_ID,
  apiPrefixFromLegacyUrl,
  serviceRootFromApiPrefix,
  speechUrlOf,
  legacyStreamUrlOf,
  publicRegistry,
  trimSlashes,
  type PublicTtsRegistry,
  type TtsRegistryConfig,
  type TtsRegistryRead,
  type TtsServiceConfig,
} from './config.ts';
import { OpenAiSpeechAdapter, isIncrementalFormat } from './openai-speech.ts';
import { VoxcpmLegacyAdapter } from './voxcpm-legacy.ts';

export { LEGACY_SERVICE_ID, apiPrefixFromLegacyUrl, serviceRootFromApiPrefix };

/** VoxCPM server 的硬时长上限:解码步数使输出恰好停在这里。 */
export const VOXCPM_MAX_AUDIO_MS = 32_000;

/** 指纹:非敏感配置的稳定散列,用于适配器缓存与语速统计命名空间。 */
export function fingerprintOf(service: TtsServiceConfig, revision: number): string {
  const material = JSON.stringify({
    revision,
    id: service.id,
    protocol: service.protocol,
    management: service.management,
    baseUrl: service.baseUrl,
    speechPath: service.speechPath ?? '',
    model: service.model,
    voice: service.voice,
    responseFormat: service.responseFormat,
    delivery: service.delivery,
    timeoutMs: service.timeoutMs,
    speed: service.speed ?? null,
    instructions: service.instructions ?? '',
    pcm: service.pcm ?? null,
    extraBody: service.extraBody ?? null,
    headers: service.headers ?? null,
  });
  return fnv1a(material);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 服务能力来自协议与管理方式的明确契约,不由端点探测推断。 */
export function capabilitiesOf(
  service: Pick<TtsServiceConfig, 'protocol' | 'management' | 'delivery' | 'responseFormat'>,
): TtsCapabilities {
  if (service.protocol === 'voxcpm-legacy') {
    return {
      incremental: service.delivery !== 'buffered',
      privateStream: true,
      aligner: true,
      referenceAudio: true,
      managesProcess: service.management === 'managed-voxcpm',
      qualityPolicy: 'voxcpm',
      maxAudioMs: VOXCPM_MAX_AUDIO_MS,
    };
  }
  return {
    incremental: service.delivery !== 'buffered' && isIncrementalFormatShape(service),
    privateStream: false,
    aligner: false,
    referenceAudio: false,
    managesProcess: false,
    qualityPolicy: 'generic',
  };
}

function isIncrementalFormatShape(
  service: Pick<TtsServiceConfig, 'responseFormat'>,
): boolean {
  return service.responseFormat === 'wav' || service.responseFormat === 'pcm';
}

/**
 * 兼容入口用的 legacy 快照:旧 `TtsClient({ url })` 只给一个服务根,其余全用旧默认。
 * `url` 语义是服务根,客户端在后面追加 `/v1/audio/speech`。
 */
export function legacySnapshotFromUrl(opts: {
  root: string;
  timeoutMs: number;
  profile?: TtsSynthProfile;
  name?: string;
}): TtsExecutionSnapshot {
  const root = trimSlashes(opts.root);
  const shape = {
    protocol: 'voxcpm-legacy' as const,
    management: 'external' as const,
    delivery: 'auto' as const,
    responseFormat: 'wav' as const,
  };
  return {
    serviceId: LEGACY_SERVICE_ID,
    revision: 0,
    fingerprint: fnv1a(`${root}|${opts.timeoutMs}`),
    name: opts.name ?? root,
    protocol: 'voxcpm-legacy',
    management: 'external',
    speechUrl: `${root}/v1/audio/speech`,
    legacyStreamUrl: `${root}/v1/audio/speech/stream`,
    serviceRoot: root,
    authHeader: null,
    model: 'voxcpm2',
    voice: 'default',
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: opts.timeoutMs,
    profile: opts.profile ?? {},
    capabilities: capabilitiesOf(shape),
  };
}

export interface TtsResolverOptions {
  /** 现读注册表:虚拟迁移、未知版本与非法配置都在这里体现 */
  read: () => TtsRegistryRead;
  /** 现读密钥表;键是 secretRef,值是密钥内容 */
  secrets: () => Record<string, string>;
  /**
   * legacy 服务的声线档案补全:参考音频是部署私有资产,base64 由 World 现读
   * 声线库后交回,注册表里只有文件名。
   */
  legacyProfile?: (service: TtsServiceConfig) => TtsSynthProfile;
  fetchImpl?: typeof fetch;
}

/** 注册表读取结果 + 当前服务快照的唯一权威。 */
export class TtsServiceResolver {
  private readonly cache = new Map<string, TtsAdapter>();

  constructor(private readonly opts: TtsResolverOptions) {}

  /** 注册表读取结果,含虚拟迁移与错误;调用方自己决定怎么呈现。 */
  read(): TtsRegistryRead {
    return this.opts.read();
  }

  /** 注册表本身;读失败时抛出面向操作者的错误。 */
  registry(): TtsRegistryConfig {
    const read = this.opts.read();
    if (!read.ok) throw new Error(read.error);
    return read.registry;
  }

  /** 面板读到的公开状态;密钥只报"是否已设置"。 */
  publicState(): PublicTtsRegistry {
    const read = this.opts.read();
    if (!read.ok) {
      return {
        version: -1,
        revision: -1,
        activeServiceId: '',
        services: [],
        notes: [],
        error: read.error,
        protectedIds: [LEGACY_SERVICE_ID],
      };
    }
    const secrets = this.opts.secrets();
    return publicRegistry(read.registry, (ref) => (secrets[ref] ?? '').length > 0, read.notes);
  }

  /** 读出全部诊断(虚拟迁移、远程地址等);读失败时给错误文本。 */
  notes(): string[] {
    const read = this.opts.read();
    return read.ok ? read.notes : [read.error];
  }

  /** 当前活动服务的冻结快照。 */
  snapshot(): TtsExecutionSnapshot {
    const registry = this.registry();
    const service = registry.services.find((s) => s.id === registry.activeServiceId);
    if (!service) {
      throw new Error(`当前 TTS 服务 ${registry.activeServiceId} 不在注册表里;请在控制台重新选择。`);
    }
    return this.snapshotFor(service, registry.revision);
  }

  /** 指定服务的冻结快照;试用草稿与按 id 取都走这里。 */
  snapshotFor(service: TtsServiceConfig, revision: number, apiKey?: string): TtsExecutionSnapshot {
    const secrets = this.opts.secrets();
    let authHeader: string | null = null;
    if (service.auth.type === 'bearer') {
      const key = (apiKey ?? secrets[service.auth.secretRef] ?? '').trim();
      if (!key) {
        throw new Error(`TTS 服务「${service.name}」配置了 Bearer 鉴权,但密钥 ${service.auth.secretRef} 没有设置。`);
      }
      authHeader = `Bearer ${key}`;
    }
    const capabilities = capabilitiesOf(service);
    const legacy = service.protocol === 'voxcpm-legacy';
    // 参考音频只在 legacy 服务上有意义;文件名→base64 由 World 现读声线库完成
    const profile = legacy ? (this.opts.legacyProfile?.(service) ?? {}) : undefined;
    return {
      serviceId: service.id,
      revision,
      /*
       * 适配器缓存的键。legacy 的声线档案(参考音频 base64、转写、生成参数)是
       * 逐片冻结的一次性材料,不进配置指纹就会让换了声线之后复用上一片的适配器,
       * 拿旧参考音频合成——听起来像"改了没生效"。
       */
      fingerprint: `${fingerprintOf(service, revision)}.${fnv1a(authHeader ?? '')}`
        + (profile ? `.${fnv1a(JSON.stringify(profile))}` : ''),
      name: service.name,
      protocol: service.protocol,
      management: service.management,
      speechUrl: speechUrlOf(service),
      legacyStreamUrl: legacy ? legacyStreamUrlOf(service) : null,
      serviceRoot: legacy ? serviceRootFromApiPrefix(service.baseUrl) : null,
      authHeader,
      model: service.model,
      voice: service.voice,
      responseFormat: service.responseFormat,
      delivery: service.delivery,
      timeoutMs: service.timeoutMs,
      ...(service.speed !== undefined ? { speed: service.speed } : {}),
      ...(service.instructions !== undefined ? { instructions: service.instructions } : {}),
      ...(service.extraBody ? { extraBody: service.extraBody } : {}),
      ...(service.headers ? { headers: service.headers } : {}),
      ...(service.pcm ? { pcm: service.pcm } : {}),
      ...(profile ? { profile } : {}),
      capabilities,
    };
  }

  /** 取(并缓存)一个快照对应的适配器。密钥轮换与配置改动都会换新实例。 */
  adapterFor(snapshot: TtsExecutionSnapshot): TtsAdapter {
    const key = `${snapshot.serviceId}@${snapshot.revision}:${snapshot.fingerprint}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const adapter: TtsAdapter = snapshot.protocol === 'voxcpm-legacy'
      ? new VoxcpmLegacyAdapter(snapshot, this.opts.fetchImpl ?? fetch)
      : new OpenAiSpeechAdapter(snapshot, this.opts.fetchImpl ?? fetch);
    // 只留最近若干条:服务数有限,但 revision 会一直涨
    if (this.cache.size > 32) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, adapter);
    return adapter;
  }

  /** 显式失效:凭据或配置变化后不必等新指纹自然覆盖。 */
  invalidate(serviceId?: string): void {
    if (!serviceId) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${serviceId}@`)) this.cache.delete(key);
    }
  }
}

/**
 * legacy 服务根上的对齐器地址:一个 llama-tts-server 同时驮着 VoxCPM2 与对齐模型。
 * 通用服务没有这个能力,不猜它的路径。
 */
export function alignerUrlOf(snapshot: TtsExecutionSnapshot): string | null {
  return snapshot.capabilities.aligner ? snapshot.serviceRoot : null;
}
