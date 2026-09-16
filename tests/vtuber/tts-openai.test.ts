import { describe, it, expect } from 'vitest';
import { TtsServiceResolver } from '../../src/tts/registry.ts';
import { TTS_TIMEOUT_DEFAULT_MS, type TtsServiceConfig } from '../../src/tts/config.ts';
import { pcm16ToWav } from '../../src/tts.ts';

/** 一段默认 100ms 的 16kHz 单声道 PCM16 测试音频 */
function wavFixture(sampleRate = 16000, ms = 100): Uint8Array {
  const frames = Math.round((sampleRate * ms) / 1000);
  const pcm = new Uint8Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(i / 6) * 9000);
    pcm[2 * i] = v & 0xff;
    pcm[2 * i + 1] = (v >> 8) & 0xff;
  }
  return pcm16ToWav([pcm], sampleRate);
}

function openAiService(overrides: Partial<TtsServiceConfig> = {}): TtsServiceConfig {
  return {
    id: 'mine',
    name: '我自己的 TTS',
    protocol: 'openai-speech',
    management: 'external',
    baseUrl: 'http://127.0.0.1:8020/v1',
    auth: { type: 'none' },
    model: 'my-tts-model',
    voice: 'my-voice',
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function resolverFor(
  service: TtsServiceConfig,
  opts: { secrets?: Record<string, string>; fetchImpl?: typeof fetch } = {},
): TtsServiceResolver {
  const registry = { version: 1, revision: 1, activeServiceId: service.id, services: [service] };
  return new TtsServiceResolver({
    read: () => ({ ok: true, registry, virtual: false, notes: [] }),
    secrets: () => opts.secrets ?? {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

/** 二进制响应体:Node 的 Response 只接 ArrayBuffer 视图,这里统一转一次。 */
function binaryResponse(bytes: Uint8Array, contentType: string): Response {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Response(copy.buffer, { status: 200, headers: { 'Content-Type': contentType } });
}

function audioResponse(bytes: Uint8Array, contentType = 'audio/wav'): Response {
  return binaryResponse(bytes, contentType);
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headersOf(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('标准 Speech 请求契约', () => {
  it('Base URL 含 /v1、尾斜杠与网关前缀时最终地址不丢前缀也不重复 /v1', async () => {
    for (const [baseUrl, expected] of [
      ['https://service.example/v1', 'https://service.example/v1/audio/speech'],
      ['https://service.example/v1/', 'https://service.example/v1/audio/speech'],
      ['https://gateway.example/team/tts/v1', 'https://gateway.example/team/tts/v1/audio/speech'],
      ['http://127.0.0.1:8020/api', 'http://127.0.0.1:8020/api/audio/speech'],
    ] as const) {
      const { impl, calls } = fakeFetch(() => audioResponse(wavFixture()));
      const resolver = resolverFor(openAiService({ baseUrl }), { fetchImpl: impl });
      await resolver.adapterFor(resolver.snapshot()).synth('你好');
      expect(calls[0]!.url).toBe(expected);
    }
  });

  it('未配置鉴权时不发送 Authorization;配置后只在请求头里出现', async () => {
    const none = fakeFetch(() => audioResponse(wavFixture()));
    const r1 = resolverFor(openAiService(), { fetchImpl: none.impl });
    await r1.adapterFor(r1.snapshot()).synth('x');
    expect(headersOf(none.calls[0]!).Authorization).toBeUndefined();

    const bear = fakeFetch(() => audioResponse(wavFixture()));
    const r2 = resolverFor(openAiService({ auth: { type: 'bearer', secretRef: 'K' } }), {
      secrets: { K: 'sk-secret' },
      fetchImpl: bear.impl,
    });
    await r2.adapterFor(r2.snapshot()).synth('x');
    expect(headersOf(bear.calls[0]!).Authorization).toBe('Bearer sk-secret');
  });

  it('配置了 Bearer 但密钥没设置时明确报错,一个请求都不发', () => {
    const { impl, calls } = fakeFetch(() => audioResponse(wavFixture()));
    const resolver = resolverFor(openAiService({ auth: { type: 'bearer', secretRef: 'K' } }), {
      secrets: { K: '' },
      fetchImpl: impl,
    });
    expect(() => resolver.snapshot()).toThrow(/密钥 K 没有设置/);
    expect(calls).toHaveLength(0);
  });

  it('任意模型名与字符串/对象两种 voice 都原样构造', async () => {
    const { impl, calls } = fakeFetch(() => audioResponse(wavFixture()));
    const resolver = resolverFor(openAiService({ model: '任意/模型 名', voice: { id: 'voice-id-42' } }), { fetchImpl: impl });
    await resolver.adapterFor(resolver.snapshot()).synth('x');
    const body = bodyOf(calls[0]!);
    expect(body.model).toBe('任意/模型 名');
    expect(body.voice).toEqual({ id: 'voice-id-42' });
  });

  it('省略 speed/instructions 时请求体里完全缺席;配置后才出现', async () => {
    const bare = fakeFetch(() => audioResponse(wavFixture()));
    const r1 = resolverFor(openAiService(), { fetchImpl: bare.impl });
    await r1.adapterFor(r1.snapshot()).synth('x');
    const b1 = bodyOf(bare.calls[0]!);
    expect('speed' in b1).toBe(false);
    expect('instructions' in b1).toBe(false);

    const tuned = fakeFetch(() => audioResponse(wavFixture()));
    const r2 = resolverFor(openAiService({ speed: 1.2, instructions: '温柔一点' }), { fetchImpl: tuned.impl });
    await r2.adapterFor(r2.snapshot()).synth('x');
    const b2 = bodyOf(tuned.calls[0]!);
    expect(b2.speed).toBe(1.2);
    expect(b2.instructions).toBe('温柔一点');
  });

  it('通用请求不带任何 VoxCPM 字段,不请求私有 /stream,也不发 stream:true', async () => {
    const { impl, calls } = fakeFetch(() => audioResponse(wavFixture()));
    const resolver = resolverFor(openAiService(), { fetchImpl: impl });
    await resolver.adapterFor(resolver.snapshot()).synth('x');
    const body = bodyOf(calls[0]!);
    for (const key of ['seed', 'cfg_value', 'inference_timesteps', 'max_steps', 'temperature', 'reference_audio', 'prompt_text', 'stream']) {
      expect(key in body, key).toBe(false);
    }
    expect(calls[0]!.url).not.toContain('/stream');
    expect(body.response_format).toBe('wav');
  });

  it('合法的扩展参数并进请求体', async () => {
    const { impl, calls } = fakeFetch(() => audioResponse(wavFixture()));
    const resolver = resolverFor(openAiService({ extraBody: { language: 'zh', speed_boost: 1 } }), { fetchImpl: impl });
    await resolver.adapterFor(resolver.snapshot()).synth('x');
    const body = bodyOf(calls[0]!);
    expect(body.language).toBe('zh');
    expect(body.speed_boost).toBe(1);
  });

  it('非敏感扩展头随请求发出', async () => {
    const { impl, calls } = fakeFetch(() => audioResponse(wavFixture()));
    const resolver = resolverFor(openAiService({ headers: { 'X-Tenant': 'acme' } }), { fetchImpl: impl });
    await resolver.adapterFor(resolver.snapshot()).synth('x');
    expect(headersOf(calls[0]!)['X-Tenant']).toBe('acme');
  });
});

describe('外部服务不依赖本地资源', () => {
  it('/health 与 /models 都是 404,合成照样成功,而且只请求 speech', async () => {
    const seen: string[] = [];
    const { impl } = fakeFetch((url) => {
      seen.push(url);
      if (url.endsWith('/health') || url.endsWith('/models')) return new Response('nope', { status: 404 });
      return audioResponse(wavFixture());
    });
    const resolver = resolverFor(openAiService(), { fetchImpl: impl });
    const piece = await resolver.adapterFor(resolver.snapshot()).synth('你好');
    expect(piece.durationMs).toBeCloseTo(100, 0);
    expect(seen).toEqual(['http://127.0.0.1:8020/v1/audio/speech']);
  });

  it('能力面不声明本地进程管理、对齐或参考音频', () => {
    const caps = resolverFor(openAiService()).snapshot().capabilities;
    expect(caps.managesProcess).toBe(false);
    expect(caps.aligner).toBe(false);
    expect(caps.referenceAudio).toBe(false);
    expect(caps.privateStream).toBe(false);
    expect(caps.qualityPolicy).toBe('generic');
    expect(caps.maxAudioMs).toBeUndefined();
  });

  it('压缩格式与 buffered 都不声明增量消费', () => {
    expect(resolverFor(openAiService({ responseFormat: 'mp3' })).snapshot().capabilities.incremental).toBe(false);
    expect(resolverFor(openAiService({ delivery: 'buffered' })).snapshot().capabilities.incremental).toBe(false);
    expect(resolverFor(openAiService()).snapshot().capabilities.incremental).toBe(true);
  });
});

describe('错误归因与凭据边界', () => {
  it('401 / 429 / 5xx 报出状态码,不当成"不支持流式"', async () => {
    for (const status of [401, 429, 500]) {
      const { impl } = fakeFetch(() => new Response('boom '.repeat(200), { status }));
      const resolver = resolverFor(openAiService(), { fetchImpl: impl });
      await expect(resolver.adapterFor(resolver.snapshot()).synth('x')).rejects.toThrow(new RegExp(`HTTP ${status}`));
    }
  });

  it('错误正文被截断,不整段回抛第三方响应', async () => {
    const { impl } = fakeFetch(() => new Response('x'.repeat(5000), { status: 400 }));
    const resolver = resolverFor(openAiService(), { fetchImpl: impl });
    try {
      await resolver.adapterFor(resolver.snapshot()).synth('x');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(String(err)).toMatch(/HTTP 400/);
      expect(String(err).length).toBeLessThan(400);
    }
  });

  it('带凭据时不自动跟随重定向:旧 Key 不发给新 origin', async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/v1/audio/speech' } }),
    );
    const resolver = resolverFor(openAiService({ auth: { type: 'bearer', secretRef: 'K' } }), {
      secrets: { K: 'sk-secret' },
      fetchImpl: impl,
    });
    await expect(resolver.adapterFor(resolver.snapshot()).synth('x')).rejects.toThrow(/HTTP 302/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('返回 SSE 时明确报传输格式不支持,不把文本当音频', async () => {
    const { impl } = fakeFetch(() => new Response('data: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const resolver = resolverFor(openAiService(), { fetchImpl: impl });
    await expect(resolver.adapterFor(resolver.snapshot()).synth('x')).rejects.toThrow(/SSE/);
  });

  it('响应体是 HTML 时按 HTTP 错误处理', async () => {
    const { impl } = fakeFetch(() => new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const resolver = resolverFor(openAiService(), { fetchImpl: impl });
    await expect(resolver.adapterFor(resolver.snapshot()).synth('x')).rejects.toThrow(/HTTP 200/);
  });

  it('压缩格式缺 ffmpeg 时报格式依赖,不当 PCM 硬啃', async () => {
    const { impl } = fakeFetch(() => audioResponse(new Uint8Array([1, 2, 3]), 'audio/mpeg'));
    const resolver = resolverFor(openAiService({ responseFormat: 'mp3' }), { fetchImpl: impl });
    const original = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(resolver.adapterFor(resolver.snapshot()).synth('x')).rejects.toThrow(/需要本机 ffmpeg/);
    } finally {
      process.env.PATH = original;
    }
  });

  it('压缩格式有 ffmpeg 时走转码,坏数据报的是转码失败而不是格式不支持', async () => {
    const { impl } = fakeFetch(() => audioResponse(new Uint8Array([1, 2, 3]), 'audio/mpeg'));
    const resolver = resolverFor(openAiService({ responseFormat: 'mp3' }), { fetchImpl: impl });
    await expect(resolver.adapterFor(resolver.snapshot()).synth('x')).rejects.toThrow(/ffmpeg/);
  });
});

describe('增量合成走同一个端点', () => {
  it('标准流式只请求 speech,不追加 /stream', async () => {
    const wav = wavFixture(16000, 200);
    const { impl, calls } = fakeFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(wav);
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    });
    const resolver = resolverFor(openAiService(), { fetchImpl: impl });
    const adapter = resolver.adapterFor(resolver.snapshot());
    const got: Uint8Array[] = [];
    const piece = await adapter.synthStream!('你好', { pcm: (c) => got.push(c) }, { signal: new AbortController().signal });
    expect(calls[0]!.url).toBe('http://127.0.0.1:8020/v1/audio/speech');
    expect(piece.durationMs).toBeCloseTo(200, 0);
    expect(got.length).toBeGreaterThan(0);
  });

  it('raw pcm 按配置的采样率解释,不假定 24kHz', async () => {
    const pcm = new Uint8Array(8000 * 2);
    const { impl } = fakeFetch(() => binaryResponse(pcm, 'audio/pcm'));
    const resolver = resolverFor(
      openAiService({ responseFormat: 'pcm', pcm: { sampleRate: 8000, channels: 1, encoding: 's16le' } }),
      { fetchImpl: impl },
    );
    const adapter = resolver.adapterFor(resolver.snapshot());
    const piece = await adapter.synthStream!('x', { pcm: () => {} }, { signal: new AbortController().signal });
    expect(piece.durationMs).toBeCloseTo(1000, 0);
  });

  it('缺少 PCM 描述时不猜采样率', async () => {
    const pcm = new Uint8Array(1600);
    const { impl } = fakeFetch(() => binaryResponse(pcm, 'audio/pcm'));
    const resolver = resolverFor(openAiService({ responseFormat: 'pcm' }), { fetchImpl: impl });
    const adapter = resolver.adapterFor(resolver.snapshot());
    await expect(adapter.synthStream!('x', { pcm: () => {} }, { signal: new AbortController().signal }))
      .rejects.toThrow(/采样率与声道数/);
  });

  it('取消后不再产出音频', async () => {
    const wav = wavFixture(16000, 3000);
    const ac = new AbortController();
    const { impl } = fakeFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(wav);
          // 不关闭:由取消终止
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    });
    const resolver = resolverFor(openAiService(), { fetchImpl: impl });
    const adapter = resolver.adapterFor(resolver.snapshot());
    let count = 0;
    const run = adapter.synthStream!('x', {
      pcm: () => {
        count++;
        ac.abort();
      },
    }, { signal: ac.signal });
    await expect(run).rejects.toBeTruthy();
    const seen = count;
    await new Promise((r) => setTimeout(r, 30));
    expect(count).toBe(seen);
  });
});

describe('服务切换按快照边界生效', () => {
  it('切换后新合成用新服务,在途快照不随之改变', async () => {
    const a = openAiService({ id: 'a', name: 'A', model: 'model-a' });
    const b = openAiService({ id: 'b', name: 'B', model: 'model-b' });
    let active = 'a';
    const registry = () => ({
      version: 1,
      revision: active === 'a' ? 1 : 2,
      activeServiceId: active,
      services: [a, b],
    });
    const calls: Call[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return audioResponse(wavFixture());
    }) as unknown as typeof fetch;
    const resolver = new TtsServiceResolver({
      read: () => ({ ok: true, registry: registry(), virtual: false, notes: [] }),
      secrets: () => ({}),
      fetchImpl: impl,
    });
    const inFlight = resolver.snapshot();
    active = 'b';
    await resolver.adapterFor(inFlight).synth('第一片');
    await resolver.adapterFor(resolver.snapshot()).synth('第二片');
    expect(bodyOf(calls[0]!).model).toBe('model-a');
    expect(bodyOf(calls[1]!).model).toBe('model-b');
    // 在途那一份没有被切换改写
    expect(inFlight.model).toBe('model-a');
  });
});
