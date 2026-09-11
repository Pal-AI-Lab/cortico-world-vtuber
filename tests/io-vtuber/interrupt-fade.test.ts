import { describe, it, expect } from 'vitest';
import { planCut, pcm16ToFloat } from '../../src/io-vtuber/interrupt-fade.ts';

const SR = 16000;

function sine(ms: number, hz: number, amp: number): Float32Array {
  const n = Math.round((ms / 1000) * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

/** 确定性伪白噪(LCG):擦音的噪声段 */
function noise(ms: number, amp: number, seed = 1): Float32Array {
  const n = Math.round((ms / 1000) * SR);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = amp * ((s / 0xffffffff) * 2 - 1);
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
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

function rms(a: Float32Array, from: number, to: number): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += a[i] * a[i];
  return Math.sqrt(acc / Math.max(1, to - from));
}

describe('打断切断规划', () => {
  it('切在元音(周期浊音)上:20-70ms 衰减,尾巴收口归零', () => {
    const plan = planCut(sine(600, 150, 0.4), SR, 300);
    expect(plan).not.toBeNull();
    expect(plan!.cls).toBe('periodic');
    expect(plan!.fadeMs).toBeGreaterThanOrEqual(20);
    expect(plan!.fadeMs).toBeLessThanOrEqual(70);
    const tail = pcm16ToFloat([plan!.tailPcm], plan!.tailPcm.length);
    expect(tail.length).toBe(Math.round((plan!.fadeMs / 1000) * SR));
    // 头段响、末段衰竭,最后一个样本精确归零(防点击台阶)
    const q = Math.floor(tail.length / 4);
    expect(rms(tail, tail.length - q, tail.length)).toBeLessThan(rms(tail, 0, q) * 0.25);
    expect(tail[tail.length - 1]).toBe(0);
  });

  it('低频浊音衰减更长(按基音周期折算),仍钳在 70ms 内', () => {
    const low = planCut(sine(600, 80, 0.4), SR, 300);
    const high = planCut(sine(600, 300, 0.4), SR, 300);
    expect(low!.cls).toBe('periodic');
    expect(high!.cls).toBe('periodic');
    expect(low!.fadeMs).toBeGreaterThan(high!.fadeMs);
    expect(low!.fadeMs).toBeLessThanOrEqual(70);
  });

  it('切在擦音(非周期噪声)上:快速收住', () => {
    const plan = planCut(noise(600, 0.3), SR, 300);
    expect(plan!.cls).toBe('noise');
    expect(plan!.fadeMs).toBeGreaterThanOrEqual(10);
    expect(plan!.fadeMs).toBeLessThanOrEqual(40);
  });

  it('切在塞音闭塞段(响段后的静音)上:只做防点击,不放释放爆破', () => {
    // 元音 500ms + 闭塞 100ms;切在闭塞里。真实塞音的爆破在闭塞之后——
    // 衰减段仅覆盖闭塞末尾数毫秒,不包含后续爆破样本。
    const samples = concat(sine(500, 150, 0.4), new Float32Array(Math.round(0.1 * SR)));
    const plan = planCut(samples, SR, 550);
    expect(plan!.cls).toBe('silence');
    expect(plan!.fadeMs).toBeLessThanOrEqual(10);
  });

  it('整体小音量的浊音不误判成静音(参考电平是相对量)', () => {
    const plan = planCut(sine(600, 150, 0.02), SR, 300);
    expect(plan!.cls).toBe('periodic');
  });

  it('切点越过已合成末尾返回 null(调用方回落固定淡出)', () => {
    const samples = sine(200, 150, 0.4);
    expect(planCut(samples, SR, 250)).toBeNull();
    expect(planCut(samples, SR, -10)).toBeNull();
    expect(planCut(new Float32Array(0), SR, 0)).toBeNull();
  });

  it('片尾不足一条尾巴:有多少样本用多少', () => {
    const plan = planCut(sine(600, 150, 0.4), SR, 595);
    expect(plan!.cls).toBe('periodic');
    // 衰减段受剩余样本限制缩短到约 5ms。
    expect(plan!.tailPcm.length / 2).toBe(Math.round(0.005 * SR));
  });

  it('pcm16ToFloat:跨分块拼接还原', () => {
    const bytes = new Uint8Array(6);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 0, true);
    view.setInt16(2, 16384, true);
    view.setInt16(4, -16384, true);
    const floats = pcm16ToFloat([bytes.subarray(0, 2), bytes.subarray(2)], bytes.length);
    expect(floats[0]).toBeCloseTo(0, 5);
    expect(floats[1]).toBeCloseTo(0.5, 3);
    expect(floats[2]).toBeCloseTo(-0.5, 3);
  });
});
