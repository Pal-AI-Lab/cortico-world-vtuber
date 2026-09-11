import { describe, it, expect, afterEach, vi } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import {
  DeviceAudioSink,
  mirrorRetarget,
  pickPlaybackHit,
  rotatePreferFirst,
  samePlaybackTarget,
  secondaryPickQuery,
  shouldMirrorSystem,
  spreadChannels,
} from '../../src/device-audio.ts';
import type { CutPlan } from '../../src/interrupt-fade.ts';
import { pcm16ToWav, type TtsPiece, Envelope } from '../../src/tts.ts';

const SR = 16000;

/** durationMs 的静音 PCM16LE 字节 */
function silencePcm(durationMs: number): Uint8Array {
  return new Uint8Array(Math.round((durationMs / 1000) * SR) * 2);
}

function fakePiece(durationMs: number): TtsPiece {
  return {
    text: '测试片',
    wav: pcm16ToWav([silencePcm(durationMs)], SR),
    durationMs,
    envelope: new Envelope(new Float32Array([0.5]), 20),
  };
}

/** 全程 silent 模式('none'):时间线照常推进,只是不碰真设备 */
function makeSink() {
  const sink = new DeviceAudioSink(nullLogger(), {
    device: () => 'none',
  });
  return { sink };
}

describe('DeviceAudioSink(静音时间线)', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('play:开播时刻在写入点附近,播毕按时长到来', async () => {
    const { sink } = makeSink();
    cleanup.push(() => sink.close());
    const t0 = Date.now();
    const { startedAt, ended } = await sink.play(fakePiece(200));
    expect(startedAt).toBeGreaterThanOrEqual(t0 - 5);
    expect(startedAt).toBeLessThan(t0 + 250);
    const endTs = await ended;
    expect(endTs - t0).toBeGreaterThanOrEqual(150);
    expect(endTs - t0).toBeLessThan(700);
  });

  it('beginStream:分块推进,end 后播毕在最后样本处', async () => {
    const { sink } = makeSink();
    cleanup.push(() => sink.close());
    const t0 = Date.now();
    const session = sink.beginStream(SR, '流式片');
    session.push(silencePcm(100));
    session.push(silencePcm(100));
    session.end(200);
    const startedAt = await session.started;
    const endTs = await session.ended;
    expect(startedAt).toBeLessThan(endTs);
    expect(endTs - t0).toBeGreaterThanOrEqual(150);
    expect(endTs - t0).toBeLessThan(700);
  });

  it('stop:队列剩余被收口,播毕立即 resolve', async () => {
    const { sink } = makeSink();
    cleanup.push(() => sink.close());
    const session = sink.beginStream(SR, '很长的片');
    session.push(silencePcm(2000));
    session.end(2000);
    await session.started;
    const t0 = Date.now();
    sink.stop(50);
    const endTs = await session.ended;
    expect(endTs - t0).toBeLessThan(200);
  });

  it('cut:切点后的内容换成尾巴,播毕远早于全片', async () => {
    const { sink } = makeSink();
    cleanup.push(() => sink.close());
    const session = sink.beginStream(SR, '要被切断的片');
    session.push(silencePcm(2000));
    session.end(2000);
    await session.started;
    const plan: CutPlan = { cls: 'silence', fadeMs: 40, sampleRate: SR, tailPcm: silencePcm(40) };
    // 切点取在写入领先量之外(AHEAD 100ms + 余量)
    expect(sink.cut(300, plan)).toBe(true);
    const t0 = Date.now();
    const endTs = await session.ended;
    // 全片 2000ms;在 300ms 切分并保留 40ms 衰减段,应在约 350ms 内结束。
    expect(endTs - t0).toBeLessThan(800);
  });

  it('spreadChannels:单声道铺满两路,左右同响', () => {
    const out = spreadChannels(new Int16Array([100, -200, 300]), 2);
    expect([...out]).toEqual([100, 100, -200, -200, 300, 300]);
  });

  it('pickPlaybackHit:精确名优先于 Hands-Free 子串', () => {
    const devices = [
      { id: 1, name: 'Headphones (Buds4 Hands-Free AG Audio)', outputChannels: 1 },
      { id: 2, name: 'Headphones (Buds4)', outputChannels: 2 },
      { id: 3, name: 'CABLE Input (VB-Audio Virtual Cable)', outputChannels: 2 },
    ];
    expect(pickPlaybackHit(devices, 'Headphones (Buds4)', 1)?.id).toBe(2);
    expect(pickPlaybackHit(devices, 'Buds4', 1)?.id).toBe(2);
    expect(pickPlaybackHit(devices, '', 2)?.id).toBe(2);
    expect(pickPlaybackHit(devices, 'CABLE Input', 2)?.id).toBe(3);
  });

  it('pickPlaybackHit:DS 表的 ANSI 乱码名按 ASCII 折叠仍能命中', () => {
    // WASAPI 配置名 "Headphones (一弛 的 Buds4)" 在 DirectSound 表里枚举成
    // "Headphones (?? ? Buds4)":非 ASCII 全变 '?',按原名匹配落空,DS 兜底从未上场。
    const dsTable = [
      { id: 129, name: 'Primary Sound Driver', outputChannels: 2 },
      { id: 130, name: 'Headphones (?? ? Buds4)', outputChannels: 2 },
      { id: 133, name: 'Speakers (C7 usb audio)', outputChannels: 2 },
    ];
    expect(pickPlaybackHit(dsTable, 'Headphones (一弛 的 Buds4)', 129)?.id).toBe(130);
    // 反向也成立:配置存了乱码名、对着 WASAPI 表也能折回去
    const wasapiTable = [
      { id: 130, name: 'Headphones (一弛 的 Buds4)', outputChannels: 2 },
      { id: 133, name: 'Speakers (C7 usb audio)', outputChannels: 2 },
    ];
    expect(pickPlaybackHit(wasapiTable, 'Headphones (?? ? Buds4)', 133)?.id).toBe(130);
    // 折叠后为空的查询串(纯非 ASCII)不许乱配
    expect(pickPlaybackHit(dsTable, '一弛的', 129)).toBeUndefined();
    // 折叠命中多条时仍避开通话端点
    const both = [
      { id: 1, name: 'Headset (?? ? Buds4 Hands-Free AG Audio)', outputChannels: 1 },
      { id: 2, name: 'Headphones (?? ? Buds4)', outputChannels: 2 },
    ];
    expect(pickPlaybackHit(both, '一弛 Buds4', 1)?.id).toBe(2);
  });

  it('rotatePreferFirst:刚死的后端放到最后,主副同一份顺序', () => {
    expect(rotatePreferFirst(['wasapi', 'ds'] as const)).toEqual(['wasapi', 'ds']);
    expect(rotatePreferFirst(['wasapi', 'ds'] as const, 'wasapi')).toEqual(['ds', 'wasapi']);
    expect(rotatePreferFirst(['wasapi', 'ds'] as const, 'ds')).toEqual(['wasapi', 'ds']);
  });

  it('samePlaybackTarget:主副查询落到同一台设备才算撞车', () => {
    const devices = [
      { id: 2, name: 'Headphones (Buds4)', outputChannels: 2 },
      { id: 3, name: 'CABLE Input (VB-Audio Virtual Cable)', outputChannels: 2 },
    ];
    expect(samePlaybackTarget(devices, 2, 'CABLE Input', 'Headphones (Buds4)')).toBe(false);
    expect(samePlaybackTarget(devices, 2, 'Headphones (Buds4)', 'CABLE Input')).toBe(false);
    expect(samePlaybackTarget(devices, 2, '', 'Headphones (Buds4)')).toBe(true);
    expect(samePlaybackTarget(devices, 2, 'CABLE Input', 'CABLE Input (VB-Audio Virtual Cable)')).toBe(true);
  });

  it('secondaryPickQuery:off 关掉,空和 default 跟系统默认', () => {
    expect(secondaryPickQuery('off')).toBeNull();
    expect(secondaryPickQuery('OFF')).toBeNull();
    expect(secondaryPickQuery('')).toBe('');
    expect(secondaryPickQuery('default')).toBe('');
    expect(secondaryPickQuery('CABLE Input')).toBe('CABLE Input');
  });

  it('shouldMirrorSystem:关、空名、none、已是默认都不镜像', () => {
    expect(shouldMirrorSystem(false, 'CortiMic', 3, 1)).toBe(false);
    expect(shouldMirrorSystem(true, '', 3, 1)).toBe(false);
    expect(shouldMirrorSystem(true, 'none', 3, 1)).toBe(false);
    expect(shouldMirrorSystem(true, 'CortiMic', 1, 1)).toBe(false);
    expect(shouldMirrorSystem(true, 'CortiMic', 3, 1)).toBe(true);
  });

  it('mirrorRetarget:默认换了就重开,关掉或已对准则不动', () => {
    expect(mirrorRetarget(true, 1, 1)).toBe('keep');
    expect(mirrorRetarget(true, 1, 2)).toBe('open');
    expect(mirrorRetarget(true, null, 2)).toBe('open');
    expect(mirrorRetarget(false, 1, 2)).toBe('close');
    expect(mirrorRetarget(false, null, 2)).toBe('keep');
  });

  it('abort:合成半途失败即收尾,promise 不悬着', async () => {
    const { sink } = makeSink();
    cleanup.push(() => sink.close());
    const session = sink.beginStream(SR, '半途而废');
    session.push(silencePcm(1000));
    session.abort();
    const startedAt = await session.started;
    const endTs = await session.ended;
    expect(endTs).toBeGreaterThanOrEqual(startedAt);
  });
});

const CABLE = { id: 1, name: 'CABLE Input (VB-Audio Virtual Cable)', outputChannels: 2 };
const BUDS = { id: 2, name: 'Headphones (Buds4)', outputChannels: 2 };
const MONITOR = { id: 3, name: 'Monitor Out', outputChannels: 2 };

/**
 * 替身声卡。`flakyId` 那台复刻蓝牙耳机的病:openStream+start 之后的第一次
 * isStreamRunning 说在跑(开流探测就此判定成功),之后自己停。
 */
function fakeAudify(flakyId: number) {
  const devices = [CABLE, BUDS, MONITOR];
  const fake = deviceAudify(Date.now);
  class FakeRt extends fake.module.RtAudio {
    private deviceId = -1;
    private runChecks = 0;
    getDevices() { return devices; }
    openStream(...args: Parameters<InstanceType<typeof fake.module.RtAudio>['openStream']>) {
      this.deviceId = args[0].deviceId;
      super.openStream(...args);
    }
    isStreamRunning() {
      if (!super.isStreamRunning()) return false;
      if (this.deviceId !== flakyId) return true;
      this.runChecks += 1;
      return this.runChecks <= 1;
    }
  }
  return {
    ...fake.module,
    RtAudio: FakeRt,
  };
}

/** 副输出选 Buds4(会自己停),主输出选虚拟线(健康)。 */
function makeMirrorSink(secondary: () => string) {
  const opens: string[] = [];
  const warns: string[] = [];
  const sink = new DeviceAudioSink({ ...nullLogger(), warn: (msg) => { warns.push(msg); } }, {
    device: () => 'CABLE Input',
    secondary,
    audifyOverride: fakeAudify(BUDS.id),
    trace: (_area, msg) => { if (msg.startsWith('副输出已开')) opens.push(msg); },
  });
  return { sink, opens, warns };
}

function recoveringPrimaryAudify(
  onRecoveryPrimerWrite: () => void,
  firstInstanceRunChecks = 1,
) {
  const devices = [CABLE];
  let instances = 0;
  const recoveryWrites: Buffer[] = [];
  const fake = deviceAudify(Date.now);
  class FakeRt extends fake.module.RtAudio {
    private readonly instance = ++instances;
    private runChecks = 0;
    private streamName = '';
    constructor(_api?: number) { super(); }
    getDevices() { return devices; }
    openStream(
      out: { deviceId: number },
      input: unknown,
      format: number,
      sampleRate: number,
      frameSize: number,
      streamName: string,
    ) {
      super.openStream(out, input, format, sampleRate, frameSize, streamName);
      this.streamName = streamName;
    }
    write(buffer: Buffer) {
      super.write(buffer);
      if (this.instance === 2 && this.streamName === 'cortico-vtuber') {
        recoveryWrites.push(Buffer.from(buffer));
        // 只有开流的 8 帧预热模拟阻塞写入,后续帧由声卡回调消费。
        if (recoveryWrites.length <= 8) onRecoveryPrimerWrite();
      }
    }
    getStreamLatency() { return this.instance === 1 ? 0 : 4_800; }
    isStreamRunning() {
      if (!super.isStreamRunning()) return false;
      this.runChecks++;
      return this.instance !== 1 || this.runChecks <= firstInstanceRunChecks;
    }
  }
  return {
    opened: () => instances,
    recoveryWrites,
    queueMs: fake.queueMs,
    starvedTicks: fake.starvedTicks,
    module: {
      ...fake.module,
      RtAudio: FakeRt,
    },
  };
}

describe('DeviceAudioSink(主输出重开的时间线)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('普通 TTS 已落线待播毕时遇到设备重开，按新时钟重挂 ending Track', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const recovered = recoveringPrimaryAudify(() => { vi.setSystemTime(Date.now() + 10); });
    const sink = new DeviceAudioSink(nullLogger(), {
      device: () => 'CABLE Input',
      secondary: () => 'off',
      audifyOverride: recovered.module,
    });
    const opening = sink.play(fakePiece(10));

    await vi.advanceTimersByTimeAsync(75);
    const speech = await opening;
    expect(speech.startedAt).toBe(160);
    let ended = false;
    void speech.ended.then(() => { ended = true; });

    await vi.advanceTimersByTimeAsync(90);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(630 - Date.now());
    await expect(speech.ended).resolves.toBe(630);
    sink.close();
  });

});

describe('DeviceAudioSink(副输出重试闸)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开成了随即停跑:退避重试有限次后放弃,且只 warn 一次', () => {
    vi.useFakeTimers();
    const { sink, opens, warns } = makeMirrorSink(() => 'Buds4');
    sink.beginStream(SR, '演出片');
    // 退避 0.5→8s,总计够跑完五次尝试还有余量
    vi.advanceTimersByTime(60_000);
    sink.close();
    expect(opens.length).toBe(5);
    expect(warns.filter((m) => m.includes('放弃这一路'))).toHaveLength(1);
  });

  it('放弃后改副输出配置:计数重置,新设备重新开起来', () => {
    vi.useFakeTimers();
    let secondary = 'Buds4';
    const { sink, opens, warns } = makeMirrorSink(() => secondary);
    sink.beginStream(SR, '演出片');
    vi.advanceTimersByTime(60_000);
    expect(opens.length).toBe(5);
    secondary = 'Monitor Out';
    // 换成健康设备:开一次就该稳住,不再累计尝试
    vi.advanceTimersByTime(60_000);
    sink.close();
    expect(opens.length).toBe(6);
    expect(warns.filter((m) => m.includes('放弃这一路'))).toHaveLength(1);
  });
});


/**
 * 主输出夹具首次 isStreamRunning 返回运行中以通过开流探测，之后停止运行。
 */
function dyingPrimaryAudify() {
  const devices = [CABLE];
  let opened = 0;
  const fake = deviceAudify(Date.now);
  class FakeRt extends fake.module.RtAudio {
    private runChecks = 0;
    getDevices() { return devices; }
    openStream(...args: Parameters<InstanceType<typeof fake.module.RtAudio>['openStream']>) {
      opened += 1;
      super.openStream(...args);
    }
    isStreamRunning() {
      if (!super.isStreamRunning()) return false;
      this.runChecks += 1;
      return this.runChecks <= 1;
    }
  }
  return {
    opened: () => opened,
    module: {
      ...fake.module,
      RtAudio: FakeRt,
    },
  };
}

describe('DeviceAudioSink(主输出重试闸)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开成了随即停跑:退避降频而不是每帧重开,并按节流报出「这段时间没有声音」', () => {
    vi.useFakeTimers();
    const dying = dyingPrimaryAudify();
    const warns: string[] = [];
    const sink = new DeviceAudioSink({ ...nullLogger(), warn: (msg) => { warns.push(msg); } }, {
      device: () => 'CABLE Input',
      secondary: () => 'off',
      audifyOverride: dying.module,
    });
    sink.beginStream(SR, '演出片');
    vi.advanceTimersByTime(60_000);
    sink.close();
    // 主输出重开按 0.5 秒到 5 秒上限退避，持续重试而不放弃；一分钟的调用次数验证限频仍保留重试。
    expect(dying.opened()).toBeGreaterThan(5);
    expect(dying.opened()).toBeLessThan(25);
    const trouble = warns.filter((m) => m.includes('反复开不住'));
    // 15s 一条的节流:一分钟至多五条,而不是每次重开都记一行
    expect(trouble.length).toBeGreaterThanOrEqual(1);
    expect(trouble.length).toBeLessThanOrEqual(5);
  });

  it('设备健康时闸门不介入:开一次就够,没有重开也没有告警', () => {
    vi.useFakeTimers();
    const opens: string[] = [];
    const warns: string[] = [];
    const sink = new DeviceAudioSink({ ...nullLogger(), warn: (msg) => { warns.push(msg); } }, {
      device: () => 'CABLE Input',
      secondary: () => 'off',
      audifyOverride: fakeAudify(BUDS.id),
      trace: (_area, msg) => { if (msg.includes('主输出')) opens.push(msg); },
    });
    sink.beginStream(SR, '演出片');
    vi.advanceTimersByTime(60_000);
    sink.close();
    expect(opens).toHaveLength(1);
    expect(opens[0]).toContain('主输出已开');
    expect(warns).toHaveLength(0);
  });

  it('死一次就好:第一次重开不退避、不告警,跑住之后记账清零', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const recovered = recoveringPrimaryAudify(() => { vi.setSystemTime(Date.now() + 10); });
    const warns: string[] = [];
    const opens: string[] = [];
    const sink = new DeviceAudioSink({ ...nullLogger(), warn: (msg) => { warns.push(msg); } }, {
      device: () => 'CABLE Input',
      secondary: () => 'off',
      audifyOverride: recovered.module,
      trace: (_area, msg) => { if (msg.includes('主输出')) opens.push(msg); },
    });
    sink.beginStream(SR, '演出片');
    vi.advanceTimersByTime(75);
    expect(recovered.opened()).toBe(2);
    expect(opens[1]).toContain('主输出重开');
    // 跑满 PRIMARY_STABLE_MS 后 notePrimaryAlive 清账,期间没有第三次开流
    vi.advanceTimersByTime(10_000);
    expect(recovered.opened()).toBe(2);
    expect(warns).toHaveLength(0);
    expect(recovered.starvedTicks()).toBe(0);
    expect(recovered.queueMs()).toBeGreaterThan(0);
    expect(recovered.queueMs()).toBeLessThan(200);
    sink.close();
  });
});

/**
 * 声卡时钟纠偏:**没有它,声音会越播越晚**。
 *
 * 写入按墙钟推(step 的 target),消费按声卡时钟走 —— audify 的输出队列是一条无界
 * `std::queue`,回调一拍弹一帧、没帧就放静音,`write()` 从不阻塞。两个时钟只要
 * 不同速,队列就只会往长的方向长,而队列有多长就是声音比字幕、比嘴型晚多少。
 *
 * 这里的替身按真实 audify + RtAudio(WASAPI)的行为造:回调按自己的表(墙钟 × factor)
 * 每帧跳一拍,`streamTime` 每拍都涨,不管那一拍弹的是帧还是静音。台架把漂移放大成
 * 10%:60 秒就该攒出 6 秒,一眼看得出有没有闭环;泵停 300ms 则看得出锚的是拍数还是消费量。
 */
const DRIFT_SR = 16000;
const PUMP = 15;
/** 与 device-audio 的 MIRROR_MAX_QUEUE_MS 同一个数(那个常量不出口) */
const MIRROR_QUEUE_CAP = 250;

function deviceAudify(
  clock: () => number,
  opts: { factor?: (deviceId: number) => number; stallAtSec?: number } = {},
) {
  type Lane = { written: number; popped: number; ticks: number; startedAtMs: number; factor: number };
  const st = { rate: DRIFT_SR, frameSize: DRIFT_SR / 50 };
  const lanes = new Map<number, Lane>();
  /** 把到此刻为止的回调拍数结算掉:有帧弹帧,没帧放静音(拍数照涨) */
  function settle(l: Lane): void {
    const elapsedSec = (Math.max(0, clock() - l.startedAtMs) / 1000) * l.factor;
    const ticks = Math.floor((elapsedSec * st.rate) / st.frameSize);
    const delta = ticks - l.ticks;
    if (delta <= 0) return;
    l.popped += Math.min(delta, l.written - l.popped);
    l.ticks = ticks;
  }
  class FakeRt {
    private id = -1;
    private running = false;
    outputVolume = 1;
    getDevices() { return [CABLE, MONITOR]; }
    getDefaultOutputDevice() { return CABLE.id; }
    openStream(
      out: { deviceId: number }, _in: unknown, _fmt: number, rate: number, frameSize: number, _streamName: string,
    ) {
      this.id = out.deviceId;
      st.rate = rate;
      st.frameSize = frameSize;
      lanes.set(this.id, {
        written: 0, popped: 0, ticks: 0, startedAtMs: clock(), factor: opts.factor?.(this.id) ?? 1,
      });
    }
    start() { this.running = true; }
    write(_buffer: Buffer) { const l = lanes.get(this.id)!; settle(l); l.written += 1; }
    closeStream() { this.running = false; }
    getStreamLatency() { return 0; }
    isStreamRunning() { return this.running; }
    isStreamOpen() { return this.running; }
    get streamTime(): number {
      if (opts.stallAtSec !== undefined) return opts.stallAtSec;
      const l = lanes.get(this.id)!;
      settle(l);
      return (l.ticks * st.frameSize) / st.rate;
    }
  }
  const lane = (id: number) => { const l = lanes.get(id)!; settle(l); return l; };
  return {
    module: {
      RtAudio: FakeRt,
      RtAudioFormat: { RTAUDIO_SINT16: 1 },
      RtAudioApi: { WINDOWS_WASAPI: 10, WINDOWS_DS: 11 },
    },
    /** 队列里还没播出去的毫秒数 = 声音比时间线晚多少 */
    queueMs: (id = CABLE.id) => { const l = lane(id); return (((l.written - l.popped) * st.frameSize) / st.rate) * 1000; },
    frames: (id = CABLE.id) => lanes.get(id)!.written,
    /** 放了静音的拍数 */
    starvedTicks: (id = CABLE.id) => { const l = lane(id); return l.ticks - l.popped; },
  };
}

function pumpFor(ms: number, tick: () => void): void {
  for (let t = 0; t < ms; t += PUMP) tick();
}

describe('DeviceAudioSink:声卡时钟纠偏', () => {
  it('声卡比墙钟慢 10%:队列不再无限攒,开播时刻按实际播放位报', async () => {
    vi.useFakeTimers();
    let now = 0;
    const fake = deviceAudify(() => now, { factor: () => 0.9 });
    const sink = new DeviceAudioSink(nullLogger(), {
      device: () => 'CABLE Input',
      secondary: () => 'off',
      audifyOverride: fake.module,
      now: () => now,
    });
    // 先开出流:开流发生在第一次 beginStream/play(采样率由片子定)
    const session = sink.beginStream(DRIFT_SR, '开流片');
    session.push(silencePcm(40));
    session.end(40);

    pumpFor(60_000, () => { now += PUMP; vi.advanceTimersByTime(PUMP); });
    // 没有闭环时这里是 6 秒上下(60s × 10%);闭环之后只剩 AHEAD_MS 那一档
    const queueMs = fake.queueMs();
    expect(queueMs).toBeGreaterThan(0);
    expect(queueMs).toBeLessThan(200);

    // 这一刻下的片,报出来的开播时刻要与"队列排完才轮到它"吻合
    const next = sink.beginStream(DRIFT_SR, '六十秒后的片');
    next.push(silencePcm(200));
    next.end(200);
    let startedAt = 0;
    void next.started.then((ts) => { startedAt = ts; });
    // 写入按声卡节拍走,不是每一拍泵都有帧可写
    let truthMs = 0;
    for (let i = 0; i < 10 && startedAt === 0; i++) {
      truthMs = now + fake.queueMs();
      now += PUMP;
      await vi.advanceTimersByTimeAsync(PUMP);
    }
    expect(startedAt).toBeGreaterThan(0);
    expect(Math.abs(startedAt - truthMs)).toBeLessThan(60);

    sink.close();
    vi.useRealTimers();
  });

  it('泵停 300ms(事件循环卡住):声卡饿空后放的静音不算消费,队列不留台阶,时间线整体后移', async () => {
    vi.useFakeTimers();
    let now = 0;
    const traces: Array<{ msg: string; level?: string; tally?: string }> = [];
    const fake = deviceAudify(() => now);
    const sink = new DeviceAudioSink(nullLogger(), {
      device: () => 'CABLE Input',
      secondary: () => 'Monitor Out',
      audifyOverride: fake.module,
      now: () => now,
      trace: (_area, msg, o) => { traces.push({ msg, level: o?.level, tally: o?.tally }); },
    });
    const session = sink.beginStream(DRIFT_SR, '开流片');
    session.push(silencePcm(40));
    session.end(40);
    pumpFor(2_000, () => { now += PUMP; vi.advanceTimersByTime(PUMP); });
    expect(fake.starvedTicks()).toBe(0);

    // 泵 300ms 没跑:声卡把 AHEAD_MS 那 100ms 弹完,余下 200ms 放静音
    now += 300;
    pumpFor(2_000, () => { now += PUMP; vi.advanceTimersByTime(PUMP); });
    expect(fake.starvedTicks()).toBe(10);
    // 按拍数锚时这里是 300ms(静音那 200ms 被记成已播,补写的帧全成积压);按消费量锚只剩 AHEAD_MS 一档
    expect(fake.queueMs()).toBeLessThan(200);
    expect(fake.queueMs(MONITOR.id)).toBeLessThan(MIRROR_QUEUE_CAP + 40);
    const starve = traces.filter((t) => t.msg.includes('声卡空转'));
    expect(starve).toHaveLength(1);
    expect(starve[0].msg).toContain('声卡空转 200ms');
    expect(starve[0].level).toBe('warn');
    expect(starve[0].tally).toBe('声卡空转');
    // 时间线后移了那 200ms:这一刻下的片报出的开播时刻仍与"队列排完才轮到它"吻合
    const next = sink.beginStream(DRIFT_SR, '卡顿之后的片');
    next.push(silencePcm(200));
    next.end(200);
    let startedAt = 0;
    void next.started.then((ts) => { startedAt = ts; });
    let truthMs = 0;
    for (let i = 0; i < 10 && startedAt === 0; i++) {
      truthMs = now + fake.queueMs();
      now += PUMP;
      await vi.advanceTimersByTimeAsync(PUMP);
    }
    expect(startedAt).toBeGreaterThan(0);
    expect(Math.abs(startedAt - truthMs)).toBeLessThan(60);

    sink.close();
    vi.useRealTimers();
  });

  it('声卡时钟停摆:不按它纠偏(否则声音被无限往后推),只报一句', () => {
    vi.useFakeTimers();
    let now = 0;
    const warns: string[] = [];
    const fake = deviceAudify(() => now, { stallAtSec: 0.5 });
    const sink = new DeviceAudioSink({ ...nullLogger(), warn: (msg) => { warns.push(msg); } }, {
      device: () => 'CABLE Input',
      secondary: () => 'off',
      audifyOverride: fake.module,
      now: () => now,
    });
    const session = sink.beginStream(DRIFT_SR, '开流片');
    session.push(silencePcm(40));
    session.end(40);
    pumpFor(20_000, () => { now += PUMP; vi.advanceTimersByTime(PUMP); });
    // 停摆的表只会把偏差算成"越来越晚";不纠 = 时间线照墙钟走,写入照常推进
    expect(fake.frames()).toBeGreaterThan(20_000 / 20 * 0.9);
    expect(warns.filter((w) => w.includes('播放时钟停摆'))).toHaveLength(1);
    sink.close();
    vi.useRealTimers();
  });
});

/**
 * 副输出(监听那一路)也会攒。时间线只能锚在一块表上 —— 主输出,它是直播命脉;
 * 副输出那台设备有自己的晶振,于是它的队列同样只长不短,操作员戴着耳机听到的
 * 就会越来越晚。这一路按"攒过 250ms 就丢一帧"追相位:丢的是监听,不是播出。
 */
describe('DeviceAudioSink:副输出相位', () => {
  it('副输出的表比主输出慢:队列被 250ms 咬住,靠丢帧追,不无限攒', () => {
    vi.useFakeTimers();
    let now = 0;
    // 两台设备:主输出准,副输出慢 10%
    const fake = deviceAudify(() => now, { factor: (id) => (id === MONITOR.id ? 0.9 : 1) });
    const sink = new DeviceAudioSink(nullLogger(), {
      device: () => 'CABLE Input',
      secondary: () => 'Monitor Out',
      audifyOverride: fake.module,
      now: () => now,
    });
    const session = sink.beginStream(DRIFT_SR, '开流片');
    session.push(silencePcm(40));
    session.end(40);
    pumpFor(60_000, () => { now += PUMP; vi.advanceTimersByTime(PUMP); });
    // 慢 10% 的那台若照写不误,60 秒会攒 6 秒;丢帧之后它写进去的帧数明显少于主输出
    expect(fake.frames(MONITOR.id)).toBeLessThan(fake.frames(CABLE.id));
    expect(fake.queueMs(MONITOR.id)).toBeLessThan(MIRROR_QUEUE_CAP + 40);
    expect(fake.queueMs(CABLE.id)).toBeLessThan(200);
    sink.close();
    vi.useRealTimers();
  });
});
