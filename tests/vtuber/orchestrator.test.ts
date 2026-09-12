import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import { segmentUnits, type AlignedUnit } from '../../src/align.ts';
import type { GestureCue, IRFrame, Mixer } from '../../src/mixer.ts';
import {
  BUDGET_MS_PER_UNIT,
  describeSpeechRate,
  overrunBudget,
  overrunBudgetOf,
  Performer,
  SPEECH_LEAD_IN_MS,
  type AudioSink,
  type PerformerTts,
  type SpeechRateHint,
} from '../../src/orchestrator.ts';
import { SILENCE_MIN_MS } from '../../src/silence-scan.ts';
import type { SubtitleCue } from '../../src/subtitle-cues.ts';
import type { StateCue } from '../../src/states.ts';
import { Envelope, StreamingEnvelope, type TtsPiece } from '../../src/tts.ts';
import { EXAMPLE_PACK_DIR, loadPack } from '../../src/pack.ts';

const pack = loadPack(EXAMPLE_PACK_DIR);

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date('2026-01-01T00:00:00Z'),
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'],
  });
});

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

class CueRecorder {
  stateCues: StateCue[] = [];
  gestureCues: GestureCue[] = [];
  prosodyCues: GestureCue[] = [];
  speech: Array<'start' | 'end'> = [];
  hasExplicitGaze = false;
  stateCue(cue: StateCue): void {
    this.stateCues.push(cue);
  }
  gestureCue(cue: GestureCue): void {
    this.gestureCues.push(cue);
  }
  prosodyCue(cue: GestureCue): void {
    this.prosodyCues.push(cue);
  }
  dropPendingProsody(now: number): void {
    this.prosodyCues = this.prosodyCues.filter((p) => p.startTs <= now);
  }
  speechStart(): void {
    this.speech.push('start');
  }
  speechEnd(): void {
    this.speech.push('end');
  }
  frame(): IRFrame {
    return {};
  }
}

function fakePiece(text: string, durationMs: number, env?: number[]): TtsPiece {
  return {
    text,
    wav: new Uint8Array(4),
    durationMs,
    envelope: new Envelope(new Float32Array(env ?? [0.5]), 20),
  };
}

/** 20ms hop 的假包络:在给定毫秒处立一个尖峰,其余是低电平底噪 */
function envWithPeaks(durationMs: number, peaks: Array<[ms: number, level: number]>): number[] {
  const values = new Array(Math.floor(durationMs / 20)).fill(0.2);
  for (const [ms, level] of peaks) values[Math.round(ms / 20)] = level;
  return values;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  do {
    await vi.advanceTimersByTimeAsync(10);
    if (cond()) return;
  } while (Date.now() - t0 <= timeoutMs);
  throw new Error('waitFor 超时');
}

function makePerformer(
  opts: {
    pieceMs?: number;
    env?: number[];
    units?: (text: string) => AlignedUnit[];
    broadcastFloorMs?: () => number;
    onDrained?: () => void;
  } = {},
) {
  const mixer = new CueRecorder();
  const fx: string[] = [];
  const synthCalls: string[] = [];
  const played: string[] = [];
  const playTimes: number[] = [];
  const stops: number[] = [];
  const cues: Array<Array<{ word: string; channel: string }>> = [];
  const pieceMs = opts.pieceMs ?? 40;
  const audio: AudioSink = {
    play(piece) {
      played.push(piece.text);
      const startedAt = Date.now();
      playTimes.push(startedAt);
      return Promise.resolve({
        startedAt,
        ended: new Promise((r) => setTimeout(() => r(Date.now()), piece.durationMs)),
      });
    },
    beginStream(_sampleRate, text) {
      played.push(text);
      playTimes.push(Date.now());
      let resolveEnd!: (n: number) => void;
      const ended = new Promise<number>((r) => (resolveEnd = r));
      return {
        started: Promise.resolve(Date.now()),
        ended,
        push: () => {},
        end: (durationMs) => setTimeout(() => resolveEnd(Date.now()), durationMs),
        abort: () => resolveEnd(Date.now()),
      };
    },
    stop(fadeMs) {
      stops.push(fadeMs);
    },
  };
  const performer = new Performer({
    pack: () => pack,
    tts: {
      synth: async (text) => {
        synthCalls.push(text);
        const piece = fakePiece(text, pieceMs, opts.env);
        if (opts.units) piece.units = opts.units(text);
        return piece;
      },
    },
    audio,
    mixer: mixer as unknown as Mixer,
    backend: { sendFrame: () => {}, fx: (clipId) => fx.push(clipId), fxDurationMs: () => 0, stop: () => {} },
    log: nullLogger(),
    onCue: (c) => cues.push(c),
    broadcastFloorMs: opts.broadcastFloorMs,
    onDrained: opts.onDrained,
    rng: () => 0.5,
  });
  performer.start();
  return { performer, mixer, fx, synthCalls, played, playTimes, stops, cues };
}

/** 流式假 TTS:每单元 unitMs 毫秒音频,20ms 块以约 5 倍速流出(RTF≈0.2) */
function makeStreamPerformer(opts: {
  align: boolean;
  unitMs?: number;
  unitsOnDone?: boolean;
  alignPcm?: PerformerTts['alignPcm'];
  /** 音频 sink 支持音素感知切断(记入 cuts) */
  withCut?: boolean;
  /** PCM 内容:正弦频率(Hz);缺省全零(静音) */
  toneHz?: number;
  /** 将音频延长到 totalMs,同时保持 units 仅覆盖文本对应的区间。 */
  runaway?: { text: string; totalMs: number };
  /**
   * 这一片从 startMs 起是超大静默段:与真客户端同一条止损——攒够 SILENCE_MIN_MS
   * 就掐流,交回的片带 silence 报告(triggered)。
   */
  silence?: { text: string; startMs: number };
  /** 该片对齐判废(World 质量门口径):units 不采信,附最后对得上的单元末尾 */
  alignBad?: { text: string; lastGoodEndMs: number | null };
  /** 块间只让出事件循环、不等定时器:合成远快于播放,预取的片在前一片还播着时就收完流 */
  fastStream?: boolean;
  /** 每块音频的毫秒数(缺省 20)。测几十秒长的片时调大,免得挂在定时器上跑几十秒。 */
  chunkMs?: number;
  /** 当前声线的实测语速;缺席即冷启动(编排器回落常数) */
  speechRate?: () => SpeechRateHint;
  /** 假声卡给出的开播时刻比 started 兑现时刻晚这么多(真声卡的写入领先量与设备延迟) */
  startLeadMs?: number;
}) {
  const mixer = new CueRecorder();
  const fx: string[] = [];
  const played: Array<{ text: string; startedAt: number; endedAt?: number }> = [];
  const stops: number[] = [];
  const cuts: Array<{ atMs: number; cls: string; fadeMs: number }> = [];
  const SR = 16000;
  const unitMs = opts.unitMs ?? 50;
  let phase = 0;
  const synthStream: NonNullable<PerformerTts['synthStream']> = async (text, sink, signal, maxDurationMs) => {
    const env = new StreamingEnvelope(SR);
    sink.begin?.({ sampleRate: SR, envelope: env });
    const units = segmentUnits(text);
    const properMs = Math.max(unitMs, units.length * unitMs);
    const sil = opts.silence?.text === text ? opts.silence : null;
    const totalMs = sil
      ? sil.startMs + SILENCE_MIN_MS + 8000
      : opts.runaway?.text === text
        ? opts.runaway.totalMs
        : properMs;
    const chunkMs = opts.chunkMs ?? 20;
    const samplesPerChunk = (SR * chunkMs) / 1000;
    let emittedMs = 0;
    let truncated = false;
    let silenceHit = false;
    for (let t = 0; t < totalMs; t += chunkMs) {
      if (signal.aborted) throw new Error('aborted');
      env.append(new Float32Array(samplesPerChunk).fill(0.3));
      const bytes = new Uint8Array(samplesPerChunk * 2);
      if (opts.toneHz) {
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < samplesPerChunk; i++) {
          const v = 0.4 * Math.sin((2 * Math.PI * opts.toneHz * (phase + i)) / SR);
          view.setInt16(2 * i, Math.round(v * 32767), true);
        }
        phase += samplesPerChunk;
      }
      sink.pcm(bytes);
      emittedMs += chunkMs;
      // 与真客户端同一条止损,先后也一样:静默段先判(它说得出掐在哪),时长界兜底
      if (sil && emittedMs >= sil.startMs + SILENCE_MIN_MS) {
        truncated = true;
        silenceHit = true;
        break;
      }
      if (maxDurationMs !== undefined && emittedMs >= maxDurationMs) {
        truncated = true;
        break;
      }
      await (opts.fastStream
        ? new Promise((r) => setImmediate(r))
        : new Promise((r) => setTimeout(r, 4)));
    }
    env.finish();
    const piece: TtsPiece = {
      text,
      wav: new Uint8Array(44),
      durationMs: emittedMs,
      envelope: env,
      ...(truncated ? { truncated } : {}),
      ...(silenceHit && sil
        ? {
            silence: {
              longestMs: SILENCE_MIN_MS,
              startMs: sil.startMs,
              endMs: sil.startMs + SILENCE_MIN_MS,
              thresholdRms: 0.006,
              refRms: 0.2,
              minSilenceMs: SILENCE_MIN_MS,
              triggered: true,
            },
          }
        : {}),
    };
    if (opts.alignBad?.text === text) {
      piece.alignBad = { reasons: ['零长跨度 56%'], lastGoodEndMs: opts.alignBad.lastGoodEndMs };
    } else if (opts.unitsOnDone) {
      piece.units = units.map((u, i) => ({
        text: u,
        start: (i * unitMs) / 1000,
        end: ((i + 1) * unitMs) / 1000,
      }));
    }
    return piece;
  };
  const audio: AudioSink = {
    play() {
      throw new Error('流式测试不该走整段播放');
    },
    beginStream(_sr, text) {
      const rec: { text: string; startedAt: number; endedAt?: number } = {
        text,
        startedAt: Date.now() + (opts.startLeadMs ?? 0),
      };
      played.push(rec);
      let resolveEnd!: (n: number) => void;
      const ended = new Promise<number>((r) => (resolveEnd = r));
      return {
        started: Promise.resolve(rec.startedAt),
        ended,
        push: () => {},
        end: (durationMs) => {
          const remain = rec.startedAt + durationMs - Date.now();
          setTimeout(() => {
            rec.endedAt = Date.now();
            resolveEnd(rec.endedAt);
          }, Math.max(0, remain));
        },
        abort: () => {
          rec.endedAt = Date.now();
          resolveEnd(rec.endedAt);
        },
      };
    },
    stop(fadeMs) {
      stops.push(fadeMs);
    },
    ...(opts.withCut
      ? {
          cut: (atMs: number, plan: { cls: string; fadeMs: number }) => {
            cuts.push({ atMs, cls: plan.cls, fadeMs: plan.fadeMs });
            return true;
          },
        }
      : {}),
  };
  const traces: Array<{ area: string; msg: string; level?: string; tally?: string; event?: string; data?: Record<string, unknown> }> = [];
  /** 收到的字幕批与接收时刻(cue 的 atMs 相对它) */
  const subtitles: Array<{ text: string; cues: SubtitleCue[]; basis: string; at: number }> = [];
  const performer = new Performer({
    pack: () => pack,
    tts: {
      synth: async (text) => {
        throw new Error(`不该走整段合成:${text}`);
      },
      synthStream,
      alignPcm: opts.alignPcm,
    },
    streamEnabled: () => true,
    alignEnabled: () => opts.align,
    speechRate: opts.speechRate,
    audio,
    mixer: mixer as unknown as Mixer,
    backend: { sendFrame: () => {}, fx: (clipId) => fx.push(clipId), fxDurationMs: () => 0, stop: () => {} },
    log: nullLogger(),
    trace: (area, msg, o) => traces.push({ area, msg, level: o?.level, tally: o?.tally, event: o?.event, data: o?.data }),
    onSubtitle: (p) => subtitles.push({ ...p, at: Date.now() }),
    rng: () => 0.5,
  });
  performer.start();
  return { performer, mixer, fx, played, stops, cuts, traces, subtitles };
}

describe('Performer', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('整轮演出:cue 按同拍次序发出,语音按序播放,风格随脚本序状态', async () => {
    const p = makePerformer();
    cleanup.push(() => p.performer.stop());
    // 空【】无条件断 TTS 片;这些短句未到自动切片门槛。pulse 声线只压紧随标签的那一片
    p.performer.perform('【生气】哼。【得意】嘿嘿。【】真香。');
    await waitFor(() => p.played.length === 3 && p.performer.status().queuedBeats === 0);
    expect(p.played).toEqual(['哼。', '嘿嘿。', '真香。']);
    expect(p.mixer.stateCues.some((c) => c.channel === 'emotion' && c.clipId === 'angry')).toBe(true);
    expect(p.mixer.gestureCues.map((c) => c.clipId)).toEqual(['smug']);
    // 句首头部模式:开口前先起势,且走韵律通道(不 duck 同参数的 State 贡献)
    expect(p.mixer.prosodyCues[0]?.clipId).toBe('speech_onset');
    expect(p.mixer.gestureCues.some((c) => c.clipId === 'speech_onset')).toBe(false);
  });

  it('句首头部模式:停顿后才起势,连着说的后续片不重复起势', async () => {
    const p = makePerformer();
    cleanup.push(() => p.performer.stop());
    p.performer.perform('第一句。【】第二句。【】第三句。');
    await waitFor(() => p.played.length === 3 && p.performer.status().queuedBeats === 0);
    // 三片语音之间只隔 100ms 同行边界(< 350ms 停顿阈值),只有开场那一次算句首
    expect(p.mixer.prosodyCues).toHaveLength(1);
  });

  it('句内韵律:重音处排头动基元,强重音处抬眉且起点早于重音', async () => {
    // 1500ms 一片,三个重音尖峰(间隔 500ms > 320ms 最小间隔);前两个够强(≥0.8)才抬眉
    const p = makePerformer({
      pieceMs: 1500,
      env: envWithPeaks(1500, [[200, 1], [700, 0.9], [1200, 0.65]]),
    });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一句有重音的话。');
    await waitFor(() => p.mixer.prosodyCues.length >= 5);

    const byClip = (id: string) => p.mixer.prosodyCues.filter((c) => c.clipId === id);
    expect(byClip('speech_onset')).toHaveLength(1);
    // rng=0.5 恒命中 0.8 的头动概率,且恒抽到权重最大的 accent_nod
    const nods = byClip('accent_nod');
    expect(nods).toHaveLength(3);
    // 幅度随重音强度(0.7 + 0.5·level)
    expect(nods[0].intensity).toBeCloseTo(1.2, 5);
    expect(nods[2].intensity).toBeCloseTo(1.025, 5);
    expect(nods[1].startTs - nods[0].startTs).toBe(500);
    expect(nods[2].startTs - nods[1].startTs).toBe(500);

    // "强重音"按片内排名取前 1/3:三个重音里只有最强那个抬眉,起点提前 60ms
    const browsCues = byClip('accent_brow');
    expect(browsCues).toHaveLength(1);
    expect(nods[0].startTs - browsCues[0].startTs).toBe(60);
  });

  it('硬打断丢掉还没起跳的韵律轨迹', async () => {
    const p = makePerformer({
      pieceMs: 1500,
      env: envWithPeaks(1500, [[200, 1], [700, 0.9], [1200, 0.65]]),
    });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一句有重音的话。');
    await waitFor(() => p.mixer.prosodyCues.length >= 5);
    const scheduled = p.mixer.prosodyCues.length;
    void p.performer.preempt({ boundaryWindowMs: 0 });
    expect(p.mixer.prosodyCues.length).toBeLessThan(scheduled);
    const now = Date.now();
    expect(p.mixer.prosodyCues.every((c) => c.startTs <= now)).toBe(true);
  });

  it('同拍含 State 与 Gesture:gesture 延迟 300ms', async () => {
    const p = makePerformer();
    cleanup.push(() => p.performer.stop());
    p.performer.perform('【微笑,点头】嗯。');
    await waitFor(() => p.played.length === 1);
    const state = p.mixer.stateCues.find((c) => c.clipId === 'smile');
    const gesture = p.mixer.gestureCues[0];
    expect(gesture.startTs - (state?.startTs ?? 0)).toBe(300);
  });

  it('FX 标签直达 backend;纯演出 beat 不等语音', async () => {
    const p = makePerformer();
    cleanup.push(() => p.performer.stop());
    p.performer.perform('【灯泡特效,点头】');
    await waitFor(() => p.fx.length === 1 && p.mixer.gestureCues.length === 1);
    expect(p.fx).toEqual(['fx_idea']);
    expect(p.played).toEqual([]);
  });

  it('新一轮到达:旧轮剩余 pending 清掉,新轮顶上', async () => {
    const p = makePerformer({ pieceMs: 150 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('第一句。第二句。第三句。第四句。');
    await waitFor(() => p.played.length >= 1);
    p.performer.perform('新的一轮。');
    await waitFor(() => p.played.includes('新的一轮。'));
    expect(p.played).not.toContain('第四句。');
  });

  it('硬打断:音频 150ms fade,pending 清空', async () => {
    const p = makePerformer({ pieceMs: 300 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('很长的一句话。后面还有。');
    await waitFor(() => p.played.length === 1);
    void p.performer.preempt({ boundaryWindowMs: 0 });
    expect(p.stops).toContain(150);
    await vi.advanceTimersByTimeAsync(450);
    expect(p.played).toHaveLength(1);
  });

  it('播出延迟地板:演出锚点不早于地板时刻(反应不先于观众看到的画面)', async () => {
    const floorAt = Date.now() + 400;
    const p = makePerformer({ broadcastFloorMs: () => floorAt });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('看到这一手了。');
    await waitFor(() => p.played.length === 1);
    expect(p.playTimes[0]).toBeGreaterThanOrEqual(floorAt);
  });

  it('onCue 旁路:beat 指令束与 <> 锚点指令各报一束(word+channel)', async () => {
    const p = makePerformer({ pieceMs: 400 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('【微笑,点头】一二三四<翻白眼>五六七八');
    await waitFor(() => p.cues.length >= 2, 4000);
    expect(p.cues[0]).toEqual([
      { word: '微笑', channel: 'emotion' },
      { word: '点头', channel: 'gesture' },
    ]);
    expect(p.cues[1]).toEqual([{ word: '翻白眼', channel: 'gesture' }]);
  });

  it('【】阻断:同拍 pulse 做完才开口(gap ≥ clip 时长)', async () => {
    const p = makePerformer({ pieceMs: 60 });
    cleanup.push(() => p.performer.stop());
    const t0 = Date.now();
    p.performer.perform('【点头】然后说话。');
    await waitFor(() => p.played.length === 1);
    // nod clip 340ms + gestureDelay 0;边界档 100ms 会被阻断等待盖过
    expect(p.playTimes[0] - t0).toBeGreaterThanOrEqual(330);
  });
});

describe('Performer <> 锚点(四组合)', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('组合①非流式无对齐:按字符比例估计触发', async () => {
    const p = makePerformer({ pieceMs: 800 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一二三四<点头>五六七八');
    await waitFor(() => p.mixer.gestureCues.length === 1, 4000);
    // charOffset 4 / 8 字 × 800ms = 400ms
    const dt = p.mixer.gestureCues[0].startTs - p.playTimes[0];
    expect(dt).toBeGreaterThanOrEqual(280);
    expect(dt).toBeLessThanOrEqual(560);
  });

  it('组合③非流式带对齐:按 units 时间点触发', async () => {
    const p = makePerformer({
      pieceMs: 1000,
      // 每单元 100ms 的假对齐
      units: (text) =>
        segmentUnits(text).map((u, i) => ({ text: u, start: i * 0.1, end: (i + 1) * 0.1 })),
    });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一二三四<点头>五六七八');
    await waitFor(() => p.mixer.gestureCues.length === 1, 4000);
    const dt = p.mixer.gestureCues[0].startTs - p.playTimes[0];
    expect(dt).toBeGreaterThanOrEqual(300);
    expect(dt).toBeLessThanOrEqual(540);
  });

  it('组合②流式无对齐:沿 <> 剪成两段流,接缝处触发动作', async () => {
    const p = makeStreamPerformer({ align: false, unitMs: 60 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('前半段落<点头>后半段落');
    await waitFor(() => p.played.length === 2 && p.mixer.gestureCues.length === 1, 4000);
    expect(p.played.map((r) => r.text)).toEqual(['前半段落', '后半段落']);
    // 接缝 fire-and-go:动作在第一段播毕后、第二段起播前后一小窗内
    const seam = p.played[0].endedAt ?? 0;
    const cueTs = p.mixer.gestureCues[0].startTs;
    expect(cueTs).toBeGreaterThanOrEqual(seam - 30);
    expect(cueTs - seam).toBeLessThanOrEqual(200);
  });

  it('组合④流式+对齐:整片一段,锚点按收流对齐的时间点触发', async () => {
    const p = makeStreamPerformer({ align: true, unitsOnDone: true, unitMs: 50 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('你好世界<点头>后面还有话。');
    await waitFor(() => p.mixer.gestureCues.length === 1, 4000);
    // 不切段
    expect(p.played).toHaveLength(1);
    // unitIndex 4 × 50ms = 200ms(RTF≈0.2,收流对齐先于死线)
    const dt = p.mixer.gestureCues[0].startTs - p.played[0].startedAt;
    expect(dt).toBeGreaterThanOrEqual(140);
    expect(dt).toBeLessThanOrEqual(340);
  });

  it('组合④对齐拿不到:死线按估计触发,不漏做', async () => {
    // unitsOnDone=false 且 alignPcm 恒 null:只能靠估计死线
    const p = makeStreamPerformer({ align: true, unitsOnDone: false, alignPcm: async () => null, unitMs: 50 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('你好世界<点头>后面还有很长很长的一段话要说完');
    await waitFor(() => p.mixer.gestureCues.length === 1, 6000);
    expect(p.mixer.gestureCues[0].clipId).toBe('nod');
  });

  it('纯锚点片:【表情】后只有 <>,动作立即触发', async () => {
    const p = makePerformer();
    cleanup.push(() => p.performer.stop());
    p.performer.perform('【微笑】<点头>');
    await waitFor(() => p.mixer.gestureCues.length === 1, 3000);
    expect(p.mixer.stateCues.some((c) => c.clipId === 'smile')).toBe(true);
    expect(p.played).toEqual([]);
  });

  it('硬打断清掉未触发的锚点定时器', async () => {
    const p = makePerformer({ pieceMs: 700 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一二三四五六<点头>七八');
    await waitFor(() => p.played.length === 1);
    void p.performer.preempt({ boundaryWindowMs: 0 });
    await vi.advanceTimersByTimeAsync(800);
    expect(p.mixer.gestureCues).toHaveLength(0);
  });
});

describe('Performer 礼让收束与外流账本', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('beginRound 是追加语义:新轮排在旧轮后面,都播完', async () => {
    const p = makePerformer({ pieceMs: 120 });
    cleanup.push(() => p.performer.stop());
    const h1 = p.performer.beginRound();
    h1.feed('第一轮的话。');
    h1.end();
    const h2 = p.performer.beginRound();
    h2.feed('第二轮的话。');
    h2.end();
    await waitFor(() => p.played.length === 2);
    expect(p.played).toEqual(['第一轮的话。', '第二轮的话。']);
  });

  it('preempt:在播片按 units 停顿处收束,账本记播出前缀;排队轮记 none', async () => {
    // 每单元 100ms,单元 4/5 之间有 400ms 停顿(1000ms 处结束,1400ms 处再开)
    const p = makePerformer({
      pieceMs: 2000,
      units: (text) =>
        segmentUnits(text).map((u, i) => {
          const start = i < 4 ? i * 0.25 : 1.4 + (i - 4) * 0.1;
          return { text: u, start, end: i < 4 ? start + 0.25 : start + 0.1 };
        }),
    });
    cleanup.push(() => p.performer.stop());
    const h1 = p.performer.beginRound({ callId: 'call-1' });
    h1.feed('一二三四五六七八');
    h1.end();
    const h2 = p.performer.beginRound({ callId: 'call-2' });
    h2.feed('排队的一轮');
    h2.end();
    await waitFor(() => p.played.length === 1);
    await vi.advanceTimersByTimeAsync(500); // 播放位 ~500ms(第二个单元中段)
    const preempting = p.performer.preempt();
    await waitFor(() => p.stops.length > 0);
    const outcomes = await preempting;
    expect(p.stops.length).toBeGreaterThan(0);
    const o1 = outcomes.find((o) => o.callId === 'call-1');
    const o2 = outcomes.find((o) => o.callId === 'call-2');
    expect(o1?.complete).toBe(false);
    // 停顿位于第 4 单元末(1000ms);收束点应覆盖第 3-4 单元。
    const spoken = o1?.pieces[0].spoken;
    expect(typeof spoken).toBe('number');
    expect(spoken as number).toBeGreaterThanOrEqual(2);
    expect(spoken as number).toBeLessThanOrEqual(4);
    expect(o2?.pieces[0].spoken).toBe('none');
    expect(o2?.complete).toBe(false);
  });

  it('preempt 后新轮照常开演;全播完的轮账本 complete=true', async () => {
    const p = makePerformer({ pieceMs: 100 });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound({ callId: 'done-1' });
    h.feed('很短。');
    h.end();
    await waitFor(() => p.played.length === 1 && p.performer.status().queuedBeats === 0);
    await waitFor(() => !p.performer.status().playing);
    const outcomes = await p.performer.preempt();
    // 已放完的轮也在 live 名单里(还没被 prune),但 complete=true 不需修订
    expect(outcomes.find((o) => o.callId === 'done-1')?.complete).toBe(true);
    const h2 = p.performer.beginRound();
    h2.feed('新话。');
    h2.end();
    await waitFor(() => p.played.includes('新话。'));
  });

  // 打断的作用域钉在调用时刻:晚于它开的轮一律不动。 World 那侧的栅栏来自
  // tap 见到 vtuber_interrupt 调用头的那一刻(见 module.test 的同名用例)。
  it('preempt 带栅栏:栅栏之后开的轮不受这次打断影响', async () => {
    const p = makePerformer({ pieceMs: 600 });
    cleanup.push(() => p.performer.stop());
    const h1 = p.performer.beginRound({ callId: 'old' });
    h1.feed('旧话说到一半。');
    h1.end();
    await waitFor(() => p.played.length === 1);
    const fence = p.performer.roundFence();
    const h2 = p.performer.beginRound({ callId: 'new' });
    h2.feed('新话。');
    h2.end();
    const preempting = p.performer.preempt({ maxRoundId: fence });
    await waitFor(() => p.stops.length > 0);
    const outcomes = await preempting;
    expect(outcomes.map((o) => o.callId)).toEqual(['old']);
    await waitFor(() => p.played.includes('新话。'), 6000);
  });

  it('drainCurrentPiece:等在播的这一片放完再让停机继续', async () => {
    const p = makePerformer({ pieceMs: 600 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一句要说完的话。');
    await waitFor(() => p.performer.status().playing);
    const draining = p.performer.drainCurrentPiece(5000);
    await vi.advanceTimersByTimeAsync(600);
    const waited = await draining;
    expect(waited).toBeGreaterThan(100);
    expect(p.performer.status().playing).toBe(false);
  });

  it('drainCurrentPiece:上限到了照断,不无限等', async () => {
    const p = makePerformer({ pieceMs: 5000 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一句很长的话。');
    await waitFor(() => p.performer.status().playing);
    const draining = p.performer.drainCurrentPiece(200);
    await vi.advanceTimersByTimeAsync(200);
    const waited = await draining;
    expect(waited).toBeLessThan(1000);
    expect(p.performer.status().playing).toBe(true);
  });

  /*
   * drainQueue 同时等待在播和排队内容，直到 speechBacklogMs 见底或达到期限。
   */
  it('drainQueue:在播的和排队的一起等完,积压见底才放行停机', async () => {
    const p = makePerformer({ pieceMs: 300 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('第一句话。【点头】第二句话。');
    await waitFor(() => p.performer.status().playing);
    const draining = p.performer.drainQueue(8000);
    await vi.advanceTimersByTimeAsync(8000);
    const waited = await draining;
    expect(waited).toBeGreaterThan(100);
    expect(p.performer.speechBacklogMs()).toBe(0);
    // 排队那片也播了,不是只等了在播的第一片
    expect(p.played).toContain('第二句话。');
  }, 15000);

  it('drainQueue:上限到了照断——排空预算必须装进 IO 收尾总预算', async () => {
    const p = makePerformer({ pieceMs: 5000 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('一句很长的话。');
    await waitFor(() => p.performer.status().playing);
    const draining = p.performer.drainQueue(200);
    await vi.advanceTimersByTimeAsync(200);
    const waited = await draining;
    expect(waited).toBeLessThan(1000);
    expect(p.performer.speechBacklogMs()).toBeGreaterThan(0);
    expect(p.performer.unplayedPieces()).toBe(1);
  });

  it('speechBacklogMs:在播剩余+排队估计,播完归零', async () => {
    const p = makePerformer({ pieceMs: 600 });
    cleanup.push(() => p.performer.stop());
    expect(p.performer.speechBacklogMs()).toBe(0);
    const h = p.performer.beginRound();
    h.feed('第一句话。【点头】第二句话。');
    h.end();
    await waitFor(() => p.played.length >= 1);
    const backlog = p.performer.speechBacklogMs();
    expect(backlog).toBeGreaterThan(300);
    await waitFor(() => p.played.length === 2 && p.performer.status().queuedBeats === 0, 6000);
    await waitFor(() => p.performer.speechBacklogMs() === 0);
    expect(p.performer.speechBacklogMs()).toBe(0);
  });

  it('estimateScriptMs:只算进 TTS 的正文,演出标记不占时长', () => {
    const p = makePerformer();
    cleanup.push(() => p.performer.stop());
    const bare = p.performer.estimateScriptMs('你好世界');
    expect(bare).toBeGreaterThan(0);
    // 【】<> [] 都不进 TTS 文本,估计值不该被它们抬高
    expect(p.performer.estimateScriptMs('【微笑,看向镜头】你好世界<点头>')).toBe(bare);
    expect(p.performer.estimateScriptMs('你好世界你好世界')).toBeGreaterThan(bare);
    expect(p.performer.estimateScriptMs('')).toBe(0);
  });

  it('播报水位:见底在下降沿报一次,初始空积压不报', async () => {
    const seen: string[] = [];
    const p = makePerformer({
      pieceMs: 600,
      onDrained: () => seen.push('drained'),
    });
    cleanup.push(() => p.performer.stop());
    // 初始空积压不触发 drained 报告。
    await vi.advanceTimersByTimeAsync(400);
    expect(seen).toEqual([]);
    p.performer.perform('一段话。');
    await waitFor(() => seen.includes('drained'), 6000);
    expect(seen).toEqual(['drained']);
  });
});

describe('Performer 音素感知切断', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('打断切在浊音上:按 PCM 分类走切断,衰减 20-70ms,不发固定淡出', async () => {
    const p = makeStreamPerformer({ align: false, withCut: true, toneHz: 200, unitMs: 120 });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed('今天想聊聊这个新游戏的手感到底怎么样\n');
    h.end();
    await waitFor(() => p.performer.status().playing);
    // 合成速度约为播放速度的 5 倍;等待切点进入已合成 PCM 区间。
    await vi.advanceTimersByTimeAsync(200);
    const preempting = p.performer.preempt();
    await vi.advanceTimersByTimeAsync(500);
    const outcomes = await preempting;
    expect(p.cuts.length).toBe(1);
    expect(p.cuts[0].cls).toBe('periodic');
    expect(p.cuts[0].fadeMs).toBeGreaterThanOrEqual(20);
    expect(p.cuts[0].fadeMs).toBeLessThanOrEqual(70);
    expect(p.stops).toEqual([]);
    expect(outcomes.length).toBe(1);
    expect(outcomes[0].complete).toBe(false);
  });

  it('切在静音上只做防点击收口', async () => {
    const p = makeStreamPerformer({ align: false, withCut: true, unitMs: 120 });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed('这一片的音频是全零的静音内容拿来当闭塞段\n');
    h.end();
    await waitFor(() => p.performer.status().playing);
    await vi.advanceTimersByTimeAsync(200);
    const preempting = p.performer.preempt();
    await vi.advanceTimersByTimeAsync(500);
    await preempting;
    expect(p.cuts.length).toBe(1);
    expect(p.cuts[0].cls).toBe('silence');
    expect(p.cuts[0].fadeMs).toBeLessThanOrEqual(10);
    expect(p.stops).toEqual([]);
  });
});

describe('Performer 跑飞的合成', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  /**
   * 三单元的短句,合成却跑到 20 秒:这才是门要拦的形状。
   *
   * 预算全由文本 + 当前速率算出(这里没接实测,用冷启动常数 400ms/单元):
   * 3 单元 × 400 + 引 500,×1.6 = 2720ms;掐流的宽容界再取 max(预算+4000,
   * 预算×1.8) = 6720ms。两个数都不含这一片自己的任何测量。
   */
  const RUNAWAY = '跑飞了';
  const RUNAWAY_MS = 20000;
  /** 上面那句的预算 */
  const RUNAWAY_BUDGET_MS = overrunBudget(RUNAWAY).estMs;
  /** 上面那句掐流的宽容界 */
  const RUNAWAY_CUT_MS = overrunBudget(RUNAWAY).cutMs;
  const LONG = '前面这一句念得久一点好让后面那句在轮到它之前就已经把流收完了对吧';
  /**
   * 长文本夹具的宽容界超过服务端 32 秒硬上限，覆盖仅靠预算掐流无法检出的服务端截停。
   */
  const CAPPED = '这一句得写得足够长才好让它的宽容界越过服务端那条硬上限不然掐流会先一步把整条流截断掉';
  /** server 侧硬上限(orchestrator TTS_SERVER_MAX_AUDIO_MS 同值) */
  const SERVER_CAP_MS = 32000;

  /*
   * 预算边界样本来自实测记录，每项为 [单元数, 停顿毫秒, 实测毫秒]；包含音频按 160ms 量化造成的边缘超出。
   */
  const CUT_SAMPLES_0827: ReadonlyArray<readonly [number, number, number]> = [
    [29,3810,27200], [17,3210,18400], [14,1910,13760], [7,1710,9120], [10,1140,9760], [18,3040,18720],
    [26,2670,22880], [15,2670,16000], [9,1140,9120], [9,970,8800], [16,1900,15040], [23,1340,18240],
    [9,1140,9120], [9,2470,11840], [19,3210,19680], [12,1540,11840], [1,1140,4640], [9,1140,9120],
    [12,970,10560], [9,1140,9120], [34,2100,26720], [33,3240,28480], [19,2270,17760], [26,2300,22080],
    [10,1140,9760], [9,970,8800], [10,1540,10560], [21,2270,18880], [24,3210,22720], [14,2640,15360],
    [3,1140,5600], [23,1900,19360], [13,1700,12800], [17,3210,18400], [5,200,5120], [14,1500,12960],
    [20,2640,19040], [4,1140,6080], [12,1710,12160], [10,2070,11680], [17,2640,17280], [9,1140,9120],
    [19,1710,16480], [15,1700,14080], [21,2300,19040], [19,2270,17760], [8,1710,9600], [7,1710,9120],
    [8,1140,8480], [20,2270,18400], [12,2850,14560], [9,1710,10240], [11,2280,12800], [7,2280,10240],
    [10,1710,10880], [13,1540,12480], [12,1710,12160], [17,3780,19520], [7,2280,10240], [4,1710,7200],
    [8,2280,10880], [3,1140,5600], [16,3780,19040], [9,1710,10240], [3,1140,5600], [9,970,8800],
    [14,2110,14240], [10,3780,15200], [11,3780,15840], [12,1710,12160], [2,2070,6720], [1,570,3840],
    [4,2640,9120], [7,2280,10240], [18,3210,19040], [13,2270,13920], [5,1140,6560], [3,1140,5600],
    [11,2100,12320], [12,1900,12480], [10,1340,10080], [3,1140,5600], [13,1340,12000], [3,1140,5600],
    [7,3420,12640], [8,2280,10880], [4,1140,6080], [16,2840,16960], [13,2640,14720], [14,2840,15840],
    [20,2640,19040], [17,3780,19520], [18,3610,19840], [3,400,4480], [22,1140,17280],
  ];

  it('预算常数:边界样本不误掐,真跑飞仍被拦', () => {
    const stillCut = CUT_SAMPLES_0827.filter(
      ([units, pauseMs, actualMs]) => actualMs > overrunBudgetOf(units, pauseMs).cutMs,
    );
    expect(stillCut).toHaveLength(0);
    // 真跑飞的形状:短文本合到服务端 32 秒上限,超的是数量级,照拦不误
    for (const [units, pauseMs] of [[1, 0], [3, 570], [8, 1140]] as const) {
      expect(32_000).toBeGreaterThan(overrunBudgetOf(units, pauseMs).cutMs * 2);
    }
    // 门仍是纯文本函数:同一段话两次算出同一对数
    expect(overrunBudget(RUNAWAY)).toEqual(overrunBudget(RUNAWAY));
  });

  /*
   * 实测/预算比为 1.38 的长尾正常片应保持在宽容界内。
   */
  it('宽容界放宽:p99(实测/预算 = 1.38)的正常片一片都碰不到界', () => {
    const P99_RATIO = 1.38;
    const stillCut = CUT_SAMPLES_0827.filter(([units, pauseMs]) => {
      const b = overrunBudgetOf(units, pauseMs);
      return b.estMs * P99_RATIO > b.cutMs;
    });
    expect(stillCut).toHaveLength(0);
    // 短句靠 +4000ms 的绝对项,长句靠 ×1.8 —— 两头都在 p99 之上留出身位
    expect(overrunBudgetOf(1, 0).cutMs / overrunBudgetOf(1, 0).estMs).toBeGreaterThan(P99_RATIO);
    expect(overrunBudgetOf(60, 5000).cutMs / overrunBudgetOf(60, 5000).estMs).toBeGreaterThan(P99_RATIO);
  });

  it('真跑飞的片:流掐在宽容界上,尾巴不再合成', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 100, fastStream: true,
      runaway: { text: RUNAWAY, totalMs: RUNAWAY_MS },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`${LONG}【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.played.length === 2, 12000);
    await waitFor(() => p.played[1].endedAt !== undefined, 12000);
    const heard = p.played[1].endedAt! - p.played[1].startedAt;
    expect(heard).toBeGreaterThan(RUNAWAY_CUT_MS - 400);
    expect(heard).toBeLessThan(RUNAWAY_CUT_MS + 800);
  }, 30000);

  /*
   * 末级裁尾同时要求对齐判废、未被本地截流、音频达到 server 硬上限，以及实测时长超过文本预算。
   */
  it('对齐判废+撞上 server 时长上限:掐掉未播出的尾巴,切点不早于最后对得上的单元', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, withCut: true, chunkMs: 200,
      runaway: { text: CAPPED, totalMs: SERVER_CAP_MS },
      alignBad: { text: CAPPED, lastGoodEndMs: 900 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`【微笑】${CAPPED}`);
    h.end();
    await waitFor(() => p.cuts.length === 1, 20000);
    // 切点在「最后对得上的单元末尾」之后、总时长之前:垃圾尾巴被省掉
    expect(p.cuts[0].atMs).toBeGreaterThanOrEqual(900);
    expect(p.cuts[0].atMs).toBeLessThan(SERVER_CAP_MS);
    expect(p.traces.some((t) => t.tally === '跑飞止损')).toBe(true);
  }, 40000);

  /*
   * 夹具超预算 960ms，但远未到服务端上限；对齐判废与小幅超预算不能单独证明跑飞，须播完。
   */
  it('对齐判废+超预算但没撞上限:不掐(超预算不是跑飞签名)', async () => {
    const totalMs = RUNAWAY_BUDGET_MS + 960;
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, withCut: true,
      runaway: { text: RUNAWAY, totalMs },
      alignBad: { text: RUNAWAY, lastGoodEndMs: 900 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.played.length === 1 && p.played[0].endedAt !== undefined, 12000);
    expect(p.cuts).toHaveLength(0);
    expect(p.traces.some((t) => t.tally === '跑飞止损')).toBe(false);
  }, 30000);

  /*
   * 已掐流片的 durationMs 来自裁剪结果，不能再用它证明需要二次裁剪；已接收部分保留播放。
   */
  it('对齐判废+撞上限,但流已被掐流截断:不再二次裁', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, withCut: true, chunkMs: 200,
      runaway: { text: CAPPED, totalMs: overrunBudget(CAPPED).cutMs + 1000 },
      alignBad: { text: CAPPED, lastGoodEndMs: 900 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`【微笑】${CAPPED}`);
    h.end();
    await waitFor(() => p.traces.some((t) => t.tally === '掐流'), 20000);
    expect(p.cuts).toHaveLength(0);
    expect(p.traces.some((t) => t.tally === '跑飞止损')).toBe(false);
  }, 40000);

  /*
   * 超大连续静默按音频实测定位切点，不能仅凭笑腔、拖音或对齐异常认定应丢弃。
   */
  it('超大静默段(在播):切在静默段起点,不等宽容界', async () => {
    // 20ms 流块使静默检出晚于开播，覆盖在播裁断。
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, withCut: true,
      silence: { text: CAPPED, startMs: 3000 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`【微笑】${CAPPED}`);
    h.end();
    await waitFor(() => p.cuts.length === 1, 20000);
    expect(p.cuts[0].atMs).toBe(3000);
    expect(p.traces.some((t) => t.tally === '静默止损')).toBe(true);
    // 掐的理由印的是静默,不是预算:CAPPED 的宽容界 49824ms 根本没被碰到
    const line = p.traces.find((t) => t.tally === '静默掐流');
    expect(line?.msg).toContain('最长 4000ms @ 起点 3000ms');
  }, 40000);

  /*
   * 预取时就收完流的时序:这一段还没开播,死气还压在积压分块里——那就一个字节
   * 都别送进声卡。观众听到的是 3 秒话音,不是 3 秒话音加 4 秒哑场。
   */
  it('超大静默段(未开播):死气不进声卡,交给会话的时长就是静默起点', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 100, withCut: true, fastStream: true,
      silence: { text: CAPPED, startMs: 3000 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`${LONG}【微笑】${CAPPED}`);
    h.end();
    await waitFor(() => p.played.length === 2 && p.played[1].endedAt !== undefined, 20000);
    expect(p.cuts).toHaveLength(0);
    const heard = p.played[1].endedAt! - p.played[1].startedAt;
    expect(heard).toBeGreaterThan(2600);
    expect(heard).toBeLessThan(3600);
    expect(p.traces.some((t) => t.msg.includes('死气未进声卡'))).toBe(true);
  }, 40000);

  /*
   * 静默从近零开始并覆盖几乎整片时，未开播内容整片作废，不送声卡或字幕。
   */
  it('整片死气(起点 0、覆盖 100%,未开播):整片作废,不进声卡也不发字幕', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 100, withCut: true, fastStream: true,
      silence: { text: CAPPED, startMs: 0 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`${LONG}【微笑】${CAPPED}`);
    h.end();
    await waitFor(() => p.traces.some((t) => t.tally === '死片'), 20000);
    // 死片不该卡住演出泵:第一片照常播完,第二片被整体跳过(播放会话从未开启)
    await waitFor(() => p.played.length === 1 && p.played[0].endedAt !== undefined, 20000);
    expect(p.played).toHaveLength(1);
    expect(p.subtitles.some((s) => s.text === CAPPED)).toBe(false);
    expect(p.cuts).toHaveLength(0);
    expect(p.performer.speechBacklogMs()).toBe(0);
  }, 40000);

  it('对齐判废但时长没过预算:单签不掐(音频可能只是念得含糊)', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, withCut: true,
      alignBad: { text: RUNAWAY, lastGoodEndMs: 60 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.played.length === 1 && p.played[0].endedAt !== undefined, 12000);
    expect(p.cuts).toHaveLength(0);
    expect(p.traces.some((t) => t.tally === '跑飞止损')).toBe(false);
  }, 30000);

  /*
   * 仅超预算一两百毫秒的边缘片仍须原样播放。
   */
  it('边缘片:超预算一百多毫秒照样过门,不掐流也不裁尾', async () => {
    const overshoot = 160;
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 50, withCut: true,
      runaway: { text: RUNAWAY, totalMs: RUNAWAY_BUDGET_MS + overshoot },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`短的一句【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.played.length === 2 && p.played[1].endedAt !== undefined, 12000);
    expect(p.cuts).toHaveLength(0);
    expect(p.traces.some((t) => t.msg.includes('跑飞的片'))).toBe(false);
    expect(p.played[1].endedAt! - p.played[1].startedAt).toBeGreaterThan(RUNAWAY_BUDGET_MS);
  }, 30000);

  /*
   * 对齐末端不能反向收紧文本预算；3 秒音频未超过 6720ms 宽容界时不得截尾。
   */
  it('单元表不当上界:对齐末端早于文本估计,也不许掐没过界的音频', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 50, withCut: true,
      runaway: { text: RUNAWAY, totalMs: 3000 },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`短的一句【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.played.length === 2 && p.played[1].endedAt !== undefined, 12000);
    // 夹具的单元表只覆盖 150ms（3 单元各 50ms），实际音频仍须播放完整。
    expect(p.cuts).toHaveLength(0);
    expect(p.played[1].endedAt! - p.played[1].startedAt).toBeGreaterThan(2500);
    expect(p.traces.some((t) => t.msg.includes('跑飞的片'))).toBe(false);
  }, 30000);

  /*
   * 流被掐断后，不再回头裁掉已合成的音频。
   */
  it('掐流之后不再回头裁已合成的音频', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 50, withCut: true,
      runaway: { text: RUNAWAY, totalMs: RUNAWAY_MS },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`短的一句【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.traces.some((t) => t.msg.includes('流已掐断')), 12000);
    await waitFor(() => p.played.length === 2 && p.played[1].endedAt !== undefined, 12000);
    expect(p.cuts).toHaveLength(0);
    // 收到多少播多少:掐在宽容界上,不再往回削
    expect(p.played[1].endedAt! - p.played[1].startedAt).toBeGreaterThan(RUNAWAY_CUT_MS - 400);
  }, 30000);

  /*
   * 编排器的速率只从 speechRate 注入，不用自身刚播放的片回调预算；外部速率不变时，同一文本预算不变。
   */
  it('编排器不自我校准:跑过几片之后同一段文本估出同一个数(速率没变的前提下)', async () => {
    const p = makeStreamPerformer({ align: true, unitsOnDone: true, unitMs: 50 });
    cleanup.push(() => p.performer.stop());
    const before = p.performer.estimateScriptMs(LONG);
    const h = p.performer.beginRound();
    h.feed(`短的一句【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.played.length === 2 && p.played[1].endedAt !== undefined, 12000);
    expect(p.performer.estimateScriptMs(LONG)).toBe(before);
  }, 30000);


  it('掐流文案印预算/实测/超出三个数,超出量不是预算本身', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 100, fastStream: true,
      runaway: { text: RUNAWAY, totalMs: RUNAWAY_MS },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`${LONG}【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.traces.some((t) => t.msg.includes('流已掐断')), 12000);
    const line = p.traces.find((t) => t.msg.includes('流已掐断'));
    const m = /预算 (\d+)ms \/ 实测 (\d+)ms \/ 超出 (-?\d+)ms/.exec(line!.msg);
    expect(m).not.toBeNull();
    const [budget, actual, over] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(budget).toBe(RUNAWAY_BUDGET_MS);
    expect(Math.abs(over - (actual - budget))).toBeLessThanOrEqual(1);
    // 掐在宽容界上,实测不该越过它太多
    expect(actual).toBeLessThan(RUNAWAY_CUT_MS + 800);
  }, 30000);

  it('掐流走 warn 口径,汇进「掐流」桶', async () => {
    const p = makeStreamPerformer({
      align: true, unitsOnDone: true, unitMs: 100, fastStream: true,
      runaway: { text: RUNAWAY, totalMs: RUNAWAY_MS },
    });
    cleanup.push(() => p.performer.stop());
    const h = p.performer.beginRound();
    h.feed(`${LONG}【微笑】${RUNAWAY}`);
    h.end();
    await waitFor(() => p.traces.some((t) => t.msg.includes('跑飞的片')), 12000);
    const cut = p.traces.filter((t) => t.msg.includes('跑飞的片'));
    expect(cut.every((t) => t.level === 'warn' && t.tally === '掐流' && t.event === 'overrun-cut')).toBe(true);
    // 三个数以结构化字段随行:预算、实测、超出、宽容界
    const cutData = cut[0].data as { budgetMs: number; actualMs: number; overMs: number; cutMs: number };
    expect(cutData.actualMs - cutData.budgetMs).toBe(cutData.overMs);
    // 流在宽容界处被掐:实测落在界上或界外
    expect(cutData.actualMs).toBeGreaterThanOrEqual(cutData.cutMs);
    // 预算埋点同一片一条「掐」,带完整预算构成
    const budget = p.traces.find((t) => t.area === 'TTS预算' && t.event === 'cut');
    expect(budget?.data).toMatchObject({
      actualMs: cutData.actualMs, budgetMs: cutData.budgetMs, cutMs: cutData.cutMs, tolerance: 1.6, leadInMs: 500,
    });
    expect(typeof budget?.data?.units).toBe('number');
    // 流水事件(合成/收流)不因此变吵;收流耗时与音频时长以结构化字段随行
    const received = p.traces.filter((t) => t.event === 'stream-received');
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((t) => t.level === undefined)).toBe(true);
    const recv = received[0].data as { recvMs: number; audioMs: number; truncated: boolean; silenceCut: boolean };
    expect(typeof recv.recvMs).toBe('number');
    expect(recv.audioMs).toBeGreaterThan(0);
    expect(received.some((t) => (t.data as { truncated: boolean }).truncated)).toBe(true);
  }, 30000);
});

/*
 * 字幕估计、预算和锚点死线使用同一语速来源；样本不足时统一回落 BUDGET_MS_PER_UNIT，埋点注明采用实测或默认值。
 */
describe('Performer 语速口径(speech-rate 接进估计路径)', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  const measured = (msPerUnit: number, samples = 40): SpeechRateHint => ({
    msPerUnit,
    measured: true,
    samples,
  });

  it('预算按传入速率算,不传时用冷启动常数;埋点分项印的是实际用的那个数', () => {
    const text = '这一句用来算预算,里面有停顿。';
    const cold = overrunBudget(text);
    const warm = overrunBudget(text, 520);
    expect(cold.msPerUnit).toBe(BUDGET_MS_PER_UNIT);
    expect(warm.msPerUnit).toBe(520);
    expect(warm.estMs).toBeGreaterThan(cold.estMs);
    // 速率显式传参,函数本身仍是纯的:同一对(文本,速率)两次算出同一组数
    expect(overrunBudget(text, 520)).toEqual(warm);
    expect(overrunBudgetOf(cold.units, cold.pauseMs, 520).estMs).toBe(warm.estMs);
    // 417ms 实测速率与 400ms 默认值接近，预算变化也应有限。
    expect(overrunBudget(text, 417).cutMs / cold.cutMs).toBeLessThan(1.1);
  });

  it('回执时长估计随实测速率走,冷启动回落常数', () => {
    let hint: SpeechRateHint = { msPerUnit: BUDGET_MS_PER_UNIT, measured: false, samples: 0 };
    const p = makeStreamPerformer({ align: true, speechRate: () => hint });
    cleanup.push(() => p.performer.stop());
    const script = '一二三四五六七八九十。';
    expect(p.performer.estimateScriptMs(script)).toBe(SPEECH_LEAD_IN_MS + 10 * BUDGET_MS_PER_UNIT);
    hint = measured(600);
    expect(p.performer.estimateScriptMs(script)).toBe(SPEECH_LEAD_IN_MS + 10 * 600);
  });

  it('实测数不合法(NaN / 离谱大 / 零)时按没接处理,回落常数', () => {
    for (const bad of [Number.NaN, 0, -30, 99_999]) {
      const p = makeStreamPerformer({
        align: true,
        speechRate: () => ({ msPerUnit: bad, measured: true, samples: 40 }),
      });
      cleanup.push(() => p.performer.stop());
      expect(p.performer.estimateScriptMs('一二三四五')).toBe(SPEECH_LEAD_IN_MS + 5 * BUDGET_MS_PER_UNIT);
    }
  });

  /*
   * 流式开播早于收流，seg.result 尚为空，字幕先走估计档；该档也须使用注入的实测速率。
   */
  it('字幕 estimate 档:cue 时刻按实测速率排,比常数档更靠后', async () => {
    const text = '第一句在这里。第二句在这里。';
    // unitMs=300:合成 3.6s 音频要 180 块,开播(轮首 400ms gap)那一刻流必然没收完
    const run = async (rate?: SpeechRateHint) => {
      const p = makeStreamPerformer({
        align: true,
        unitsOnDone: false,
        unitMs: 300,
        ...(rate ? { speechRate: () => rate } : {}),
      });
      cleanup.push(() => p.performer.stop());
      p.performer.perform(text);
      await waitFor(() => p.subtitles.length > 0, 6000);
      return p;
    };

    // 句末标点在 TTS 中形成真实停顿；下一条 cue 起点加入与预算路径同源的停顿先验。
    const pausePrior = overrunBudget('第一句在这里。').pauseMs;
    expect(pausePrior).toBeGreaterThan(0);

    const cold = await run();
    expect(cold.subtitles[0].basis).toBe('estimate');
    expect(cold.subtitles[0].cues).toHaveLength(2);
    // 「第一句在这里」6 单元 → 第二条从 引子 + 6×常数 + 句末停顿先验 起
    // (atMs 已换到接收坐标,与开播坐标差的是 started 兑现到发出之间的一两毫秒)
    expect(cold.subtitles[0].cues[1].atMs).toBeCloseTo(SPEECH_LEAD_IN_MS + 6 * BUDGET_MS_PER_UNIT + pausePrior, -1);

    const warm = await run(measured(600));
    expect(warm.subtitles[0].basis).toBe('estimate');
    expect(warm.subtitles[0].cues[1].atMs).toBeCloseTo(SPEECH_LEAD_IN_MS + 6 * 600 + pausePrior, -1);
    expect(warm.subtitles[0].cues[1].atMs).toBeGreaterThan(cold.subtitles[0].cues[1].atMs);
  }, 20000);

  /*
   * 开播时对齐尚未完成，先使用估计字幕；收流后重发仍处于显示区间的 cue，并保留当前正在念、atMs 为负的那条。
   */
  it('收流后重发字幕时间轴:开播走估计档,对齐到手重发仍在显示区间内的 cue,正在念的那条带负 atMs', async () => {
    const text = '第一句在这里。第二句在这里。';
    // unitMs=1000:第二条 cue 的对齐时刻在 6s;合成流的墙钟远早于它、又晚于开播
    const p = makeStreamPerformer({ align: true, unitsOnDone: true, unitMs: 1000, chunkMs: 60 });
    cleanup.push(() => p.performer.stop());
    p.performer.perform(text);
    await waitFor(() => p.subtitles.length >= 2, 10000);
    expect(p.subtitles[0].basis).toBe('estimate');
    const re = p.subtitles[1];
    expect(re.basis).toBe('align');
    expect(re.text).toBe(text);
    expect(re.cues.map((c) => c.text)).toEqual(['第一句在这里。', '第二句在这里。']);
    // 首条 cue 的对齐时刻是 0,正在念:atMs 为负,绝对值 = 开播以来已过的时间
    const elapsed = re.at - p.played[0].startedAt;
    expect(re.cues[0].atMs).toBeLessThan(0);
    expect(Math.abs(re.cues[0].atMs + elapsed)).toBeLessThan(150);
    expect(Math.abs(re.cues[1].atMs - (6000 - elapsed))).toBeLessThan(150);
    const resend = p.traces.find((t) => t.area === '字幕' && t.msg.includes('收流重发'));
    // 时间轴一行的数字以结构化字段随行:摘要七个数 + 时刻来源 + 重发坐标偏移
    expect(resend).toMatchObject({
      event: 'resend',
      data: { basis: 'align', kind: 'realign', cues: 2, chars: text.length, firstAtMs: 0, live: 2 },
    });
    const data = resend!.data as { spanMs: number; speakMs: number; padMs: number; shiftMs: number; units: number; totalUnits: number };
    // 全量对齐:单元表覆盖整句
    expect(data.units).toBe(data.totalUnits);
    expect(data.totalUnits).toBeGreaterThan(0);
    expect(data.spanMs).toBeGreaterThan(0);
    expect(data.speakMs).toBeGreaterThan(0);
    expect(data.padMs).toBeGreaterThanOrEqual(0);
    expect(data.shiftMs).toBeLessThan(0);
  }, 20000);

  it('cue 时刻换到接收坐标:声卡给出的开播时刻在未来时整批顺延同样多', async () => {
    const lead = 700;
    const p = makeStreamPerformer({ align: true, unitsOnDone: false, unitMs: 300, startLeadMs: lead });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('第一句在这里。第二句在这里。');
    await waitFor(() => p.subtitles.length > 0, 6000);
    const first = p.subtitles[0];
    expect(first.basis).toBe('estimate');
    // 估计档首条在开播 +500ms;开播本身在接收之后 lead ms
    expect(Math.abs(first.cues[0].atMs - (SPEECH_LEAD_IN_MS + lead))).toBeLessThan(100);
    const line = p.traces.find((t) => t.area === '字幕')!;
    expect(line.msg).toMatch(/开播于 \+\d+ms/);
    expect(line).toMatchObject({ event: 'timeline', data: { basis: 'estimate', kind: 'open', rateMeasured: false } });
    expect((line.data as { shiftMs: number }).shiftMs).toBeGreaterThan(0);
  });

  /*
   * 合成头领先播放头；收流前得到前缀对齐时即可重发已有音频范围内 cue 的真实时刻。
   */
  it('播放中前缀对齐到手就重发:cue 在收流之前换到真实时刻,只送到边界单元为止', async () => {
    const text = '第一句在这里。第二句在这里。第三句在这里。';
    const unitMs = 500;
    const requested: number[] = [];
    const p = makeStreamPerformer({
      align: true,
      unitsOnDone: true,
      unitMs,
      alignPcm: async (_pcm, _sr, units) => {
        requested.push(units.length);
        return units.map((u, i) => ({ text: u, start: (i * unitMs) / 1000, end: ((i + 1) * unitMs) / 1000 }));
      },
    });
    cleanup.push(() => p.performer.stop());
    p.performer.perform(text);
    await waitFor(() => p.subtitles.some((s) => s.basis === 'prefix'), 8000);
    const track = p.subtitles.find((s) => s.basis === 'prefix')!;
    // 收流(全量对齐)还没到:跟播先于它
    expect(p.subtitles.findIndex((s) => s.basis === 'align')).toBe(-1);
    // 第一个边界 = 第二句起点(第 6 个单元),连它自己一起送去对齐:7 个单元
    expect(requested[0]).toBe(7);
    // 首条还在不在批里取决于重发时刻是否已过它的显示区间;后两条必在
    expect(track.cues.map((c) => c.text).slice(-2)).toEqual(['第二句在这里。', '第三句在这里。']);
    // 第二句起点换到真实时刻 6×500=3000ms(估计档会排在 500+6×400+570=3470)
    const elapsed = track.at - p.played[0].startedAt;
    const second = track.cues.find((c) => c.text === '第二句在这里。')!;
    expect(Math.abs(second.atMs - (6 * unitMs - elapsed))).toBeLessThan(150);
    expect(p.traces.some((t) => t.area === '字幕' && t.msg.includes('跟播重发') && t.msg.includes('7/18 单元'))).toBe(true);
    // 收流后仍以全量对齐收尾
    await waitFor(() => p.subtitles.some((s) => s.basis === 'align'), 10000);
  }, 20000);

  it('字幕埋点写明这一片的时间源:估计档要能分出「实测分位」还是「常数回落」', async () => {
    const warm = makeStreamPerformer({
      align: true, unitsOnDone: false, unitMs: 300, speechRate: () => measured(430, 51),
    });
    cleanup.push(() => warm.performer.stop());
    warm.performer.perform('第一句在这里。第二句在这里。');
    await waitFor(() => warm.traces.some((t) => t.area === '字幕'), 6000);
    const warmLine = warm.traces.find((t) => t.area === '字幕')!.msg;
    expect(warmLine).toContain('校准估计');
    expect(warmLine).toContain('实测 430ms/单元(近期 51 片)');

    const cold = makeStreamPerformer({ align: true, unitsOnDone: false, unitMs: 300 });
    cleanup.push(() => cold.performer.stop());
    cold.performer.perform('第一句在这里。第二句在这里。');
    await waitFor(() => cold.traces.some((t) => t.area === '字幕'), 6000);
    const coldLine = cold.traces.find((t) => t.area === '字幕')!.msg;
    expect(coldLine).toContain(`常数回落 ${BUDGET_MS_PER_UNIT}ms/单元`);
    expect(coldLine).toContain('不足');

    // 对齐档不挂速率说明:那一片的时刻是量出来的,速率没参与
    expect(describeSpeechRate(measured(430, 51))).toBe('实测 430ms/单元(近期 51 片)');
  }, 20000);

  it('锚点估计死线也走同一份实测速率', async () => {
    // unitsOnDone=false 且 alignPcm 恒 null:锚点只能靠估计死线
    const p = makeStreamPerformer({
      align: true, unitsOnDone: false, alignPcm: async () => null, unitMs: 150,
      speechRate: () => measured(150),
    });
    cleanup.push(() => p.performer.stop());
    p.performer.perform('你好世界<点头>后面还有很长很长的一段话要说完');
    await waitFor(() => p.mixer.gestureCues.length === 1, 6000);
    // unitIndex 4:实测档 500 + 4×150 = 1100ms;常数档会是 500 + 4×400 = 2100ms
    const dt = p.mixer.gestureCues[0].startTs - p.played[0].startedAt;
    expect(dt).toBeGreaterThan(900);
    expect(dt).toBeLessThan(1600);
  }, 20000);
});
