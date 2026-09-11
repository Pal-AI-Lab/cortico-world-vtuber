import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driftNoise, sampleKeys, type Key } from '../../src/clips.ts';
import { EXAMPLE_PACK_DIR, loadPack, parsePack, vocabTableRows } from '../../src/pack.ts';

const example = loadPack(EXAMPLE_PACK_DIR);

describe('driftNoise', () => {
  it('有界、不周期(不像正弦一周期后原样重复),且最高分量在 1.14Hz 以内', () => {
    const hz = 0.22;
    const period = 1 / hz;
    const xs: number[] = [];
    const sine: number[] = [];
    for (let i = 0; i < 3600; i++) {
      const t = i / 60;
      xs.push(driftNoise(t, hz));
      sine.push(Math.sin(2 * Math.PI * hz * t));
    }
    expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(1);
    // 一周期后的自相关:正弦是 1(机械往复),漂移应明显更低
    const corr = (a: number[], lag: number): number => {
      const n = a.length - lag;
      const m1 = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
      const m2 = a.slice(lag).reduce((x, y) => x + y, 0) / n;
      let num = 0;
      let d1 = 0;
      let d2 = 0;
      for (let i = 0; i < n; i++) {
        const x = a[i] - m1;
        const y = a[i + lag] - m2;
        num += x * y;
        d1 += x * x;
        d2 += y * y;
      }
      return num / Math.sqrt(d1 * d2);
    };
    const lag = Math.round(period * 60);
    expect(corr(sine, lag)).toBeGreaterThan(0.99);
    expect(corr(xs, lag)).toBeLessThan(0.8);
    // 同一 t 可复现(无状态)
    expect(driftNoise(3.5, hz)).toBe(driftNoise(3.5, hz));
  });
});

describe('sampleKeys 段缓动', () => {
  it('缺省 smooth:段中点即值中点,段两端速度为零(贴近端点几乎不动)', () => {
    const keys: Key[] = [[0, 0], [100, 10]];
    expect(sampleKeys(keys, 50)).toBeCloseTo(5, 5);
    expect(sampleKeys(keys, 5)).toBeLessThan(0.2);
    expect(sampleKeys(keys, 95)).toBeGreaterThan(9.8);
  });

  it('out 快去慢停,in 慢去快到:同一时刻 out 进度大于 smooth 大于 in', () => {
    const at30 = (ease?: 'in' | 'out') => sampleKeys([[0, 0], [100, 10, ease]], 30);
    expect(at30('out')).toBeGreaterThan(at30(undefined));
    expect(at30(undefined)).toBeGreaterThan(at30('in'));
  });

  it('back 冲过目标再落回:段内峰值超过目标值,段尾回到目标', () => {
    const keys: Key[] = [[0, 0], [100, 10, 'back']];
    let peak = 0;
    for (let t = 0; t <= 100; t += 2) peak = Math.max(peak, sampleKeys(keys, t));
    expect(peak).toBeGreaterThan(10);
    expect(sampleKeys(keys, 100)).toBe(10);
  });

  it('back 两端速度为零:裸 easeOutBack 的起步斜率是均速 4.7 倍,短段转头会读成瞬跳', () => {
    const keys: Key[] = [[0, 0], [100, 10, 'back']];
    expect(sampleKeys(keys, 5)).toBeLessThan(0.4);
    expect(Math.abs(sampleKeys(keys, 96) - 10)).toBeLessThan(0.3);
  });
});

describe('范例演出包', () => {
  it('pulse 曲线全是加性偏移:每条轨首尾归零、时长为正、尾帧不越过 durationMs,lint 无警告', () => {
    for (const clip of Object.values(example.pulse)) {
      expect(clip.durationMs, clip.id).toBeGreaterThan(0);
      expect(clip.speechOnsetMs, clip.id).toBeGreaterThanOrEqual(0);
      for (const [param, keys] of Object.entries(clip.tracks)) {
        expect(keys[0][1], `${clip.id}.${param}`).toBe(0);
        expect(keys[keys.length - 1][1], `${clip.id}.${param}`).toBe(0);
        expect(keys[keys.length - 1][0], `${clip.id}.${param}`).toBeLessThanOrEqual(clip.durationMs);
      }
    }
    expect(example.lint()).toEqual([]);
  });

  it('点头是两下:FaceAngleY 两个负峰,中间回零,段外钳在尾帧', () => {
    const y = example.pulse.nod.tracks.FaceAngleY;
    expect(sampleKeys(y, 190)).toBeLessThan(-20);
    expect(sampleKeys(y, 500)).toBe(0);
    expect(sampleKeys(y, 740)).toBeLessThan(-15);
    expect(sampleKeys(y, example.pulse.nod.durationMs)).toBe(0);
  });

  it('resolveTag:别名归一、Reset 两种大小写、首尾空白忽略、空串与表外词为 null', () => {
    expect(example.resolveTag('凑近')).toMatchObject({ kind: 'perform', entry: { word: '前倾', clipId: 'lean_in' } });
    expect(example.resolveTag(' 点头 ')).toMatchObject({ kind: 'perform', entry: { clipId: 'nod' } });
    expect(example.resolveTag('用力点头')).toMatchObject({ kind: 'perform', entry: { clipId: 'nod', intensity: 1.35 } });
    expect(example.resolveTag('Reset')).toEqual({ kind: 'reset' });
    expect(example.resolveTag('reset')).toEqual({ kind: 'reset' });
    expect(example.resolveTag('')).toBeNull();
    expect(example.resolveTag('起飞')).toBeNull();
  });

  it('entryByClipId 取先声明的代表词:nod 是「点头」不是「用力点头」', () => {
    expect(example.entryByClipId('nod')?.word).toBe('点头');
    expect(example.entryByClipId('fx_idea')?.word).toBe('灯泡特效');
    expect(example.entryByClipId('nope')).toBeUndefined();
  });

  it('vocabTableRows:五行按通道分组,词带反引号', () => {
    const rows = vocabTableRows(example).split('\n');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.slice(0, r.indexOf('|', 2) + 1))).toEqual(['| 动作 |', '| 姿态 |', '| 表情 |', '| 看向 |', '| 特效 |']);
    expect(rows[0]).toContain('`点头`、`用力点头`');
    expect(rows[4]).toContain('`灯泡特效`');
  });
});

describe('loadPack 校验', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  type Json = Record<string, any>;
  /** 把范例包拷进临时目录,改过再写盘;返回目录 */
  function writePack(mutate: (vocab: Json, clips: Json, params: Json) => void = () => {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'vtuber-pack-'));
    dirs.push(dir);
    const params = JSON.parse(readFileSync(join(EXAMPLE_PACK_DIR, 'params.json'), 'utf8')) as Json;
    const vocab = JSON.parse(readFileSync(join(EXAMPLE_PACK_DIR, 'vocab.json'), 'utf8')) as Json;
    const clips = JSON.parse(readFileSync(join(EXAMPLE_PACK_DIR, 'clips.json'), 'utf8')) as Json;
    mutate(vocab, clips, params);
    writeFileSync(join(dir, 'params.json'), JSON.stringify(params));
    writeFileSync(join(dir, 'vocab.json'), JSON.stringify(vocab));
    writeFileSync(join(dir, 'clips.json'), JSON.stringify(clips));
    return dir;
  }

  it('合法目录:整包读入,dir 记的是来源目录', () => {
    const dir = writePack();
    const pack = loadPack(dir);
    expect(pack.dir).toBe(dir);
    expect(pack.entries).toEqual(example.entries);
    expect(pack.pulse).toEqual(example.pulse);
    expect(pack.gaze).toEqual(example.gaze);
  });

  it('JSON 坏了或文件缺了:错误信息带文件路径', () => {
    const dir = writePack();
    writeFileSync(join(dir, 'vocab.json'), '{ not json');
    expect(() => loadPack(dir)).toThrow(join(dir, 'vocab.json'));

    const gone = writePack();
    unlinkSync(join(gone, 'clips.json'));
    expect(() => loadPack(gone)).toThrow(`${join(gone, 'clips.json')}: 文件不存在`);
  });

  it('词指向不存在的 clip:错误点名那个词', () => {
    const dir = writePack((vocab) => {
      vocab.entries.find((e: Json) => e.word === '点头').clipId = 'nope';
    });
    expect(() => loadPack(dir)).toThrow(/词「点头」对应的 clip「nope」不在 clips\.pulse 里/);
  });

  it('别名指向表外词或与词同名:拒收', () => {
    const dangling = writePack((vocab) => {
      vocab.aliases['嗯嗯'] = '不存在的词';
    });
    expect(() => loadPack(dangling)).toThrow(/vocab\.aliases\.嗯嗯 指向的「不存在的词」不在词表里/);

    const shadow = writePack((vocab) => {
      vocab.aliases['点头'] = '摇头';
    });
    expect(() => loadPack(shadow)).toThrow(/vocab\.aliases\.点头 与词表里的词同名/);
  });

  it('曲线写到 params.json 没声明的参数:拒收并点名参数与 clip', () => {
    const dir = writePack((_vocab, clips) => {
      clips.pulse.nod.tracks.ParamHairSwing = [[0, 0], [100, 1], [200, 0]];
    });
    expect(() => loadPack(dir)).toThrow(/clips\.pulse\.nod\.tracks 的参数 ParamHairSwing 没在 params\.json 里声明/);
  });

  it('包可以扩参数集:声明 TailSwing 后曲线能驱动它,量程给混音台钳位用', () => {
    const dir = writePack((_vocab, clips, params) => {
      params.TailSwing = { unit: '[-1,1]', range: [-1, 1], suggests: 'ParamTail' };
      clips.pulse.nod.tracks.TailSwing = [[0, 0], [300, 0.8], [1400, 0]];
    });
    const pack = loadPack(dir);
    expect(pack.paramIds).toContain('TailSwing');
    expect(pack.range('TailSwing')).toEqual([-1, 1]);
    expect(pack.range('NotDeclared')).toBeNull();
    expect(pack.pulse.nod.tracks.TailSwing).toHaveLength(3);
  });

  it('混音台内建行为依赖的十个参数缺一不可', () => {
    const dir = writePack((_vocab, _clips, params) => {
      delete params.EyeLeftY;
      delete params.MouthOpen;
    });
    expect(() => loadPack(dir)).toThrow(/params\.json 缺少混音台依赖的参数 MouthOpen、EyeLeftY/);
  });

  it('参数声明的形状:range 必须下小上大,probe 必须为正', () => {
    const bad = writePack((_vocab, _clips, params) => {
      params.FaceAngleX.range = [30, -30];
    });
    expect(() => loadPack(bad)).toThrow(/params\.FaceAngleX\.range 下限必须小于上限/);
    const probe = writePack((_vocab, _clips, params) => {
      params.FaceAngleX.probe = 0;
    });
    expect(() => loadPack(probe)).toThrow(/params\.FaceAngleX\.probe 必须大于 0/);
  });

  it('错误信息以来源为前缀:parsePack 直接喂空对象', () => {
    expect(() => parsePack({}, {}, {}, 'bot/vtuber-pack')).toThrow(/^bot\/vtuber-pack: params\.json 缺少混音台依赖的参数/);
    expect(() => parsePack(example.data.params, { entries: [] }, { pulse: {}, sustain: {}, gaze: { chat: { id: 'other' } } }, 'x'))
      .toThrow(/^x: clips\.gaze\.chat\.id 必须等于键名 chat/);
  });

  it('形状警告不阻止生效:尾帧不归零的 pulse 照样载入,lint 报出来', () => {
    const dir = writePack((_vocab, clips) => {
      const keys = clips.pulse.nod.tracks.FaceAngleY as Array<[number, number]>;
      keys[keys.length - 1][1] = -3;
    });
    const pack = loadPack(dir);
    expect(pack.pulse.nod.tracks.FaceAngleY.at(-1)).toEqual([1150, -3]);
    expect(pack.lint()).toEqual(['nod.FaceAngleY 尾帧不为 0(会留残余偏移)']);
  });
});
