import { describe, it, expect } from 'vitest';
import {
  LEGACY_SERVICE_ID,
  TTS_REGISTRY_VERSION,
  TTS_TIMEOUT_DEFAULT_MS,
  TTS_TIMEOUT_MAX_MS,
  apiPrefixFromLegacyUrl,
  clampTtsProfile,
  legacyNotes,
  normalizeService,
  projectLegacyFields,
  publicRegistry,
  readTtsRegistry,
  sanitizeExtraBody,
  serviceRootFromApiPrefix,
  speechUrlOf,
  validateRegistry,
  validateService,
  virtualLegacyRegistry,
  type TtsRegistryConfig,
  type TtsServiceConfig,
} from '../../src/tts/config.ts';

/** 旧部署最小配置:只有扁平字段。 */
function legacySource(overrides: Record<string, unknown> = {}) {
  return {
    ttsUrl: 'http://127.0.0.1:8010',
    ttsProfile: { refAudio: 'me.wav', refText: '你好', seed: 7, cfgValue: 1.5, inferenceTimesteps: 12, maxSteps: 300, temperature: 0.9 },
    ttsRuntimeDir: '',
    ttsRuntimeRelease: '',
    ttsBaseLmFile: '',
    ttsAcousticFile: '',
    ttsAlignerLmFile: '',
    ttsAlignerAudioFile: '',
    ttsVoicesDir: '',
    ...overrides,
  };
}

const LOCAL_URL = 'http://127.0.0.1:8010/v1';

/**
 * 直接拼一条服务对象,不走 `normalizeService`:校验用例要的正是"不合法的输入",
 * 而保存入口会先把它挡掉,拿不到待校验的样本。
 */
function service(overrides: Partial<TtsServiceConfig> = {}): TtsServiceConfig {
  return {
    id: 'local-compatible',
    name: '我自己的 TTS',
    protocol: 'openai-speech',
    management: 'external',
    baseUrl: LOCAL_URL,
    auth: { type: 'none' },
    model: 'my-tts-model',
    voice: 'my-voice',
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
    ...overrides,
  };
}

describe('旧配置的虚拟迁移', () => {
  it('没有新配置时生成唯一 legacy 条目,地址/型号/声音与全部旧声线参数不变', () => {
    const read = readTtsRegistry(legacySource(), 'http://127.0.0.1:8010');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.virtual).toBe(true);
    expect(read.registry.version).toBe(TTS_REGISTRY_VERSION);
    expect(read.registry.revision).toBe(0);
    expect(read.registry.activeServiceId).toBe(LEGACY_SERVICE_ID);
    expect(read.registry.services).toHaveLength(1);
    const only = read.registry.services[0]!;
    expect(only.protocol).toBe('voxcpm-legacy');
    // 本机地址仍旧走原来的托管管理器
    expect(only.management).toBe('managed-voxcpm');
    expect(only.model).toBe('voxcpm2');
    expect(only.voice).toBe('default');
    expect(only.responseFormat).toBe('wav');
    expect(speechUrlOf(only)).toBe('http://127.0.0.1:8010/v1/audio/speech');
    expect(only.legacy?.profile).toMatchObject({ refAudio: 'me.wav', refText: '你好', seed: 7, maxSteps: 300 });
  });

  it('读操作不改写传入的对象,也不产出任何落盘补丁', () => {
    const source = legacySource();
    const before = JSON.stringify(source);
    readTtsRegistry(source, 'http://127.0.0.1:8010');
    expect(JSON.stringify(source)).toBe(before);
    expect(source).not.toHaveProperty('tts');
  });

  it('旧 ttsUrl 迁移前后实际构造的合成地址逐字等价', () => {
    for (const url of [
      'http://127.0.0.1:8010',
      'http://127.0.0.1:8010/',
      'https://tts.example/team/proxy',
      'http://127.0.0.1:8010/v1',
    ]) {
      const old = `${url.replace(/\/+$/, '')}/v1/audio/speech`;
      const { registry } = virtualLegacyRegistry({}, url);
      expect(speechUrlOf(registry.services[0]!)).toBe(old);
    }
  });

  it('指向远程主机时按 external 处理并给出诊断,本地运行设置仍原样保留', () => {
    const read = readTtsRegistry(legacySource({ ttsUrl: 'https://tts.example/v1', ttsRuntimeDir: 'D:/rt' }), 'https://tts.example/v1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const only = read.registry.services[0]!;
    expect(only.management).toBe('external');
    expect(only.legacy?.runtime.runtimeDir).toBe('D:/rt');
    expect(read.notes.join('')).toContain('远程主机');
    // 重复 /v1 是旧配置的既有行为:只报不改
    expect(read.notes.join('')).toContain('/v1');
  });

  it('服务根与 API 前缀互转只剥一层 /v1,反向代理前缀留住', () => {
    expect(apiPrefixFromLegacyUrl('http://h:8010')).toBe('http://h:8010/v1');
    expect(serviceRootFromApiPrefix('http://h:8010/v1')).toBe('http://h:8010');
    expect(serviceRootFromApiPrefix('https://g/team/tts/v1')).toBe('https://g/team/tts');
    expect(serviceRootFromApiPrefix('https://g/team/tts')).toBe('https://g/team/tts');
    expect(serviceRootFromApiPrefix('https://g/team/tts/v1/')).toBe('https://g/team/tts');
  });

  it('没有 /v1 结尾的地址不产生重复段诊断', () => {
    expect(legacyNotes('http://127.0.0.1:8010')).toEqual([]);
  });
});

describe('新结构是唯一权威', () => {
  const registry: TtsRegistryConfig = {
    version: TTS_REGISTRY_VERSION,
    revision: 3,
    activeServiceId: 'local-compatible',
    services: [
      {
        id: LEGACY_SERVICE_ID,
        name: '默认 VoxCPM2(旧配置)',
        protocol: 'voxcpm-legacy',
        management: 'managed-voxcpm',
        baseUrl: LOCAL_URL,
        auth: { type: 'none' },
        model: 'voxcpm2',
        voice: 'default',
        responseFormat: 'wav',
        delivery: 'auto',
        timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
        legacy: {
          profile: clampTtsProfile({ refAudio: 'a.wav' }),
          runtime: {
            runtimeDir: 'D:/rt',
            runtimeRelease: 'r1',
            baseLmFile: 'D:/m/base.gguf',
            acousticFile: '',
            alignerLmFile: '',
            alignerAudioFile: '',
            voicesDir: 'D:/v',
          },
        },
      },
      service(),
    ],
  };

  it('有 tts 段时不再虚拟迁移,当前服务取自 activeServiceId', () => {
    const read = readTtsRegistry({ tts: registry }, 'http://127.0.0.1:8010');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.virtual).toBe(false);
    expect(read.registry.revision).toBe(3);
    expect(read.registry.activeServiceId).toBe('local-compatible');
  });

  it('旧扁平字段回写成内置条目的兼容投影,两处不会各自可编辑', () => {
    const flat = projectLegacyFields(registry);
    expect(flat.ttsUrl).toBe('http://127.0.0.1:8010');
    expect(flat.ttsRuntimeDir).toBe('D:/rt');
    expect(flat.ttsRuntimeRelease).toBe('r1');
    expect(flat.ttsBaseLmFile).toBe('D:/m/base.gguf');
    expect(flat.ttsVoicesDir).toBe('D:/v');
    expect(flat.ttsProfile).toMatchObject({ refAudio: 'a.wav' });
  });

  it('未知版本明确失败,不偷偷改选另一个服务', () => {
    const read = readTtsRegistry({ tts: { ...registry, version: 99 } }, 'http://127.0.0.1:8010');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toContain('99');
    expect(read.error).toContain('不替你改选');
  });

  it('结构不合法时明确失败并把原因带上', () => {
    const bad = { ...registry, activeServiceId: 'nope' };
    const read = readTtsRegistry({ tts: bad }, 'http://127.0.0.1:8010');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toContain('nope');
  });
});

describe('校验', () => {
  it('拒绝重复 id、空 model、空 voice、非法 URL', () => {
    expect(validateService(service({ model: '  ' })).join('')).toContain('model');
    expect(validateService(service({ voice: '' })).join('')).toContain('voice');
    expect(validateService(service({ baseUrl: 'ftp://h/v1' })).join('')).toContain('http');
    expect(validateService(service(), [service()]).join('')).toContain('重复');
  });

  it('拒绝内嵌凭据、fragment 与 query 的 Base URL', () => {
    expect(validateService(service({ baseUrl: 'http://u:p@h/v1' })).join('')).toContain('用户名');
    expect(validateService(service({ baseUrl: 'http://h/v1#x' })).join('')).toContain('fragment');
    expect(validateService(service({ baseUrl: 'http://h/v1?k=v' })).join('')).toContain('query');
  });

  it('speechPath 不能带协议或 .. 穿越', () => {
    expect(validateService(service({ speechPath: 'https://evil/x' })).join('')).toContain('协议');
    expect(validateService(service({ speechPath: '../../x' })).join('')).toContain('..');
  });

  it('通用协议 + managed-voxcpm 是无意义组合,直接拒绝', () => {
    expect(validateService(service({ management: 'managed-voxcpm' })).join('')).toContain('external');
  });

  it('pcm 必须给出采样率与声道数,且只用配置值', () => {
    expect(validateService(service({ responseFormat: 'pcm' })).join('')).toContain('采样率');
    expect(validateService(service({ responseFormat: 'pcm', pcm: { sampleRate: 24000, channels: 1, encoding: 's16le' } }))).toEqual([]);
    expect(validateService(service({ responseFormat: 'pcm', pcm: { sampleRate: 0, channels: 1, encoding: 's16le' } })).join('')).toContain('采样率');
  });

  it('超时落在面板 RPC 死线之内', () => {
    expect(validateService(service({ timeoutMs: 120_000 })).join('')).toContain('超时');
    expect(validateService(service({ timeoutMs: 100 })).join('')).toContain('超时');
    // 上限与转码预算成套:60s + 30s,留出对齐与排队余量
    expect(validateService(service({ timeoutMs: TTS_TIMEOUT_MAX_MS }))).toEqual([]);
  });

  it('鉴权引用名受限;扩展头不能覆盖适配器自己的头', () => {
    expect(validateService(service({ auth: { type: 'bearer', secretRef: '9bad' } })).join('')).toContain('密钥名');
    expect(validateService(service({ headers: { Authorization: 'Bearer x' } })).join('')).toContain('适配器');
    expect(validateService(service({ headers: { 'X-Trace': 'a\nb' } })).join('')).toContain('换行');
  });

  it('注册表至少要有一条服务,active 必须指向存在的条目', () => {
    expect(validateRegistry({ version: 1, revision: 0, activeServiceId: 'x', services: [] }).join('')).toContain('至少要有一条');
    expect(validateRegistry({ version: 1, revision: 0, activeServiceId: 'x', services: [service()] }).join('')).toContain('x');
  });

  it('只允许一条 managed-voxcpm:复制内置条目不能复制出第二个本地实例', () => {
    const legacy = normalizeService({
      id: LEGACY_SERVICE_ID,
      name: '默认',
      protocol: 'voxcpm-legacy',
      management: 'managed-voxcpm',
      baseUrl: LOCAL_URL,
      auth: { type: 'none' },
      model: 'voxcpm2',
      voice: 'default',
      responseFormat: 'wav',
      delivery: 'auto',
      timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
    }) as TtsServiceConfig;
    const copy = { ...legacy, id: 'legacy-copy' };
    const errors = validateRegistry({ version: 1, revision: 1, activeServiceId: LEGACY_SERVICE_ID, services: [legacy, copy] });
    expect(errors.join('')).toContain('只允许一条 managed-voxcpm');
    // 改成 external 就能存下
    expect(validateRegistry({
      version: 1, revision: 1, activeServiceId: LEGACY_SERVICE_ID,
      services: [legacy, { ...copy, management: 'external' }],
    })).toEqual([]);
  });
});

describe('扩展参数的边界', () => {
  it('接受普通 JSON 值', () => {
    const out = sanitizeExtraBody({ language: 'zh', gain: 1.5, nested: { a: [1, 2, null, true] } });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toMatchObject({ language: 'zh' });
  });

  it('拒绝函数、非有限数、循环引用与污染键', () => {
    expect(sanitizeExtraBody({ f: () => 1 }).ok).toBe(false);
    expect(sanitizeExtraBody({ n: Number.NaN }).ok).toBe(false);
    expect(sanitizeExtraBody({ n: Number.POSITIVE_INFINITY }).ok).toBe(false);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(sanitizeExtraBody(cyc).ok).toBe(false);
    expect(sanitizeExtraBody(JSON.parse('{"__proto__":{"x":1}}')).ok).toBe(false);
  });

  it('拒绝与受控字段冲突的键,不做后写覆盖', () => {
    for (const key of ['input', 'model', 'voice', 'response_format', 'stream_format', 'speed', 'stream']) {
      const out = sanitizeExtraBody({ [key]: 'x' });
      if (key === 'stream') {
        // stream 是聊天接口的参数,不在受控键里,允许透传
        expect(out.ok).toBe(true);
        continue;
      }
      expect(out.ok, key).toBe(false);
    }
  });

  it('拒绝过深与过大的对象', () => {
    let deep: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(sanitizeExtraBody(deep).ok).toBe(false);
    expect(sanitizeExtraBody({ big: 'x'.repeat(8000) }).ok).toBe(false);
  });
});

describe('公开状态脱敏', () => {
  it('只报密钥是否已设置,可编辑的非敏感扩展头原样读回', () => {
    const registry: TtsRegistryConfig = {
      version: TTS_REGISTRY_VERSION,
      revision: 5,
      activeServiceId: 'cloud',
      services: [service({
        id: 'cloud',
        auth: { type: 'bearer', secretRef: 'VTUBER_TTS_CLOUD_API_KEY' },
        headers: { 'X-Tenant': 'acme' },
      })],
    };
    const pub = publicRegistry(registry, (ref) => ref === 'VTUBER_TTS_CLOUD_API_KEY', ['note']);
    const only = pub.services[0]!;
    expect(only.auth).toEqual({ type: 'bearer', secretRef: 'VTUBER_TTS_CLOUD_API_KEY', apiKeyConfigured: true });
    expect(only.headers).toEqual({ 'X-Tenant': 'acme' });
    expect(JSON.stringify(pub)).not.toContain('sk-');
    expect(pub.notes).toEqual(['note']);
    expect(pub.protectedIds).toContain(LEGACY_SERVICE_ID);
  });

  it('没有配置密钥时 apiKeyConfigured 为 false', () => {
    const registry: TtsRegistryConfig = {
      version: TTS_REGISTRY_VERSION,
      revision: 1,
      activeServiceId: 'cloud',
      services: [service({ id: 'cloud', auth: { type: 'bearer', secretRef: 'K' } })],
    };
    const pub = publicRegistry(registry, () => false, []);
    expect(pub.services[0]!.auth).toEqual({ type: 'bearer', secretRef: 'K', apiKeyConfigured: false });
  });
});

describe('保存入口的规整', () => {
  it('模型与声音可以自由填写,不受官方列表限制', () => {
    const out = normalizeService({ ...service(), model: '任意模型/名', voice: { id: 'my-voice-id' } });
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.model).toBe('任意模型/名');
    expect(out.voice).toEqual({ id: 'my-voice-id' });
  });

  it('省略 speed / instructions 时字段完全缺席,而不是填空值', () => {
    const out = normalizeService(service()) as TtsServiceConfig;
    expect('speed' in out).toBe(false);
    expect('instructions' in out).toBe(false);
    expect('extraBody' in out).toBe(false);
  });

  it('voxcpm-legacy 保留 legacy 段;通用协议不保留', () => {
    const legacy = normalizeService({
      id: LEGACY_SERVICE_ID,
      name: '默认',
      protocol: 'voxcpm-legacy',
      management: 'managed-voxcpm',
      baseUrl: LOCAL_URL,
      auth: { type: 'none' },
      model: 'voxcpm2',
      voice: 'default',
      responseFormat: 'wav',
      delivery: 'auto',
      timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
      legacy: { profile: { refAudio: 'a.wav' }, runtime: { runtimeDir: 'D:/rt' } },
    }) as TtsServiceConfig;
    expect(legacy.legacy?.profile.refAudio).toBe('a.wav');
    expect(legacy.legacy?.runtime.runtimeDir).toBe('D:/rt');
  });

  it('声线档案钳制沿用旧上界,并拒绝带路径分隔符的参考文件名', () => {
    expect(clampTtsProfile({ refAudio: '../../etc/passwd' }).refAudio).toBeNull();
    expect(clampTtsProfile({ seed: -5 }).seed).toBe(0);
    expect(clampTtsProfile({ cfgValue: 99 }).cfgValue).toBe(10);
  });
});
