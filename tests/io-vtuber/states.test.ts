import { describe, it, expect } from 'vitest';
import { StateMachines, STATE_FADE_IN_MS, type StateCue } from '../../src/io-vtuber/states.ts';

function make(neutralGaze: string | null = 'camera') {
  const cues: StateCue[] = [];
  const sm = new StateMachines({
    emit: (c) => cues.push(c),
    neutral: (ch) => (ch === 'gaze' ? neutralGaze : null),
    rng: () => 0.5,
  });
  return { cues, sm };
}

describe('StateMachines', () => {
  it('设置发 crossfade cue;重复设当前值重发 cue(重新起势)并刷新超时', () => {
    const { cues, sm } = make();
    sm.set('emotion', 'smile', 1000);
    expect(cues).toEqual([
      { channel: 'emotion', clipId: 'smile', startTs: 1000, intensity: 1, fadeInMs: STATE_FADE_IN_MS },
    ]);
    sm.set('emotion', 'smile', 2000);
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ clipId: 'smile', startTs: 2000 });
    // rng=0.5 → emotion 超时 25s:第二次 set 把超时推到 27s,26s 时还不衰减
    sm.tick(26_500);
    expect(cues).toHaveLength(2);
    sm.set('emotion', 'laugh', 27_000);
    expect(cues[2].clipId).toBe('laugh');
  });

  it('超时范围可由 provider 覆盖', () => {
    const cues: StateCue[] = [];
    const sm = new StateMachines({
      emit: (c) => cues.push(c),
      neutral: () => null,
      timeouts: () => [1000, 1000],
      rng: () => 0.5,
    });
    sm.set('emotion', 'smile', 0);
    sm.tick(1500);
    expect(cues[1]).toMatchObject({ channel: 'emotion', clipId: null });
  });

  it('超时衰减:gaze 落回模式默认注视,emotion 落回中性', () => {
    const { cues, sm } = make('screen');
    sm.set('gaze', 'chat', 0);
    sm.set('emotion', 'angry', 0);
    // rng=0.5 → gaze 超时 5s,emotion 25s
    sm.tick(4000);
    expect(cues).toHaveLength(2);
    sm.tick(5500);
    const gazeDecay = cues[2];
    expect(gazeDecay.channel).toBe('gaze');
    expect(gazeDecay.clipId).toBe('screen');
    expect(gazeDecay.fadeInMs).toBeGreaterThanOrEqual(2000);
    expect(sm.active('gaze')).toBeNull();
    sm.tick(26000);
    expect(cues[3]).toMatchObject({ channel: 'emotion', clipId: null });
    sm.tick(30000);
    expect(cues).toHaveLength(4);
  });

  it('Reset 清空全部 State 通道', () => {
    const { cues, sm } = make('camera');
    sm.set('pose', 'lean_in', 0);
    sm.set('emotion', 'smile', 0);
    sm.set('gaze', 'down', 0);
    cues.length = 0;
    sm.resetAll(100);
    expect(cues.map((c) => [c.channel, c.clipId]).sort()).toEqual([
      ['emotion', null],
      ['gaze', 'camera'],
      ['pose', null],
    ]);
    expect(sm.active('pose')).toBeNull();
  });
});
