import { describe, it, expect } from 'vitest';
import { PerfDiagnostics } from '../../src/diagnostics.ts';
import { Mixer } from '../../src/mixer.ts';
import type { IRFrame } from '../../src/mixer.ts';
import { EXAMPLE_PACK_DIR, loadPack } from '../../src/pack.ts';

const pack = loadPack(EXAMPLE_PACK_DIR);

/** 空分层原料;各用例只填自己关心的那几层 */
function layers(p: {
  stateRaw?: Record<string, number>;
  duck?: Record<string, number>;
  pulse?: Record<string, number>;
  prosody?: Record<string, number>;
  blink?: Record<string, number>;
  ambient?: Record<string, number>;
  followX?: number;
  followY?: number;
} = {}) {
  return {
    stateRaw: new Map(Object.entries(p.stateRaw ?? {})),
    duck: new Map(Object.entries(p.duck ?? {})),
    pulse: new Map(Object.entries(p.pulse ?? {})),
    prosody: new Map(Object.entries(p.prosody ?? {})),
    blink: new Map(Object.entries(p.blink ?? {})),
    ambient: new Map(Object.entries(p.ambient ?? {})),
    followX: p.followX ?? 0,
    followY: p.followY ?? 0,
  };
}

const frameOf = (vals: Record<string, number>): IRFrame =>
  Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, { value: v, mode: 'add' as const }]));

describe('PerfDiagnostics', () => {
  it('跳变归因:能指出是 ducking 把 State 贡献瞬间掐掉的', () => {
    const d = new PerfDiagnostics();
    // 第一帧:lean_in 挂着 FaceAngleY -9,未被压
    d.frame(1000, frameOf({ FaceAngleY: -9 }), layers({ stateRaw: { FaceAngleY: -9 }, duck: { FaceAngleY: 1 } }));
    // 第二帧:一个 pulse 起跳,同参数 State 贡献被压到 30%
    d.frame(1016, frameOf({ FaceAngleY: -2.7 }), layers({ stateRaw: { FaceAngleY: -9 }, duck: { FaceAngleY: 0.3 } }));

    const rep = d.report() as { params: Record<string, { jumps: Array<Record<string, unknown>> }> };
    const jump = rep.params.FaceAngleY.jumps[0];
    expect(jump).toMatchObject({ from: -9, to: -2.7, dtMs: 16 });
    // 元凶层是 state,而且 duck 系数的变化被记下来了
    expect(jump.dBy).toEqual({ state: 6.3 });
    expect(jump.duck).toEqual([1, 0.3]);
  });

  it('跳变归因:参数从帧里消失(override 释放)也算一次跳变', () => {
    const d = new PerfDiagnostics();
    d.frame(0, { EyeRightX: { value: 0.8, mode: 'set' } }, layers());
    d.frame(16, {}, layers()); // gaze 释放,不再写这个参数
    const rep = d.report() as { params: Record<string, { jumps: Array<{ from: number; to: number; dBy: unknown }> }> };
    const jump = rep.params.EyeRightX.jumps[0];
    expect(jump.from).toBe(0.8);
    expect(jump.to).toBe(0);
    expect(jump.dBy).toEqual({ override: -0.8 });
  });

  it('跳变只留最坏的几次,按幅度排序', () => {
    const d = new PerfDiagnostics();
    let v = 0;
    const steps = [1, 5, 2, 9, 3, 7];
    d.frame(0, frameOf({ FaceAngleX: 0 }), layers({ pulse: { FaceAngleX: 0 } }));
    for (const [i, s] of steps.entries()) {
      v += s;
      d.frame(16 * (i + 1), frameOf({ FaceAngleX: v }), layers({ pulse: { FaceAngleX: v } }));
    }
    const rep = d.report() as { params: Record<string, { jumps: Array<{ delta: number }> }> };
    expect(rep.params.FaceAngleX.jumps.map((j) => j.delta)).toEqual([9, 7, 5, 3]);
  });

  it('每层峰值贡献与动态范围可定位被其他层压低的贡献', () => {
    const d = new PerfDiagnostics();
    // prosody 峰值 3°,但 State 常驻 -9 且被压到 0.3,因此最终动态范围较小。
    for (let i = 0; i <= 10; i++) {
      const pro = i === 5 ? 3 : 0;
      d.frame(16 * i, frameOf({ FaceAngleY: -2.7 + pro }), layers({
        stateRaw: { FaceAngleY: -9 }, duck: { FaceAngleY: 0.3 }, prosody: { FaceAngleY: pro },
      }));
    }
    const rep = d.report() as { params: Record<string, { p2p: number; peakBy: Record<string, number> }> };
    expect(rep.params.FaceAngleY.peakBy.prosody).toBe(3);
    expect(rep.params.FaceAngleY.peakBy.state).toBeCloseTo(2.7, 5);
    expect(rep.params.FaceAngleY.p2p).toBe(3);
  });

  it('注入实况:丢帧率与实机没有的参数都进报表', () => {
    const d = new PerfDiagnostics();
    d.frame(0, frameOf({ FaceAngleY: 1 }), layers());
    d.frame(1000, frameOf({ FaceAngleY: 1 }), layers());
    d.noteInject({ sent: true, rejected: ['BrowAngleL'] });
    d.noteInject({ sent: false });
    d.noteInject({ sent: false });
    const rep = d.report() as { inject: Record<string, unknown> };
    expect(rep.inject).toMatchObject({ sent: 1, droppedBusy: 2, dropPct: 67, rejectedParams: ['BrowAngleL'] });
  });

  it('事件环:带数值时间戳与跨度,可增量拉取', () => {
    const d = new PerfDiagnostics();
    const a = d.trace('拍', '#1 b0 [点头]', { detail: 'gestureDelay=300ms' });
    const b = d.trace('TTS', '合成 2100ms', { durMs: 2100 });
    expect(a.seq).toBe(1);
    expect(typeof a.tsMs).toBe('number');
    expect(b.durMs).toBe(2100);
    expect(d.eventsAfter(1).map((e) => e.seq)).toEqual([2]);
  });

  // level/tally/event/data 是运行日志投影与滚动摘要那一侧的事;事件环照原样收,
  // 带不带这些参数的事件形状必须一模一样。
  it('事件环:level/tally/event/data 不落进事件,不带这些参数的调用形状不变', () => {
    const d = new PerfDiagnostics();
    const plain = d.trace('闸门', '拒收:积压超上限');
    const flagged = d.trace('闸门', '拒收:积压超上限', {
      level: 'warn',
      tally: '拒收',
      event: 'reject',
      data: { backlogMs: 9000, capMs: 3000 },
    });
    expect(plain).toEqual({ seq: 1, tsMs: plain.tsMs, lane: '闸门', label: '拒收:积压超上限' });
    expect({ ...flagged, seq: 1, tsMs: plain.tsMs }).toEqual(plain);
  });

  it('对拍读回:输出/输入两条序列与 capture 共用时间轴,resetWindow 一并清掉', () => {
    const d = new PerfDiagnostics();
    d.frame(0, frameOf({ FaceAngleY: 0 }), layers()); // 定下窗口起点
    d.beginProbe(['ParamAngleY', 'ParamMouthForm'], ['FaceAngleY'], { FaceAngleY: 0 });
    d.probeOutputRow(50, [3.14159, -0.987654]);
    d.probeInputRow(52, [2.5]);
    const rep = d.report() as {
      probe: {
        outputParams: string[];
        inputParams: string[];
        inputDefaults: Record<string, number>;
        outputRows: number[][];
        inputRows: number[][];
      };
    };
    expect(rep.probe.outputParams).toEqual(['ParamAngleY', 'ParamMouthForm']);
    expect(rep.probe.inputDefaults).toEqual({ FaceAngleY: 0 });
    expect(rep.probe.outputRows).toEqual([[50, 3.1416, -0.9877]]);
    expect(rep.probe.inputRows).toEqual([[52, 2.5]]);
    d.resetWindow();
    expect((d.report() as { probe: unknown }).probe).toBeNull();
  });

  it('录制:按时长攒逐帧原始值,到点自动停', () => {
    const d = new PerfDiagnostics();
    d.frame(0, frameOf({ FaceAngleY: 0 }), layers());
    d.startCapture(100, ['FaceAngleY']);
    for (let t = 16; t <= 300; t += 16) d.frame(t, frameOf({ FaceAngleY: t / 100 }), layers());
    const rep = d.report() as { capture: { params: string[]; rows: number[][] } };
    expect(rep.capture.params).toEqual(['FaceAngleY']);
    // 只录到 100ms 那一段,之后停了
    expect(rep.capture.rows.length).toBeGreaterThan(2);
    expect(rep.capture.rows.length).toBeLessThan(10);
    expect(rep.capture.rows[0][0]).toBe(16);
  });
});

describe('Mixer 接上诊断', () => {
  it('真实混合链上的 ducking 变化会被记下来,且不再是一帧到底的台阶', () => {
    const diag = new PerfDiagnostics();
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.attachDiagnostics(diag);
    // 先稳定保持 FaceAngleY = -9 的前倾姿态。
    m.stateCue({ channel: 'pose', clipId: 'lean_in', startTs: 0, intensity: 1, fadeInMs: 1 });
    for (let t = 0; t <= 600; t += 16) m.frame(t);
    // 点头写入同一参数并触发 State ducking。
    m.gestureCue({ clipId: 'nod', startTs: 616, intensity: 1 });
    for (let t = 616; t <= 1200; t += 16) m.frame(t);

    const rep = diag.report(m.snapshot()) as {
      params: Record<string, { jumps: Array<{ dBy: Record<string, number>; duck?: [number, number] }> }>;
      state: { pose: string | null };
    };
    const ducked = rep.params.FaceAngleY.jumps.filter((j) => j.duck !== undefined);
    expect(ducked.length).toBeGreaterThan(0);
    // 每次记录 duck 的前后值，且单帧变化保持在斜坡阈值内。
    for (const j of ducked) {
      const [before, after] = j.duck!;
      expect(Math.abs(before - after)).toBeLessThan(0.2);
    }
    // 快照包含当前分层状态。
    expect(rep.state.pose).toBe('lean_in');
  });
});
