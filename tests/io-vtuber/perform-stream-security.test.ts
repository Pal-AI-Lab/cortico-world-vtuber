import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PerformStream } from '../../src/perform-stream.ts';
import { nullLogger } from 'cortico/core/util.ts';

function rejected(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.once('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      resolve(status);
    });
    ws.once('open', () => {
      ws.close();
      reject(new Error('非本机 Origin 不应连接成功'));
    });
    ws.once('error', () => { /* unexpected-response 后忽略 */ });
  });
}

function opened(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('PerformStream danmaku Origin', () => {
  let stream: PerformStream | null = null;
  afterEach(async () => {
    if (stream) await stream.stop();
    stream = null;
  });

  async function start() {
    stream = new PerformStream({
      preferredPort: 0,
      snapshot: () => ({ mode: 'chat' }),
      onDanmakuIn: () => {},
    });
    await stream.start(nullLogger());
    return stream;
  }

  it('拒绝互联网网页 Origin', async () => {
    const s = await start();
    // verifyClient 布尔拒绝时 ws 库回 401
    expect(await rejected(s.danmakuUrl, 'https://evil.example')).toBe(401);
  });

  it('允许本机不同端口页面，保留测试台/overlay 周边工具兼容', async () => {
    const s = await start();
    const ws = await opened(s.danmakuUrl, 'http://localhost:65530');
    ws.close();
  });
});
