/**
 * 演出流服务:vtuber 模组的对外网络面。
 *
 * - `GET /overlay`(页面):模组自带的演出画面层——字幕(按 cue 时间轴)、动作
 *   标签气泡、弹幕,透明底。这是演出画面的**唯一渲染实现**:OBS browser source
 *   订这里。
 * - `GET /stream`(SSE,单向广播):overlay 使用的演出语义数据面。渲染客户端使用
 *   `/overlay`。
 *   事件仍然前向兼容:只加新事件类型不改旧的,订阅者必须忽略不认识的 type。
 * - `WS /danmaku`(双向):观众弹幕输入通道。客户端发 `{type:'danmaku_in', text, from}`。
 *
 * 单向订阅用 SSE 而不是 WS 是有意的:传输层物理上长不出"订阅者回话"的分支,
 * 协议不会发胖;断线续传(Last-Event-ID)与重连是 EventSource 原生的。
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'cortico/core/types.ts';

/** overlay 页静态资产;请求时现读,改页面刷新即见 */
const OVERLAY_DIR = fileURLToPath(new URL('./overlay/', import.meta.url));
const OVERLAY_FILES: Record<string, { file: string; type: string }> = {
  '/overlay': { file: 'overlay.html', type: 'text/html; charset=utf-8' },
  '/overlay/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/overlay/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

/**
 * 弹幕 WS 只收本机页面开的连接。
 *
 * 这条通道是**入站**的:任何页面连上来都能把文字塞进她的视野。跨站页面开 WS
 * 不受同源策略约束,只能在握手这一关自己拦。放宽到"回环主机的任意端口"是有
 * 意的——overlay 可能被 OBS 这类本机别的端口的页面嵌着。
 * 没有 Origin 的程序化客户端(mock 弹幕机、脚本)照旧放行。
 */
function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // 非浏览器
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
}

/** SSE 保活注释间隔,防止代理关闭空闲连接。 */
const KEEPALIVE_MS = 15_000;
/** Last-Event-ID 续传的环形缓冲条数 */
const REPLAY_CAP = 256;
/**
 * OBS browser source 的 CEF 会把不足约 2KB 的流式响应攒在网络层,
 * EventSource 收不到 snapshot / 后续事件,页面是空的。开流先垫一块注释。
 */
const SSE_PAD = `: ${' '.repeat(2048)}\n\n`;

export interface PerformStreamOptions {
  /** 偏好端口;被占自动顺延(0 = 随机空闲口) */
  preferredPort: number;
  host?: string;
  /** 新订阅者的现状快照(snapshot 事件的数据体) */
  snapshot: () => Record<string, unknown>;
  /** 观众弹幕入站 */
  onDanmakuIn: (text: string, from: string) => void;
}

export class PerformStream {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private boundPort: number | null = null;
  private readonly listenHost: string;
  private readonly subscribers = new Set<ServerResponse>();
  private readonly danmakuSockets = new Set<WebSocket>();
  private seq = 0;
  private readonly replay: Array<{ seq: number; payload: string }> = [];
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: PerformStreamOptions) {
    this.listenHost = opts.host ?? '127.0.0.1';
  }

  get port(): number {
    return this.boundPort ?? this.opts.preferredPort;
  }

  /** 当前 SSE 消费者数(overlay 页/OBS browser source);"在播"的判据来源 */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get streamUrl(): string {
    return `http://${this.listenHost}:${this.port}/stream`;
  }

  get danmakuUrl(): string {
    return `ws://${this.listenHost}:${this.port}/danmaku`;
  }

  /** overlay 页地址;OBS browser source 与测试台 iframe 都指这里 */
  get overlayUrl(): string {
    return `http://${this.listenHost}:${this.port}/overlay`;
  }

  async start(log: Logger): Promise<void> {
    const preferred = this.opts.preferredPort;
    // 顺延上限 5(原为 50):顺延一两个是"上次没退干净",顺延到第 20 个只可能是
    // 有人在反复起实例,继续顺延等于把两个实例都留着跑。
    const maxAttempts = preferred === 0 ? 1 : Math.min(5, 65536 - preferred);
    let server: Server | null = null;
    let lastErr: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = preferred === 0 ? 0 : preferred + i;
      const attempt = createServer((req, res) => this.onRequest(req.url ?? '', res));
      try {
        await new Promise<void>((resolve, reject) => {
          attempt.once('error', reject);
          attempt.listen(candidate, this.listenHost, () => {
            attempt.removeListener('error', reject);
            resolve();
          });
        });
        server = attempt;
        // warn 而不是 info:端口顺延是"另一个实例还在跑"最早也最便宜的旁证。
        if (i > 0) {
          log.warn(
            `演出流端口 ${preferred} 被占用,改用 ${candidate}`
            + '——如果没在跑第二个实例,说明上一次没退干净',
          );
        }
        break;
      } catch (err) {
        lastErr = err;
        attempt.close();
        if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE' || preferred === 0) throw err;
      }
    }
    if (!server) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`演出流端口 ${preferred}–${preferred + maxAttempts - 1} 均不可用`);
    }
    this.http = server;
    this.boundPort = (server.address() as AddressInfo).port;

    this.wss = new WebSocketServer({
      server,
      path: '/danmaku',
      verifyClient: (info: { origin: string }) => {
        if (isLocalOrigin(info.origin)) return true;
        log.warn('拒绝非本机弹幕连接', { origin: info.origin });
        return false;
      },
    });
    this.wss.on('connection', (ws) => {
      this.danmakuSockets.add(ws);
      ws.on('message', (raw) => {
        let msg: { type?: string; text?: string; from?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'danmaku_in' && typeof msg.text === 'string' && msg.text.trim()) {
          this.opts.onDanmakuIn(
            msg.text.trim(),
            typeof msg.from === 'string' && msg.from.trim() ? msg.from.trim() : 'audience',
          );
        }
      });
      const drop = (): void => {
        this.danmakuSockets.delete(ws);
      };
      ws.on('close', drop);
      ws.on('error', () => {
        drop();
        try {
          ws.terminate();
        } catch {
          /* 已断 */
        }
      });
    });

    this.keepalive = setInterval(() => {
      for (const res of this.subscribers) {
        try {
          res.write(':hb\n\n');
        } catch {
          /* 掉线的连接由 close 事件清理 */
        }
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
    log.info(`演出流已启动 ${this.streamUrl}`);
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const res of [...this.subscribers]) {
      try {
        res.end();
      } catch {
        /* 收尾 */
      }
    }
    this.subscribers.clear();
    for (const ws of [...this.danmakuSockets]) {
      try {
        ws.close(1001, 'vtuber down');
      } catch {
        /* 收尾 */
      }
    }
    this.danmakuSockets.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.wss = null;
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
    this.boundPort = null;
  }

  /** 广播一条演出事件;seq 单调,断线订阅者凭 Last-Event-ID 续传近期条目 */
  emit(type: string, data: Record<string, unknown>): void {
    const seq = ++this.seq;
    const payload = `id: ${seq}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    this.replay.push({ seq, payload });
    if (this.replay.length > REPLAY_CAP) this.replay.shift();
    for (const res of this.subscribers) {
      try {
        res.write(payload);
      } catch {
        /* 掉线的连接由 close 事件清理 */
      }
    }
  }

  private onRequest(url: string, res: ServerResponse): void {
    const raw = url.split('?')[0];
    const path = raw === '/' ? '/overlay' : raw.replace(/\/$/, '') || '/';
    const asset = OVERLAY_FILES[path];
    if (asset) {
      try {
        const body = readFileSync(OVERLAY_DIR + asset.file);
        res.writeHead(200, {
          'Content-Type': asset.type,
          'Cache-Control': 'no-cache, no-store',
          'Access-Control-Allow-Origin': '*',
        }).end(body);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('overlay asset unreadable');
      }
      return;
    }
    if (path !== '/stream') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('perform stream: GET /overlay | /stream');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // 订阅是公开单向面,测试台页面跨端口直连
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    res.write(SSE_PAD);
    const lastId = Number(res.req.headers['last-event-id']);
    if (Number.isFinite(lastId)) {
      for (const item of this.replay) if (item.seq > lastId) res.write(item.payload);
    }
    res.write(`data: ${JSON.stringify({ type: 'snapshot', ...this.opts.snapshot() })}\n\n`);
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }
}
