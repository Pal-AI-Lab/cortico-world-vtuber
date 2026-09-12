import { describe, it, expect } from 'vitest';
import { Mixer } from '../../src/mixer.ts';
import { EXAMPLE_PACK_DIR, loadPack } from '../../src/pack.ts';

const pack = loadPack(EXAMPLE_PACK_DIR);

describe('Mixer', () => {
  it('sustain crossfade:fade 中途值介于 0 与保持位之间,fade 后到位', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.stateCue({ channel: 'emotion', clipId: 'angry', startTs: 1000, intensity: 1, fadeInMs: 300 });
    const hold = pack.sustain.angry.hold.MouthSmile.v;
    const mid = m.frame(1150).MouthSmile;
    expect(mid.mode).toBe('add');
    expect(Math.abs(mid.value)).toBeGreaterThan(0);
    expect(Math.abs(mid.value)).toBeLessThan(Math.abs(hold));
    const after = m.frame(1400).MouthSmile;
    expect(after.value).toBeCloseTo(hold, 5);
  });

  it('sustain settle:大笑的眯眼分量数秒内松弛,不再长驻(眯眯眼卡脸)', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.stateCue({ channel: 'emotion', clipId: 'laugh', startTs: 0, intensity: 1, fadeInMs: 1 });
    const spec = pack.sustain.laugh.hold.EyeOpenLeft;
    const burst = m.frame(100).EyeOpenLeft.value;
    expect(burst).toBeCloseTo(spec.v, 1);
    const settled = m.frame(spec.settleMs! + 1000).EyeOpenLeft.value;
    expect(settled).toBeCloseTo(spec.settleTo!, 5);
    // 重新点名(同 clip 再来一条 cue):从松弛值平滑爆回起势值
    m.stateCue({ channel: 'emotion', clipId: 'laugh', startTs: 10_000, intensity: 1, fadeInMs: 300 });
    const mid = m.frame(10_150).EyeOpenLeft.value;
    expect(mid).toBeLessThan(spec.settleTo!);
    expect(mid).toBeGreaterThan(spec.v);
    const reburst = m.frame(10_400).EyeOpenLeft.value;
    expect(reburst).toBeCloseTo(spec.v, 1);
  });

  it('sustain 链式替换:长淡出中途换新表情,旧贡献不整块消失(逐帧连续)', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.stateCue({ channel: 'emotion', clipId: 'laugh', startTs: 0, intensity: 1, fadeInMs: 1 });
    for (let t = 0; t <= 6000; t += 16) m.frame(t);
    // 使用 2.8s 淡出回到中性位。
    m.stateCue({ channel: 'emotion', clipId: null, startTs: 6016, intensity: 1, fadeInMs: 2800 });
    let prev = m.frame(6016).MouthSmile?.value ?? 0;
    // 淡出中途加入微笑时，前一状态的残余贡献必须连续。
    let cued = false;
    for (let t = 6032; t <= 9600; t += 16) {
      if (!cued && t >= 7400) {
        m.stateCue({ channel: 'emotion', clipId: 'smile', startTs: t, intensity: 1, fadeInMs: 300 });
        cued = true;
      }
      const v = m.frame(t).MouthSmile?.value ?? 0;
      expect(Math.abs(v - prev)).toBeLessThan(0.08);
      prev = v;
    }
    expect(prev).toBeCloseTo(pack.sustain.smile.hold.MouthSmile.v, 1);
  });

  it('接管期眨眼:眼睑被表情持有时数秒内出现眨眼;不持有的帧不碰眼睑', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.stateCue({ channel: 'emotion', clipId: 'fearful', startTs: 0, intensity: 1, fadeInMs: 1 });
    let minV = 99;
    for (let t = 0; t <= 8000; t += 16) minV = Math.min(minV, m.frame(t).EyeOpenLeft?.value ?? 99);
    // fearful 常驻 +0.5 睁大;眨眼把 (1+0.5) 的乘性压向全闭
    expect(minV).toBeLessThan(-0.4);
    // 没有眼睑写入的帧完全不出现眼睑参数(眨眼归 idle 动画)
    const idle = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false, idleBlinks: () => true });
    for (let t = 0; t <= 8000; t += 16) expect(idle.frame(t).EyeOpenLeft).toBeUndefined();
  });

  it('模型 idle 不眨眼时全程接管眼睑:空闲期也眨,不用改模型文件', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false, idleBlinks: () => false });
    let minL = 99;
    let minR = 99;
    let frames = 0;
    for (let t = 0; t <= 12_000; t += 16) {
      const f = m.frame(t);
      // 空闲帧也持有两眼(注入压过 idle 动画,眨眼所有权换人)
      expect(f.EyeOpenLeft?.mode).toBe('add');
      expect(f.EyeOpenRight?.mode).toBe('add');
      minL = Math.min(minL, f.EyeOpenLeft.value);
      minR = Math.min(minR, f.EyeOpenRight.value);
      frames++;
    }
    expect(frames).toBeGreaterThan(700);
    // 数秒内出现完整闭合(-1 = 全闭),双眼同步
    expect(minL).toBeLessThan(-0.9);
    expect(minR).toBeLessThan(-0.9);
  });

  it('全程接管时单眼动作也补齐另一只:眨单眼期间另一只眼照常眨', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false, idleBlinks: () => false });
    m.gestureCue({ clipId: 'wink', startTs: 100, intensity: 1 });
    const at = (t: number) => m.frame(t);
    // wink 只写 EyeOpenLeft,右眼由接管补上
    const mid = at(400);
    expect(mid.EyeOpenLeft.value).toBeLessThan(-0.5);
    expect(mid.EyeOpenRight).toBeDefined();
    expect(mid.EyeOpenRight.mode).toBe('add');
  });

  it('头部三轴全时持有:每帧必写(含环境漂移),所有权不还给 idle 动画', () => {
    // VTS 注入会替代 idle 对同一输出参数的控制；头部三轴必须持续写入。
    const m = new Mixer({ pack: () => pack, rng: () => 0.5 });
    let minX = 9e9, maxX = -9e9;
    for (let t = 0; t <= 30_000; t += 16) {
      const f = m.frame(t);
      for (const ax of ['FaceAngleX', 'FaceAngleY', 'FaceAngleZ'] as const) {
        expect(f[ax]).toBeDefined();
        expect(f[ax].mode).toBe('add');
      }
      minX = Math.min(minX, f.FaceAngleX.value);
      maxX = Math.max(maxX, f.FaceAngleX.value);
    }
    // 漂移在数秒尺度保持可见,且幅度低于 idle 的 ±7.5°。
    expect(maxX - minX).toBeGreaterThan(3);
    expect(Math.max(Math.abs(minX), Math.abs(maxX))).toBeLessThan(7);
    // 关掉环境层(测试确定性用)时头轴仍每帧持有,值为 0
    const bare = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    const f0 = bare.frame(100);
    expect(f0.FaceAngleY).toEqual({ value: 0, mode: 'add' });
  });

  it('pulse 加性轨迹按曲线走完回零并出列', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.gestureCue({ clipId: 'nod', startTs: 0, intensity: 1 });
    const dip = m.frame(190).FaceAngleY;
    expect(dip.value).toBeLessThan(-10);
    const done = m.frame(pack.pulse.nod.durationMs + 100);
    expect(done.FaceAngleY?.value ?? 0).toBeCloseTo(0, 3);
  });

  it('ducking:压下去是斜坡不是台阶,pulse 结束 1s 后恢复', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    // dejected pulse 与 pitiful sustain 都写 FaceAngleY
    m.stateCue({ channel: 'emotion', clipId: 'pitiful', startTs: 0, intensity: 1, fadeInMs: 1 });
    const holdY = pack.sustain.pitiful.hold.FaceAngleY.v;
    // 逐帧推进:混音台把单帧 dt 钳在 50ms,跳着采样斜坡是走不完的
    let t = 0;
    const runTo = (until: number) => {
      for (; t <= until; t += 16) m.frame(t);
    };
    runTo(400);
    expect(m.frame(t).FaceAngleY.value).toBeCloseTo(holdY, 1);

    const clip = pack.pulse.dejected;
    const startTs = t; // 紧接着上一帧,别造出人为的时间空档(单帧 dt 被钳在 50ms)
    m.gestureCue({ clipId: 'dejected', startTs, intensity: 1 });
    // pulse 首帧贡献仍为 0;State 贡献不得瞬时归零。
    // 真机上曾在此处一帧从 1.0 掉到 0.3(头一帧瞬转 11°);现在应沿斜坡渐变。
    const firstFrame = m.frame(startTs).FaceAngleY.value;
    expect(Math.abs(firstFrame)).toBeGreaterThan(Math.abs(holdY) * 0.6);
    expect(Math.abs(firstFrame)).toBeLessThan(Math.abs(holdY));

    // pulse 走完 + 1s:基本回到保持位(指数恢复,≈3τ 走完)
    t = startTs + 16;
    runTo(startTs + clip.durationMs + 1100);
    expect(Math.abs(m.frame(t).FaceAngleY.value)).toBeGreaterThan(Math.abs(holdY) * 0.95);
    // 再多给一会儿:完全归位
    runTo(startTs + clip.durationMs + 2600);
    expect(m.frame(t).FaceAngleY.value).toBeCloseTo(holdY, 1);
  });

  it('ducking:压到底就是 30%(用同参数但曲线为零的时刻取样)', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    // tilt_hold 保持 FaceAngleZ;shake 也写 FaceAngleZ,且其曲线在 0ms 与末帧为 0
    m.stateCue({ channel: 'pose', clipId: 'tilt_hold', startTs: 0, intensity: 1, fadeInMs: 1 });
    for (let t = 0; t <= 400; t += 16) m.frame(t);
    const hold = m.frame(416).FaceAngleZ.value;
    m.gestureCue({ clipId: 'shake', startTs: 500, intensity: 1 });
    // 走到 shake 的末帧:pulse 自身贡献回零,只剩被压到底的 state
    let last = 0;
    for (let t = 500; t <= 500 + pack.pulse.shake.durationMs - 20; t += 16) last = m.frame(t).FaceAngleZ.value;
    expect(Math.abs(last)).toBeLessThan(Math.abs(hold) * 0.45);
  });

  it('lipsync override:说话时 MouthOpen 为 set 模式且随包络;停在张嘴处走短斜坡收口后归还', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.speechStart((ms) => (ms < 500 ? 0.8 : 0), 2000);
    const speaking = m.frame(2100).MouthOpen;
    expect(speaking.mode).toBe('set');
    expect(speaking.value).toBeCloseTo(0.72, 2);
    m.speechEnd();
    // 打断在嘴张着的时刻:一帧归零是跳变,先按指数斜坡闭合
    const releasing = m.frame(2130).MouthOpen;
    expect(releasing.mode).toBe('set');
    expect(releasing.value).toBeLessThan(0.72);
    expect(releasing.value).toBeGreaterThan(0.2);
    // 逐帧走几百毫秒收完,参数归还
    let t = 2146;
    for (; t <= 2600; t += 16) m.frame(t);
    expect(m.frame(t).MouthOpen).toBeUndefined();
  });

  it('lipsync:包络采样过端点硬回 0(speechEnd 还没到),嘴不一帧闭合', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    // 播毕回执晚到:包络 500ms 处走完,speechEnd 迟迟不来
    m.speechStart((ms) => (ms < 500 ? 0.8 : 0), 2000);
    let prev = 0;
    let maxDrop = 0;
    for (let t = 2000; t <= 2900; t += 16) {
      const v = m.frame(t).MouthOpen?.value ?? 0;
      maxDrop = Math.max(maxDrop, prev - v);
      prev = v;
    }
    expect(maxDrop).toBeLessThan(0.3);
    expect(prev).toBeLessThan(0.05);
  });

  it('gaze 转向:眼先冲到位、头滞后跟上、眼随后回中,总视线守恒', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.stateCue({ channel: 'gaze', clipId: 'chat', startTs: 0, intensity: 1, fadeInMs: 300 });
    const EYE_DEG = 18; // mixer 的 EYE_RANGE_DEG.x
    const sample = (t: number) => {
      const f = m.frame(t);
      return { eyeDeg: (f.EyeRightX?.value ?? 0) * EYE_DEG, headDeg: f.FaceAngleX?.value ?? 0 };
    };
    // 换向必须经过扫视轨迹;第一帧不能直接到达目标。
    const firstFrame = sample(16);
    expect(Math.abs(firstFrame.eyeDeg)).toBeLessThan(EYE_DEG - 2);

    // 扫视走完(≥SHIFT_MIN_MS=130ms)之后,眼顶到舒适量程上限而头几乎还没动
    for (let t = 32; t < 200; t += 16) m.frame(t);
    const early = sample(200);
    expect(early.eyeDeg).toBeGreaterThan(EYE_DEG - 0.5);

    for (let t = 216; t <= 1500; t += 16) m.frame(t);
    const late = sample(1516);
    // 头到位(chat 的 headX 18° × 0.85 跟随衰减)
    expect(late.headDeg).toBeGreaterThan(14);
    // 眼到位那一刻头还差得远 —— 这才是"眼先到位"的判据
    expect(early.headDeg).toBeLessThan(late.headDeg * 0.75);
    // 眼从量程边界回落
    expect(late.eyeDeg).toBeLessThan(early.eyeDeg - 2);
    // 总视线(眼在头内 + 头)在整个过程中守恒:眼让位给头,注视点没被甩掉
    const totalEarly = early.eyeDeg + early.headDeg;
    const totalLate = late.eyeDeg + late.headDeg;
    expect(Math.abs(totalLate - totalEarly)).toBeLessThan(6);
  });

  it('gaze 注视:保持—突跳节律,而非钉死在目标点', () => {
    // 定死种子的 LCG:统计有变化又可复现
    let s = 12345;
    const rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const m = new Mixer({ pack: () => pack, rng });
    m.stateCue({ channel: 'gaze', clipId: 'chat', startTs: 0, intensity: 1, fadeInMs: 300 });
    const xs: number[] = [];
    for (let t = 0; t <= 20_000; t += 16) {
      const f = m.frame(t);
      if (t > 3000) xs.push((f.EyeRightX?.value ?? 0) * 18);
    }
    const steps = xs.slice(1).map((v, i) => Math.abs(v - xs[i]));
    // 帧间位移 > 0.16°/帧(=10°/s)判为扫视中:扫视很快,只占少数帧
    const fast = steps.filter((d) => d > 0.16).length;
    expect(fast / steps.length).toBeGreaterThan(0.02);
    expect(fast / steps.length).toBeLessThan(0.3);

    // 注视段:连续慢帧算一段。速率与时长要落在文献量纲上
    const holds: number[] = [];
    let run = 0;
    for (const d of steps) {
      if (d <= 0.16) run += 16;
      else if (run > 0) {
        holds.push(run);
        run = 0;
      }
    }
    const perSec = holds.length / ((20_000 - 3000) / 1000);
    expect(perSec).toBeGreaterThan(1.5);
    expect(perSec).toBeLessThan(5);
    const mean = holds.reduce((a, b) => a + b, 0) / holds.length;
    expect(mean).toBeGreaterThan(150);
    expect(mean).toBeLessThan(600);
    // 右偏长尾:最长注视远大于均值
    expect(Math.max(...holds)).toBeGreaterThan(mean * 2);

    // 注视点随时间移动,不固定在单一点位。
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - avg) ** 2, 0) / xs.length);
    expect(sd).toBeGreaterThan(1);
  });

  it('眼睑只走加性,绝不 set:眨眼归 VTS,抢占会把眼睑卡在移交缝隙里', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.stateCue({ channel: 'emotion', clipId: 'laugh', startTs: 0, intensity: 1, fadeInMs: 1 });
    m.stateCue({ channel: 'gaze', clipId: 'down', startTs: 0, intensity: 1, fadeInMs: 1 });
    // 挂着最眯眼的表情 + 往下看(lid saccade 也压眼睑)的最不利组合
    for (let t = 0; t <= 8000; t += 16) {
      const p = m.frame(t).EyeOpenLeft;
      if (p) expect(p.mode).toBe('add');
    }
  });

  it('gaze:目标激活时眼球 set 且趋向目标;清除后弹回并释放 override', () => {
    const m = new Mixer({ pack: () => pack, rng: () => 0.5, ambient: false });
    m.stateCue({ channel: 'gaze', clipId: 'chat', startTs: 0, intensity: 1, fadeInMs: 300 });
    let f = m.frame(0);
    for (let t = 16; t <= 1200; t += 16) f = m.frame(t);
    expect(f.EyeLeftX.mode).toBe('set');
    expect(f.EyeLeftX.value).toBeGreaterThan(0.3);
    m.stateCue({ channel: 'gaze', clipId: null, startTs: 1200, intensity: 1, fadeInMs: 300 });
    for (let t = 1216; t <= 4000; t += 16) f = m.frame(t);
    expect(f.EyeLeftX).toBeUndefined();
  });
});
