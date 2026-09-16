import { describe, it, expect } from 'vitest';
import { VtuberWorldProxy } from '../../src/proxy.ts';
import { TTS_TIMEOUT_DEFAULT_MS, type TtsRegistryConfig, type TtsRegistryRead, type TtsServiceConfig } from '../../src/tts/config.ts';
import type { TtsServicesState } from '../../src/world.ts';

/**
 * 服务表的增删改与切换在主进程做,所以这里不起子进程:没有子进程时应用会失败,
 * 正好覆盖"已保存但未应用"这条可恢复路径。真实 IPC 应用另有 world/proxy 的用例与
 * 真机验收。
 */
function harness(initial: TtsRegistryConfig | null = null) {
  let registry: TtsRegistryConfig | null = initial;
  const writes: TtsRegistryConfig[] = [];
  const secrets: Array<{ ref: string; value: string }> = [];
  const secretValues: Record<string, string> = {};
  const proxy = new VtuberWorldProxy({
    ttsRegistry: (): TtsRegistryRead => {
      if (!registry) return { ok: false, error: '未接线' };
      return { ok: true, registry, virtual: false, notes: [] };
    },
    ttsSecrets: () => secretValues,
    onTtsRegistry: (next) => {
      writes.push(next);
      registry = next;
    },
    storeTtsSecret: (ref, value) => {
      secrets.push({ ref, value });
      if (value) secretValues[ref] = value;
      else delete secretValues[ref];
    },
  });
  const console_ = proxy.ttsConsole();
  return {
    console: console_,
    writes,
    secrets,
    base: (): TtsRegistryConfig | null => registry,
    set: (next: TtsRegistryConfig | null): void => { registry = next; },
  };
}

function service(overrides: Partial<TtsServiceConfig> = {}): TtsServiceConfig {
  return {
    id: 'mine',
    name: '我的服务',
    protocol: 'openai-speech',
    management: 'external',
    baseUrl: 'http://127.0.0.1:8020/v1',
    auth: { type: 'none' },
    model: 'model',
    voice: 'voice',
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
    ...overrides,
  };
}

function registryOf(services: TtsServiceConfig[], activeServiceId: string, revision = 1): TtsRegistryConfig {
  return { version: 1, revision, activeServiceId, services };
}

/** 虚拟迁移:配置里没有 tts 时装配层给的就是这一条 legacy 条目 */
function virtualLegacy(): TtsRegistryConfig {
  return registryOf([{
    id: 'legacy-default',
    name: '默认 VoxCPM2(旧配置)',
    protocol: 'voxcpm-legacy',
    management: 'managed-voxcpm',
    baseUrl: 'http://127.0.0.1:8010/v1',
    auth: { type: 'none' },
    model: 'voxcpm2',
    voice: 'default',
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
    legacy: {
      profile: { refAudio: null, refText: '', seed: 42, cfgValue: 2, inferenceTimesteps: 10, maxSteps: 200, temperature: 1 },
      runtime: { runtimeDir: '', runtimeRelease: '', baseLmFile: '', acousticFile: '', alignerLmFile: '', alignerAudioFile: '', voicesDir: '' },
    },
  }], 'legacy-default', 0);
}

describe('服务表:新增与保存', () => {
  it('新增一条服务,revision 加一,落盘的候选含新旧两条', async () => {
    const h = harness(virtualLegacy());
    const out = await h.console.saveService({ service: service(), baseRevision: 0 }) as { savedRevision: number };
    expect(out.savedRevision).toBe(1);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.services.map((s) => s.id)).toEqual(['legacy-default', 'mine']);
    // 没有子进程 → 已保存但未应用,不能报成已经用上
    expect(h.writes[0]!.activeServiceId).toBe('legacy-default');
  });

  it('覆盖同 id 的条目而不是追加第二条', async () => {
    const h = harness(registryOf([service(), service({ id: 'other' })], 'mine'));
    await h.console.saveService({ service: service({ name: '改了名字' }), baseRevision: 1 });
    expect(h.writes[0]!.services.map((s) => s.id)).toEqual(['mine', 'other']);
    expect(h.writes[0]!.services[0]!.name).toBe('改了名字');
  });

  it('上一次读到的 revision 已过期时拒绝保存,不覆盖别处的改动', async () => {
    const h = harness(registryOf([service()], 'mine', 7));
    await expect(h.console.saveService({ service: service({ name: 'x' }), baseRevision: 3 }))
      .rejects.toThrow(/已被别处改动/);
    expect(h.writes).toHaveLength(0);
  });

  it('保存失败时不报告成功:落盘口抛错原样上抛', async () => {
    let registry = virtualLegacy();
    const proxy = new VtuberWorldProxy({
      ttsRegistry: () => ({ ok: true, registry, virtual: false, notes: [] }),
      onTtsRegistry: () => { throw new Error('磁盘只读'); },
    });
    await expect(proxy.ttsConsole().saveService({ service: service(), baseRevision: 0 }))
      .rejects.toThrow(/保存失败,配置未改动/);
    expect(registry.services).toHaveLength(1);
  });

  it('非法 config 原样报出服务端校验错误', async () => {
    const h = harness(virtualLegacy());
    await expect(h.console.saveService({ service: service({ model: '' }), baseRevision: 0 }))
      .rejects.toThrow(/model/);
    expect(h.writes).toHaveLength(0);
  });

  it('activate 一步完成保存与切换', async () => {
    const h = harness(virtualLegacy());
    const out = await h.console.saveService({ service: service(), baseRevision: 0, activate: true }) as { activeServiceId: string };
    expect(out.activeServiceId).toBe('mine');
    expect(h.writes[0]!.activeServiceId).toBe('mine');
  });
});

describe('服务表:密钥', () => {
  it('bearer 密钥经宿主密钥口写入,配置里只留密钥名', async () => {
    const h = harness(virtualLegacy());
    await h.console.saveService({
      service: service({ auth: { type: 'bearer', secretRef: 'VTUBER_TTS_MINE_API_KEY' } }),
      baseRevision: 0,
      apiKey: 'sk-secret',
    });
    expect(h.secrets).toEqual([{ ref: 'VTUBER_TTS_MINE_API_KEY', value: 'sk-secret' }]);
    expect(JSON.stringify(h.writes[0])).not.toContain('sk-secret');
  });

  it('新条目的密钥名由 id 派生,不沿用别人的名字', async () => {
    const h = harness(virtualLegacy());
    await h.console.saveService({ service: service({ auth: { type: 'bearer', secretRef: '' } }), baseRevision: 0 });
    const saved = h.writes[0]!.services.find((s) => s.id === 'mine')!;
    expect(saved.auth).toEqual({ type: 'bearer', secretRef: 'VTUBER_TTS_MINE_API_KEY' });
  });

  it('跨源换地址且没给新 Key 时不复用旧凭据:换成新的密钥名,旧 Key 留在原名字下', async () => {
    const base = service({ auth: { type: 'bearer', secretRef: 'OLD_REF' } });
    const h = harness(registryOf([base], 'mine'));
    await h.console.saveService({
      service: service({ baseUrl: 'https://other.example/v1', auth: { type: 'bearer', secretRef: 'OLD_REF' } }),
      baseRevision: 1,
    });
    const saved = h.writes[0]!.services[0]!;
    expect(saved.auth.type).toBe('bearer');
    if (saved.auth.type !== 'bearer') return;
    expect(saved.auth.secretRef).not.toBe('OLD_REF');
    expect(saved.auth.secretRef).toMatch(/^VTUBER_TTS_MINE_/);
    // 旧名字下的密钥没有被搬走,也没有发给新地址
    expect(h.secrets).toHaveLength(0);
  });

  it('公开状态只报是否已设置', async () => {
    const h = harness(registryOf([service({ auth: { type: 'bearer', secretRef: 'K' } })], 'mine'));
    const state = await h.console.services() as TtsServicesState;
    expect(state.services[0]!.auth).toEqual({ type: 'bearer', secretRef: 'K', apiKeyConfigured: false });
  });

  it('清除密钥是独立动作', async () => {
    const h = harness(registryOf([service({ auth: { type: 'bearer', secretRef: 'K' } })], 'mine'));
    h.set(registryOf([service({ auth: { type: 'bearer', secretRef: 'K' } })], 'mine'));
    await h.console.saveService({
      service: service({ auth: { type: 'bearer', secretRef: 'K' } }),
      baseRevision: 1,
      clearApiKey: true,
    });
    expect(h.secrets).toEqual([{ ref: 'K', value: '' }]);
  });
});

describe('服务表:切换与删除', () => {
  it('切换只改 activeServiceId,数组原样', async () => {
    const h = harness(registryOf([virtualLegacy().services[0]!, service()], 'legacy-default'));
    const out = await h.console.activateService({ id: 'mine', baseRevision: 1 }) as {
      activeServiceId: string;
      message: string;
    };
    expect(out.activeServiceId).toBe('mine');
    expect(h.writes[0]!.services).toHaveLength(2);
    // 界面必须如实说明在途音频不会中途换声线
    expect(out.message).toContain('预取');
  });

  it('删非当前服务:数组整体替换,不是合并', async () => {
    const h = harness(registryOf([virtualLegacy().services[0]!, service(), service({ id: 'other' })], 'legacy-default'));
    await h.console.deleteService({ id: 'mine', baseRevision: 1 });
    expect(h.writes[0]!.services.map((s) => s.id)).toEqual(['legacy-default', 'other']);
  });

  it('删当前服务必须指定替代,否则拒绝', async () => {
    const h = harness(registryOf([virtualLegacy().services[0]!, service()], 'mine'));
    await expect(h.console.deleteService({ id: 'mine', baseRevision: 1 })).rejects.toThrow(/替代/);
    expect(h.writes).toHaveLength(0);
  });

  it('删当前服务并指定替代:引用不悬空', async () => {
    const h = harness(registryOf([virtualLegacy().services[0]!, service(), service({ id: 'other' })], 'mine'));
    await h.console.deleteService({ id: 'mine', baseRevision: 1, replacementId: 'other' });
    expect(h.writes[0]!.activeServiceId).toBe('other');
    expect(h.writes[0]!.services.map((s) => s.id)).toEqual(['legacy-default', 'other']);
  });

  it('内置条目受保护,删不掉', async () => {
    const h = harness(registryOf([virtualLegacy().services[0]!, service()], 'mine'));
    await expect(h.console.deleteService({ id: 'legacy-default', baseRevision: 1 }))
      .rejects.toThrow(/不能删除/);
  });

  it('替代服务不存在时拒绝,不留悬空引用', async () => {
    const h = harness(registryOf([virtualLegacy().services[0]!, service()], 'mine'));
    await expect(h.console.deleteService({ id: 'mine', baseRevision: 1, replacementId: 'nope' }))
      .rejects.toThrow(/替代服务不存在/);
  });

  it('不能删到一条不剩', async () => {
    const h = harness(registryOf([service()], 'mine'));
    await expect(h.console.deleteService({ id: 'mine', baseRevision: 1 })).rejects.toThrow(/至少要留一条/);
    expect(h.base()!.services).toHaveLength(1);
  });
});

describe('配置读不出来时', () => {
  it('services 报错误而不是假装有一条默认服务', async () => {
    const proxy = new VtuberWorldProxy({
      ttsRegistry: () => ({ ok: false, error: '未知的 TTS 配置版本 99' }),
    });
    const state = await proxy.ttsConsole().services() as TtsServicesState;
    expect(state.error).toContain('99');
    expect(state.services).toEqual([]);
  });

  it('保存被拒绝,并说明先修好配置', async () => {
    const proxy = new VtuberWorldProxy({
      ttsRegistry: () => ({ ok: false, error: '未知的 TTS 配置版本 99' }),
    });
    await expect(proxy.ttsConsole().saveService({ service: service(), baseRevision: 0 }))
      .rejects.toThrow(/先修好/);
  });
});
