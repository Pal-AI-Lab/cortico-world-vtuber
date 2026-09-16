import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, Logger, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { VtuberWorldProxy } from '../../src/proxy.ts';
import { makeWav, recordingLogger, type LogLine } from './helpers.ts';
import type { TtsRegistryConfig } from '../../src/tts/config.ts';
import type { TtsServicesState } from '../../src/world.ts';

/**
 * 服务表经**真实子进程**接线:R8 要的是"配置真的到了执行 TTS 的那个进程",
 * 不是主进程里的对象形状对不对。所以这里 fork 真引擎,走完整 IPC,并用注入的
 * 假 HTTP 服务确认子进程确实发出了那次合成请求。
 */
class QuietHost implements WorldHost {
  logs: LogLine[] = [];
  log: Logger = recordingLogger('worlds.vtuber', (line) => this.logs.push(line));
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (): null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128_000 };
  pushDeferred(): void {}
  reportUsage(): void {}
  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, _opts?: PushOptions): Promise<EventEnvelope> {
    return { ...e, cursor: 1 } as EventEnvelope;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  async llmStalls(): Promise<number> {
    return 0;
  }
}

const TIMEOUT = 60_000;

describe('TTS 服务表经真实子进程', () => {
  let host: QuietHost;
  let tts: Server;
  let proxy: VtuberWorldProxy;
  let registry: TtsRegistryConfig;
  let serverDir: string;
  /** 子进程实际 POST 到的路径,用来证明请求真的发出去了 */
  const hits: string[] = [];

  beforeAll(async () => {
    host = new QuietHost();
    serverDir = mkdtempSync(join(tmpdir(), 'vtuber-tts-ipc-'));
    tts = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        hits.push(req.url ?? '');
        if (req.url === '/v1/audio/speech/stream') {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.from(makeWav(new Array(4800).fill(0.4))));
      });
    });
    await new Promise<void>((r) => tts.listen(0, '127.0.0.1', () => r()));
    const port = (tts.address() as { port: number }).port;
    registry = {
      version: 1,
      revision: 0,
      activeServiceId: 'legacy-default',
      services: [{
        id: 'legacy-default',
        name: '默认 VoxCPM2(旧配置)',
        protocol: 'voxcpm-legacy',
        management: 'managed-voxcpm',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        auth: { type: 'none' },
        model: 'voxcpm2',
        voice: 'default',
        responseFormat: 'wav',
        delivery: 'auto',
        timeoutMs: 30_000,
        legacy: {
          profile: { refAudio: null, refText: '', seed: 42, cfgValue: 2, inferenceTimesteps: 10, maxSteps: 200, temperature: 1 },
          runtime: {
            runtimeDir: '',
            runtimeRelease: '',
            baseLmFile: '',
            acousticFile: '',
            alignerLmFile: '',
            alignerAudioFile: '',
            voicesDir: '',
          },
        },
      }],
    };
    proxy = new VtuberWorldProxy({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl: `http://127.0.0.1:${port}`,
      audioDevice: () => 'none',
      ttsVoicesDir: () => join(serverDir, 'voices'),
      ttsRegistry: () => ({ ok: true, registry, virtual: false, notes: [] }),
      onTtsRegistry: (next) => { registry = next; },
      ttsSecrets: () => ({}),
    });
    await proxy.start(host);
  }, TIMEOUT);

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((r) => tts.close(() => r()));
    rmSync(serverDir, { recursive: true, force: true });
  });

  it('init 把注册表带进子进程:services 报的就是配置里那一条', async () => {
    const state = await proxy.ttsConsole().services() as TtsServicesState;
    expect(state.services.map((s) => s.id)).toEqual(['legacy-default']);
    expect(state.activeServiceId).toBe('legacy-default');
    expect(state.savedRevision).toBe(0);
    expect(state.appliedRevision).toBe(0);
    expect(state.pendingApply).toBe(false);
  });

  it('保存并激活一条通用服务:子进程回执确认应用,revision 对齐', async () => {
    const res = await proxy.ttsConsole().saveService({
      service: {
        id: 'generic',
        name: '通用服务',
        protocol: 'openai-speech',
        management: 'external',
        baseUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}/v1`,
        auth: { type: 'none' },
        model: 'any-model',
        voice: 'any-voice',
        responseFormat: 'wav',
        delivery: 'auto',
        timeoutMs: 30_000,
      },
      baseRevision: 0,
      activate: true,
    }) as { savedRevision: number; appliedRevision: number; activeServiceId: string; pendingApply: boolean };
    expect(res.savedRevision).toBe(1);
    // 子进程确认收到并应用,才算"已应用";没有回执时这里是 pendingApply
    expect(res.appliedRevision).toBe(1);
    expect(res.pendingApply).toBe(false);
    expect(res.activeServiceId).toBe('generic');
    expect(registry.activeServiceId).toBe('generic');
  });

  it('切换回内置条目同样经子进程确认', async () => {
    const res = await proxy.ttsConsole().activateService({ id: 'legacy-default', baseRevision: 1 }) as {
      appliedRevision: number;
      pendingApply: boolean;
    };
    expect(res.appliedRevision).toBe(2);
    expect(res.pendingApply).toBe(false);
  });

  it('草稿试听经子进程真实调用该服务并取回 wav;不落盘、不切换', async () => {
    hits.length = 0;
    const before = JSON.stringify(registry);
    const out = await proxy.ttsConsole().testService({
      id: 'draft',
      name: '草稿服务',
      protocol: 'openai-speech',
      management: 'external',
      baseUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}/v1`,
      auth: { type: 'none' },
      model: 'draft-model',
      voice: 'draft-voice',
      responseFormat: 'wav',
      delivery: 'auto',
      timeoutMs: 30_000,
    }, '草稿试听一句') as { message: string; wav: string | null };
    expect(out.message).toContain('试听 OK');
    expect(out.wav).toBeTruthy();
    const bytes = Buffer.from(out.wav!, 'base64');
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    // 真的发出了一次合成请求,而且没有写注册表
    expect(hits).toContain('/v1/audio/speech');
    expect(JSON.stringify(registry)).toBe(before);
  });

  it('指向不存在的地址时报错可诊断,不谎报成功', async () => {
    const out = await proxy.ttsConsole().testService({
      id: 'dead',
      name: '不存在的服务',
      protocol: 'openai-speech',
      management: 'external',
      baseUrl: 'http://127.0.0.1:1/v1',
      auth: { type: 'none' },
      model: 'm',
      voice: 'v',
      responseFormat: 'wav',
      delivery: 'auto',
      timeoutMs: 5_000,
    }, '一句') as { message: string; wav: string | null };
    expect(out.wav).toBeNull();
    expect(out.message).toContain('试听失败');
  });
});
