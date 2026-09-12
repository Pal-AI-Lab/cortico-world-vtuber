import { describe, it, expect } from 'vitest';
import { decodeWav, extractEnvelope, pcm16ToWav, StreamingEnvelope, TtsClient } from '../../src/tts.ts';
import { makeWav } from './helpers.ts';

describe('decodeWav / extractEnvelope', () => {
  it('解出采样与时长;响段包络高于静段', () => {
    const sr = 16000;
    // 前 200ms 静音,后 200ms 全幅方波
    const silent = new Array(sr / 5).fill(0);
    const loud = Array.from({ length: sr / 5 }, (_, i) => (i % 2 === 0 ? 0.9 : -0.9));
    const wav = makeWav([...silent, ...loud], sr);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(sr);
    expect(decoded.durationMs).toBeCloseTo(400, 0);
    const env = extractEnvelope(decoded);
    expect(env.at(100)).toBeLessThan(0.1);
    expect(env.at(350)).toBeGreaterThan(0.5);
    expect(env.at(9999)).toBe(0);
  });

  it('拒绝非 wav 数据', () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow();
  });
});

describe('TtsClient', () => {
  it('非 2xx 抛错并带回应片段', async () => {
    const fetchImpl = (async () => new Response('cuda OOM', { status: 500 })) as typeof fetch;
    const client = new TtsClient({ url: 'http://fake', fetchImpl });
    await expect(client.synth('x')).rejects.toThrow(/500.*cuda OOM/s);
  });

  it('声线档案进请求体:参考音频/转写/生成参数;无档案则不带这些字段', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const wav = makeWav(new Array(1600).fill(0.3));
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(wav.slice().buffer, { status: 200 });
    }) as typeof fetch;

    const withProfile = new TtsClient({
      url: 'http://fake',
      fetchImpl,
      profile: () => ({
        referenceAudioB64: 'QUJD',
        refText: '参考转写',
        seed: 7,
        cfgValue: 1.5,
        inferenceTimesteps: 16,
        maxSteps: 300,
        temperature: 0.8,
      }),
    });
    await withProfile.synth('你好');
    expect(bodies[0]).toMatchObject({
      reference_audio: 'QUJD',
      prompt_text: '参考转写',
      seed: 7,
      cfg_value: 1.5,
      inference_timesteps: 16,
      max_steps: 300,
      temperature: 0.8,
    });

    // 只给音频不给转写 = 纯克隆:不带 prompt_text
    const cloneOnly = new TtsClient({
      url: 'http://fake',
      fetchImpl,
      profile: () => ({ referenceAudioB64: 'QUJD' }),
    });
    await cloneOnly.synth('你好');
    expect(bodies[1].reference_audio).toBe('QUJD');
    expect(bodies[1]).not.toHaveProperty('prompt_text');

    const bare = new TtsClient({ url: 'http://fake', fetchImpl });
    await bare.synth('你好');
    for (const key of ['reference_audio', 'prompt_text', 'seed', 'cfg_value', 'temperature']) {
      expect(bodies[2]).not.toHaveProperty(key);
    }
  });
});

describe('StreamingEnvelope', () => {
  it('分块喂入收敛到与整段 extractEnvelope 一致', () => {
    const sr = 16000;
    const samples = new Float32Array(sr); // 1s
    for (let i = 0; i < samples.length; i++) {
      // 前半弱后半强的调幅噪声形状
      samples[i] = Math.sin(i / 7) * (i < samples.length / 2 ? 0.2 : 0.8);
    }
    const whole = extractEnvelope({ samples, sampleRate: sr, durationMs: 1000 });
    const inc = new StreamingEnvelope(sr);
    for (let at = 0; at < samples.length; at += 333) {
      inc.append(samples.subarray(at, Math.min(at + 333, samples.length)));
    }
    inc.finish();
    for (const ms of [40, 250, 500, 760, 980]) {
      expect(inc.at(ms)).toBeCloseTo(whole.at(ms), 5);
    }
    expect(inc.coveredMs()).toBeGreaterThanOrEqual(1000);
  });
});

describe('TtsClient.synthStream', () => {
  /** 44 字节流式头(长度占位) + 若干 PCM16 分块拼一个 chunked body */
  function streamResponse(sampleRate: number, chunks: Uint8Array[]): Response {
    const header = pcm16ToWav([], sampleRate).subarray(0, 44);
    const parts = [header, ...chunks];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  it('边收边给 PCM 分块,收流后重组完整 wav 与时长', async () => {
    const sr = 16000;
    // 两块共 3200 样本 = 200ms;第二块与第一块之间制造奇数字节切口
    const pcm = new Uint8Array(3200 * 2);
    for (let i = 0; i < 3200; i++) {
      const v = Math.round(Math.sin(i / 5) * 12000);
      pcm[2 * i] = v & 0xff;
      pcm[2 * i + 1] = (v >> 8) & 0xff;
    }
    const cut = 1601; // 奇数:跨块半样本
    const fetchImpl = (async () =>
      streamResponse(sr, [pcm.subarray(0, cut), pcm.subarray(cut)])) as typeof fetch;
    const client = new TtsClient({ url: 'http://fake', fetchImpl });

    const got: Uint8Array[] = [];
    let sampleRateSeen = 0;
    const piece = await client.synthStream('测试', {
      begin: ({ sampleRate }) => {
        sampleRateSeen = sampleRate;
      },
      pcm: (chunk) => got.push(chunk),
    });
    expect(sampleRateSeen).toBe(sr);
    expect(piece.durationMs).toBeCloseTo(200, 0);
    const merged = Buffer.concat(got);
    expect(merged.equals(Buffer.from(pcm))).toBe(true);
    const decoded = decodeWav(piece.wav);
    expect(decoded.sampleRate).toBe(sr);
    expect(decoded.durationMs).toBeCloseTo(200, 0);
  });

  it('超出时长预算中途掐流:已收部分照常交回并打 truncated 标', async () => {
    const sr = 16000;
    // 10 块 × 100ms = 1000ms;预算 350ms → 第 4 块(400ms)越线后停收
    const chunk = new Uint8Array(sr * 0.1 * 2); // 100ms 静音 PCM16
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pcm16ToWav([], sr).subarray(0, 44));
        for (let i = 0; i < 10; i++) controller.enqueue(chunk.slice());
        controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const client = new TtsClient({ url: 'http://fake', fetchImpl });
    const got: Uint8Array[] = [];
    const piece = await client.synthStream('测试', { pcm: (c) => got.push(c) }, { maxDurationMs: 350 });
    expect(piece.truncated).toBe(true);
    expect(piece.durationMs).toBeCloseTo(400, 0);
    expect(got.length).toBe(4);
    expect(cancelled).toBe(true);
  });

  /*
   * 夹具在正常话音后拼接长静默段，不设置 maxDurationMs；验证按静默本身检出并截流。
   */
  it('超大静默段中途掐流:掐在检出点,报告带起点与时长', async () => {
    const sr = 16000;
    const speech = new Uint8Array(sr * 0.1 * 2); // 100ms 正弦
    {
      const view = new DataView(speech.buffer);
      for (let i = 0; i < sr * 0.1; i++) {
        view.setInt16(2 * i, Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 220 * i) / sr)), true);
      }
    }
    const quiet = new Uint8Array(sr * 0.1 * 2); // 100ms 静默
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pcm16ToWav([], sr).subarray(0, 44));
        for (let i = 0; i < 10; i++) controller.enqueue(speech.slice()); // 1000ms 语音
        for (let i = 0; i < 200; i++) controller.enqueue(quiet.slice()); // 20 秒死气
        controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const client = new TtsClient({ url: 'http://fake', fetchImpl });
    const piece = await client.synthStream('测试', { pcm: () => {} });
    expect(piece.truncated).toBe(true);
    expect(piece.silence?.triggered).toBe(true);
    expect(piece.silence?.startMs).toBe(1000);
    expect(cancelled).toBe(true);
    // 静默攒够 4000ms 的半秒内掐;20 秒死气一秒都没白烧
    expect(piece.durationMs).toBeGreaterThanOrEqual(5000);
    expect(piece.durationMs).toBeLessThanOrEqual(5500);
  });

  it('一直在出声的片不掐:静默报告照带,triggered 为假', async () => {
    const sr = 16000;
    const speech = new Uint8Array(sr * 0.1 * 2);
    const view = new DataView(speech.buffer);
    for (let i = 0; i < sr * 0.1; i++) {
      view.setInt16(2 * i, Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 220 * i) / sr)), true);
    }
    const fetchImpl = (async () =>
      streamResponse(sr, Array.from({ length: 30 }, () => speech.slice()))) as typeof fetch;
    const client = new TtsClient({ url: 'http://fake', fetchImpl });
    const piece = await client.synthStream('测试', { pcm: () => {} });
    expect(piece.truncated).toBeUndefined();
    expect(piece.silence?.triggered).toBe(false);
    expect(piece.silence?.longestMs).toBe(0);
    expect(piece.durationMs).toBeCloseTo(3000, 0);
  });

  it('空流报错;abort 信号传给 fetch', async () => {
    const fetchImpl = (async () => streamResponse(16000, [])) as typeof fetch;
    const client = new TtsClient({ url: 'http://fake', fetchImpl });
    await expect(client.synthStream('x', { pcm: () => {} })).rejects.toThrow(/没有产出音频/);

    let seenSignal: AbortSignal | undefined;
    const fetchImpl2 = (async (_u: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return streamResponse(16000, [new Uint8Array(64)]);
    }) as typeof fetch;
    const client2 = new TtsClient({ url: 'http://fake', fetchImpl: fetchImpl2 });
    const ac = new AbortController();
    await client2.synthStream('x', { pcm: () => {} }, { signal: ac.signal });
    expect(seenSignal).toBeDefined();
  });
});
