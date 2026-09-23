import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { IncrementalWavParser, pcm16ToWav, samplesToPcm16Wav } from '../../src/tts/audio.ts';
import { normalizeService, publicRegistry, virtualLegacyRegistry, type TtsRegistryConfig, type TtsServiceConfig } from '../../src/tts/config.ts';
import { prepareTtsAudition } from '../../src/tts/audition.ts';
import { legacySnapshotFromUrl } from '../../src/tts/registry.ts';
import { OpenAiSpeechAdapter } from '../../src/tts/openai-speech.ts';
import { VoxcpmLegacyAdapter } from '../../src/tts/voxcpm-legacy.ts';
import type { TtsPcmAligner, TtsPiece, TtsStreamSink } from '../../src/tts/types.ts';
import { VtuberWorldProxy } from '../../src/proxy.ts';
import { TtsServerManager } from '../../src/tts-server.ts';
import { VtuberWorld } from '../../src/world.ts';
import { makeRawWav } from './helpers.ts';

function wav(fmtSize = 18): Buffer {
  const dataAt = 20 + fmtSize + (fmtSize % 2);
  const b = Buffer.alloc(dataAt + 12);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(fmtSize, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', dataAt); b.writeUInt32LE(4, dataAt + 4);
  b.writeInt16LE(1000, dataAt + 8); b.writeInt16LE(-1000, dataAt + 10);
  return b;
}
function parse(chunks: Uint8Array[]): Buffer {
  const parser = new IncrementalWavParser();
  const out = Buffer.concat(chunks.map(chunk => parser.push(chunk)));
  parser.finish();
  return out;
}
function service(overrides: Partial<TtsServiceConfig> = {}): TtsServiceConfig {
  return {
    id: 'mine', name: '本地测试', protocol: 'openai-speech', management: 'external',
    baseUrl: 'http://127.0.0.1:8020/v1', auth: { type: 'none' },
    model: 'test-model', voice: 'test-voice', responseFormat: 'wav',
    delivery: 'auto', timeoutMs: 1000, ...overrides,
  };
}
function registry(s: TtsServiceConfig): TtsRegistryConfig {
  return { version: 1, revision: 1, activeServiceId: s.id, services: [s] };
}

// This fake transport honours AbortSignal, including while waiting for response headers.
function delayedResponse(delayMs: number, makeResponse = () => new Response(new Uint8Array(wav()), { headers: { 'Content-Type': 'audio/wav' } })): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(makeResponse());
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  })) as typeof fetch;
}

describe('functional regression: WAV fmt transport boundaries', () => {
  it.each([16, 18, 19, 40])('parses fmt=%i at every split and bytewise', (fmtSize) => {
    const bytes = wav(fmtSize);
    const expected = Buffer.from([0xe8, 0x03, 0x18, 0xfc]);
    expect(parse([bytes])).toEqual(expected);
    for (let split = 1; split < bytes.length; split++) {
      expect(parse([bytes.subarray(0, split), bytes.subarray(split)]), `fmt=${fmtSize}, split=${split}`).toEqual(expected);
    }
    expect(parse(Array.from(bytes, b => Uint8Array.of(b)))).toEqual(expected);
  });
});

describe('functional regression: optional settings round trip', () => {
  const base = service({ speed: 1.5, instructions: '慢一点', speechPath: 'custom/speech', extraBody: { language: 'zh' }, headers: { 'X-Tenant': 'acme' } });
  it('omitted fields preserve an existing partial configuration', () => {
    const saved = normalizeService({ name: '改名' }, base) as TtsServiceConfig;
    expect(saved.speed).toBe(1.5);
    expect(saved.instructions).toBe('慢一点');
    expect(saved.speechPath).toBe('custom/speech');
    expect(saved.extraBody).toEqual(base.extraBody);
    expect(saved.headers).toEqual(base.headers);
  });
  it('explicit null removes settings instead of restoring the saved values', () => {
    const saved = normalizeService({ speed: null, instructions: null, speechPath: null, extraBody: null, headers: null }, base) as TtsServiceConfig;
    expect(saved).not.toHaveProperty('error');
    for (const key of ['speed', 'instructions', 'speechPath', 'extraBody', 'headers']) expect(saved).not.toHaveProperty(key);
  });
  it('the editor can read its non-sensitive headers back', () => {
    expect(publicRegistry(registry(base), () => false, []).services[0]?.headers).toEqual(base.headers);
  });
});

describe('functional regression: draft API key', () => {
  const saved = service({ auth: { type: 'bearer', secretRef: 'SAVED_KEY' } });
  const read = { ok: true as const, registry: registry(saved), virtual: false, notes: [] };
  it('uses the just-entered key without writing the registry', () => {
    const before = JSON.stringify(read);
    const out = prepareTtsAudition({ ...saved, id: 'new', auth: { type: 'bearer' } }, read, 'temporary-key');
    expect(out).not.toHaveProperty('error');
    if ('error' in out) throw new Error(out.error);
    expect(out.apiKey).toBe('temporary-key');
    expect(out.service.auth).toEqual({ type: 'bearer', secretRef: 'VTUBER_TTS_AUDITION' });
    expect(JSON.stringify(read)).toBe(before);
  });
  it('unchanged origin and blank input retain the saved credential', () => {
    const out = prepareTtsAudition(saved, read);
    expect(out).not.toHaveProperty('error');
    if ('error' in out) throw new Error(out.error);
    expect(out.apiKey).toBeUndefined();
    expect(out.service.auth).toEqual(saved.auth);
  });
  it('editing the host does not use the old host key during preview', () => {
    const out = prepareTtsAudition({ ...saved, baseUrl: 'http://127.0.0.1:8021/v1' }, read);
    expect(out).not.toHaveProperty('error');
    if ('error' in out) throw new Error(out.error);
    expect(out.apiKey).toBe('');
  });
  it('a temporary key also works after editing the host', () => {
    const out = prepareTtsAudition({ ...saved, baseUrl: 'http://127.0.0.1:8021/v1' }, read, 'new-host-key');
    expect(out).toMatchObject({ apiKey: 'new-host-key' });
  });
});

describe('functional regression: stream deadline', () => {
  const snapshot = () => legacySnapshotFromUrl({ root: 'http://local-test', timeoutMs: 30 });
  it.each(['openai', 'legacy'] as const)('%s times out while waiting for headers', async (kind) => {
    const s = snapshot();
    const adapter = kind === 'openai' ? new OpenAiSpeechAdapter(s, delayedResponse(150)) : new VoxcpmLegacyAdapter(s, delayedResponse(150));
    await expect(adapter.synthStream('测试', { pcm() {} }, { signal: new AbortController().signal })).rejects.toBeTruthy();
  });
  it('ongoing small chunks do not remove the total synthesis deadline', async () => {
    let timer: ReturnType<typeof setInterval>;
    let ended = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        let count = 0;
        timer = setInterval(() => {
          c.enqueue(new Uint8Array([0xe8, 0x03]));
          if (++count === 30) { clearInterval(timer); ended = true; c.close(); }
        }, 10);
      },
      cancel() { clearInterval(timer); ended = true; },
    });
    const s = { ...snapshot(), responseFormat: 'pcm' as const, pcm: { sampleRate: 24000, channels: 1 as const, encoding: 's16le' as const } };
    const adapter = new OpenAiSpeechAdapter(s, (async () => new Response(body)) as typeof fetch);
    try {
      await expect(adapter.synthStream('测试', { pcm() {} }, { signal: new AbortController().signal })).rejects.toBeTruthy();
      expect(ended).toBe(true);
    } finally { clearInterval(timer!); }
  });
});

describe('functional regression: legacy profile persistence', () => {
  it('persists the profile into the registry and retains it through later service edits', async () => {
    let state = virtualLegacyRegistry({}, 'http://127.0.0.1:8010').registry;
    const proxy = new VtuberWorldProxy({
      ttsRegistry: () => ({ ok: true, registry: state, virtual: false, notes: [] }),
      onTtsRegistry: next => { state = next; },
    });
    // Test persistence independently of child startup. Full IPC tests remain in tts-ipc.test.ts.
    const engine = proxy as unknown as { applyTtsToEngine(r: TtsRegistryConfig): Promise<{ appliedRevision: number; activeServiceId: string }> };
    engine.applyTtsToEngine = async r => ({ appliedRevision: r.revision, activeServiceId: r.activeServiceId });
    const out = await proxy.ttsConsole().setProfile({ refAudio: 'voice.wav', refText: '参考转写', seed: 73 });
    expect(out.seed).toBe(73);
    expect(state.revision).toBe(1);
    expect(state.services[0]?.legacy?.profile).toMatchObject({ refAudio: 'voice.wav', refText: '参考转写', seed: 73 });
    await proxy.ttsConsole().saveService({ service: service(), baseRevision: 1 });
    expect(state.services[0]?.legacy?.profile.seed).toBe(73);
    const restartedState = JSON.parse(JSON.stringify(state)) as TtsRegistryConfig;
    expect(restartedState.services[0]?.legacy?.profile.refText).toBe('参考转写');
  });
  it('does not report success when the engine has not applied the saved profile', async () => {
    let state = virtualLegacyRegistry({}, 'http://127.0.0.1:8010').registry;
    const proxy = new VtuberWorldProxy({
      ttsRegistry: () => ({ ok: true, registry: state, virtual: false, notes: [] }),
      onTtsRegistry: next => { state = next; },
    });
    await expect(proxy.ttsConsole().setProfile({ seed: 74 })).rejects.toThrow(/档案已保存，但尚未应用/);
    expect(state.services[0]?.legacy?.profile.seed).toBe(74);
  });
});

describe('functional regression: managed process port', () => {
  it('keeps the running port and reads the new setting at the next start', async () => {
    let port = 8010;
    const log = { info() {}, warn() {}, emit() {}, child() { return this; } } as unknown as Logger;
    const manager = new TtsServerManager({
      runtimeDir: () => '', serverExe: () => '', modelsDir: '', port: () => port, log,
      commandOverride: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      healthIntervalMs: 60000,
    });
    try {
      manager.start();
      expect(manager.state().url).toBe('http://127.0.0.1:8010');
      port = 8011;
      expect(manager.state().url).toBe('http://127.0.0.1:8010');
      expect(manager.state().detail).toContain('停止后再启动');
      await manager.stop();
      manager.start();
      expect(manager.state().url).toBe('http://127.0.0.1:8011');
      expect(manager.state().detail).toBeNull();
    } finally { await manager.stop(); }
  });
});

describe('服务策略与配置归属', () => {
  it('切换服务后,在途流的前缀与整片对齐仍使用原服务', async () => {
    const state = virtualLegacyRegistry({}, 'http://original-service').registry;
    state.services.push(service());
    const pcm = new Uint8Array(new Int16Array([1000, -1000]).buffer);
    const audio = pcm16ToWav([pcm], 16000);
    const alignUrls: string[] = [];
    const units = [{ text: '测试', start: 0, end: 0.1 }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      alignUrls.push(String(url));
      return Response.json({ units, duration: 0.1 });
    });
    const world = new VtuberWorld({
      ttsRegistry: () => ({ ok: true, registry: state, virtual: false, notes: [] }),
      ttsFetch: (async () => new Response(new Uint8Array(audio), {
        headers: { 'Content-Type': 'audio/wav' },
      })) as typeof fetch,
      audioDevice: () => 'none',
      alignEnabled: () => true,
    });
    const engine = world as unknown as {
      synthStreamAligned(text: string, sink: TtsStreamSink, signal: AbortSignal): Promise<TtsPiece>;
      alignOk: boolean | null;
      ttsOk: boolean | null;
    };
    let alignPcm: TtsPcmAligner | undefined;
    try {
      await engine.synthStreamAligned('测试', {
        begin: info => {
          alignPcm = info.alignPcm;
          state.activeServiceId = 'mine';
          state.revision++;
        },
        pcm() {},
      }, new AbortController().signal);
      expect(alignPcm).toBeTypeOf('function');
      expect(await alignPcm!(pcm, 16000, ['测试'])).toEqual(units);
      expect(alignUrls).toEqual([
        'http://original-service/v1/audio/align',
        'http://original-service/v1/audio/align',
      ]);
      expect(engine.alignOk).toBeNull();
      expect(engine.ttsOk).toBeNull();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each(['openai', 'legacy'] as const)('%s 只采用所属协议的长静默策略', async (kind) => {
    const sampleRate = 8000;
    const bytes = pcm16ToWav([new Uint8Array(sampleRate * 2 * 8)], sampleRate);
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 44));
        for (let at = 44; at < bytes.length; at += sampleRate) {
          controller.enqueue(bytes.subarray(at, at + sampleRate));
        }
        controller.close();
      },
    }), { headers: { 'Content-Type': 'audio/wav' } })) as typeof fetch;
    const snapshot = legacySnapshotFromUrl({ root: 'http://test', timeoutMs: 1000 });
    const adapter = kind === 'openai'
      ? new OpenAiSpeechAdapter(snapshot, fetchImpl)
      : new VoxcpmLegacyAdapter(snapshot, fetchImpl);
    let delivered = 0;
    const piece = await adapter.synthStream('测试', { pcm: chunk => { delivered += chunk.length; } }, {
      signal: new AbortController().signal,
      ...(kind === 'openai' ? { maxDurationMs: 2000 } : {}),
    });
    expect(piece.silence?.triggered).toBe(true);
    if (kind === 'openai') {
      expect(piece.qualityPolicy).toBe('generic');
      expect(piece.durationMs).toBe(8000);
      expect(delivered).toBe(bytes.length - 44);
      expect(piece.truncated).toBeUndefined();
      expect(piece.maxAudioMs).toBeUndefined();
    } else {
      expect(piece.qualityPolicy).toBe('voxcpm');
      expect(piece.durationMs).toBeLessThan(8000);
      expect(delivered).toBeLessThan(bytes.length - 44);
      expect(piece.truncated).toBe(true);
      expect(piece.maxAudioMs).toBe(32000);
    }
  });

  it.each([16, 24])('增量解析 %i bit EXTENSIBLE 在任意网络分块处保持样本完整', bits => {
    const data = bits === 16
      ? new Uint8Array(new Int16Array([-32768, 0, 16384]).buffer)
      : Uint8Array.from([0, 0, 128, 0, 0, 0, 0, 0, 64]);
    const bytes = makeRawWav({ format: 0xfffe, bits, fmtLen: 40, data });
    const expected = Buffer.from(new Int16Array([-32768, 0, 16384]).buffer);
    for (let at = 1; at < bytes.length; at++) {
      expect(parse([bytes.subarray(0, at), bytes.subarray(at)]), `split=${at}`).toEqual(expected);
    }
    expect(parse(Array.from(bytes, b => Uint8Array.of(b)))).toEqual(expected);
  });

  it('注册表中的空运行时目录生效,清除构造时的旧路径', () => {
    const state = virtualLegacyRegistry({}, 'http://127.0.0.1:8010').registry;
    const world = new VtuberWorld({
      ttsRuntimeDir: () => 'obsolete-runtime',
      ttsBaseLmFile: () => 'obsolete-model',
      ttsRegistry: () => ({ ok: true, registry: state, virtual: false, notes: [] }),
      audioDevice: () => 'none',
    });
    expect(world.ttsConsole().runtime().own).toBe(false);
    expect(world.ttsConsole().runtime().models.some(model => model.path.includes('obsolete'))).toBe(false);
  });

  it('草稿试听从所选服务的声线目录读取同名参考音频', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-service-voices-'));
    const reference = samplesToPcm16Wav(Float32Array.from([0, 0.5, -0.5]), 16000);
    writeFileSync(join(dir, 'voice.wav'), reference);
    const state = virtualLegacyRegistry({}, 'http://127.0.0.1:8010').registry;
    const other: TtsServiceConfig = {
      ...state.services[0], id: 'other', management: 'external',
      legacy: {
        profile: { ...state.services[0].legacy!.profile, refAudio: 'voice.wav' },
        runtime: { ...state.services[0].legacy!.runtime, voicesDir: dir },
      },
    };
    state.services.push(other);
    let body: Record<string, unknown> = {};
    const world = new VtuberWorld({
      ttsRegistry: () => ({ ok: true, registry: state, virtual: false, notes: [] }),
      ttsFetch: (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(new Uint8Array(reference), { headers: { 'Content-Type': 'audio/wav' } });
      }) as typeof fetch,
      audioDevice: () => 'none',
    });
    try {
      const result = await world.ttsConsole().testService(other, '试听');
      expect(result.wav).not.toBeNull();
      expect(body.reference_audio).toBe(Buffer.from(reference).toString('base64'));
      expect(state.activeServiceId).toBe('legacy-default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
