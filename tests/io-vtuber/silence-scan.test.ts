import { describe, expect, it } from 'vitest';

import { SILENCE_HOP_MS, SILENCE_MIN_MS, SilenceScanner, scanSilence } from '../../src/io-vtuber/silence-scan.ts';

const SR = 16000;
/** 一个 hop 的样本数(20ms @16k = 320);所有片段都按整 hop 造,免得边界 hop 混进半段语音 */
const HOP = (SR * SILENCE_HOP_MS) / 1000;

/** ms 毫秒的正弦「语音」,振幅 amp(RMS ≈ amp/√2) */
function speech(ms: number, amp = 0.3): Float32Array {
  const n = (SR * ms) / 1000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}

/** ms 毫秒的静默;amp>0 时是底噪(±amp 方波,RMS = amp) */
function silence(ms: number, amp = 0): Float32Array {
  const n = (SR * ms) / 1000;
  const out = new Float32Array(n);
  if (amp > 0) for (let i = 0; i < n; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

function join(...parts: Float32Array[]): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('超大静默段检测', () => {
  /*
   * 正常停顿夹具包含句末 570ms、句中 200ms 和语音标签 1500ms，最长停顿仍低于 4000ms 检测门槛。
   */
  it('正常停顿不触发:句末 570 / 句中 200 / 语音标签 1500 都在门下', () => {
    const wav = join(
      speech(1000),
      silence(200),
      speech(1000),
      silence(580),
      speech(1000),
      silence(1500),
      speech(1000),
    );
    const r = scanSilence(wav, SR);
    expect(r.triggered).toBe(false);
    expect(r.longestMs).toBe(1500);
    expect(r.startMs).toBe(3780);
  });

  it('长静默触发:报出起点与时长', () => {
    const r = scanSilence(join(speech(1000), silence(6000), speech(500)), SR);
    expect(r.triggered).toBe(true);
    expect(r.startMs).toBe(1000);
    expect(r.longestMs).toBe(6000);
    expect(r.endMs).toBe(7000);
  });

  it('开头结尾的静默照样量出来,但够不着门', () => {
    const r = scanSilence(join(silence(300), speech(2000), silence(800)), SR);
    expect(r.triggered).toBe(false);
    // 结尾那段更长,报的是它
    expect(r.startMs).toBe(2300);
    expect(r.longestMs).toBe(800);
  });

  it('底噪不算出声:-60dB 的噪声底垫满 5 秒仍判静默', () => {
    // amp 0.001 ≈ -60dBFS,低于绝对下限 0.003
    const r = scanSilence(join(speech(1000), silence(5000, 0.001), speech(500)), SR);
    expect(r.triggered).toBe(true);
    expect(r.longestMs).toBe(5000);
  });

  /*
   * 反向的一头:整体小音量的片不能被当成整段静默。这一片从头到尾在出声,
   * 只是振幅 0.02(RMS ≈ 0.014),相对门算出来只有 0.0004,被绝对下限 0.003 顶住,
   * 而 0.014 在门之上——一段都检不出。
   */
  it('小音量的片不被判成静默:绝对下限顶住相对门的塌陷', () => {
    const r = scanSilence(speech(6000, 0.02), SR);
    expect(r.triggered).toBe(false);
    expect(r.longestMs).toBe(0);
    expect(r.thresholdRms).toBeCloseTo(0.003, 6);
  });

  it('整片都是静默:p95 自己也趋近 0,靠绝对下限仍检得出', () => {
    const r = scanSilence(silence(6000), SR);
    expect(r.triggered).toBe(true);
    expect(r.startMs).toBe(0);
    expect(r.longestMs).toBe(6000);
  });

  it('中间夹一声杂音就算两段:严格连续,宁可漏不误伤', () => {
    const r = scanSilence(join(silence(3000), speech(SILENCE_HOP_MS * 2), silence(3000)), SR);
    expect(r.triggered).toBe(false);
    expect(r.longestMs).toBe(3000);
  });

  it('逐块喂与一次喂同一份样本,得同一个报告', () => {
    const wav = join(speech(1200), silence(5000), speech(800));
    const inc = new SilenceScanner(SR);
    // 故意用不对齐 hop 的块长(HOP 的 2.5 倍),测残留样本的跨块累加
    const step = Math.round(HOP * 2.5);
    for (let at = 0; at < wav.length; at += step) inc.append(wav.subarray(at, Math.min(at + step, wav.length)));
    inc.finish();
    expect(inc.report()).toEqual(scanSilence(wav, SR));
  });

  /*
   * 流式的用法:check() 每攒够 500ms 才整片重算一次,只在签名成立时返回。
   * 静默从 1000ms 起,到 5000ms 攒够 4000ms —— 那一刻起的半秒内(而不是收流之后)
   * 就该认出来。节流带来的这点延迟是设计的一部分:掐的是一段本就要丢的死气。
   */
  it('流式检查:静默攒够门的半秒内返回报告,之前一直返回 null', () => {
    const inc = new SilenceScanner(SR);
    inc.append(speech(1000));
    let firstHitMs: number | null = null;
    for (let t = 1000; t < 8000; t += 100) {
      inc.append(silence(100));
      if (inc.check() && firstHitMs === null) firstHitMs = t + 100;
    }
    expect(firstHitMs).toBeGreaterThanOrEqual(1000 + SILENCE_MIN_MS);
    expect(firstHitMs).toBeLessThanOrEqual(1000 + SILENCE_MIN_MS + 500);
    const r = inc.report();
    expect(r.triggered).toBe(true);
    expect(r.startMs).toBe(1000);
  });

  it('没有样本时报零,不炸', () => {
    const r = new SilenceScanner(SR).report();
    expect(r).toMatchObject({ longestMs: 0, triggered: false, refRms: 0 });
  });
});
