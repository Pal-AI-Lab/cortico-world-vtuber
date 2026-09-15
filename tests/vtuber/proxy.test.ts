import { legacyTap } from '../helpers/fixture-stream.ts';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, WorldHost, PushOptions } from 'cortico/core/types.ts';
import { PassThrough } from 'node:stream';
import { HANDOFF_NOTE } from '../../src/world.ts';
import { attachStdio, VtuberWorldProxy } from '../../src/proxy.ts';
import { makeWav, recordingLogger, type LogLine } from './helpers.ts';

class FakeHost implements WorldHost {
  events: Array<{ e: EventEnvelope; opts?: PushOptions }> = [];
  deferred: Array<{
    type: string;
    render: () => string | null | Promise<string | null>;
    trigger?: string;
  }> = [];
  pushDeferred(
    e: { type: string; senderKey?: string; meta?: Record<string, unknown>; render: () => string | null | Promise<string | null> },
    opts?: { trigger?: string },
  ): void {
    this.deferred.push({ type: e.type, render: e.render, trigger: opts?.trigger });
  }
  get outcomes(): Array<{ callId: string; script: string; reason: string }> {
    return this.events.filter(row => row.e.type === 'vtuber.act.outcome')
      .flatMap(row => row.e.meta?.outcomes as Array<{ callId: string; script: string; reason: string }>);
  }
  logs: LogLine[] = [];
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = {
    model: () => 'test',
    accepts: () => false,
    contextWindow: () => 128000,
  };
  log: WorldHost['log'];

  constructor() {
    this.log = recordingLogger('worlds.vtuber', (line) => this.logs.push(line));
  }

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push({ e: full, opts });
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  notes: string[] = [];
  reportUsage() {}
}

function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
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
    }, 20);
  });
}

describe('传给子进程的一次性载荷', () => {
  /**
   * World 跑在子进程里,配置里的函数过不去。运行时目录与版本漏在 EngineInit 外面的话,
   * 子进程拿到空串,TTS 起不来只报一句「缺文件(TTS server):」后面什么都没有。
   */
  it('运行时目录与版本进 EngineInit', () => {
    const proxy = new VtuberWorldProxy({
      ttsRuntimeDir: () => 'D:\\rt\\bin',
      ttsRuntimeRelease: () => 'tts-b64d092c-1',
    });
    const init = (proxy as unknown as { buildInit(): { ttsRuntimeDir: string; ttsRuntimeRelease: string } }).buildInit();
    expect(init.ttsRuntimeDir).toBe('D:\\rt\\bin');
    expect(init.ttsRuntimeRelease).toBe('tts-b64d092c-1');
  });

  it('没配就是空串,由 World 那边决定走托管下载', () => {
    const proxy = new VtuberWorldProxy({});
    const init = (proxy as unknown as { buildInit(): { ttsRuntimeDir: string; ttsRuntimeRelease: string } }).buildInit();
    expect(init.ttsRuntimeDir).toBe('');
    expect(init.ttsRuntimeRelease).toBe('');
  });
});

describe('VtuberWorldProxy(演出引擎子进程)', () => {
  let host: FakeHost;
  let tts: Server;
  let ttsUrl: string;
  let serverDir: string;
  let proxy: VtuberWorldProxy;
  let live2dDir = '';

  beforeAll(async () => {
    host = new FakeHost();
    serverDir = mkdtempSync(join(tmpdir(), 'vtuber-proxy-'));
    mkdirSync(join(serverDir, 'voices'));
    writeFileSync(join(serverDir, 'voices', 'mei.wav'), Buffer.from(makeWav(new Array(160).fill(0.2))));
    // VoxCPM2 测试夹具固定返回 3s 音频,提供可打断的播放窗口。
    tts = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.from(makeWav(new Array(48000).fill(0.4))));
      });
    });
    await new Promise<void>((r) => tts.listen(0, '127.0.0.1', () => r()));
    const ttsPort = (tts.address() as { port: number }).port;
    ttsUrl = `http://127.0.0.1:${ttsPort}`;
    proxy = new VtuberWorldProxy({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl,
      audioDevice: () => 'none',
      speechCapSec: () => 30,
      ttsVoicesDir: () => join(serverDir, 'voices'),
      live2dDir: () => live2dDir,
    });
    await proxy.start(host);
  }, 60_000);

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((r) => tts.close(() => r()));
    rmSync(serverDir, { recursive: true, force: true });
  }, 30_000);

  it('启动后拿到演出流地址,状态行经推送缓存可读;无 overlay 消费者时不算在播', async () => {
    // 引擎起了 ≠ 在播:live 要 overlay 有 SSE 消费者(OBS/测试台)才为真
    expect(proxy.live).toBe(false);
    expect(proxy.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    expect(proxy.overlayUrl).toContain('/overlay');
    await waitFor(() => proxy.statusLine() !== null);
    expect(proxy.console().badges?.length).toBeGreaterThan(0);
    // 灯与徽标同批跨界:子进程报上来之后,代理不再点自己那颗"引擎启动中"
    expect(proxy.console().lamps?.[0]?.label).not.toBe('引擎');
  });

  it('overlay 连上 SSE 后状态推送把 live 置真,断开后回落', async () => {
    const res = await fetch(`${proxy.streamUrl}`, {
      headers: { Accept: 'text/event-stream' },
    });
    try {
      await waitFor(() => proxy.live);
      expect(proxy.live).toBe(true);
    } finally {
      await res.body?.cancel();
    }
    await waitFor(() => !proxy.live);
  });

  it('代理工具表只有 vtuber_act 与 vtuber_interrupt', () => {
    expect(proxy.tools().map((tool) => tool.name)).toEqual(['vtuber_act', 'vtuber_interrupt']);
  });

  it('vtuber_act 直连:回执从子进程原样返回,空 script 沉默', async () => {
    const act = proxy.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('missing vtuber_act');
    const r = await act.handler({ script: '大家好呀。' }, { role: 'main', log: host.log, callId: 'p1' });
    expect(r).toContain('已排入演出');
    const silent = String(await act.handler({ script: '' }, { role: 'main', log: host.log, callId: 'p2' }));
    expect(silent).toContain('没有台词正文');
    expect(silent).not.toContain('本轮沉默');
  });

  it('子进程代理对外部数组字符串采用相同归一化与拒绝规则', async () => {
    const act = proxy.tools().find((tool) => tool.name === 'vtuber_act');
    if (!act) throw new Error('missing vtuber_act');
    const decoded = '代理边界只播这一句。';
    const normalized = await act.handler(
      { script: JSON.stringify([decoded]) },
      { role: 'main', log: host.log, callId: 'proxy-normalized' },
    );
    expect(normalized).toContain('已排入演出');
    expect(normalized).toContain('已解包外部 JSON 单元素字符串数组');

    const invalid = await act.handler(
      { script: '["第一段","第二段"]' },
      { role: 'main', log: host.log, callId: 'proxy-invalid' },
    );
    expect(invalid).toContain('invalid_script_shape');
    expect(host.logs.some((log) => log.msg.includes('invalid_script_shape'))).toBe(true);
    expect(host.outcomes.some((revision) => revision.callId === 'proxy-invalid')).toBe(false);
  });

  it('outputTap 增量过界:流式喂字后 handler 回「已开演(流式)」', async () => {
    const tap = legacyTap(proxy.outputTap());
    const script = '流式演出的一句话。';
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 't1', name: 'vtuber_act' });
    const args = JSON.stringify({ script });
    for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onDelta({ type: 'tool_call.end', index: 0 });
    tap.onRoundEnd?.();
    const act = proxy.tools().find((t) => t.name === 'vtuber_act');
    if (!act) throw new Error('missing vtuber_act');
    const r = await act.handler({ script }, { role: 'main', log: host.log, callId: 't1' });
    expect(r).toContain('已开演(流式)');
  });

  it('outputTap 断流经子进程丢弃待定容器，不留下已流式演出的账', async () => {
    const tap = legacyTap(proxy.outputTap());
    const script = JSON.stringify(['子进程断流不播这一句。']);
    const args = JSON.stringify({ script });
    tap.onDelta({ type: 'tool_call.begin', index: 0, id: 'proxy-abort', name: 'vtuber_act' });
    for (const ch of args) tap.onDelta({ type: 'tool_call.delta', index: 0, argsFragment: ch });
    tap.onAbort?.('测试断流');

    const act = proxy.tools().find((tool) => tool.name === 'vtuber_act');
    if (!act) throw new Error('missing vtuber_act');
    const result = await act.handler(
      { script },
      { role: 'main', log: host.log, callId: 'proxy-abort' },
    );
    expect(result).toContain('已排入演出');
    expect(result).not.toContain('已开演(流式)');
  });

  it('子进程日志落在 World 自己的区域,不多冠一层;演出通道跨 IPC 后仍是 worlds.vtuber.<通道>', async () => {
    await waitFor(() => host.logs.some((l) => l.event === 'round-open'));
    const open = host.logs.find((l) => l.event === 'round-open');
    // host 给的区域就是 World 的区域;子进程的根 logger 不再叠一次 World 名
    expect(open).toMatchObject({ area: 'worlds.vtuber.round', level: 'info' });
    expect(host.logs.every((l) => l.area === 'worlds.vtuber' || l.area.startsWith('worlds.vtuber.'))).toBe(true);
    expect(host.logs.some((l) => l.area.includes('vtuber.vtuber'))).toBe(false);
  });

  it('控制台面板经代理可用:clips 分组、演出日志、overlay 试显', async () => {
    const clips = await proxy.clipsConsole().state();
    expect(clips.groups.length).toBeGreaterThan(0);
    const entries = await proxy.logConsole().entries();
    expect(Array.isArray(entries)).toBe(true);
    const demo = await proxy.overlayConsole().demo('danmaku');
    expect(demo).toContain('试显');
    const presets = await proxy.performConsole().presets();
    expect(presets.length).toBeGreaterThan(0);
  });

  it('面板调用前同步刚写入的外置资源路径', async () => {
    live2dDir = join(serverDir, 'live2d');
    const state = await proxy.console().invoke!('model', 'state', []) as { live2dDir: string };
    expect(state.live2dDir).toBe(live2dDir);
  });

  it('管道类子进程错误降级,真故障仍是 error', () => {
    // 关机时子进程已被杀,演出 World 再往管道写一笔就是 EPIPE:那是时序噪音,
    // 记成 error 会让「按 error 找故障」这条复盘路径失效。
    const internals = proxy as unknown as { child: { emit: (ev: string, err: Error) => void }; stopping: boolean };
    const pipe = host.logs.length;
    internals.child.emit('error', new Error('write EPIPE'));
    expect(host.logs.slice(pipe).some((l) => l.level === 'error')).toBe(false);
    expect(host.logs.slice(pipe).some((l) => l.level === 'debug' && l.msg.includes('管道已关'))).toBe(true);

    const shutting = host.logs.length;
    internals.stopping = true;
    internals.child.emit('error', new Error('spawn ENOENT'));
    internals.stopping = false;
    expect(host.logs.slice(shutting).some((l) => l.level === 'error')).toBe(false);

    const real = host.logs.length;
    internals.child.emit('error', new Error('spawn ENOENT'));
    expect(host.logs.slice(real).some((l) => l.level === 'error' && l.msg.includes('子进程出错'))).toBe(true);
  });

  it('vtuber_interrupt:收束回执 + 结果事件在回执前跨回主进程', async () => {
    const act = proxy.tools().find((t) => t.name === 'vtuber_act');
    const stop = proxy.tools().find((t) => t.name === 'vtuber_interrupt');
    if (!act || !stop) throw new Error('missing tools');
    const long = '打断测试的长台词。'.repeat(10);
    await act.handler({ script: long }, { role: 'main', log: host.log, callId: 'i1' });
    const out = await stop.handler({}, { role: 'main', log: host.log });
    expect(out).toContain('收住');
    expect(host.outcomes.some(r => r.callId === 'i1')).toBe(true);
    const revision = host.outcomes.find((r) => r.callId === 'i1');
    expect(revision?.script).not.toContain('打断测试');
  });

  it('shutdown 一经接收就拒绝后续面板 RPC', async () => {
    const isolatedHost = new FakeHost();
    const isolated = new VtuberWorldProxy({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      ttsUrl,
      audioDevice: () => 'none',
      speechCapSec: () => 30,
    });
    await isolated.start(isolatedHost);
    const act = isolated.tools().find((tool) => tool.name === 'vtuber_act');
    if (!act) throw new Error('missing vtuber_act');
    await act.handler({ script: '停机排空窗口。' }, {
      role: 'main', log: isolatedHost.log, callId: 'shutdown-gate-act',
    });
    await waitFor(() => isolated.statusLine()?.includes('正在说话') === true);

    const stopping = isolated.stop();
    const invoke = isolated.console().invoke;
    if (!invoke) throw new Error('missing console invoke');
    try {
      await expect(invoke('log', 'entries', [])).rejects.toThrow('演出引擎正在停机');
    } finally {
      await stopping;
    }
  }, 20_000);
});

/*
 * 此组直接驱动子进程退出回调，验证退出告知，不操作其他用例的真实子进程。
 */
describe('演出引擎子进程退出的告知', () => {
  interface Internals {
    onExit(code: number | null): void;
    stopping: boolean;
    restartTimer: ReturnType<typeof setTimeout> | null;
  }

  function makeIdleProxy(): { proxy: VtuberWorldProxy; host: FakeHost; inner: Internals } {
    const host = new FakeHost();
    const proxy = new VtuberWorldProxy({
      botName: 'bot',
      streamPort: 0,
      vtsWsUrl: 'ws://127.0.0.1:1',
      audioDevice: () => 'none',
      speechCapSec: () => 30,
    });
    (proxy as unknown as { host: WorldHost }).host = host;
    const inner = proxy as unknown as Internals;
    return { proxy, host, inner };
  }

  afterEach(() => {
    // 退出回调会排一次重启;不让它真去 fork
    vi.clearAllTimers?.();
  });

  it('交接钩子:代理侧直接推一条 internal worlds.note(flush 档),不经子进程', () => {
    const { proxy, host } = makeIdleProxy();
    proxy.onHandoffEnded();
    expect(host.events).toHaveLength(1);
    const { e, opts } = host.events[0];
    expect(e.type).toBe('worlds.note');
    expect(e.origin).toBe('internal');
    expect(e.text).toBe(HANDOFF_NOTE);
    expect(opts?.trigger).toBe('flush');
  });

  it('非关机期退出:error 日志 + 一条事件进她的上下文', () => {
    const { host, inner } = makeIdleProxy();
    inner.onExit(3221225477);
    if (inner.restartTimer) clearTimeout(inner.restartTimer);

    expect(host.logs.some((l) => l.level === 'error' && l.msg.includes('意外退出'))).toBe(true);
    const note = host.events.find((x) => x.e.type === 'worlds.note');
    expect(note).toBeDefined();
    // 报障是 World 自己这一侧机制的话:进 user 区,不落进「保持怀疑」的事件帧
    expect(note!.e.origin).toBe('internal');
    expect(note!.opts?.trigger).toBe('flush');
    expect(note!.e.text).toContain('意外退出');
    expect(note!.e.text).toContain('画面与声音');
  });

  it('关机期退出:不报错也不投事件(与 EPIPE 降级同一条纪律)', () => {
    const { host, inner } = makeIdleProxy();
    inner.stopping = true;
    inner.onExit(0);
    expect(host.events).toHaveLength(0);
    expect(host.logs.some((l) => l.level === 'error')).toBe(false);
  });
});

/*
 * 子进程的 stdout/stderr 不再继承主进程终端:逐行进运行日志的 stdio 区域。
 * 演出 World 自己的日志走 IPC note,这一路只收直接写 console 的部件。
 */
describe('attachStdio', () => {
  it('跨 chunk 的半行拼成一条;stdout 记 debug、stderr 记 warn;空行丢弃;流关时残段发出', async () => {
    const logs: LogLine[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    attachStdio({ stdout, stderr }, () => recordingLogger('worlds.vtuber', (line) => logs.push(line)));
    stdout.write('第一行前半 ');
    stdout.write('后半\n\n  第二行  \n尾巴没有换行');
    stdout.end();
    stderr.write('  boom  \n');
    stderr.end();
    await waitFor(() => logs.length >= 4, 2000);
    expect(logs.filter((l) => l.event === 'stdout')).toEqual([
      { area: 'worlds.vtuber.stdio', level: 'debug', event: 'stdout', msg: '第一行前半 后半', durMs: undefined, data: undefined },
      { area: 'worlds.vtuber.stdio', level: 'debug', event: 'stdout', msg: '第二行', durMs: undefined, data: undefined },
      { area: 'worlds.vtuber.stdio', level: 'debug', event: 'stdout', msg: '尾巴没有换行', durMs: undefined, data: undefined },
    ]);
    expect(logs.filter((l) => l.event === 'stderr')).toEqual([
      { area: 'worlds.vtuber.stdio', level: 'warn', event: 'stderr', msg: 'boom', durMs: undefined, data: undefined },
    ]);
  });

  it('host 还没挂上时行被丢弃,挂上之后照常转发', async () => {
    const logs: LogLine[] = [];
    let log: ReturnType<typeof recordingLogger> | undefined;
    const stdout = new PassThrough();
    attachStdio({ stdout, stderr: null }, () => log);
    stdout.write('没人接\n');
    await new Promise((r) => setImmediate(r));
    log = recordingLogger('worlds.vtuber', (line) => logs.push(line));
    stdout.write('有人接\n');
    await waitFor(() => logs.length >= 1, 2000);
    expect(logs.map((l) => l.msg)).toEqual(['有人接']);
  });
});
