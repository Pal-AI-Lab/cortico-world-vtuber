import { describe, it, expect, vi } from 'vitest';
import { VtsBackend } from '../../src/backend.ts';
import {
  DEFAULT_PROFILE,
  type ModelProfile,
  type ParamWiring,
} from '../../src/models/index.ts';
import type { VtsClient } from '../../src/vts-client.ts';

/** 只想改一两条接线时的临时档案 */
function profileOf(wiring: Record<string, ParamWiring>): ModelProfile {
  return { ...DEFAULT_PROFILE, id: 'test', label: '测试档案', wiring };
}

/** 眼睑/嘴角/眉毛中性在输入半程 (1+v)×0.5,眼球横轴取反;没有 FX */
const HALF_NEUTRAL: ModelProfile = {
  ...DEFAULT_PROFILE,
  id: 'half',
  label: '半程中性',
  wiring: {
    MouthSmile: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    BrowLeftY: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    BrowRightY: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    EyeOpenLeft: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    EyeOpenRight: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    EyeLeftX: { invert: true },
    EyeRightX: { invert: true },
  },
};

/** 头部三轴与嘴按实测斜率倒数缩放,眼睑中性 0.7337,双眉并到 Brows,没有腮帮与 FX */
const MEASURED: ModelProfile = {
  ...DEFAULT_PROFILE,
  id: 'measured',
  label: '实测斜率',
  wiring: {
    FaceAngleY: { scale: 0.4 },
    FaceAngleZ: { scale: 0.6667 },
    MouthOpen: { scale: 0.4 },
    EyeOpenLeft: { neutral: 0.7337, scale: 0.5337, clamp: [0, 1] },
    EyeOpenRight: { neutral: 0.7337, scale: 0.5337, clamp: [0, 1] },
    BrowLeftY: { neutral: 0.875, scale: 0.125, clamp: [0.75, 1], aliasTo: ['Brows'] },
    BrowRightY: { neutral: 0.875, scale: 0.125, clamp: [0.75, 1], aliasTo: ['Brows'] },
    EyeLeftX: { invert: true },
    EyeRightX: { invert: true },
  },
  unsupported: ['CheekPuff'],
};

interface Injected {
  values: Array<{ id: string; value: number; weight?: number }>;
  mode: 'set' | 'add';
}

function makeFakeVts(opts: { hang?: boolean; rejectMode?: 'set' | 'add' } = {}) {
  const injected: Injected[] = [];
  const expressions: Array<{ file: string; active: boolean }> = [];
  const pending: Array<() => void> = [];
  const vts = {
    connected: true,
    injectParameters: (values: Injected['values'], mode: 'set' | 'add') => {
      injected.push({ values, mode });
      if (opts.rejectMode === mode) return Promise.reject(new Error('VTS APIError 453'));
      if (!opts.hang) return Promise.resolve();
      return new Promise<void>((r) => pending.push(r));
    },
    setExpression: async (file: string, active: boolean) => {
      expressions.push({ file, active });
    },
  } as unknown as VtsClient;
  return { vts, injected, expressions, pending };
}

describe('VtsBackend', () => {
  it('add/set 分包注入', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts);
    backend.sendFrame({
      FaceAngleY: { value: -10, mode: 'add' },
      MouthOpen: { value: 0.6, mode: 'set' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(injected).toHaveLength(2);
    expect(injected[0]).toEqual({ values: [{ id: 'FaceAngleY', value: -10 }], mode: 'add' });
    expect(injected[1].mode).toBe('set');
    expect(injected[1].values[0]).toMatchObject({ id: 'MouthOpen', value: 0.6, weight: 1 });
  });

  it('帧流水:两帧在途,第三帧进候补;回执一到立即补发最新候补', async () => {
    const { vts, injected, pending } = makeFakeVts({ hang: true });
    const stats: boolean[] = [];
    const backend = new VtsBackend(vts, { onInjectStat: (s) => stats.push(s.sent) });
    backend.sendFrame({ FaceAngleY: { value: -5, mode: 'add' } });
    backend.sendFrame({ FaceAngleY: { value: -6, mode: 'add' } });
    expect(injected).toHaveLength(2); // 双帧流水:VTS 往返吃不满求值率时靠它顶到 60Hz
    backend.sendFrame({ FaceAngleY: { value: -7, mode: 'add' } });
    backend.sendFrame({ FaceAngleY: { value: -8, mode: 'add' } });
    expect(injected).toHaveLength(2); // 在途满,-7 进候补又被 -8 覆盖
    pending.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(injected).toHaveLength(3); // 回执一到补发的是最新的 -8
    expect(injected[2].values[0].value).toBe(-8);
    // 真正丢掉的只有被覆盖的 -7 那一帧
    expect(stats).toEqual([true, true, false, true]);
  });

  it('眼球横轴按模型接线取反(头眼同向);纵轴与头部不动', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts);
    backend.sendFrame({
      FaceAngleX: { value: 18, mode: 'add' },
      EyeRightX: { value: 0.75, mode: 'set' },
      EyeLeftX: { value: 0.75, mode: 'set' },
      EyeRightY: { value: -0.2, mode: 'set' },
    });
    await Promise.resolve();
    await Promise.resolve();
    const add = injected.find((i) => i.mode === 'add')!;
    const set = injected.find((i) => i.mode === 'set')!;
    expect(add.values).toEqual([{ id: 'FaceAngleX', value: 18 }]);
    const byId = Object.fromEntries(set.values.map((v) => [v.id, v.value]));
    expect(byId.EyeRightX).toBe(-0.75);
    expect(byId.EyeLeftX).toBe(-0.75);
    expect(byId.EyeRightY).toBe(-0.2);
  });

  it('档案不声明取反时,眼球横轴原样注入', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts, { profile: () => profileOf({ EyeRightX: {} }) });
    backend.sendFrame({ EyeRightX: { value: 0.75, mode: 'set' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(injected[0].values[0].value).toBe(0.75);
  });

  it('实机没有的输入参数直接跳过,只报一次;其余照发', async () => {
    const { vts, injected } = makeFakeVts();
    const errors: string[] = [];
    const backend = new VtsBackend(vts, { onError: (e) => errors.push(e.message) });
    backend.setKnownParameters(new Set(['FaceAngleY', 'MouthOpen']));
    backend.sendFrame({
      FaceAngleY: { value: -10, mode: 'add' },
      BrowAngleL: { value: 0.3, mode: 'add' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(injected).toHaveLength(1);
    expect(injected[0].values).toEqual([{ id: 'FaceAngleY', value: -10 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('BrowAngleL');
    backend.sendFrame({ FaceAngleY: { value: -8, mode: 'add' }, BrowAngleL: { value: 0.3, mode: 'add' } });
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });

  it('一包被拒不影响另一包(add 失败,set 仍要发出)', async () => {
    const { vts, injected } = makeFakeVts({ rejectMode: 'add' });
    const errors: string[] = [];
    const backend = new VtsBackend(vts, { onError: (e) => errors.push(e.message) });
    backend.sendFrame({
      FaceAngleY: { value: -10, mode: 'add' },
      MouthOpen: { value: 0.6, mode: 'set' },
    });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(injected.map((i) => i.mode)).toEqual(['add', 'set']);
    expect(errors[0]).toContain('453');
  });

  it('半程中性档案:眼睑/嘴角/眉毛按 (1+v)×0.5 换算,中性在输入 0 的参数不动', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts, { profile: () => HALF_NEUTRAL });
    backend.sendFrame({
      EyeOpenLeft: { value: -0.6, mode: 'add' },
      EyeOpenRight: { value: 0.5, mode: 'add' },
      MouthSmile: { value: 0.64, mode: 'add' },
      BrowLeftY: { value: 0.12, mode: 'add' },
      BrowRightY: { value: -0.55, mode: 'add' },
      CheekPuff: { value: 0.3, mode: 'add' },
      FaceAngleY: { value: -10, mode: 'add' },
    });
    await Promise.resolve();
    const at = (id: string): number | undefined => injected[0].values.find((v) => v.id === id)?.value;
    // -0.6 眯眼 → 输入 0.2(输出映射 [0,2] 下是 0.4 深眯,不再是全闭)
    expect(at('EyeOpenLeft')).toBeCloseTo(0.2, 5);
    expect(at('EyeOpenRight')).toBeCloseTo(0.75, 5);
    // 对拍实录:基线 0 直发时 +0.64 的微笑只渲染出 +0.28、+0.12 的眉毛输出成 -0.76
    expect(at('MouthSmile')).toBeCloseTo(0.82, 5);
    expect(at('BrowLeftY')).toBeCloseTo(0.56, 5);
    expect(at('BrowRightY')).toBeCloseTo(0.225, 5);
    // 中性在输入 0 的参数(CheekPuff in[0,1]→out[0,1]、头部三轴是度)不换算
    expect(at('CheekPuff')).toBe(0.3);
    expect(at('FaceAngleY')).toBe(-10);
  });

  it('实测斜率档案:头部按实测斜率缩回度数,眼睑中性挪到 0.7337', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts, { profile: () => MEASURED });
    backend.sendFrame({
      FaceAngleY: { value: -26, mode: 'add' },
      FaceAngleZ: { value: 23, mode: 'add' },
      MouthOpen: { value: 0.55, mode: 'add' },
      EyeOpenLeft: { value: 0, mode: 'add' },
    });
    await Promise.resolve();
    const at = (id: string): number | undefined => injected[0].values.find((v) => v.id === id)?.value;
    // 实机斜率 2.5:发 −10.4 进去,屏幕上才是 −26°(直发会变成 −65°,远超正常范围)
    expect(at('FaceAngleY')).toBeCloseTo(-10.4, 4);
    expect(at('FaceAngleZ')).toBeCloseTo(15.33, 2);
    expect(at('MouthOpen')).toBeCloseTo(0.22, 4);
    // 偏移 0 = 平常睁眼,在这个模型上是输入 0.7337(按 0.5 发会永久半睁)
    expect(at('EyeOpenLeft')).toBeCloseTo(0.7337, 4);
  });

  it('多路语义并到一路合并输入:左右眉都发到 Brows,取均值', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts, { profile: () => MEASURED });
    backend.sendFrame({
      BrowLeftY: { value: 0.4, mode: 'add' },
      BrowRightY: { value: 0.4, mode: 'add' },
    });
    await Promise.resolve();
    expect(injected[0].values).toEqual([{ id: 'Brows', value: expect.closeTo(0.925, 4) }]);
    expect(injected[0].values.find((v) => v.id === 'BrowLeftY')).toBeUndefined();
  });

  it('单侧挑眉在合并输入上退化成双眉同抬(只有一路时不与隐含 0 平均)', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts, { profile: () => MEASURED });
    backend.sendFrame({ BrowRightY: { value: 0.45, mode: 'add' } });
    await Promise.resolve();
    expect(injected[0].values[0].value).toBeCloseTo(0.875 + 0.45 * 0.125, 5);
  });

  it('档案声明演不出来的参数:丢掉并只报一次,同帧其余照发', async () => {
    const { vts, injected } = makeFakeVts();
    const errors: string[] = [];
    const backend = new VtsBackend(vts, { profile: () => MEASURED, onError: (e) => errors.push(e.message) });
    backend.sendFrame({ CheekPuff: { value: 0.9, mode: 'add' }, FaceAngleY: { value: -10, mode: 'add' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(injected[0].values.map((v) => v.id)).toEqual(['FaceAngleY']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('CheekPuff');
    backend.sendFrame({ CheekPuff: { value: 0.9, mode: 'add' }, FaceAngleY: { value: -8, mode: 'add' } });
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });

  /*
   * 丢弃按名称和原因累计，首次与十进位里程碑报告，收工汇总；限流不能丢失频次信息。
   */
  it('丢弃按名称×原因计数:首次与十进位里程碑各报一条,收工汇总累计次数', async () => {
    const { vts } = makeFakeVts();
    const errors: string[] = [];
    const backend = new VtsBackend(vts, { profile: () => MEASURED, onError: (e) => errors.push(e.message) });
    for (let i = 0; i < 12; i++) {
      backend.sendFrame({ CheekPuff: { value: 0.9, mode: 'add' }, FaceAngleY: { value: -10, mode: 'add' } });
      await Promise.resolve();
      await Promise.resolve();
    }
    // 12 次丢弃 → 两条:第 1 次与第 10 次
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain('累计 10 次');
    expect([...backend.dropCounts().values()]).toEqual([12]);
    backend.stop();
    expect(errors[2]).toContain('合计 12 次');
    expect(errors[2]).toContain('CheekPuff');
    expect(backend.dropCounts().size).toBe(0);
  });

  it('名单重查前把这一段的累计写出去,再清表', async () => {
    const { vts } = makeFakeVts();
    const errors: string[] = [];
    const backend = new VtsBackend(vts, { onError: (e) => errors.push(e.message) });
    backend.setKnownParameters(new Set(['FaceAngleY']));
    backend.sendFrame({ BrowAngleL: { value: 0.3, mode: 'add' }, FaceAngleY: { value: -10, mode: 'add' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(backend.dropCounts().size).toBe(1);
    backend.setKnownParameters(new Set(['FaceAngleY', 'BrowAngleL']));
    expect(errors.at(-1)).toContain('合计 1 次');
    // 名单变了,先前无效的参数重新有效:计数表清空,不再压着旧账
    expect(backend.dropCounts().size).toBe(0);
  });

  it('档案标成 null 的 FX 咽掉并提醒;有条目的按档案里的文件名开,时长也从档案取', async () => {
    const q = makeFakeVts();
    const errors: string[] = [];
    const dead = new VtsBackend(q.vts, { profile: () => MEASURED, onError: (e) => errors.push(e.message) });
    dead.fx('fx_idea');
    dead.fx('fx_star');
    await Promise.resolve();
    expect(q.expressions).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors.join()).toContain('fx_idea');
    expect(errors.join()).toContain('fx_star');
    expect(dead.fxDurationMs('fx_star')).toBe(0);
    dead.stop();

    const starred: ModelProfile = {
      ...HALF_NEUTRAL,
      fx: { ...HALF_NEUTRAL.fx, fx_star: { file: 'Star.exp3.json', durationMs: 100 } },
    };
    const h1 = makeFakeVts();
    const ok = new VtsBackend(h1.vts, { profile: () => starred });
    ok.fx('fx_star');
    await Promise.resolve();
    expect(h1.expressions.map((e) => e.file)).toEqual(['Star.exp3.json']);
    expect(ok.fxDurationMs('fx_star')).toBe(100);
    expect(ok.fxDurationMs('fx_idea')).toBe(0);
    ok.stop();
  });

  it('参数名单同步中不发帧(453 竞态窗口);名单到手或取消后恢复', () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts);
    backend.beginParameterSync();
    backend.sendFrame({ FaceAngleY: { value: -5, mode: 'add' } });
    expect(injected).toHaveLength(0);
    backend.setKnownParameters(null);
    backend.sendFrame({ FaceAngleY: { value: -5, mode: 'add' } });
    expect(injected).toHaveLength(1);
    backend.beginParameterSync();
    backend.sendFrame({ FaceAngleY: { value: -6, mode: 'add' } });
    expect(injected).toHaveLength(1);
    backend.cancelParameterSync();
    backend.sendFrame({ FaceAngleY: { value: -6, mode: 'add' } });
    expect(injected).toHaveLength(2);
  });

  it('空帧不发请求', async () => {
    const { vts, injected } = makeFakeVts();
    const backend = new VtsBackend(vts);
    backend.sendFrame({});
    await Promise.resolve();
    expect(injected).toHaveLength(0);
  });

  /*
   * 上层用成功注入信号解除故障；仅有 onError 无法识别已恢复。
   */
  it('onInjectOk:两包都拿到回执才响,任一包被拒就不响', async () => {
    const ok: number[] = [];
    const a = makeFakeVts();
    const good = new VtsBackend(a.vts, { onInjectOk: () => ok.push(1) });
    good.sendFrame({ FaceAngleY: { value: -10, mode: 'add' }, MouthOpen: { value: 0.6, mode: 'set' } });
    await vi.waitFor(() => expect(ok).toHaveLength(1));

    const errs: string[] = [];
    const b = makeFakeVts({ rejectMode: 'set' });
    const bad = new VtsBackend(b.vts, {
      onInjectOk: () => ok.push(2),
      onError: (e) => errs.push(e.message),
    });
    bad.sendFrame({ FaceAngleY: { value: -10, mode: 'add' }, MouthOpen: { value: 0.6, mode: 'set' } });
    await vi.waitFor(() => expect(errs).toHaveLength(1));
    expect(ok).toEqual([1]);
  });

  it('fx:开表情,durationMs 后关', async () => {
    vi.useFakeTimers();
    try {
      const { vts, expressions } = makeFakeVts();
      const profile: ModelProfile = {
        ...DEFAULT_PROFILE,
        fx: { ...DEFAULT_PROFILE.fx, fx_idea: { file: 'Idea.exp3.json', durationMs: 900 } },
      };
      const backend = new VtsBackend(vts, { profile: () => profile });
      backend.fx('fx_idea');
      await Promise.resolve();
      expect(expressions).toEqual([{ file: 'Idea.exp3.json', active: true }]);
      await vi.advanceTimersByTimeAsync(900 + 10);
      expect(expressions[1]).toEqual({ file: 'Idea.exp3.json', active: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
