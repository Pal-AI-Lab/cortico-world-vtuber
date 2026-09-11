import { describe, it, expect, afterEach } from 'vitest';
import { createServer, get as httpGet, type IncomingHttpHeaders, type Server } from 'node:http';
import WebSocket from 'ws';
import { nullLogger } from 'cortico/core/util.ts';
import { PerformStream } from '../../src/perform-stream.ts';

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
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

/** 最小 SSE 客户端:攒 {id, data} 对 */
function subscribe(url: string, headers: Record<string, string> = {}) {
  const events: Array<{ id: number | null; data: Record<string, unknown> }> = [];
  let req: ReturnType<typeof httpGet>;
  const ready = new Promise<void>((resolve, reject) => {
    req = httpGet(url, { headers }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          let id: number | null = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = Number(line.slice(4));
            if (line.startsWith('data: ')) {
              events.push({ id, data: JSON.parse(line.slice(6)) as Record<string, unknown> });
            }
          }
        }
      });
      resolve();
    });
    req.on('error', reject);
  });
  return {
    events,
    ready,
    close: (): void => {
      req.destroy();
    },
  };
}

describe('PerformStream', () => {
  let cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  async function makeStream() {
    const danmaku: Array<{ text: string; from: string }> = [];
    const stream = new PerformStream({
      preferredPort: 0,
      snapshot: () => ({ mode: 'chat', status: '[演出状态] 测试' }),
      onDanmakuIn: (text, from) => danmaku.push({ text, from }),
    });
    await stream.start(nullLogger());
    cleanup.push(() => stream.stop());
    return { stream, danmaku };
  }

  it('订阅即收 snapshot;事件带单调 id 广播给所有订阅者', async () => {
    const { stream } = await makeStream();
    const a = subscribe(stream.streamUrl);
    const b = subscribe(stream.streamUrl);
    cleanup.push(a.close, b.close);
    await a.ready;
    await b.ready;
    await waitFor(() => a.events.length >= 1 && b.events.length >= 1);
    expect(a.events[0].data).toMatchObject({ type: 'snapshot', mode: 'chat' });

    stream.emit('subtitle', { text: '第一句' });
    stream.emit('cue', { cues: [{ word: '点头', channel: 'gesture' }] });
    await waitFor(() => a.events.length >= 3 && b.events.length >= 3);
    expect(a.events[1]).toMatchObject({ id: 1, data: { type: 'subtitle', text: '第一句' } });
    expect(a.events[2].data).toMatchObject({ type: 'cue' });
    expect(b.events[1].data).toMatchObject({ type: 'subtitle', text: '第一句' });
  });

  it('断线重连凭 Last-Event-ID 续传近期条目', async () => {
    const { stream } = await makeStream();
    stream.emit('subtitle', { text: '错过的一句' });
    stream.emit('subtitle', { text: '也错过的一句' });
    const late = subscribe(stream.streamUrl, { 'Last-Event-ID': '1' });
    cleanup.push(late.close);
    await late.ready;
    // 续传的 seq>1 条目在 snapshot 之前送达
    await waitFor(() => late.events.length >= 2);
    expect(late.events[0]).toMatchObject({ id: 2, data: { type: 'subtitle', text: '也错过的一句' } });
    expect(late.events[1].data).toMatchObject({ type: 'snapshot' });
  });

  it('GET /overlay 交出自带的演出画面页;静态资产带对的 Content-Type', async () => {
    const { stream } = await makeStream();
    const fetchText = (url: string): Promise<{ status: number; type: string; body: string }> =>
      new Promise((resolve, reject) => {
        httpGet(url, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
        }).on('error', reject);
      });
    const page = await fetchText(stream.overlayUrl);
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('/overlay/app.js');
    const trailed = await fetchText(stream.overlayUrl + '/');
    expect(trailed.status).toBe(200);
    expect(trailed.type).toContain('text/html');
    const js = await fetchText(stream.overlayUrl + '/app.js');
    expect(js.status).toBe(200);
    expect(js.type).toContain('javascript');
    const miss = await fetchText(stream.overlayUrl + '/nope');
    expect(miss.status).toBe(404);
  });

  it('SSE 开流带去缓冲头与垫块,snapshot 仍是第一条 data', async () => {
    const { stream } = await makeStream();
    const got = await new Promise<{ headers: IncomingHttpHeaders; chunks: string }>((resolve, reject) => {
      httpGet(stream.streamUrl, (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks += c;
          if (chunks.includes('snapshot')) {
            res.destroy();
            resolve({ headers: res.headers, chunks });
          }
        });
      }).on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
        reject(err);
      });
    });
    expect(got.headers['content-type']).toContain('text/event-stream');
    expect(got.headers['x-accel-buffering']).toBe('no');
    expect(got.chunks.startsWith(': ')).toBe(true);
    expect(got.chunks.indexOf(': ')).toBeLessThan(got.chunks.indexOf('snapshot'));
  });

  it('WS /danmaku 投喂进回调;残缺 JSON 与空文本被丢弃', async () => {
    const { stream, danmaku } = await makeStream();
    const ws = new WebSocket(stream.danmakuUrl);
    cleanup.push(() => ws.close());
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'danmaku_in', text: '   ' }));
    ws.send(JSON.stringify({ type: 'danmaku_in', text: ' 你好 ', from: ' 观众A ' }));
    ws.send(JSON.stringify({ type: 'danmaku_in', text: '匿名的' }));
    await waitFor(() => danmaku.length >= 2);
    expect(danmaku).toEqual([
      { text: '你好', from: '观众A' },
      { text: '匿名的', from: 'audience' },
    ]);
  });

  it('WS /danmaku 只收本机页面:回环任意端口放行,外站 Origin 被拒', async () => {
    const { stream } = await makeStream();
    const handshake = (origin?: string): Promise<'open' | 'rejected'> =>
      new Promise((resolve) => {
        const ws = new WebSocket(stream.danmakuUrl, origin ? { headers: { origin } } : {});
        ws.once('open', () => {
          ws.close();
          resolve('open');
        });
        ws.once('error', () => resolve('rejected'));
      });
    // OBS 这类页面在本机别的端口上
    expect(await handshake('http://127.0.0.1:65123')).toBe('open');
    expect(await handshake('http://localhost:3000')).toBe('open');
    expect(await handshake()).toBe('open'); // mock 弹幕机这类程序化客户端
    expect(await handshake('http://evil.example')).toBe('rejected');
    expect(await handshake('null')).toBe('rejected');
  });

  it('偏好端口被占时顺延并报 warn(不是 info)——那是"上一次没退干净"最早的旁证', async () => {
    const { stream: blocker } = await makeStream();
    const busy = blocker.port;

    const warns: string[] = [];
    const infos: string[] = [];
    const recording = {
      error() {}, debug() {},
      info(msg: string) { infos.push(msg); },
      warn(msg: string) { warns.push(msg); },
      child() { return this; },
    } as unknown as Parameters<PerformStream['start']>[0];

    const stream = new PerformStream({
      preferredPort: busy,
      snapshot: () => ({ mode: 'chat', status: '[演出状态] 测试' }),
      onDanmakuIn: () => {},
    });
    await stream.start(recording);
    cleanup.push(() => stream.stop());

    expect(stream.port).toBeGreaterThan(busy);
    const hit = warns.find((msg) => msg.includes('被占用'));
    expect(hit).toBeDefined();
    expect(hit).toContain(`端口 ${busy} 被占用,改用 ${stream.port}`);
    expect(hit).toContain('上一次没退干净');
    expect(infos.some((msg) => msg.includes('被占用'))).toBe(false);
  });

  it('顺延上限 5:连占 5 个口就报错,不再顺延到第 50 个', async () => {
    const { stream: blocker } = await makeStream();
    const busy = blocker.port;
    // 连占 busy..busy+4:第 6 个候选(busy+5)是空的,若还能起来说明上限没收到 5
    const holders: Server[] = [];
    cleanup.push(() => Promise.all(holders.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => {}));
    for (let i = 1; i < 5; i++) {
      const s = createServer(() => {});
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(busy + i, '127.0.0.1', () => resolve());
      });
      holders.push(s);
    }

    const stream = new PerformStream({
      preferredPort: busy,
      snapshot: () => ({ mode: 'chat', status: '[演出状态] 测试' }),
      onDanmakuIn: () => {},
    });
    cleanup.push(() => stream.stop());
    await expect(stream.start(nullLogger())).rejects.toThrow();
  });
});
