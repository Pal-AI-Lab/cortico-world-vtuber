import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { VtsClient } from '../../src/io-vtuber/vts-client.ts';
import { VtsBackend } from '../../src/io-vtuber/backend.ts';

function authOk(ws: WebSocket, msg: { requestID: string; messageType: string }): void {
  if (msg.messageType === 'AuthenticationTokenRequest') {
    ws.send(
      JSON.stringify({
        requestID: msg.requestID,
        messageType: 'AuthenticationTokenResponse',
        data: { authenticationToken: 'tok-ok' },
      }),
    );
    return;
  }
  if (msg.messageType === 'AuthenticationRequest') {
    ws.send(
      JSON.stringify({
        requestID: msg.requestID,
        messageType: 'AuthenticationResponse',
        data: { authenticated: true },
      }),
    );
  }
}

/*
 * 半开场景全部用真 WebSocketServer + 假时钟:假时钟只接管 setTimeout/setInterval/Date,
 * 不接管 setImmediate/nextTick——那两个是 ws 内部推进收发的通道,一起假掉会把握手卡死。
 * 真 socket 的 IO 不受假时钟影响,所以「等 IO 落地」要用下面这个真睡眠轮询,
 * 「跳时间」才用 advanceTimersByTimeAsync。
 */
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => {
    realSetTimeout(r, ms);
  });

async function until(cond: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await realSleep(2);
  }
  throw new Error(`等待超时:${label}`);
}

function useVtsFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

interface StubMsg {
  requestID: string;
  messageType: string;
  data?: Record<string, unknown>;
}
interface SeenMsg {
  conn: number;
  type: string;
  data: Record<string, unknown>;
}

/** 可编排的 VTS 替身:记下每条收到的请求属于第几条连接,以及每条连接何时被对端断开。 */
async function startStub(handle: (ws: WebSocket, msg: StubMsg, conn: number) => void): Promise<{
  url: string;
  seen: SeenMsg[];
  sockets: WebSocket[];
  closedConns: number[];
  stop: () => Promise<void>;
}> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const seen: SeenMsg[] = [];
  const sockets: WebSocket[] = [];
  const closedConns: number[] = [];
  let conns = 0;
  wss.on('connection', (ws) => {
    const conn = ++conns;
    sockets.push(ws);
    ws.on('close', () => closedConns.push(conn));
    ws.on('error', () => {
      /* terminate 会让服务端这侧报 ECONNRESET,不是测试失败 */
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as StubMsg;
      seen.push({ conn, type: msg.messageType, data: msg.data ?? {} });
      handle(ws, msg, conn);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const port = (http.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    seen,
    sockets,
    closedConns,
    stop: async () => {
      for (const s of sockets) {
        try {
          s.terminate();
        } catch {
          /* 已经死了 */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
    },
  };
}

function reply(ws: WebSocket, msg: StubMsg, messageType: string, data: Record<string, unknown>): void {
  ws.send(JSON.stringify({ requestID: msg.requestID, messageType, data }));
}

describe('VtsClient', () => {
  it('APIError 带上 data.message；失败后可以重连成功', async () => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    let round = 0;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as {
          requestID: string;
          messageType: string;
        };
        round++;
        if (round === 1) {
          // 第一次：AuthenticationTokenRequest → APIError（文案在 data 里）
          ws.send(
            JSON.stringify({
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              requestID: msg.requestID,
              messageType: 'APIError',
              data: { errorID: 50, message: 'User refused the request' },
            }),
          );
          return;
        }
        if (msg.messageType === 'AuthenticationTokenRequest') {
          ws.send(
            JSON.stringify({
              requestID: msg.requestID,
              messageType: 'AuthenticationTokenResponse',
              data: { authenticationToken: 'tok-ok' },
            }),
          );
          return;
        }
        if (msg.messageType === 'AuthenticationRequest') {
          ws.send(
            JSON.stringify({
              requestID: msg.requestID,
              messageType: 'AuthenticationResponse',
              data: { authenticated: true },
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const port = (http.address() as { port: number }).port;
    const client = new VtsClient({ url: `ws://127.0.0.1:${port}` });

    await expect(client.connect()).rejects.toThrow(/User refused the request/);
    expect(client.connected).toBe(false);

    await client.connect();
    expect(client.connected).toBe(true);

    await client.close();
    await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
  });

  /*
   * 首连失败后自动连接的首次认证也须通知，以重建模型档案、参数名单和在途状态。
   */
  it('onConnected:首连失败之后连上的那一次也通知;重复 connect 不重复触发;退订后不再触发', async () => {
    let refuse = true;
    const stub = await startStub((ws, msg) => {
      if (refuse) {
        ws.send(JSON.stringify({
          requestID: msg.requestID,
          messageType: 'APIError',
          data: { errorID: 50, message: 'User refused the request' },
        }));
        return;
      }
      if (msg.messageType === 'AuthenticationTokenRequest') {
        reply(ws, msg, 'AuthenticationTokenResponse', { authenticationToken: 'tok-ok' });
        return;
      }
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: true });
      }
    });
    const client = new VtsClient({ url: stub.url });
    let hits = 0;
    const off = client.onConnected(() => {
      hits += 1;
    });
    try {
      await expect(client.connect()).rejects.toThrow(/User refused the request/);
      expect(hits).toBe(0);

      refuse = false;
      await client.connect();
      expect(client.connected).toBe(true);
      expect(hits).toBe(1); // 修复前这里是 0:everAuthed 还是 false

      // 同一条连接上再 connect() 直接返回,不该再算一次「连上了」
      await client.connect();
      expect(hits).toBe(1);

      off();
      await client.close();
      await client.connect();
      expect(client.connected).toBe(true);
      expect(hits).toBe(1);
    } finally {
      await client.close();
      await stub.stop();
    }
  });

  it('clearActiveExpressions 关掉激活表情并保留 keepFiles', async () => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const deactivated: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { requestID: string; messageType: string; data?: { expressionFile?: string } };
        if (
          msg.messageType === 'AuthenticationTokenRequest' ||
          msg.messageType === 'AuthenticationRequest'
        ) {
          authOk(ws, msg);
          return;
        }
        if (msg.messageType === 'ExpressionStateRequest') {
          ws.send(
            JSON.stringify({
              requestID: msg.requestID,
              messageType: 'ExpressionStateResponse',
              data: {
                expressions: [
                  { file: 'Idea.exp3.json', active: true },
                  { file: 'Yukima.exp3.json', active: true },
                  { file: 'Mic.exp3.json', active: true },
                  { file: 'Sweating.exp3.json', active: true },
                  { file: 'Idle.exp3.json', active: false },
                ],
              },
            }),
          );
          return;
        }
        if (msg.messageType === 'ExpressionActivationRequest') {
          deactivated.push(String(msg.data?.expressionFile ?? ''));
          ws.send(
            JSON.stringify({
              requestID: msg.requestID,
              messageType: 'ExpressionActivationResponse',
              data: {},
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const port = (http.address() as { port: number }).port;
    const client = new VtsClient({ url: `ws://127.0.0.1:${port}`, authToken: 'pre' });
    const cleared = await client.clearActiveExpressions({
      keepFiles: ['Yukima.exp3.json', 'Mic.exp3.json'],
    });
    expect(cleared.sort()).toEqual(['Idea.exp3.json', 'Sweating.exp3.json']);
    expect(deactivated.sort()).toEqual(['Idea.exp3.json', 'Sweating.exp3.json']);

    await client.close();
    await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
  });

  it('参数读回:输出参数实时值与输入参数默认值都解出来,残缺条目跳过', async () => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { requestID: string; messageType: string };
        if (msg.messageType === 'AuthenticationTokenRequest' || msg.messageType === 'AuthenticationRequest') {
          authOk(ws, msg);
          return;
        }
        if (msg.messageType === 'Live2DParameterListRequest') {
          ws.send(
            JSON.stringify({
              requestID: msg.requestID,
              messageType: 'Live2DParameterListResponse',
              data: {
                parameters: [
                  { name: 'ParamAngleX', value: 4.2, defaultValue: 0 },
                  { name: 'ParamMouthForm', value: -0.8 },
                  { name: '', value: 1 },
                  { name: 'ParamBroken' },
                ],
              },
            }),
          );
          return;
        }
        if (msg.messageType === 'InputParameterListRequest') {
          ws.send(
            JSON.stringify({
              requestID: msg.requestID,
              messageType: 'InputParameterListResponse',
              data: {
                defaultParameters: [{ name: 'MouthSmile', value: 0.55, defaultValue: 0 }],
                customParameters: [{ name: 'Custom1', value: 1, defaultValue: 0.5 }],
              },
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const port = (http.address() as { port: number }).port;
    const client = new VtsClient({ url: `ws://127.0.0.1:${port}`, authToken: 'pre' });
    const outs = await client.live2dParameters();
    expect(outs).toEqual([
      { name: 'ParamAngleX', value: 4.2, defaultValue: 0 },
      { name: 'ParamMouthForm', value: -0.8, defaultValue: 0 },
    ]);
    const ins = await client.inputParameters();
    expect(ins).toEqual([
      { name: 'MouthSmile', value: 0.55, defaultValue: 0 },
      { name: 'Custom1', value: 1, defaultValue: 0.5 },
    ]);

    await client.close();
    await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
  });
});

/*
 * 半开连接夹具正常响应认证，随后收包但不回复、不关闭；对端无 FIN，连接状态仍可显示 OPEN。
 */
describe('VtsClient 半开自愈', () => {
  it('B1 注入按 2 秒超时,第 3 次超时后连接不再是恒 true(修复前会一路撑到 30 秒硬拆)', async () => {
    useVtsFakeTimers();
    const stub = await startStub((ws, msg) => {
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: true });
      }
      // 其余一律不回、不关:半开
    });
    const client = new VtsClient({ url: stub.url, authToken: 'tok-fixed' });
    try {
      await client.connect();
      expect(client.connected).toBe(true);

      const shots = [0, 1, 2].map((i) => client.injectParameters([{ id: 'FaceAngleY', value: -i }], 'add'));
      const settled = shots.map((p) => p.then(() => 'ok').catch((e: Error) => e.message));
      await until(() => stub.seen.filter((s) => s.type === 'InjectParameterDataRequest').length === 3, '三包注入已到服务端');

      // 1.9 秒:分层超时是 2000ms,这时应该一个都还没判超时
      await vi.advanceTimersByTimeAsync(1_900);
      expect(client.connected).toBe(true);

      await vi.advanceTimersByTimeAsync(200);
      expect(await Promise.all(settled)).toEqual([
        'VTS 请求超时: InjectParameterDataRequest',
        'VTS 请求超时: InjectParameterDataRequest',
        'VTS 请求超时: InjectParameterDataRequest',
      ]);
      // 修复前这里恒 true,一直到 30000ms 才翻
      expect(client.connected).toBe(false);
    } finally {
      await client.close();
      await stub.stop();
      vi.useRealTimers();
    }
  });

  it('B2 第 3 次超时即熔断:服务端看到连接被断开,不等 30 秒', async () => {
    useVtsFakeTimers();
    const stub = await startStub((ws, msg) => {
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: true });
      }
    });
    const client = new VtsClient({ url: stub.url, authToken: 'tok-fixed' });
    try {
      await client.connect();
      for (const i of [0, 1, 2]) {
        void client.injectParameters([{ id: 'FaceAngleY', value: -i }], 'add').catch(() => undefined);
      }
      await until(() => stub.seen.filter((s) => s.type === 'InjectParameterDataRequest').length === 3, '三包注入已到服务端');
      expect(stub.closedConns).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_100);
      await until(() => stub.closedConns.length === 1, '服务端收到第一条连接的 close');
      expect(stub.closedConns).toEqual([1]);
    } finally {
      await client.close();
      await stub.stop();
      vi.useRealTimers();
    }
  });

  it('熔断后退避重连:第二条连接重跑 AuthenticationRequest 且带同一 token,绝不重申请 token', async () => {
    useVtsFakeTimers();
    let halfOpen = true;
    const stub = await startStub((ws, msg) => {
      if (msg.messageType === 'AuthenticationTokenRequest') {
        reply(ws, msg, 'AuthenticationTokenResponse', { authenticationToken: 'tok-from-vts' });
        return;
      }
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: true });
        return;
      }
      if (halfOpen) return; // 半开:收下不回
      reply(ws, msg, 'InjectParameterDataResponse', {});
    });
    // 首连没有 token,走一次弹窗申请;之后的重连只许用这个 token
    const client = new VtsClient({ url: stub.url });
    try {
      await client.connect();
      for (const i of [0, 1, 2]) {
        void client.injectParameters([{ id: 'FaceAngleY', value: -i }], 'add').catch(() => undefined);
      }
      await until(() => stub.seen.filter((s) => s.type === 'InjectParameterDataRequest').length === 3, '三包注入已到服务端');
      await vi.advanceTimersByTimeAsync(2_100);
      await until(() => stub.closedConns.length === 1, '第一条连接已断');

      halfOpen = false;
      // 退避第一档 500ms
      await vi.advanceTimersByTimeAsync(600);
      await until(() => client.connected, '退避后重连并认证成功');

      const auths = stub.seen.filter((s) => s.type === 'AuthenticationRequest');
      expect(auths.map((a) => a.conn)).toEqual([1, 2]);
      expect(auths[1].data.authenticationToken).toBe('tok-from-vts');
      expect(auths[0].data.authenticationToken).toBe('tok-from-vts');
      // 重走 TokenRequest 会在实机 VTS 弹窗打断直播
      expect(stub.seen.filter((s) => s.type === 'AuthenticationTokenRequest')).toHaveLength(1);
    } finally {
      await client.close();
      await stub.stop();
      vi.useRealTimers();
    }
  });

  it('重连后 backend 重新拉参数名单、补发最后一帧,背压不再卡在两帧在途', async () => {
    useVtsFakeTimers();
    let halfOpen = false;
    const stub = await startStub((ws, msg) => {
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: true });
        return;
      }
      if (msg.messageType === 'InputParameterListRequest') {
        reply(ws, msg, 'InputParameterListResponse', {
          defaultParameters: [{ name: 'FaceAngleY' }],
          customParameters: [],
        });
        return;
      }
      if (halfOpen) return;
      reply(ws, msg, 'InjectParameterDataResponse', {});
    });
    const client = new VtsClient({ url: stub.url, authToken: 'tok-fixed' });
    const errors: string[] = [];
    const backend = new VtsBackend(client, { onError: (e) => errors.push(e.message) });
    const injectsOn = (conn: number): SeenMsg[] =>
      stub.seen.filter((s) => s.conn === conn && s.type === 'InjectParameterDataRequest');
    try {
      await client.connect();
      // 首连也算「连上了」:先等这一轮名单到手、发帧暂停解除,再开始灌帧
      await until(
        () => (backend as unknown as { syncingKnown: boolean }).syncingKnown === false,
        '首连后参数名单到手',
      );

      halfOpen = true;
      backend.sendFrame({ FaceAngleY: { value: -1, mode: 'add' } });
      backend.sendFrame({ FaceAngleY: { value: -2, mode: 'add' } });
      backend.sendFrame({ FaceAngleY: { value: -3, mode: 'add' } }); // 在途已满,进候补
      await until(() => injectsOn(1).length === 2, '两帧在途');

      // 2000ms 两包超时(streak 2,候补帧顶上来),3000ms「有在途且久无应答」补刀熔断
      await vi.advanceTimersByTimeAsync(3_200);
      await until(() => stub.closedConns.length === 1, '第一条连接已熔断');

      halfOpen = false;
      await vi.advanceTimersByTimeAsync(600);
      await until(() => client.connected, '退避后重连成功');

      // 恢复动作:重查名单 → 补发最后一帧
      await until(
        () => stub.seen.some((s) => s.conn === 2 && s.type === 'InputParameterListRequest'),
        '重连后重新拉取输入参数名单',
      );
      await until(() => injectsOn(2).length >= 1, '重连后补发最后一帧');
      const replayed = injectsOn(2)[0].data.parameterValues as Array<{ id: string; value: number }>;
      expect(replayed).toEqual([{ id: 'FaceAngleY', value: -3 }]);

      // 修复前 inFlight 停在 2 再也不减,这五帧一帧都出不去
      for (const i of [4, 5, 6, 7, 8]) {
        backend.sendFrame({ FaceAngleY: { value: -i, mode: 'add' } });
        await realSleep(5);
      }
      await until(() => injectsOn(2).length >= 6, '重连后连打五帧全部发得出去');
      expect(errors.filter((e) => e.includes('APIError'))).toEqual([]);
    } finally {
      backend.stop();
      await client.close();
      await stub.stop();
      vi.useRealTimers();
    }
  });

  it('半开态 close() 在 1 秒死线内返回,不陪 ws 库耗满 30 秒', async () => {
    useVtsFakeTimers();
    const stub = await startStub((ws, msg) => {
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: true });
      }
    });
    const client = new VtsClient({ url: stub.url, authToken: 'tok-fixed' });
    try {
      await client.connect();
      // 真半开:服务端不再读这条 socket,连 Close 帧也读不到,自然也回不了
      (stub.sockets[0] as unknown as { _socket: { pause: () => void } })._socket.pause();

      let done = false;
      void client.close().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(900);
      await realSleep(10);
      expect(done).toBe(false); // 死线未到,还在等对端的 Close 帧

      await vi.advanceTimersByTimeAsync(300);
      await until(() => done, 'close 在死线内返回');
    } finally {
      await stub.stop();
      vi.useRealTimers();
    }
  });

  it('心跳:连续两拍没有 pong 就判死(空闲期掉线也发现得了)', async () => {
    useVtsFakeTimers();
    let subscribed = false;
    const stub = await startStub((ws, msg) => {
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: true });
      }
      if (msg.messageType === 'EventSubscriptionRequest') {
        reply(ws, msg, 'EventSubscriptionResponse', {});
        subscribed = true;
      }
    });
    const client = new VtsClient({ url: stub.url, authToken: 'tok-fixed' });
    try {
      await client.connect();
      // 认证后自带的模型事件订阅先答完:此后没有在途请求,只有心跳能发现对端已经不在
      await until(() => subscribed, '模型事件订阅已应答');
      await realSleep(20);
      (stub.sockets[0] as unknown as { _socket: { pause: () => void } })._socket.pause();

      await vi.advanceTimersByTimeAsync(5_100); // 第一拍 ping 发出,没有 pong
      expect(client.connected).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000); // 第二拍仍无 pong → terminate
      expect(client.connected).toBe(false);
    } finally {
      await client.close();
      await stub.stop();
      vi.useRealTimers();
    }
  });

  /*
   * token 无效后停止自动重连；回调按拒绝状态翻转报告一次，重新认证成功再报告解除。
   */
  it('token 被判无效:报障回调翻一次,自动重连不再排;重新授权成功后解除', async () => {
    useVtsFakeTimers();
    const flips: boolean[] = [];
    let accept = false;
    const stub = await startStub((ws, msg) => {
      if (msg.messageType === 'AuthenticationTokenRequest') {
        reply(ws, msg, 'AuthenticationTokenResponse', { authenticationToken: 'tok-new' });
        return;
      }
      if (msg.messageType === 'AuthenticationRequest') {
        reply(ws, msg, 'AuthenticationResponse', { authenticated: accept });
      }
    });
    const client = new VtsClient({
      url: stub.url,
      authToken: 'tok-stale',
      onAuthRejected: (rejected) => flips.push(rejected),
    });
    try {
      await expect(client.connect()).rejects.toThrow('认证失败');
      expect(flips).toEqual([true]);

      // 自动重连这条路已经停了:踢一脚也不排定时器,时间跳过去仍然没连上
      client.ensureConnected();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.connected).toBe(false);
      expect(flips).toEqual([true]);

      // 人工在 VTS 里重新允许插件 = 重新申请 token 并认证成功
      accept = true;
      await client.connect();
      expect(client.connected).toBe(true);
      expect(flips).toEqual([true, false]);
    } finally {
      await client.close();
      await stub.stop();
      vi.useRealTimers();
    }
  });
});
