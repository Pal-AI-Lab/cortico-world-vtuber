import { afterEach, describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../../src/core/util.ts';
import type { GestureCue, IRFrame, Mixer } from '../../src/io-vtuber/mixer.ts';
import { Performer, type AudioSink } from '../../src/io-vtuber/orchestrator.ts';
import type { StateCue } from '../../src/io-vtuber/states.ts';
import { Envelope, type TtsPiece } from '../../src/io-vtuber/tts.ts';
import { EXAMPLE_PACK_DIR, loadPack } from '../../src/io-vtuber/pack.ts';

const pack = loadPack(EXAMPLE_PACK_DIR);

class CueRecorder {
  readonly states: StateCue[] = [];
  readonly gestures: GestureCue[] = [];
  readonly prosody: GestureCue[] = [];
  readonly speech: string[] = [];
  readonly speechStartedAt: number[] = [];
  readonly speechEnvelopes: Array<(milliseconds: number) => number> = [];
  readonly prosodyDrops: number[] = [];
  hasExplicitGaze = false;
  stateCue(cue: StateCue): void { this.states.push(cue); }
  gestureCue(cue: GestureCue): void { this.gestures.push(cue); }
  prosodyCue(cue: GestureCue): void { this.prosody.push(cue); }
  dropPendingProsody(now: number): void { this.prosodyDrops.push(now); }
  speechStart(envelope: (milliseconds: number) => number, startedAt: number): void {
    this.speech.push('start');
    this.speechStartedAt.push(startedAt);
    this.speechEnvelopes.push(envelope);
  }
  speechEnd(): void { this.speech.push('end'); }
  frame(): IRFrame { return {}; }
}

function piece(text: string, durationMs = 20): TtsPiece {
  return {
    text,
    wav: new Uint8Array(44),
    durationMs,
    envelope: new Envelope(new Float32Array([0.6, 0]), 20),
  };
}

function fixture(options: { now?: () => number } = {}) {
  const mixer = new CueRecorder();
  const synthesized: string[] = [];
  const ordinaryAudio: string[] = [];
  const fx: string[] = [];
  const subtitles: string[] = [];
  const subtitleCuts: string[] = [];
  const traces: Array<{ area: string; msg: string; level: string }> = [];
  const audio: AudioSink = {
    async play(tts) {
      ordinaryAudio.push(tts.text);
      const startedAt = Date.now();
      return { startedAt, ended: Promise.resolve(startedAt + tts.durationMs) };
    },
    beginStream() { throw new Error('prepared act 不走流式播放'); },
    stop() {},
  };
  const performer = new Performer({
    pack: () => pack,
    tts: {
      synth: async (text) => {
        synthesized.push(text);
        return piece(text);
      },
    },
    audio,
    mixer: mixer as unknown as Mixer,
    backend: { sendFrame: () => {}, fx: (clipId) => fx.push(clipId), fxDurationMs: () => 0, stop: () => {} },
    log: nullLogger(),
    rng: () => 0.5,
    now: options.now,
    onSubtitle: ({ text }) => subtitles.push(text),
    onSubtitleCut: () => subtitleCuts.push('cut'),
    trace: (area, msg, opts) => traces.push({ area, msg, level: opts?.level ?? 'info' }),
  });
  return { performer, mixer, synthesized, ordinaryAudio, fx, subtitles, subtitleCuts, traces };
}

describe('Performer 预编译片', () => {
  afterEach(() => vi.useRealTimers());
  it('完整解析和合成但不触发动作、口型或普通音频队列', async () => {
    const f = fixture();
    const act = await f.performer.prepareAct('【微笑,点头】你好。<看一眼弹幕>再见。', 'call-1');

    expect(act.callId).toBe('call-1');
    expect(f.synthesized).toEqual(['你好。 再见。']);
    expect(act.pieces).toHaveLength(1);
    expect(act.pieces[0].tts?.text).toBe('你好。 再见。');
    expect(act.pieces[0].commands.map((c) => c.kind === 'reset' ? 'Reset' : c.entry.word))
      .toEqual(['微笑', '点头']);
    expect(act.pieces[0].anchors[0].commands[0].kind).toBe('perform');
    expect(act.pieces[0].occupiedMs).toBeGreaterThan(act.pieces[0].tts!.durationMs);
    expect(f.ordinaryAudio).toEqual([]);
    expect(f.mixer.states).toEqual([]);
    expect(f.mixer.gestures).toEqual([]);
    expect(f.mixer.speech).toEqual([]);
  });

  it('播放时使用调用方指定的音频总线并复用现有口型和字幕时序', async () => {
    const f = fixture();
    const act = await f.performer.prepareAct('短句。');
    const overlay: string[] = [];

    await f.performer.playPreparedPiece(act.pieces[0], async (tts) => {
      overlay.push(tts.text);
      const startedAt = Date.now();
      return {
        startedAt,
        ended: new Promise<number>((resolve) => setTimeout(() => resolve(Date.now()), tts.durationMs)),
      };
    });

    expect(overlay).toEqual(['短句。']);
    expect(f.ordinaryAudio).toEqual([]);
    expect(f.mixer.speech).toEqual(['start', 'end']);
  });

  /**
 * cue 时间轴按批记录埋点，不按每条 cue 记录。
 */
  it('交出 cue 时间轴时按批落一条埋点(不是每条 cue 一条)', async () => {
    const f = fixture();
    const act = await f.performer.prepareAct('第一句话说完了。第二句话也说完了。第三句收尾。');

    await f.performer.playPreparedPiece(act.pieces[0], async (tts) => {
      const startedAt = Date.now();
      return { startedAt, ended: Promise.resolve(startedAt + tts.durationMs) };
    });

    const lines = f.traces.filter((t) => t.area === '字幕');
    // 一片多条 cue,但只落一条日志——按批汇总,不是每条 cue 一条
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toContain('时间轴');
    expect(Number(/(\d+) 条/.exec(lines[0].msg)?.[1])).toBeGreaterThan(1);
    expect(lines[0].msg).toMatch(/跨度 \d+ms/);
    expect(lines[0].level).toBe('info');
  });

  /** 台词整段是 [] 语气词时观众一个字都看不到:这种"发了等于没发"必须冒出来 */
  it('有台词却零 cue 时埋点升 warn', async () => {
    const f = fixture();
    const act = await f.performer.prepareAct('[sigh]');
    await f.performer.playPreparedPiece(act.pieces[0], async (tts) => {
      const startedAt = Date.now();
      return { startedAt, ended: Promise.resolve(startedAt + tts.durationMs) };
    });

    const lines = f.traces.filter((t) => t.area === '字幕');
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toContain('0 条');
    expect(lines[0].level).toBe('warn');
  });

  it('使用外部时间线的绝对 anchor，迟到时不会重新追加 lead', async () => {
    let now = 1_000;
    const f = fixture({ now: () => now });
    const act = await f.performer.prepareAct('【微笑】短句。');
    const prepared = { ...act.pieces[0], leadMs: 250, occupiedMs: 270 };
    const openedAt: number[] = [];

    await f.performer.playPreparedPiece(prepared, async () => {
      openedAt.push(now);
      return { startedAt: 750, ended: Promise.resolve(770) };
    }, { anchorTs: 500, speechProsody: false });

    expect(openedAt).toEqual([1_000]);
    expect(f.mixer.states[0]).toMatchObject({ clipId: 'smile', startTs: 500 });
    expect(f.mixer.speechStartedAt).toEqual([750]);
  });

  it('中止后立即收动作，但口型和字幕等外部音频真正结束', async () => {
    const f = fixture();
    const act = await f.performer.prepareAct('【微笑】短句。');
    const abort = new AbortController();
    let resolveEnded!: (timestamp: number) => void;
    const ended = new Promise<number>((resolve) => (resolveEnded = resolve));
    let playerCalled!: () => void;
    const called = new Promise<void>((resolve) => (playerCalled = resolve));
    let settled = false;

    const playback = f.performer.playPreparedPiece(act.pieces[0], async () => {
      playerCalled();
      // 开播时刻与编排器同一墙钟:字幕时间轴按它换算到接收坐标
      return { startedAt: Date.now(), ended };
    }, {
      signal: abort.signal,
      drainAudioOnAbort: true,
      transientState: true,
      speechProsody: false,
    }).then(() => { settled = true; });
    await called;
    await Promise.resolve();
    await Promise.resolve();
    expect(f.mixer.speech).toEqual(['start']);
    expect(f.subtitles).toEqual(['短句。']);

    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.mixer.speech).toEqual(['start']);
    expect(f.mixer.states.at(-1)).toMatchObject({ channel: 'emotion', clipId: null });
    expect(f.subtitleCuts).toEqual([]);

    resolveEnded(120);
    await playback;
    expect(f.mixer.speech).toEqual(['start', 'end']);
    expect(f.subtitleCuts).toEqual(['cut']);
  });

  it('外部总线暂停时口型与语音内动作跟随媒体位置而不是墙钟', async () => {
    vi.useFakeTimers();
    let now = 100;
    let positionMs = 0;
    const f = fixture({ now: () => now });
    const act = await f.performer.prepareAct('【点头】短句。');
    const source = act.pieces[0];
    const prepared = {
      ...source,
      commands: [],
      anchors: [{ charOffset: 1, commands: [source.commands[0]] }],
      leadMs: 0,
    };
    let resolveEnded!: (timestamp: number) => void;
    const ended = new Promise<number>((resolve) => (resolveEnded = resolve));

    const playback = f.performer.playPreparedPiece(prepared, async () => ({
      startedAt: now,
      ended,
      positionMs: () => positionMs,
    }), { speechProsody: false });
    for (let turn = 0; turn < 10 && f.mixer.speechEnvelopes.length === 0; turn++) {
      await Promise.resolve();
    }

    expect(f.mixer.speechEnvelopes[0](1_000)).toBeCloseTo(0.6);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.mixer.gestures).toEqual([]);

    positionMs = source.tts!.durationMs;
    now = 200;
    await vi.advanceTimersByTimeAsync(20);
    expect(f.mixer.gestures).toHaveLength(1);
    expect(f.mixer.speechEnvelopes[0](0)).toBeCloseTo(0);

    resolveEnded(now);
    await playback;
  });
});
