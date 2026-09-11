import { legacyTap } from '../core/fixture-protocol.ts';
import { ChatResponseAssembly } from '../../src/providers/transport/response-assembly.ts';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, get as httpGet, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import type { EventEnvelope, IOModuleHost, PushOptions } from '../../src/core/types.ts';
import { findFfmpeg } from '../../src/io-vtuber/audio-convert.ts';
import {
  VTUBER_CONFIG_GROUP,
  VTS_STALL_STREAK,
  VTUBER_MODULE_DEFAULTS,
  VTUBER_TOOL_DECLS,
  VtuberModule,
  silenceReminder,
  type TtsProfile,
} from '../../src/io-vtuber/module.ts';
import { EXAMPLE_PACK_DIR } from '../../src/io-vtuber/pack.ts';
import { decodeWav } from '../../src/io-vtuber/tts.ts';
import { encodeAudio, fixtureProfileJson, makeWav, recordingLogger, writeProfileDir, type LogLine } from './helpers.ts';

const ffmpegExe = findFfmpeg('');

/** 面板声明里的局部 id(新式对象声明;字符串形态这个模组已经不用了) */
function panelIds(m: VtuberModule): string[] {
  return (m.console().panels ?? []).map((p) => (typeof p === 'string' ? p : p.id));
}

class FakeHost implements IOModuleHost {
  events: Array<{ e: EventEnvelope; opts?: PushOptions }> = [];
  pushDeferred(): void {}
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as IOModuleHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = {
    model: () => 'test',
    accepts: () => false,
    contextWindow: () => 128000,
  };
  /** 运行日志流:告警口径的断言看 level,投影断言看 area/event/data。用例会整体换掉这个数组 */
  logs: LogLine[] = [];
  log = recordingLogger('io.vtuber', (line) => this.logs.push(line));

  async pushEvent(
    e: Omit<EventEnvelope, 'cursor' | 'origin'> & { origin?: EventEnvelope['origin'] },
    opts?: PushOptions,
  ): Promise<EventEnvelope> {
    const full = { origin: 'external', ...e, cursor: this.events.length + this.notes.length + 1 } as EventEnvelope;
    // 通道融合后模组自省信号走 pushEvent(origin:'internal');分开收集保持断言语义
    if (full.origin === 'internal') {
      this.notes.push(full.text);
      return full;
    }
    this.events.push({ e: full, opts });
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  notes: string[] = [];
  reportUsage() {}
  get outcomes(): Array<{ callId: string; script: string; reason: string }> {
    return this.events.filter(row => row.e.type === 'vtuber.act.outcome')
      .flatMap(row => row.e.meta?.outcomes as Array<{ callId: string; script: string; reason: string }>);
  }
}

class FakeVts {
  http: Server;
  wss: WebSocketServer;
  received: string[] = [];
  port = 0;
  /** CurrentModelRequest 报回的模型名;换模型时改这里再 pushModelLoaded */
  modelName = 'FixtureModel';

  constructor() {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { requestID: string; messageType: string };
        this.received.push(msg.messageType);
        const reply = (messageType: string, data: Record<string, unknown>) =>
          ws.send(JSON.stringify({ requestID: msg.requestID, messageType, data }));
        switch (msg.messageType) {
          case 'AuthenticationTokenRequest':
            return reply('AuthenticationTokenResponse', { authenticationToken: 'tok-dev' });
          case 'AuthenticationRequest':
            return reply('AuthenticationResponse', { authenticated: true });
          case 'CurrentModelRequest':
            return reply('CurrentModelResponse', { modelLoaded: true, modelName: this.modelName, modelID: 'm1' });
          case 'EventSubscriptionRequest':
            return reply('EventSubscriptionResponse', {});
          case 'ExpressionStateRequest':
            return reply('ExpressionStateResponse', { expressions: [{ file: 'Idea.exp3.json', active: true }] });
          case 'InputParameterListRequest':
            // 实机内置参数名单,刻意不含 BrowAngleL 这类外部面板运行时才追加的参数,
            // 用于覆盖过滤逻辑分支
            return reply('InputParameterListResponse', {
              defaultParameters: [
                'FaceAngleX', 'FaceAngleY', 'FaceAngleZ',
                'EyeOpenLeft', 'EyeOpenRight',
                'EyeLeftX', 'EyeLeftY', 'EyeRightX', 'EyeRightY',
                'BrowLeftY', 'BrowRightY',
                'MouthSmile', 'MouthOpen', 'CheekPuff',
              ].map((name) => ({ name })),
              customParameters: [],
            });
          default:
            return reply(`${msg.messageType.replace(/Request$/, '')}Response`, {});
        }
      });
    });
  }

  /** VTS 主动推的换模型事件:没有 requestID */
  pushModelLoaded(modelName: string): void {
    const msg = JSON.stringify({ messageType: 'ModelLoadedEvent', data: { modelLoaded: true, modelName } });
    for (const c of this.wss.clients) c.send(msg);
  }

  /** port=0 随机挑;给定端口用于「VTS 后起」——模组得连回同一个地址 */
  async start(port = 0): Promise<void> {
    await new Promise<void>((r) => this.http.listen(port, '127.0.0.1', () => r()));
    this.port = (this.http.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => this.http.close(() => r())));
  }
}

class StreamProbe {
  events: Array<Record<string, unknown>> = [];
  private req: ReturnType<typeof httpGet> | null = null;
  private ws: WebSocket | null = null;

  async attach(streamUrl: string, danmakuUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(streamUrl, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk: string) => {
          buf += chunk;
          let at: number;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, at);
            buf = buf.slice(at + 2);
            for (const line of block.split('\n')) {
              if (line.startsWith('data: ')) {
                this.events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
              }
            }
          }
        });
        resolve();
      });
      req.on('error', reject);
      this.req = req;
    });
    const ws = new WebSocket(danmakuUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
  }

  sendDanmaku(text: string, from: string): void {
    this.ws?.send(JSON.stringify({ type: 'danmaku_in', text, from }));
  }

  close(): void {
    this.req?.destroy();
    try {
      this.ws?.close();
    } catch {
      /* 收尾 */
    }
  }
}

function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor 超时'));
      }
    }, 10);
  });
}

describe('VtuberModule 停机次序', () => {
  it('先等当前台词排空,再停编排器', async () => {
    const mod = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      audioDevice: () => 'none',
    });
    const order: string[] = [];
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let noteDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => { noteDrainStarted = resolve; });
    const internals = mod as unknown as {
      performer: {
        drainQueue(): Promise<number>;
        speechBacklogMs(): number;
        unplayedPieces(): number;
        stop(): void;
      } | null;
    };
    internals.performer = {
      drainQueue: async () => {
        order.push('performer.drain');
        noteDrainStarted();
        await drain;
        return 0;
      },
      speechBacklogMs: () => 0,
      unplayedPieces: () => 0,
      stop: () => { order.push('performer.stop'); },
    };

    const stopping = mod.stop();
    await drainStarted;
    const beforeDrainRelease = [...order];
    releaseDrain();
    await stopping;

    expect(beforeDrainRelease).toEqual(['performer.drain']);
    expect(order).toEqual(['performer.drain', 'performer.stop']);
  });

  /*
   * 排空超时后 stop 丢弃剩余队列，须记录丢弃片数和时长。
   */
  it('关机排空超时:丢掉的片数与秒数记成「关机丢词」', async () => {
    const mod2 = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      audioDevice: () => 'none',
    });
    const internals = mod2 as unknown as {
      performer: {
        drainQueue(maxMs: number): Promise<number>;
        speechBacklogMs(): number;
        unplayedPieces(): number;
        stop(): void;
      } | null;
    };
    internals.performer = {
      drainQueue: async (maxMs: number) => maxMs,
      speechBacklogMs: () => 4500,
      unplayedPieces: () => 2,
      stop: () => {},
    };
    await mod2.stop();
    const entries = mod2.logConsole().entries();
    expect(entries.some((e) => e.area === '关机' && e.msg.includes('关机丢词') && e.msg.includes('2 片'))).toBe(true);
  });
});

describe('VTuber 外置资源配置', () => {
  it('默认留空,配置声明提供对应的本机选择器', () => {
    const keys = [
      'ttsBaseLmFile',
      'ttsAcousticFile',
      'ttsAlignerLmFile',
      'ttsAlignerAudioFile',
      'ttsVoicesDir',
      'live2dDir',
    ] as const;
    for (const key of keys) {
      expect(VTUBER_MODULE_DEFAULTS[key]).toBe('');
      expect(VTUBER_CONFIG_GROUP.schema.properties[`io.vtuber.${key}`]?.['x-path']).toBeDefined();
    }
  });
});

describe('VtuberModule', () => {
  let host: FakeHost;
  let stage: StreamProbe;
  let tts: Server;
  let mod: VtuberModule;
  let serverDir: string;
  let ttsBodies: Array<Record<string, unknown>>;
  /** 假 VoxCPM2 这一轮要回的音频;null=默认那段 100ms 话音 */
  let ttsWav: Uint8Array | null;
  let savedProfiles: TtsProfile[];

  beforeEach(async () => {
    host = new FakeHost();
    // 声线库:一条带转写的参考音频
    serverDir = mkdtempSync(join(tmpdir(), 'vtuber-ttsdir-'));
    mkdirSync(join(serverDir, 'voices'));
    writeFileSync(join(serverDir, 'voices', 'mei.wav'), Buffer.from(makeWav(new Array(160).fill(0.2))));
    writeFileSync(join(serverDir, 'voices', 'mei.txt'), '参考音频的转写文本', 'utf8');
    // 假 VoxCPM2:记下请求体,任何合成请求回 100ms 的 wav
    ttsBodies = [];
    ttsWav = null;
    savedProfiles = [];
    tts = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) {
          try {
            ttsBodies.push(JSON.parse(raw) as Record<string, unknown>);
          } catch {
            /* health 等非 JSON 请求 */
          }
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.from(ttsWav ?? makeWav(new Array(1600).fill(0.4))));
      });
    });
    await new Promise<void>((r) => tts.listen(0, '127.0.0.1', () => r()));
    const ttsPort = (tts.address() as { port: number }).port;
    mod = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      // 不可达端口:VTS 缺席时演出仍走
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl: `http://127.0.0.1:${ttsPort}`,
      ttsServerDir: serverDir,
      onTtsProfile: (p) => savedProfiles.push(p),
      // 积压闸测试用最紧的上限;正常用例积压为 0,闸不介入
      speechCapSec: () => 3,
      // 测试机不出声,走静音时间线
      audioDevice: () => 'none',
    });
    await mod.start(host);
    stage = new StreamProbe();
    await stage.attach(mod.streamUrl, mod.danmakuUrl);
  });

  afterEach(async () => {
    stage.close();
    await mod.stop();
    await new Promise<void>((r) => tts.close(() => r()));
    rmSync(serverDir, { recursive: true, force: true });
  });

  it('keeps interleaved standard function streams open until each native call completes', async () => {
    const tap = mod.outputTap();
    const assembly = new ChatResponseAssembly({ model: 'test' });
    const emit = tap.onEvent.bind(tap);
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'first', function: { name: 'vtuber_act', arguments: '{"script":"第一' } }] } }] }, emit);
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'second', function: { name: 'vtuber_act', arguments: '{"script":"第二' } }] } }] }, emit);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ttsBodies).toHaveLength(0);
    assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '句。"}' } }, { index: 1, function: { arguments: '句。"}' } }] }, finish_reason: 'tool_calls' }] }, emit);
    assembly.finish(emit);
    tap.onRoundEnd?.();
    await waitFor(() => stage.events.filter(event => event.type === 'subtitle').length >= 2);
    expect(stage.events.filter(event => event.type === 'subtitle').map(event => event.text)).toEqual(['第一句。', '第二句。']);
  });

  it('outputTap 流式捕获:参数流边到边演,handler 只回执不二次演出', async () => {
    const tap = legacyTap(mod.outputTap());
    const args = JSON.stringify({ script: '【点头】大家好。' });
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'c1', name: 'vtuber_act' });
    for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 0 });
    // 字幕事件送出 = 语音已进声卡时间线
    await waitFor(() => stage.events.some((m) => m.type === 'subtitle'));
    const tools = mod.tools();
    const act = tools.find((t) => t.name === 'vtuber_act');
    // 去重按 tool_call id 对上号,不按台词原文:同轮重复短语不会被误判成已演出
    const result = await act?.handler({ script: '【点头】大家好。' }, { role: 'main', log: host.log, callId: 'c1' });
    expect(result).toContain('流式');
    // 同样台词、不同调用:不是已开演的那次,照常排入演出
    const again = await act?.handler({ script: '【点头】大家好。' }, { role: 'main', log: host.log, callId: 'c2' });
    expect(again).toContain('已排入演出');
    // 字幕随播放进演出流
    await waitFor(() => stage.events.some((m) => m.type === 'subtitle' && m.text === '大家好。'));
  });

  /*
   * 非流式重合成只针对超大静默段；逐字对齐偏差本身不触发重合成。
   */
  it('非流式:超大静默段重合成一次,第二次仍不干净就照常播出', async () => {
    // 5 秒死气打头 + 1 秒话音:错误生产的签名(门 4000ms)
    ttsWav = makeWav([...new Array(16000 * 5).fill(0), ...new Array(16000).fill(0.4)]);
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    await act?.handler({ script: '带死气的一句。' }, { role: 'main', log: host.log, callId: 'silence-1' });
    const tries = (): number => ttsBodies.filter((b) => b.input === '带死气的一句。').length;
    await waitFor(() => tries() === 2);
    // 只重合成一次:第二次仍有死气就照常播出,宁可念得不完美,不要哑掉
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(tries()).toBe(2);
    await waitFor(() => stage.events.some((m) => m.type === 'subtitle' && m.text === '带死气的一句。'));
    await mod.tools().find((t) => t.name === 'vtuber_interrupt')!.handler({}, { role: 'main', log: host.log });
  });

  it('非流式:一直在出声的片一次合成就够,不重合成', async () => {
    ttsWav = makeWav(new Array(1600).fill(0.4));
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    await act?.handler({ script: '干净的一句。' }, { role: 'main', log: host.log, callId: 'silence-2' });
    await waitFor(() => stage.events.some((m) => m.type === 'subtitle' && m.text === '干净的一句。'));
    expect(ttsBodies.filter((b) => b.input === '干净的一句。')).toHaveLength(1);
  });

  it('outputTap 在工具参数流结束前把达标句末送进 TTS', async () => {
    const tap = legacyTap(mod.outputTap());
    // 自动切片要求首片自身达到 40 字门槛。
    const first = `${'一二三四五六七八九十'.repeat(4)}。”`;
    const args = JSON.stringify({ script: `${first}后续。` });
    const nextChar = args.indexOf('后');
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'early-tts', name: 'vtuber_act' });
    for (const ch of args.slice(0, nextChar + 1)) {
      tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    }

    await waitFor(() => ttsBodies.some((body) => body.input === first));

    for (const ch of args.slice(nextChar + 1)) {
      tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    }
    tap.onDelta({ type: 'tool_call.end', index: 0 });
    await waitFor(() => ttsBodies.some((body) => body.input === '后续。'));
  });

  it('JSON 字符串数组候选跨 fragment 全程扣流，结束后只播解包台本并修订历史', async () => {
    const tap = legacyTap(mod.outputTap());
    const decoded = '候选台本只在结束后播出。';
    const wrapped = JSON.stringify([decoded]);
    const args = JSON.stringify({ script: wrapped });
    const before = ttsBodies.length;
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'wrapped-stream', name: 'vtuber_act' });
    for (let i = 0; i < args.length; i += 2) {
      tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: args.slice(i, i + 2) });
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(ttsBodies).toHaveLength(before);
    expect(stage.events.some((event) => event.type === 'subtitle')).toBe(false);

    tap.onDelta({ type: 'tool_call.end', index: 0 });
    await waitFor(() => ttsBodies.some((body) => body.input === decoded));
    expect(ttsBodies.slice(before).every((body) => !String(body.input).includes('['))).toBe(true);

    const act = mod.tools().find((tool) => tool.name === 'vtuber_act');
    const result = await act?.handler(
      { script: wrapped },
      { role: 'main', log: host.log, callId: 'wrapped-stream' },
    );
    expect(result).toContain('已开演(流式)');
    expect(result).toContain('已解包外部 JSON 单元素字符串数组');
    expect(host.logs.some((log) => log.msg.includes('normalized_act_script'))).toBe(true);
  });

  it('JSON 字符串数组候选断流时丢弃，不外化也不冒充已流式演出', async () => {
    const tap = legacyTap(mod.outputTap());
    const decoded = '断流后不能播出的候选台本。';
    const wrapped = JSON.stringify([decoded]);
    const args = JSON.stringify({ script: wrapped });
    const before = ttsBodies.length;
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'wrapped-abort', name: 'vtuber_act' });
    for (let i = 0; i < args.length; i += 2) {
      tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: args.slice(i, i + 2) });
    }
    tap.onAbort?.('测试断流');

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(ttsBodies).toHaveLength(before);
    expect(stage.events.some((event) => event.type === 'subtitle' && event.text === decoded)).toBe(false);

    const act = mod.tools().find((tool) => tool.name === 'vtuber_act');
    const result = await act?.handler(
      { script: wrapped },
      { role: 'main', log: host.log, callId: 'wrapped-abort' },
    );
    expect(result).toContain('已排入演出');
    expect(result).not.toContain('已开演(流式)');
  });

  it('普通台本断流时不 flush 禁播词待定尾缀', async () => {
    await mod.stop();
    mod = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}`,
      ttsServerDir: serverDir,
      speechCapSec: () => 3,
      audioDevice: () => 'none',
      mutedText: () => '(这句已归入交接笔记)',
    });
    await mod.start(host);
    stage.close();
    stage = new StreamProbe();
    await stage.attach(mod.streamUrl, mod.danmakuUrl);

    const tap = legacyTap(mod.outputTap());
    const args = JSON.stringify({ script: '晚安(这句已' });
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'redactor-abort', name: 'vtuber_act' });
    for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onAbort?.('测试断流');

    await waitFor(() => ttsBodies.some((body) => body.input === '晚安'));
    expect(ttsBodies.some((body) => String(body.input).includes('(这句已'))).toBe(false);
    expect(stage.events.some((event) =>
      event.type === 'subtitle' && typeof event.text === 'string' && event.text.includes('(这句已'))).toBe(false);
  });

  it('多元素数组与损坏容器不进入字幕或 TTS，并返回稳定形状错误', async () => {
    const tap = legacyTap(mod.outputTap());
    const wrapped = '["第一段。","第二段。"]';
    const args = JSON.stringify({ script: wrapped });
    const before = ttsBodies.length;
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'invalid-stream', name: 'vtuber_act' });
    for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 0 });

    const act = mod.tools().find((tool) => tool.name === 'vtuber_act');
    const result = await act?.handler(
      { script: wrapped },
      { role: 'main', log: host.log, callId: 'invalid-stream' },
    );
    expect(result).toContain('invalid_script_shape');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(ttsBodies).toHaveLength(before);
    expect(stage.events.some((event) => event.type === 'subtitle')).toBe(false);
    expect(host.logs.some((log) => log.msg.includes('invalid_script_shape'))).toBe(true);
  });

  it('工具表只有 vtuber_act 与 vtuber_interrupt', () => {
    expect(mod.tools().map((tool) => tool.name)).toEqual(['vtuber_act', 'vtuber_interrupt']);
    expect(VTUBER_TOOL_DECLS.map((decl) => decl.name)).toEqual(['vtuber_act', 'vtuber_interrupt']);
  });

  it('重启后从诊断目录恢复当前声线的历史语速样本', async () => {
    const diagDir = join(serverDir, 'rate-history');
    const common = {
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}`,
      ttsServerDir: serverDir,
      audioDevice: () => 'none',
      diagDir,
    } as const;
    const producer = new VtuberModule(common);
    let restored: VtuberModule | null = null;
    try {
      await producer.start(new FakeHost());
      const act = producer.tools().find((tool) => tool.name === 'vtuber_act');
      if (!act) throw new Error('no act tool');
      await act.handler(
        { script: '留下一条持久语速样本。' },
        { role: 'main', log: host.log, callId: 'persist-rate' },
      );
      const rateLog = join(diagDir, 'speech-rate.jsonl');
      await waitFor(() => existsSync(rateLog) && readFileSync(rateLog, 'utf8').trim().length > 0);
      await producer.stop();

      restored = new VtuberModule(common);
      await restored.start(new FakeHost());
      const samples = (restored as unknown as { speechRateSamples: unknown[] }).speechRateSamples;
      expect(samples.length).toBeGreaterThan(0);
    } finally {
      await producer.stop();
      await restored?.stop();
    }
  });

  it('outputTap:content 含演出标记时投内部自省提醒并引用原文;无标签不投;冷却期不重复', () => {
    const tap = legacyTap(mod.outputTap());
    tap.onDelta({ type: 'content', text: '【看一眼弹幕,点头】赢了赢了' });
    tap.onRoundEnd?.();
    expect(host.events.length).toBe(0);
    expect(host.notes).toHaveLength(1);
    expect(host.notes[0]).toContain('没有发给观众');
    expect(host.notes[0]).toContain('【看一眼弹幕,点头】赢了赢了');
    expect(host.notes[0]).toContain('vtuber_act');

    // 词表词的 <> / [] 括法同样算泄漏——但落在冷却期内,不重复提醒
    tap.onDelta({ type: 'content', text: '<点头>好的呀' });
    tap.onRoundEnd?.();
    expect(host.notes).toHaveLength(1);

    host.notes = [];
    tap.onDelta({ type: 'content', text: '只是内部备注,没有演出标签' });
    tap.onRoundEnd?.();
    expect(host.notes).toHaveLength(0);
    // 散文里的 <> / [] 不误报:括的不是词表词
    tap.onDelta({ type: 'content', text: '看 [文档](https://x) 或 <div> 标签' });
    tap.onRoundEnd?.();
    expect(host.notes).toHaveLength(0);
  });

  it('未经 tap 的调用整段演出,演完后状态行回到安静', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    const result = await act?.handler({ script: '就说一句。' }, { role: 'main', log: host.log });
    expect(result).toContain('已排入演出');
    await waitFor(() => mod.statusLine()?.includes('安静') ?? false);
  });

  it('弹幕逐条落一条事件,合批交给核心(模组不再自己攒一遍)', async () => {
    stage.sendDanmaku('主播好', '观众A');
    stage.sendDanmaku('来啦', '观众A2');
    await waitFor(() => host.events.filter(({ e }) => e.type === 'vtuber.danmaku').length === 2);
    const danmaku = host.events.filter(({ e }) => e.type === 'vtuber.danmaku');
    expect(danmaku.map(({ e }) => e.senderKey)).toEqual(['观众A', '观众A2']);
    // 不指定 trigger = 走核心的安静窗口与地板;既不冲洗也不落库不投
    for (const d of danmaku) {
      expect(d.opts?.trigger).toBeUndefined();
      expect(d.opts?.deliver).toBeUndefined();
    }
  });

  /*
   * 空 script 使用否定形失败回执并点明入参。
   */
  it('空 script 走否定形失败回执并点名入参,不再冒充"本轮沉默"', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    for (const script of ['', '   ']) {
      const result = String(await act?.handler({ script }, { role: 'main', log: host.log }));
      expect(result).toContain('script');
      expect(result).toContain('没有台词正文');
      expect(result).not.toContain('本轮沉默');
      expect(result).not.toContain('[演出状态]');
    }
    // 失真要看得见:空调用落 warn 并计入滚动摘要的桶
    expect(host.logs.some((l) => l.level === 'warn' && l.area === 'io.vtuber.empty-script')).toBe(true);
  });

  it('非字符串 script 稳定失败，不降成空台本假装本轮沉默', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    const result = await act?.handler(
      { script: 123, other: '绝不能播出' },
      { role: 'main', log: host.log },
    );
    expect(result).toContain('[vtuber_act 失败]');
    expect(result).toContain('必须是字符串');
    expect(result).not.toContain('本轮沉默');
  });

  it('积压闸:超上限的新调用拒收并回执解释', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    // 长台本先排入:合成尚未返回,积压按单元×校准估计,远超 3s 上限
    const long = '这是一段非常长的台词'.repeat(20) + '。';
    const r1 = await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'g1' });
    expect(r1).toContain('已排入演出');
    const r2 = await act.handler({ script: '第二段想插话。' }, { role: 'main', log: host.log, callId: 'g2' });
    expect(r2).toContain('[未排入]');
    expect(r2).toContain('vtuber_interrupt');
  });

  // 空调用排在闸后会拿到「你上一段话还有 N 秒没说完,这一段没有播出」——
  // 她并没有写台词,却被告知台词被丢了,由此以为自己说过的话被系统吞掉。
  it('空调用不受积压闸评判:排着长台本时空 script 仍走空台本回执', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    const long = '这是一段非常长的台词'.repeat(20) + '。';
    await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'b1' });
    const silent = String(await act.handler({ script: '' }, { role: 'main', log: host.log, callId: 'b2' }));
    expect(silent).toContain('没有台词正文');
    expect(silent).not.toContain('本轮沉默');
    expect(silent).not.toContain('未排入');
    // 有正文的照旧被拦
    const spoken = await act.handler({ script: '第二段想插话。' }, { role: 'main', log: host.log, callId: 'b3' });
    expect(spoken).toContain('[未排入]');
  });

  // 本地演出未按预期完成的事实记录 warn，普通流水仍用 info。
  it('告警口径:失真才报 warn,流水事件仍是 info', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    const long = '这是一段非常长的台词'.repeat(20) + '。';
    host.logs = []; // 开局 VTS 连不上那条 warn 与本用例无关
    const r1 = await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'q1' });
    expect(r1).toContain('已排入演出');
    // 正常排入是流水:开轮/合成/播放一律 info,不占告警
    expect(host.logs.filter((l) => l.level === 'warn')).toHaveLength(0);
    expect(host.logs.some((l) => l.level === 'info')).toBe(true);

    const r2 = await act.handler({ script: '插一句。' }, { role: 'main', log: host.log, callId: 'q2' });
    expect(r2).toContain('[未排入]');
    const warns = host.logs.filter((l) => l.level === 'warn');
    expect(warns.map((l) => l.msg).join('\n')).toContain('拒收');
  });

  it('滚动摘要:按桶聚合这一窗的失真计数,推控制台走的还是那条埋点通道', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    const long = '这是一段非常长的台词'.repeat(20) + '。';
    await act.handler({ script: long }, { role: 'main', log: host.log, callId: 's0' });
    await act.handler({ script: '插一句。' }, { role: 'main', log: host.log, callId: 's1' });
    await act.handler({ script: '再插一句。' }, { role: 'main', log: host.log, callId: 's2' });
    host.logs = [];
    // 停机把最后一窗交出去(定时器窗口是 10 分钟,测试等不起)
    await mod.stop();
    const summary = host.logs.filter((l) => l.msg.includes('最近'));
    expect(summary).toHaveLength(1);
    expect(summary[0].level).toBe('warn');
    expect(summary[0].msg).toContain('拒收 2');
    // 摘要与单条 warn 同源:也进演出日志事件环(控制台日志面板读的就是它)
    expect(mod.logConsole().entries().some((e) => e.area === '摘要')).toBe(true);
  });

  it('滚动摘要:计数全零那一窗不发(平安无事不占控制台一行)', async () => {
    // 共享夹具的 VTS 指着 ws://127.0.0.1:1(必然拒连),拒连后「排定重连」告警异步
    // 落进 tally——那不是全零,摘要照发是对的。要测「平安无事」得先让 VTS 真连上。
    const vts = new FakeVts();
    await vts.start();
    const mod2 = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: `ws://127.0.0.1:${vts.port}`,
      ttsUrl: 'http://127.0.0.1:1',
      ttsServerDir: serverDir,
      audioDevice: () => 'none',
    });
    const host2 = new FakeHost();
    await mod2.start(host2);
    try {
      host2.logs = [];
      await mod2.stop();
      expect(host2.logs.some((l) => l.msg.includes('最近'))).toBe(false);
      expect(mod2.logConsole().entries().some((e) => e.area === '摘要')).toBe(false);
    } finally {
      await mod2.stop().catch(() => {});
      await vts.close();
    }
  });

  it('同一 LLM 轮内的多次 vtuber_act 追加,不被闸拦', async () => {
    const tap = legacyTap(mod.outputTap());
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    const long = JSON.stringify({ script: '同一轮的第一段台词'.repeat(15) + '。' });
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 't1', name: 'vtuber_act' });
    for (const ch of long) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 0 });
    // 同轮第二个调用:积压已超限,但同轮分段豁免
    const second = JSON.stringify({ script: '同一轮的第二段。' });
    tap.onDelta({ type: 'tool_call.begin', index: 1, id: 't2', name: 'vtuber_act' });
    for (const ch of second) tap.onDelta({ type: 'tool_call.delta', index: 1, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 1 });
    const r2 = await act.handler({ script: '同一轮的第二段。' }, { role: 'main', log: host.log, callId: 't2' });
    expect(r2).not.toContain('未排入');
    // 轮结束后的新调用才重新过闸:此刻积压仍超限 → 拒收
    tap.onRoundEnd?.();
    const r3 = await act.handler({ script: '下一轮的话。' }, { role: 'main', log: host.log, callId: 't3' });
    expect(r3).toContain('[未排入]');
  });

  /** 开过的演出轮数(引擎的权威埋点,不是回执文案) */
  const roundsOpened = (): number =>
    mod.logConsole().entries().filter((e) => e.area === '轮' && e.msg.includes('开新轮')).length;

  // 同一回复可重复生成新的 tool_call id；同轮分段豁免也须限制开轮数量。
  it('同轮豁免有界:一条回复里复读 vtuber_act,开轮数不超过上限', async () => {
    const tap = legacyTap(mod.outputTap());
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    const script = '第六圈交差。谁说话我回。';
    const receipts: string[] = [];
    const before = roundsOpened();
    // 同一轮里连开 40 次(复读风暴的缩比):没有上限的话就是 40 个新轮
    for (let i = 0; i < 40; i++) {
      const args = JSON.stringify({ script });
      tap.onDelta({ type: 'tool_call.begin', index: i, id: `r${i}`, name: 'vtuber_act' });
      for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: i, argsFragment: ch });
      tap.onDelta({ type: 'tool_call.end', index: i });
      const out = await act.handler({ script }, { role: 'main', log: host.log, callId: `r${i}` });
      receipts.push(typeof out === 'string' ? out : (out?.text ?? ''));
    }
    const rejected = receipts.filter((r) => r.includes('[未排入]'));
    // 前 8 次照常演出(豁免仍在),其余全被拦下——不是 40 个轮都开出去
    expect(receipts.length - rejected.length).toBe(8);
    expect(rejected.length).toBe(32);
    // 引擎侧对账:被拒的调用一拍都没入队,不只是回执上说没播
    expect(roundsOpened() - before).toBe(8);
    // 拒收回执要讲清是"这一轮开够了",而不是含糊的积压话术
    expect(rejected.at(-1)).toContain('vtuber_act');
    expect(rejected.at(-1)).toContain('先结束这轮回复');
    // 每次都是新 tool_call id,却没有一段被重演:去重键盖得住一整轮
    expect(receipts.filter((r) => r.includes('已开演(流式)')).length).toBe(8);
  });

  it('同轮封顶数可调:maxActRoundsPerTurn 覆盖默认值', async () => {
    const ttsPort = (tts.address() as { port: number }).port;
    const mod2 = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl: `http://127.0.0.1:${ttsPort}`,
      ttsServerDir: serverDir,
      speechCapSec: () => 3,
      audioDevice: () => 'none',
      maxActRoundsPerTurn: () => 3,
    });
    const host2 = new FakeHost();
    await mod2.start(host2);
    try {
      const tap = legacyTap(mod2.outputTap());
      const act = mod2.tools().find((t) => t.name === 'vtuber_act');
      if (!act) throw new Error('no act tool');
      const script = '第六圈交差。谁说话我回。';
      const receipts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const args = JSON.stringify({ script });
        tap.onDelta({ type: 'tool_call.begin', index: i, id: `q${i}`, name: 'vtuber_act' });
        for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: i, argsFragment: ch });
        tap.onDelta({ type: 'tool_call.end', index: i });
        const out = await act.handler({ script }, { role: 'main', log: host2.log, callId: `q${i}` });
        receipts.push(typeof out === 'string' ? out : (out?.text ?? ''));
      }
      const rejected = receipts.filter((r) => r.includes('[未排入]'));
      expect(receipts.length - rejected.length).toBe(3);
      expect(rejected.length).toBe(7);
      // 回执报的是生效值,不是默认值
      expect(rejected.at(-1)).toContain('3 次 vtuber_act');
    } finally {
      await mod2.stop();
    }
  });

  // 积压闸在流式 tap 开轮时判断，不能只拒绝 handler 回执却已将内容排入演出。
  it('开轮路径本身过闸:轮首调用被积压闸拒收时,tap 不开轮', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    // 先垫一段远超 3s 上限的积压
    const long = '这是一段非常长的台词'.repeat(20) + '。';
    await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'p0' });
    const before = roundsOpened();

    // 新一轮回复的轮首调用:走流式 tap,积压超限 → 一拍都不该入队
    const tap = legacyTap(mod.outputTap());
    const args = JSON.stringify({ script: '插一句。' });
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'p1', name: 'vtuber_act' });
    for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 0 });
    expect(roundsOpened()).toBe(before);

    // handler 取回同一条裁决(不再二次裁决、更不补演一遍)
    const r = await act.handler({ script: '插一句。' }, { role: 'main', log: host.log, callId: 'p1' });
    expect(r).toContain('[未排入]');
    expect(roundsOpened()).toBe(before);
  });

  /*
   * tap 见到 act 时，排在前面的 interrupt handler 可能尚未执行；工具串行保证 interrupt 先完成，同轮后续 act 不能按打断前的积压拒收。
   */
  it('同轮先 interrupt 后 act:不再被 tap 时刻的陈旧积压水位拒收', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    const stop = mod.tools().find((t) => t.name === 'vtuber_interrupt');
    if (!act || !stop) throw new Error('no tools');
    // 垫一段远超 3s 上限的积压
    const long = '这是一段非常长的台词'.repeat(20) + '。';
    await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'i0' });
    const before = roundsOpened();

    // 同一条回复:interrupt 在前,act 在后
    const tap = legacyTap(mod.outputTap());
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'i1', name: 'vtuber_interrupt' });
    tap.onDelta({ type: 'tool_call.end', index: 0 });
    const args = JSON.stringify({ script: '谢谢你的礼物!' });
    tap.onDelta({ type: 'tool_call.begin', index: 1, id: 'i2', name: 'vtuber_act' });
    for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: 1, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 1 });
    // tap 时刻就放行开轮,不再撞陈旧水位
    expect(roundsOpened()).toBe(before + 1);
    expect(host.logs.some((l) => l.msg.includes('积压读数') && l.msg.includes('陈旧'))).toBe(true);

    // handler 串行落地:先 interrupt 清积压,再 act 取回裁决——不是 [未排入]
    await stop.handler({}, { role: 'main', log: host.log, callId: 'i1' });
    const r = await act.handler({ script: '谢谢你的礼物!' }, { role: 'main', log: host.log, callId: 'i2' });
    expect(r).not.toContain('未排入');

    // 标志随轮清零:下一轮不带 interrupt 的轮首照旧过闸
    tap.onRoundEnd?.();
    await waitFor(() => (mod.statusLine() ?? '').includes('安静'));
    const r3 = await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'i3' });
    expect(r3).toContain('已排入演出');
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'i4', name: 'vtuber_act' });
    const args2 = JSON.stringify({ script: '这句该被拦。' });
    for (const ch of args2) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 0 });
    const r2 = await act.handler({ script: '这句该被拦。' }, { role: 'main', log: host.log, callId: 'i4' });
    expect(r2).toContain('[未排入]');
  });

  it('无新脚本输入时引擎不自开新轮:队列只减不增', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    await act.handler({ script: '就这一句,说完就安静。' }, { role: 'main', log: host.log, callId: 'q1' });
    const opened = roundsOpened();
    // 停止一切输入后,队列必须单调收敛到安静,不能自我续期
    await waitFor(() => mod.statusLine()?.includes('安静') ?? false);
    const settled = mod.statusLine();
    await new Promise((r) => setTimeout(r, 300));
    expect(mod.statusLine()).toBe(settled);
    expect(mod.statusLine()).toContain('安静');
    // 引擎没有任何自开新轮的路径:没有新脚本进来,开轮计数就不动
    expect(roundsOpened()).toBe(opened);
  });

  it('vtuber_interrupt 在收束和结果投递后返回，新台词仍可继续排入', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    const stop = mod.tools().find((t) => t.name === 'vtuber_interrupt');
    if (!act || !stop) throw new Error('missing tools');
    const long = '打断测试的长台词'.repeat(20) + '。';
    await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'i1' });
    const out = String(await stop.handler({}, { role: 'main', log: host.log }));
    expect(out).toContain('收住');
    /*
     * 打断回执报告实际丢弃的台词时长。
     */
    expect(out).toMatch(/丢掉了.*\d+ 秒/);
    expect(out).not.toContain('积压');
    expect(host.outcomes).toHaveLength(1);
    expect(host.outcomes[0].callId).toBe('i1');
    expect(host.outcomes[0].script).toBe('');
    expect(host.outcomes[0].reason).toBe('interrupted');
    expect(host.events.find(row => row.e.type === 'vtuber.act.outcome')?.opts?.trigger).toBe('flush');
    // 打断后嘴是空的,新话照常
    const r = await act.handler({ script: '新话。' }, { role: 'main', log: host.log, callId: 'i2' });
    expect(r).toContain('已排入演出');
  });

  // 新话可经流式 tap 先于 interrupt handler 入队；打断只覆盖调用时刻已有内容，保留同轮后续调用的新话。
  it('vtuber_interrupt 只剪调用时刻已有的内容:同一轮里排在它后面的新话照常播出', async () => {
    const stop = mod.tools().find((t) => t.name === 'vtuber_interrupt');
    if (!stop) throw new Error('no interrupt tool');
    const tap = legacyTap(mod.outputTap());
    const feed = (index: number, id: string, script: string): void => {
      tap.onDelta({ type: 'tool_call.begin', index, id, name: 'vtuber_act' });
      for (const ch of JSON.stringify({ script })) {
        tap.onDelta({ type: 'tool_call.delta', index, argsFragment: ch });
      }
      tap.onDelta({ type: 'tool_call.end', index });
    };
    // 一条回复里的三个调用,按流上的真实次序:旧话 → 打断 → 新话
    feed(0, 'f0', '旧话说到一半。');
    tap.onDelta({ type: 'tool_call.begin', index: 1, id: 'fi', name: 'vtuber_interrupt' });
    tap.onDelta({ type: 'tool_call.end', index: 1 });
    feed(2, 'f1', '【点头】这句必须完整播出。');

    // handler 依闭合序串行执行,此刻新话早已经 tap 开了演
    const out = await stop.handler({}, { role: 'main', log: host.log, callId: 'fi' });
    expect(out).toContain('收住');
    // 新话整句进声卡时间线;栅栏没生效时这一轮会被一并作废,字幕永不出现
    await waitFor(() => stage.events.some((m) => m.type === 'subtitle' && m.text === '这句必须完整播出。'));
    // 结果事件只关联被栅栏截断的旧调用。
    expect(host.outcomes.every((r) => r.callId !== 'f1')).toBe(true);
  });

  it('清理执行参数后在回执说明，不把受理伪报为实际播放结果', async () => {
    const act = mod.tools().find(t => t.name === 'vtuber_act')!;
    const script = '【惊吓后仰,喘气特效】哇!<sigh>吓死我了[Surprise-wa][喘不过气]';
    const result = await act.handler({ script }, { role: 'main', log: host.log, callId: 'u1' });
    expect(result).toContain('忽略词表外标记');
    expect(result).toContain('原始调用保留');
    await waitFor(() => ttsBodies.some(body => String(body.input).includes('吓死我了')));
    expect(ttsBodies.every(body => !String(body.input).includes('喘气特效'))).toBe(true);
    expect(host.outcomes).toHaveLength(0);
  });

  /**
   * 字幕收束同时记录日志，SSE 事件保持原契约。
   */
  it('字幕收束落一条埋点,SSE 事件本身一字不改', async () => {
    const internals = mod as unknown as { emitSubtitleCut(reason: string, script?: string): void };
    host.logs.length = 0;
    internals.emitSubtitleCut('演出被打断', '实际听到的半句。');

    await waitFor(() => stage.events.some((e) => e.type === 'subtitle.cut'));
    const cut = stage.events.filter((e) => e.type === 'subtitle.cut').pop();
    expect(cut).toMatchObject({ type: 'subtitle.cut', script: '实际听到的半句。' });

    const line = host.logs.find((l) => l.area === 'io.vtuber.subtitle' && l.msg.includes('收束'));
    expect(line).toBeDefined();
    expect(line?.msg).toContain('演出被打断');
    expect(line).toMatchObject({ event: 'cut', data: { reason: '演出被打断', heardChars: 8 } });
  });

  /*
   * 演出埋点投影到运行日志的规则:通道名 → io.vtuber.<ascii 区域>;级别显式给的优先,
   * 否则状态机通道 trace、其余 debug;durMs 与结构化字段各归各的槽,消息不再带前缀。
   */
  describe('演出埋点投影到运行日志', () => {
    type Internals = { tracePerf(lane: string, msg: string, opts?: Record<string, unknown>): void };

    it('状态机通道落 trace,区域是 io.vtuber.state,消息不带 [演出·] 前缀', () => {
      host.logs = [];
      (mod as unknown as Internals).tracePerf('状态', 'emotion → 中性 (fade 200ms)');
      expect(host.logs).toEqual([
        { area: 'io.vtuber.state', level: 'trace', msg: 'emotion → 中性 (fade 200ms)', event: undefined, durMs: undefined, data: undefined },
      ]);
    });

    it('TTS 收流一行落 debug,耗时进 durMs,数字与台词片段进 data', () => {
      host.logs = [];
      (mod as unknown as Internals).tracePerf('TTS', '流式收流 812ms → 2400ms 音频', {
        durMs: 812,
        detail: '「大家好」',
        event: 'stream-received',
        data: { recvMs: 812, audioMs: 2400 },
      });
      expect(host.logs).toEqual([{
        area: 'io.vtuber.tts',
        level: 'debug',
        msg: '流式收流 812ms → 2400ms 音频',
        event: 'stream-received',
        durMs: 812,
        data: { recvMs: 812, audioMs: 2400, detail: '「大家好」' },
      }]);
    });

    it('显式 warn 保持 warn;表外的通道名原样作区域后缀', () => {
      host.logs = [];
      const inner = mod as unknown as Internals;
      inner.tracePerf('闸门', '拒收:积压 9s 超上限', { level: 'warn', tally: '拒收' });
      inner.tracePerf('新通道', '一句话');
      expect(host.logs).toMatchObject([
        { area: 'io.vtuber.gate', level: 'warn', msg: '拒收:积压 9s 超上限' },
        { area: 'io.vtuber.新通道', level: 'debug' },
      ]);
    });

    it('真实合成一片:TTS 通道的合成行带结构化的合成耗时与音频时长', async () => {
      const act = mod.tools().find((t) => t.name === 'vtuber_act');
      if (!act) throw new Error('no act tool');
      host.logs = [];
      await act.handler({ script: '一句话。' }, { role: 'main', log: host.log, callId: 'proj-1' });
      await waitFor(() => host.logs.some((l) => l.event === 'synth'));
      const synth = host.logs.find((l) => l.event === 'synth')!;
      expect(synth).toMatchObject({ area: 'io.vtuber.tts', level: 'debug' });
      expect(typeof synth.durMs).toBe('number');
      const data = synth.data as { synthMs: number; audioMs: number; units: number };
      expect(data.synthMs).toBe(synth.durMs);
      expect(data.audioMs).toBe(100);
      expect(data.units).toBeGreaterThan(0);
      // 开新轮/脚本收完是逐条读得下去的状态迁移:info
      expect(host.logs.find((l) => l.event === 'round-open')).toMatchObject({ area: 'io.vtuber.round', level: 'info' });
      expect(host.logs.find((l) => l.event === 'script-done')).toMatchObject({
        area: 'io.vtuber.round', level: 'info', data: { beats: 1, pieces: 1 },
      });
    });
  });

  it('标记全命中时没有清理说明或中断结果', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    await act.handler(
      { script: '【微笑,看向镜头】都在词表里[laughing]' },
      { role: 'main', log: host.log, callId: 'u2' },
    );
    expect(host.outcomes.some((r) => r.callId === 'u2')).toBe(false);
  });

  it('永不自动顶掉正在说的话:积压没超上限就排队,超了才拒收', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    const long = '很长的一段台词'.repeat(20) + '。';
    await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'p1' });
    const r2 = await act.handler({ script: '看我这步!' }, { role: 'main', log: host.log, callId: 'p2' });
    expect(r2).not.toContain('顶掉');
    // 自动排队不得触发任何段落修订。
    expect(host.outcomes.some((r) => r.callId === 'p1')).toBe(false);
  });

  it('ttsConsole:test 走真合成并送舞台;state 探测可达性', async () => {
    // 「声线档案」的插件已经补上,所以声明里也有它(声明与插件同进同退)
    expect(panelIds(mod)).toContain('tts');
    const c = mod.ttsConsole();
    const out = await c.test();
    expect(out.message).toContain('合成 OK');
    expect(out.message).toContain('声卡');
    // wav 带回面板就地播放;声卡侧经 DeviceAudioSink 同步播出
    expect(out.wav).toBeTruthy();
    // 假 TTS server 对 /health 也回 200 → reachable
    const st = await c.state();
    expect(st.reachable).toBe(true);
    expect(st.phase).toBe('stopped');
  });

  it('声线档案:voices 列举带转写;setProfile 钳制并持久化;合成请求携带参考音频与参数', async () => {
    const c = mod.ttsConsole();
    const st = await c.state();
    expect(st.voices).toEqual([{ file: 'mei.wav', text: '参考音频的转写文本' }]);
    expect(st.profile.refAudio).toBeNull();

    const saved = c.setProfile({
      refAudio: 'mei.wav',
      refText: '参考音频的转写文本',
      cfgValue: 99, // 越界 → 钳到 10
      temperature: 0.5,
      seed: 7,
    });
    expect(saved.cfgValue).toBe(10);
    expect(savedProfiles).toHaveLength(1);
    expect(savedProfiles[0].refAudio).toBe('mei.wav');
    // 路径穿越必须被拒绝。
    expect(c.setProfile({ refAudio: '../evil.wav' }).refAudio).toBeNull();
    c.setProfile({ refAudio: 'mei.wav' });

    const custom = await c.test('自定义的一句');
    expect(custom.message).toContain('合成 OK');
    const body = ttsBodies[ttsBodies.length - 1];
    expect(String(body.input)).toContain('自定义的一句');
    expect(typeof body.reference_audio).toBe('string');
    expect(String(body.reference_audio).length).toBeGreaterThan(0);
    expect(body.prompt_text).toBe('参考音频的转写文本');
    expect(body).toMatchObject({ seed: 7, cfg_value: 10, temperature: 0.5 });
  });

  it('外置声线目录与 Live2D 部署记录热更新,同名声线随目录重读', async () => {
    const voicesA = mkdtempSync(join(tmpdir(), 'vtuber-voices-a-'));
    const voicesB = mkdtempSync(join(tmpdir(), 'vtuber-voices-b-'));
    const wavA = Buffer.from(makeWav(new Array(160).fill(0.1)));
    const wavB = Buffer.from(makeWav(new Array(160).fill(0.8)));
    writeFileSync(join(voicesA, 'same.wav'), wavA);
    writeFileSync(join(voicesB, 'same.wav'), wavB);
    let voicesDir = voicesA;
    let live2dDir = 'D:\\VTubeStudio\\Models\\Corti';
    const mod2 = new VtuberModule({
      streamPort: 0,
      ttsUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}`,
      ttsServerDir: serverDir,
      ttsVoicesDir: () => voicesDir,
      live2dDir: () => live2dDir,
      audioDevice: () => 'none',
    });
    try {
      const console = mod2.ttsConsole();
      expect((await console.state()).voicesDir).toBe(voicesA);
      expect(mod2.modelConsole().state().live2dDir).toBe(live2dDir);
      console.setProfile({ refAudio: 'same.wav' });
      await console.test('目录 A');
      expect(ttsBodies[ttsBodies.length - 1].reference_audio).toBe(wavA.toString('base64'));

      voicesDir = voicesB;
      live2dDir = 'E:\\VTubeStudio\\Models\\Corti';
      expect((await console.state()).voicesDir).toBe(voicesB);
      expect(mod2.modelConsole().state().live2dDir).toBe(live2dDir);
      await console.test('目录 B');
      expect(ttsBodies[ttsBodies.length - 1].reference_audio).toBe(wavB.toString('base64'));
    } finally {
      rmSync(voicesA, { recursive: true, force: true });
      rmSync(voicesB, { recursive: true, force: true });
    }
  });

  it('试听按传进来的档案合成,不改生效档案:面板上换了声线还没保存也能听到新的', async () => {
    const c = mod.ttsConsole();
    writeFileSync(join(serverDir, 'voices', '新人.wav'), Buffer.from(makeWav(new Array(240).fill(0.3))));
    c.setProfile({ refAudio: 'mei.wav', refText: '参考音频的转写文本', seed: 7 });
    const inUse = Buffer.from(readFileSync(join(serverDir, 'voices', 'mei.wav'))).toString('base64');
    const auditioned = Buffer.from(readFileSync(join(serverDir, 'voices', '新人.wav'))).toString('base64');

    const out = await c.test('试听一句', { refAudio: '新人.wav', refText: '新人的转写', seed: 99 });
    expect(out.message).toContain('声线 新人.wav');
    const body = ttsBodies[ttsBodies.length - 1];
    expect(body.reference_audio).toBe(auditioned);
    expect(body.reference_audio).not.toBe(inUse);
    expect(body).toMatchObject({ prompt_text: '新人的转写', seed: 99 });

    // 生效档案没被试听改动:演出仍走已保存的那条
    expect((await c.state()).profile).toMatchObject({ refAudio: 'mei.wav', seed: 7 });
    await c.test('再来一句');
    expect(ttsBodies[ttsBodies.length - 1].reference_audio).toBe(inUse);
  });

  it('vtsConsole:连接→模型信息与表情复位;测试动作走注入链路;断开归零', async () => {
    const vts = new FakeVts();
    await vts.start();
    const mod2 = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: `ws://127.0.0.1:${vts.port}`,
      ttsUrl: 'http://127.0.0.1:1',
      ttsServerDir: serverDir,
      audioDevice: () => 'none',
    });
    const host2 = new FakeHost();
    await mod2.start(host2);
    try {
      // 局部 id(不带 vtuber- 前缀):控制台按 provider + 局部 id 路由
      expect(panelIds(mod2))
        .toEqual(['mount', 'model', 'overlay', 'clips', 'tts', 'align', 'log', 'diag']);
      const c = mod2.vtsConsole();
      const st = await c.state();
      expect(st.connected).toBe(true);
      expect(st.model).toEqual({ name: 'FixtureModel', id: 'm1' });
      expect(st.tokenSet).toBe(true);

      const msg = c.test();
      expect(msg).toContain('测试动作');
      // 点头 pulse 经 60Hz 混音台流到 VTS 注入
      await waitFor(() => vts.received.includes('InjectParameterDataRequest'));

      const off = await c.disconnect();
      expect(off.connected).toBe(false);
      expect((await c.state()).connected).toBe(false);
      expect(c.test()).toContain('未连接');

      const on = await c.connect();
      expect(on.connected).toBe(true);
      // 手动连接顺带复位残留表情(fake 里挂着一个 Idea)
      expect(on.cleared).toContain('Idea.exp3.json');
    } finally {
      await mod2.stop();
      await vts.close();
    }
  });

  /*
   * VTS 晚于 bot 启动时，自动连上的首次认证也须执行模型定档。
   */
  it('VTS 后起:自己连上的那一次补跑定档,档案从默认档切回按模型名匹配', async () => {
    // 先占一个端口拿号再让开:模组开播的那一刻 VTS 还没起来
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const live2d = mkdtempSync(join(tmpdir(), 'vtuber-live2d-'));
    writeProfileDir(live2d, 'FixtureModel', fixtureProfileJson());
    const mod2 = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: `ws://127.0.0.1:${port}`,
      ttsUrl: 'http://127.0.0.1:1',
      ttsServerDir: serverDir,
      audioDevice: () => 'none',
      live2dDir: () => live2d,
    });
    const host2 = new FakeHost();
    const vts = new FakeVts();
    await mod2.start(host2);
    try {
      // 开局连不上:模型名空,只能吊在默认档
      expect(mod2.modelConsole().state().vtsModelName).toBe('');
      expect(mod2.modelConsole().state().how).toBe('fallback');

      await vts.start(port);
      // 实况里踢这一脚的是混音台的帧(backend.sendFrame 发现没连上)
      (mod2 as unknown as { vts: { ensureConnected(): void } }).vts.ensureConnected();

      await waitFor(() => mod2.modelConsole().state().how === 'matched');
      const st = mod2.modelConsole().state();
      expect(st.vtsModelName).toBe('FixtureModel');
      expect(st.profileFile).toBe(join(live2d, 'FixtureModel', 'cortico.profile.json'));
      // 定档日志标明按模型名匹配的结果。
      expect(host2.logs.some((l) => l.msg.includes('模型「FixtureModel」→ 档案') && l.msg.includes('按模型名匹配')))
        .toBe(true);
      // 定档与名单各只查一遍:backend 那份订阅走的是同一次同步,不再自己拉名单
      expect(vts.received.filter((t) => t === 'CurrentModelRequest')).toHaveLength(1);
      expect(vts.received.filter((t) => t === 'InputParameterListRequest')).toHaveLength(1);
    } finally {
      await mod2.stop();
      await vts.close();
      rmSync(live2d, { recursive: true, force: true });
    }
  });

  it('VTS 里换了模型:ModelLoadedEvent 触发重新定档,匹配档退到默认档', async () => {
    const live2d = mkdtempSync(join(tmpdir(), 'vtuber-live2d-'));
    writeProfileDir(live2d, 'FixtureModel', fixtureProfileJson());
    const vts = new FakeVts();
    await vts.start();
    const mod2 = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: `ws://127.0.0.1:${vts.port}`,
      ttsUrl: 'http://127.0.0.1:1',
      ttsServerDir: serverDir,
      audioDevice: () => 'none',
      live2dDir: () => live2d,
    });
    const host2 = new FakeHost();
    await mod2.start(host2);
    try {
      expect(mod2.modelConsole().state().how).toBe('matched');
      expect(vts.received).toContain('EventSubscriptionRequest');

      vts.modelName = 'Other';
      vts.pushModelLoaded('Other');
      await waitFor(() => mod2.modelConsole().state().how === 'fallback');
      expect(mod2.modelConsole().state().vtsModelName).toBe('Other');
      expect(host2.logs.some((l) => l.msg.includes('VTS 换了模型'))).toBe(true);
      expect(vts.received.filter((t) => t === 'CurrentModelRequest')).toHaveLength(2);
    } finally {
      await mod2.stop();
      await vts.close();
      rmSync(live2d, { recursive: true, force: true });
    }
  });

  it('演出测试:预置台本可演,回执带断链警告;演出日志记录关键事件并支持增量拉取', async () => {
    const perform = mod.performConsole();
    const presets = perform.presets();
    expect(presets.length).toBeGreaterThanOrEqual(5);
    expect(presets[0].script).toContain('【叹气,叹气特效】');

    const receipt = perform.perform(presets[0].script);
    expect(receipt).toContain('已排入演出');
    // 本测试环境 VTS 是死端口 → 回执必须点名
    expect(receipt).toContain('VTS 未连');
    await waitFor(() => stage.events.some((m) => m.type === 'subtitle'));

    const log = mod.logConsole();
    const all = log.entries();
    expect(all.length).toBeGreaterThan(0);
    const areas = new Set(all.map((e) => e.area));
    for (const a of ['测试', '轮', '拍', 'TTS', '音频']) expect(areas).toContain(a);
    // 增量拉取:after=最后一条 → 空
    const last = all[all.length - 1].seq;
    expect(log.entries(last)).toEqual([]);
    expect(log.entries(all[0].seq).length).toBe(all.length - 1);
  });

  it('clipsConsole:分组列表带中文词;试跳/试挂回执带 VTS 断链警告;重载与复位可用', async () => {
    expect(panelIds(mod)).toContain('clips');
    const c = mod.clipsConsole();
    const st = c.state();
    expect(st.vtsConnected).toBe(false);
    expect(st.file).toBe(EXAMPLE_PACK_DIR);
    expect(st.groups.map((g) => g.label)).toEqual(['动作', '姿态', '表情', '看向', '特效']);
    const pulses = st.groups[0].items;
    expect(pulses.find((i) => i.clipId === 'nod')?.word).toBe('点头');
    expect(pulses.find((i) => i.clipId === 'nod')?.durationMs).toBe(1400);
    expect(mod.envPromptVars()['vtuber.vocab']).toContain('| 动作 |');

    expect(c.trigger('pulse', 'nod', 0.8)).toMatch(/已触发「点头」.*VTS 未连/);
    expect(c.trigger('emotion', 'smile')).toContain('回中性');
    expect(c.trigger('pulse', '不存在的')).toContain('[失败]');
    expect(c.trigger('体操', 'nod')).toContain('[失败]');
    expect(c.reset()).toContain('回中性');

    // 包的校验语义由 pack.test 覆盖;这里只确认控制台接线不抛
    const reload = await c.reload();
    expect(reload.ok).toBe(true);
    expect(reload.warnings).toEqual([]);
  });

  it('packDir:演出包来自指定目录;盘上加了词与曲线后 reload 即生效,坏文件则旧包保持', async () => {
    const packDir = join(serverDir, 'pack');
    mkdirSync(packDir);
    const vocabFile = join(packDir, 'vocab.json');
    const clipsFile = join(packDir, 'clips.json');
    writeFileSync(vocabFile, readFileSync(join(EXAMPLE_PACK_DIR, 'vocab.json')));
    writeFileSync(clipsFile, readFileSync(join(EXAMPLE_PACK_DIR, 'clips.json')));
    writeFileSync(join(packDir, 'params.json'), readFileSync(join(EXAMPLE_PACK_DIR, 'params.json')));
    const mod2 = new VtuberModule({
      streamPort: 0,
      ttsUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}`,
      ttsServerDir: serverDir,
      audioDevice: () => 'none',
      packDir,
    });
    const c = mod2.clipsConsole();
    expect(c.state().file).toBe(packDir);
    expect(c.state().groups[0].items.map((i) => i.clipId)).not.toContain('bow');

    const vocab = JSON.parse(readFileSync(vocabFile, 'utf8')) as { entries: unknown[] };
    vocab.entries.push({ word: '鞠躬', channel: 'gesture', clipId: 'bow', lifecycle: 'pulse' });
    writeFileSync(vocabFile, JSON.stringify(vocab));
    const clips = JSON.parse(readFileSync(clipsFile, 'utf8')) as { pulse: Record<string, unknown> };
    clips.pulse.bow = { id: 'bow', durationMs: 900, speechOnsetMs: 100, tracks: { FaceAngleY: [[0, 0], [300, -20], [900, 0]] } };
    writeFileSync(clipsFile, JSON.stringify(clips));

    const reload = await c.reload();
    expect(reload).toEqual({ ok: true, message: expect.stringContaining('动作 21'), warnings: [] });
    expect(c.state().groups[0].items).toContainEqual({ clipId: 'bow', word: '鞠躬', kind: 'pulse', durationMs: 900 });
    expect(mod2.envPromptVars()['vtuber.vocab']).toContain('`鞠躬`');
    expect(c.trigger('pulse', 'bow')).toContain('鞠躬');

    writeFileSync(vocabFile, '{ oops');
    const broken = await c.reload();
    expect(broken.ok).toBe(false);
    expect(broken.message).toContain(vocabFile);
    expect(c.state().groups[0].items.some((i) => i.clipId === 'bow')).toBe(true);
  });

  it('saveVoice:本地 wav 落盘缓存(名字消毒),voiceWav 可回读,坏数据拒绝', async () => {
    const c = mod.ttsConsole();
    const wavB64 = Buffer.from(makeWav(new Array(320).fill(0.1))).toString('base64');
    const saved = await c.saveVoice('新声线 v2.wav', wavB64);
    expect(saved.file).toBe('新声线_v2.wav');
    expect(saved.path).toContain(serverDir);
    expect(saved.converted).toBeNull(); // 源就是 wav,没走转码
    const st = await c.state();
    expect(st.voicesDir).toContain(serverDir);
    // 新导入的声线还没有转写:侧车归 setProfile 写,导入不替人猜
    expect(st.voices).toContainEqual({ file: '新声线_v2.wav', text: '' });
    expect(c.voiceWav('新声线_v2.wav')).toBe(wavB64);
    expect(c.voiceWav('../mei.wav')).toBeNull();
    expect(c.voiceWav('不存在.wav')).toBeNull();
    await expect(c.saveVoice('bad.wav', Buffer.from('不是wav数据啊啊啊').toString('base64'))).rejects.toThrow();
  });

  it('setProfile 写转写侧车:存档案后再选中这条声线能带回转写,清空则删掉侧车', async () => {
    const c = mod.ttsConsole();
    await c.saveVoice('新人.wav', Buffer.from(makeWav(new Array(320).fill(0.1))).toString('base64'));

    c.setProfile({ refAudio: '新人.wav', refText: '  这是转写  ' });
    expect((await c.state()).voices).toContainEqual({ file: '新人.wav', text: '这是转写' });

    c.setProfile({ refText: '' });
    expect((await c.state()).voices).toContainEqual({ file: '新人.wav', text: '' });
  });

  it.skipIf(!ffmpegExe)('saveVoice:mp3 先转码再入库,落盘的是 24kHz wav', async () => {
    const c = mod.ttsConsole();
    const tone = Array.from({ length: 8000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 16_000) * 0.5);
    const mp3 = await encodeAudio(ffmpegExe!, makeWav(tone, 16_000), 'mp3', ['-b:a', '128k']);

    const saved = await c.saveVoice('外来声线.mp3', Buffer.from(mp3).toString('base64'));
    expect(saved.file).toBe('外来声线.wav');
    expect(saved.converted).toBe('MP3');
    const onDisk = decodeWav(new Uint8Array(readFileSync(saved.path)));
    expect(onDisk.sampleRate).toBe(24_000);
    expect(onDisk.durationMs).toBeGreaterThan(400);
    expect((await c.state()).voices).toContainEqual({ file: '外来声线.wav', text: '' });
  });


  describe('VTS 僵死的报障', () => {
    interface Inner {
      noteVtsInjectError(e: Error): void;
      noteVtsInjectOk(): void;
    }
    const timeout = (): Error => new Error('VTS 请求超时: InjectParameterDataRequest');
    const vtsNotes = (h: FakeHost): string[] => h.notes.filter((t) => t.includes('VTS'));

    it('到阈值才报,同一次故障只报一次', () => {
      const inner = mod as unknown as Inner;
      for (let i = 0; i < VTS_STALL_STREAK - 1; i++) inner.noteVtsInjectError(timeout());
      expect(vtsNotes(host)).toHaveLength(0);

      inner.noteVtsInjectError(timeout());
      expect(vtsNotes(host)).toHaveLength(1);
      expect(vtsNotes(host)[0]).toContain(`连续 ${VTS_STALL_STREAK} 次没有响应`);
      expect(vtsNotes(host)[0]).toContain('皮套画面可能已冻结');
      expect(host.logs.some((l) => l.level === 'error' && l.msg.includes('VTS 连续'))).toBe(true);

      // 故障持续:再超时二十次也不再刷屏
      for (let i = 0; i < 20; i++) inner.noteVtsInjectError(timeout());
      expect(vtsNotes(host)).toHaveLength(1);
    });

    it('恢复时投一条解除,再次故障可以再报', () => {
      const inner = mod as unknown as Inner;
      for (let i = 0; i < VTS_STALL_STREAK; i++) inner.noteVtsInjectError(timeout());
      inner.noteVtsInjectOk();
      expect(vtsNotes(host)).toHaveLength(2);
      expect(vtsNotes(host)[1]).toContain('恢复');

      // 没在故障中时的成功注入不产生任何话
      inner.noteVtsInjectOk();
      expect(vtsNotes(host)).toHaveLength(2);

      for (let i = 0; i < VTS_STALL_STREAK; i++) inner.noteVtsInjectError(timeout());
      expect(vtsNotes(host)).toHaveLength(3);
    });

    /*
     * 每条注入失败记录 warn 并计入滚动摘要；同文案窗口内折叠由运行日志 sink 处理。
     */
    it('逐条注入失败每条落 warn 并计入 tally;折叠交给运行日志 sink', async () => {
      const inner = mod as unknown as { noteVtsInjectWarn(e: Error): void };
      host.logs = [];
      for (let i = 0; i < 3; i++) inner.noteVtsInjectWarn(new Error('VTS 连接已关闭'));
      inner.noteVtsInjectWarn(new Error('VTS 请求超时: InjectParameterDataRequest'));
      const warns = host.logs.filter((l) => l.level === 'warn' && l.area === 'io.vtuber.inject');
      expect(warns.map((l) => l.msg)).toEqual([
        '注入失败:VTS 连接已关闭',
        '注入失败:VTS 连接已关闭',
        '注入失败:VTS 连接已关闭',
        '注入失败:VTS 请求超时: InjectParameterDataRequest',
      ]);
      // 三次 + 一次全部计进同一个桶,停机时的摘要能报出总数
      host.logs = [];
      await mod.stop();
      const summary = host.logs.find((l) => l.msg.includes('最近'));
      expect(summary?.msg).toContain('注入失败 4');
      expect(summary).toMatchObject({ area: 'io.vtuber.summary', event: 'summary', data: { tally: { 注入失败: 4 } } });
    });

    it('中途成功一次就重新计数;非超时的注入错误不计入', () => {
      const inner = mod as unknown as Inner;
      for (let i = 0; i < VTS_STALL_STREAK - 1; i++) inner.noteVtsInjectError(timeout());
      inner.noteVtsInjectOk();
      inner.noteVtsInjectError(timeout());
      expect(vtsNotes(host)).toHaveLength(0);

      // 参数被拒是接线问题,不是没响应:一百条也不该报成僵死
      for (let i = 0; i < 100; i++) inner.noteVtsInjectError(new Error('VTS APIError 453'));
      expect(vtsNotes(host)).toHaveLength(0);
    });

    /*
     * token 无效会停止自动重连，报障须说明需要在 VTS 重新授权。
     */
    it('token 被判无效报一条障,重新认证成功报一条解除,重复通知不刷屏', () => {
      const inner = mod as unknown as { noteVtsAuthRejected(rejected: boolean): void };
      inner.noteVtsAuthRejected(true);
      expect(vtsNotes(host)).toHaveLength(1);
      expect(vtsNotes(host)[0]).toContain('拒绝了已存的认证令牌');
      expect(vtsNotes(host)[0]).toContain('自动重连已停止');
      expect(vtsNotes(host)[0]).toContain('人工在 VTS 里重新授权');
      expect(host.logs.some((l) => l.level === 'error' && l.msg.includes('拒绝了已存的认证令牌'))).toBe(true);

      inner.noteVtsAuthRejected(true);
      expect(vtsNotes(host)).toHaveLength(1);

      inner.noteVtsAuthRejected(false);
      expect(vtsNotes(host)).toHaveLength(2);
      expect(vtsNotes(host)[1]).toContain('重新认证成功');

      // 没在这条故障里时的成功认证不产生任何话
      inner.noteVtsAuthRejected(false);
      expect(vtsNotes(host)).toHaveLength(2);
    });
  });
});

/**
 * 验证播报队列的三个数、静默提醒及实际音频时序。
 * 测试 TTS 返回 3 秒音频并放宽积压上限,以覆盖队列从满到空的转换。
 */
describe('VtuberModule 播报队列', () => {
  let host: FakeHost;
  let tts: Server;
  let serverDir: string;
  let mod: VtuberModule;

  beforeEach(async () => {
    host = new FakeHost();
    serverDir = mkdtempSync(join(tmpdir(), 'vtuber-queue-'));
    mkdirSync(join(serverDir, 'voices'));
    // 每次合成回 3 秒音频:队列有厚度,水位才会真的从满降到空
    tts = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.from(makeWav(new Array(48_000).fill(0.3))));
      });
    });
    await new Promise<void>((r) => tts.listen(0, '127.0.0.1', () => r()));
    mod = new VtuberModule({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}`,
      ttsServerDir: serverDir,
      audioDevice: () => 'none',
      speechCapSec: () => 60,
      silenceRemindSec: () => 1,
      silenceRemind2Sec: () => 2,
      silenceRemind3Sec: () => 4,
    });
    await mod.start(host);
  });

  afterEach(async () => {
    await mod.stop();
    await new Promise<void>((r) => tts.close(() => r()));
    rmSync(serverDir, { recursive: true, force: true });
  });

  it('回执报这段多长、前面排着多久、全部说完还要多久', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    const r1 = await act.handler({ script: '第一段台词。' }, { role: 'main', log: host.log, callId: 'e1' });
    // 队列空时只报这段自己的长度,不谈"前面还排着 0 秒"
    expect(r1).toMatch(/这段约 \d+ 秒。/);
    expect(r1).not.toContain('前面还排着');

    const r2 = await act.handler({ script: '第二段台词。' }, { role: 'main', log: host.log, callId: 'e2' });
    const m = /这段约 (\d+) 秒;前面还排着 (\d+) 秒,全部说完约 (\d+) 秒后。/.exec(r2 as string);
    if (!m) throw new Error(`回执没带三个数: ${r2}`);
    expect(Number(m[2])).toBeGreaterThan(0);
    expect(Number(m[3])).toBe(Number(m[1]) + Number(m[2]));
    await mod.tools().find((t) => t.name === 'vtuber_interrupt')!.handler({}, { role: 'main', log: host.log });
  });

  it('见底后静默提醒逐级加急:1s/2s/4s 三级,说话途中不提醒,三级后闭嘴', async () => {
    const act = mod.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('no act tool');
    await act.handler({ script: '一句话。' }, { role: 'main', log: host.log, callId: 'w1' });
    // 说话与排队期间没有任何水位提醒
    expect(host.notes.filter((n) => n.includes('[演出]'))).toHaveLength(0);
    // base=1s → 三级在总静默 1s/2s/4s 处各投一条,秒数随级别累计
    await waitFor(() => host.notes.some((n) => /安静.*1 秒/.test(n)), 15_000);
    await waitFor(() => host.notes.some((n) => /安静.*2 秒/.test(n)), 15_000);
    await waitFor(() => host.notes.some((n) => /安静.*4 秒/.test(n)), 15_000);
    // 第三级之后不再催
    await new Promise((r) => setTimeout(r, 1500));
    expect(host.notes.filter((n) => n.includes('[演出]'))).toHaveLength(3);
  });
});

describe('silenceReminder', () => {
  it('silenceReminder:配置措辞按 | 分变体、{sec} 代秒数、自动补 [演出] 前缀;留空落回内置池', () => {
    const custom = silenceReminder(1, 30, '安静{sec}秒了,快说话!');
    expect(custom).toBe('[演出] 安静30秒了,快说话!');
    const picked = silenceReminder(0, 15, 'A线|B线');
    expect(['[演出] A线', '[演出] B线']).toContain(picked);
    const builtin = silenceReminder(0, 15, '  ');
    expect(builtin).toContain('[演出]');
    expect(builtin).toContain('15 秒');
    // 级别越界按最高级说,不炸
    expect(silenceReminder(9, 99)).toContain('99');
  });

  /**
   * 静默期间发生流失败时，提醒须带上该原因。
   */
  it('silenceReminder:卡住过就把因由带上,没卡过不加话', () => {
    const withStalls = silenceReminder(2, 60, undefined, 3);
    expect(withStalls).toContain('60');
    expect(withStalls).toContain('卡住了 3 次');
    expect(silenceReminder(2, 60, undefined, 0)).not.toContain('卡住');
    expect(silenceReminder(2, 60)).not.toContain('卡住');
    // 配置措辞一样带因由
    const custom = silenceReminder(0, 15, '安静{sec}秒', 2);
    expect(custom).toContain('安静15秒');
    expect(custom).toContain('卡住了 2 次');
  });
});
