/**
 * VTuber 面板经 provider 通道的交互形态:GET/POST 透传、GET 带 args、$binary 回 wav
 * 字节(GET 与 POST 两条路都要)、$file 按声明的大小与 sha256 校验后流式发送、
 * 时间点标注那屏的四条数据面、没这个 provider 时 404。
 * 面板语义在模组侧,这里的 fake provider 按 VtuberModuleProxy.invokePanel 的
 * wire 形状回话。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from 'cortico/web/server.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { FakeStore } from '../helpers/fake-store.ts';

let app: WebApp;
let bare: WebApp;
let port: number;
let barePort: number;
let dir: string;
let phase = 'stopped';
let vtsConnected = false;
let mediaMutationCalls = 0;
const FILE_BYTES = Buffer.from('RIFF-streamed-file');
const FILE_SHA256 = createHash('sha256').update(FILE_BYTES).digest('hex');

const GET_METHODS: Record<string, readonly string[]> = {
  mount: ['state', 'vtsState', 'ttsState'],
  model: ['state'],
  overlay: ['state'],
  clips: ['state'],
  tts: ['state', 'voiceWav'],
  align: ['state', 'units'],
  media: ['list', 'file'],
  log: ['entries'],
  diag: ['state', 'report', 'presets'],
};

const call = async (
  p: number,
  path: string,
  args?: unknown[],
): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${p}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: args ?? [] }),
  });
  return { status: r.status, body: (await r.json()) as any };
};

/** fake 模组面板面:形状对齐 VtuberModuleProxy.invokePanel */
const panels: Record<string, Record<string, (...args: any[]) => unknown>> = {
  tts: {
    state: () => ({ phase, url: 'http://127.0.0.1:8010', detail: null, pid: null, reachable: phase === 'running' }),
    start: () => { phase = 'running'; return { phase, url: 'http://127.0.0.1:8010', detail: null, pid: 42 }; },
    stop: () => { phase = 'stopped'; return { phase, url: 'http://127.0.0.1:8010', detail: null, pid: null }; },
    setProfile: (patch: Record<string, unknown>) => ({ refAudio: null, seed: 42, ...patch }),
    saveVoice: (name: string) => ({
      file: name.replace(/\.[^.]{1,5}$/, '') + '.wav',
      path: 'C:\\voices\\' + name,
      converted: /\.wav$/i.test(name) ? null : 'MP3',
    }),
    voiceWav: (file: string) => {
      if (file !== 'mei.wav') throw new Error(`声线不存在: ${file}`);
      return { $binary: { mime: 'audio/wav', base64: Buffer.from('RIFFfake').toString('base64') } };
    },
    test: (text?: string, profile?: Record<string, unknown>) => ({
      ok: true,
      message: `合成 OK:900ms 音频${text ? ',文本=' + text : ''}${profile ? ';试听档案=' + JSON.stringify(profile) : ''}`,
      wav: 'UklGRg==',
    }),
  },
  // 时间点标注:一段音频 + 逐字稿 → 逐单元起止时间。units 与 synth 的回执形状
  // 是波形那屏的全部输入(单元预览 / 拿 TTS 现合一段来标)
  align: {
    state: () => ({ enabled: false, available: true, lastOk: null }),
    units: (text: string) => ({ units: [...text] }),
    align: (audioBase64: string, text: string) => ({
      units: [...text].map((ch, i) => ({ text: ch, start: i * 0.2, end: (i + 1) * 0.2 })),
      duration: text.length * 0.2,
      verdict: { ok: true, reasons: [], coverage: 1 },
      elapsedMs: 12,
      // 音频确实过来了(面板把整段 base64 原样交回)
      bytes: Buffer.from(audioBase64, 'base64').length,
    }),
    synth: (text: string) => ({ wav: Buffer.from('RIFF' + text).toString('base64'), durationMs: 900 }),
  },
  diag: {
    presets: () => ({ presets: [{ label: '输棋复盘', script: '【叹气】哎。' }] }),
    perform: (script: string) => ({ ok: true, message: `已排入演出(${script.length} 字)` }),
  },
  log: {
    entries: (after = 0) => ({
      entries: [{ seq: 1, ts: '12:00:00', area: '轮', msg: '#1 开新轮' }].filter((e) => e.seq > after),
    }),
  },
  // 「挂载」一屏管形象与声音两条链路,所以方法名带链路前缀(state / test 两边都有,会撞)
  mount: {
    vtsState: () => ({ connected: vtsConnected, url: 'ws://127.0.0.1:8001', tokenSet: true, model: null }),
    vtsConnect: () => { vtsConnected = true; return { connected: true, cleared: [] }; },
    vtsDisconnect: () => { vtsConnected = false; return { connected: false }; },
    vtsTest: () => ({ ok: true, message: vtsConnected ? '已排入测试动作' : '[失败] VTS 未连接' }),
  },
  // 大文件走 $file:面板只回路径与校验值,字节由 web 服务端核对后流式发送
  media: {
    list: () => ({ files: ['clip.wav'] }),
    file: () => ({
      $file: {
        mime: 'audio/wav',
        path: join(dir, 'clip.wav'),
        bytes: FILE_BYTES.byteLength,
        sha256: FILE_SHA256,
      },
    }),
    state: () => { mediaMutationCalls++; return { sessionId: 'session-a' }; },
    rebuild: () => { mediaMutationCalls++; return { message: 'started' }; },
    stop: () => { mediaMutationCalls++; return { message: 'stopped' }; },
  },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-vtts-'));
  writeFileSync(join(dir, 'clip.wav'), FILE_BYTES);
  const common = {
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({}),
    log: nullLogger(),
  };
  app = new WebApp({
    ...common,
    consolePageSources: () => [{
      id: 'world:vtuber',
      contribute: () => ({
        id: 'world:vtuber',
        kind: 'world' as const,
        label: 'VTuber',
        availability: 'active' as const,
        panels: Object.keys(panels).map((id) => ({
          id,
          title: id,
          getMethods: GET_METHODS[id] ?? [],
        })),
        invoke: async (panel: string, method: string, args: unknown[]) => {
          const fn = panels[panel]?.[method];
          if (!fn) throw new Error(`未知面板方法 ${panel}.${method}`);
          return fn(...(args as any[]));
        },
      }),
    }],
  });
  port = await app.start(0);
  // 一个 provider 都没挂的裸框架:同一批路径应当解析不出 provider。
  bare = new WebApp({ ...common, store: new FakeStore() });
  barePort = await bare.start(0);
});

afterAll(async () => {
  await app.stop();
  await bare.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('面板 $file 回执与 GET 白名单的 HTTP 边界', () => {
  it('GET/HEAD 只允许白名单方法，会话与副作用方法返回 405 且不调用 provider', async () => {
    mediaMutationCalls = 0;
    const root = `http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/media`;
    expect((await fetch(`${root}/list`)).status).toBe(200);
    const file = await fetch(`${root}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('audio/wav');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('RIFF-streamed-file');
    const head = await fetch(`${root}/file`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(FILE_BYTES.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    for (const method of ['state', 'rebuild', 'stop']) {
      expect((await fetch(`${root}/${method}`)).status).toBe(405);
      expect((await fetch(`${root}/${method}`, { method: 'HEAD' })).status).toBe(405);
    }
    expect(mediaMutationCalls).toBe(0);
    expect((await call(port, '/api/console/providers/worlds%3Avtuber/panels/media/state')).status).toBe(200);
    expect(mediaMutationCalls).toBe(1);
  });

  it('文件内容与声明 hash 不一致时不发送文件字节', async () => {
    const path = join(dir, 'clip.wav');
    writeFileSync(path, Buffer.from('RIFF-tampered-file'));
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/media/file`,
      );
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.text()).not.toContain('RIFF-tampered-file');
    } finally {
      writeFileSync(path, FILE_BYTES);
    }
  });
});

describe('vtuber tts 面板经 provider 通道', () => {
  it('state/start/stop/test 透传', async () => {
    const st = (await (await fetch(`http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/tts/state`)).json()) as any;
    expect(st).toMatchObject({ phase: 'stopped', reachable: false });

    const started = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/start');
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ phase: 'running', pid: 42 });

    const test = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/test');
    expect(test.body).toMatchObject({ ok: true, message: '合成 OK:900ms 音频', wav: 'UklGRg==' });

    const stopped = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/stop');
    expect(stopped.body).toMatchObject({ phase: 'stopped' });
  });

  it('profile 与带文本/试听档案的 test 透传', async () => {
    const r = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/setProfile', [{ refAudio: 'mei.wav', temperature: 0.5 }]);
    expect(r.body).toMatchObject({ refAudio: 'mei.wav', temperature: 0.5, seed: 42 });

    const t = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/test', ['来一句']);
    expect(t.body.message).toContain('文本=来一句');

    // 面板上未保存的档案随试听请求一起过去(校验归模组,通道只透传)
    const audition = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/test', ['听听新声线', { refAudio: '新人.wav', seed: 9 }]);
    expect(audition.body.message).toContain('"refAudio":"新人.wav"');
  });

  it('声线上传;试听经 GET args 回 wav 字节;不存在 500', async () => {
    const up = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/saveVoice', ['mei.wav', 'UklGRg==']);
    expect(up.body).toMatchObject({ file: 'mei.wav', converted: null });

    const mp3 = await call(port, '/api/console/providers/worlds%3Avtuber/panels/tts/saveVoice', ['mei.mp3', 'SUQzBA==']);
    expect(mp3.body).toMatchObject({ file: 'mei.wav', converted: 'MP3' });

    // <audio src> 只能带 URL:GET + args 查询串
    const wav = await fetch(
      `http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/tts/voiceWav?args=${encodeURIComponent('["mei.wav"]')}`,
    );
    expect(wav.status).toBe(200);
    expect(wav.headers.get('content-type')).toContain('audio/wav');
    expect(Buffer.from(await wav.arrayBuffer()).toString('utf8')).toBe('RIFFfake');

    // 面板走的是 `ctx.invokeBinary`(POST + 随 signal 取消),同一份字节也得回来:
    // 它不再自己拼 URL 造 `new Audio(...)`,而是拿 Blob 喂给一个登记过的 <audio>
    const posted = await fetch(`http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/tts/voiceWav`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['mei.wav'] }),
    });
    expect(posted.status).toBe(200);
    expect(posted.headers.get('content-type')).toContain('audio/wav');
    expect(Buffer.from(await posted.arrayBuffer()).toString('utf8')).toBe('RIFFfake');

    const miss = await fetch(
      `http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/tts/voiceWav?args=${encodeURIComponent('["none.wav"]')}`,
    );
    expect(miss.status).toBe(500);
  });

  it('没有这个 provider → 404', async () => {
    expect((await fetch(`http://127.0.0.1:${barePort}/api/console/providers/worlds%3Avtuber/panels/tts/state`)).status).toBe(404);
    expect((await call(barePort, '/api/console/providers/worlds%3Avtuber/panels/tts/start')).status).toBe(404);
  });
});

describe('vtuber align 面板经 provider 通道', () => {
  it('状态 / 单元预览 / 现合一段 / 标注 四条透传', async () => {
    const st = (await (await fetch(`http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/align/state`)).json()) as any;
    expect(st).toMatchObject({ available: true, enabled: false, lastOk: null });

    // 单元预览:面板边打字边问(合流拍每 300ms 一次),回的是要对齐的单元表
    const units = await call(port, '/api/console/providers/worlds%3Avtuber/panels/align/units', ['你好呀']);
    expect(units.body.units).toEqual(['你', '好', '呀']);

    // 「用 TTS 合成这句」:wav 按 base64 回,面板解码后画波形
    const synth = await call(port, '/api/console/providers/worlds%3Avtuber/panels/align/synth', ['你好']);
    expect(Buffer.from(synth.body.wav, 'base64').toString('utf8')).toBe('RIFF你好');
    expect(synth.body.durationMs).toBe(900);

    // 标注:音频整段 base64 交回去,回执带单元、时长、过门判据与耗时
    const run = await call(port, '/api/console/providers/worlds%3Avtuber/panels/align/align', [synth.body.wav, '你好']);
    expect(run.body.units).toHaveLength(2);
    expect(run.body.units[0]).toEqual({ text: '你', start: 0, end: 0.2 });
    expect(run.body).toMatchObject({ duration: 0.4, elapsedMs: 12 });
    expect(run.body.verdict.ok).toBe(true);
    expect(run.body.bytes).toBe(Buffer.from(synth.body.wav, 'base64').length);
  });

  it('没有这个 provider → 404', async () => {
    expect((await fetch(`http://127.0.0.1:${barePort}/api/console/providers/worlds%3Avtuber/panels/align/state`)).status).toBe(404);
  });
});

describe('diag / log / mount 面板', () => {
  it('演出测试与演出日志透传', async () => {
    const presets = (await (await fetch(`http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/diag/presets`)).json()) as any;
    expect(presets.presets[0].label).toBe('输棋复盘');
    const done = await call(port, '/api/console/providers/worlds%3Avtuber/panels/diag/perform', ['【点头】好。']);
    expect(done.body.message).toContain('已排入演出');

    const log = (await (
      await fetch(`http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/log/entries?args=${encodeURIComponent('[0]')}`)
    ).json()) as any;
    expect(log.entries).toHaveLength(1);
    const empty = (await (
      await fetch(`http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/log/entries?args=${encodeURIComponent('[1]')}`)
    ).json()) as any;
    expect(empty.entries).toEqual([]);
  });

  it('VTS 连接控制透传', async () => {
    const st = (await (await fetch(`http://127.0.0.1:${port}/api/console/providers/worlds%3Avtuber/panels/mount/vtsState`)).json()) as any;
    expect(st.connected).toBe(false);
    const t0 = await call(port, '/api/console/providers/worlds%3Avtuber/panels/mount/vtsTest');
    expect(t0.body.message).toContain('未连接');
    const on = await call(port, '/api/console/providers/worlds%3Avtuber/panels/mount/vtsConnect');
    expect(on.body).toMatchObject({ connected: true });
    const t1 = await call(port, '/api/console/providers/worlds%3Avtuber/panels/mount/vtsTest');
    expect(t1.body).toMatchObject({ ok: true, message: '已排入测试动作' });
    const off = await call(port, '/api/console/providers/worlds%3Avtuber/panels/mount/vtsDisconnect');
    expect(off.body).toMatchObject({ connected: false });
  });
});
