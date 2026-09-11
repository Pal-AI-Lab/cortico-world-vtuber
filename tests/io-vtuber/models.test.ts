import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROFILE,
  checkModelFile,
  fxFor,
  loadProfiles,
  parseProfile,
  profileById,
  profileByModelName,
  profileChoices,
  resolveProfile,
  toWire,
  type ModelProfile,
} from '../../src/io-vtuber/models/index.ts';
import { EXAMPLE_PACK_DIR, loadPack } from '../../src/io-vtuber/pack.ts';
import { PROFILE_CTX, fixtureProfileJson, writeProfileDir } from './helpers.ts';

const pack = loadPack(EXAMPLE_PACK_DIR);

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const parse = (raw: Record<string, unknown>) => parseProfile(raw, 'fixture.json', PROFILE_CTX).profile;
const warningsOf = (raw: Record<string, unknown>) => parseProfile(raw, 'fixture.json', PROFILE_CTX).warnings;

describe('模型档案 · 校验', () => {
  it('完整档案原样通过,fx 表逐项保留', () => {
    const p = parse(fixtureProfileJson({
      wiring: { EyeOpenLeft: { neutral: 0.5, scale: 0.5, clamp: [0, 1] }, BrowLeftY: { aliasTo: ['Brows'] } },
      unsupported: ['CheekPuff'],
      fx: { fx_idea: null, fx_star: { file: 'Star.exp3.json', durationMs: 900 } },
      caveat: '没有腮帮',
    }));
    expect(p.id).toBe('VTS-Fixture');
    expect(p.vtsModelName).toBe('FixtureModel');
    expect(p.wiring.EyeOpenLeft).toEqual({ neutral: 0.5, scale: 0.5, clamp: [0, 1] });
    expect(p.wiring.BrowLeftY).toEqual({ aliasTo: ['Brows'] });
    expect(p.unsupported).toEqual(['CheekPuff']);
    expect(p.fx.fx_star).toEqual({ file: 'Star.exp3.json', durationMs: 900 });
    expect(p.fx.fx_idea).toBeNull();
    expect(p.caveat).toBe('没有腮帮');
  });

  it('fx 是稀疏表:没写的按 null;写了包外的 id 只警告不拒收', () => {
    const p = parse(fixtureProfileJson({ fx: { fx_star: { file: 'Star.exp3.json', durationMs: 900 } } }));
    expect(fxFor(p, 'fx_star')).toEqual({ file: 'Star.exp3.json', durationMs: 900 });
    expect(fxFor(p, 'fx_sigh')).toBeNull();
    expect(warningsOf(fixtureProfileJson({ fx: {} }))).toEqual([]);
    const w = warningsOf(fixtureProfileJson({ fx: { fx_rainbow: { file: 'Rainbow.exp3.json', durationMs: 900 } } }));
    expect(w).toEqual(['fx.fx_rainbow 不是当前演出包里的特效 id,这条用不上']);
  });

  it('wiring / unsupported 引用包里没有的参数:加载照过,逐条警告', () => {
    const raw = fixtureProfileJson({ wiring: { ParamAngleX: { scale: 1 } }, unsupported: ['Tail'] });
    expect(parse(raw).wiring.ParamAngleX).toEqual({ scale: 1 });
    expect(warningsOf(raw)).toEqual([
      'wiring.ParamAngleX 不是当前演出包里的参数,这条换算用不上',
      'unsupported 里的 Tail 不是当前演出包里的参数',
    ]);
  });

  it('未知顶层字段拒收', () => {
    expect(() => parse(fixtureProfileJson({ fxFiles: {} }))).toThrow(/未知字段 fxFiles/);
  });

  it('backend 只认 vts', () => {
    expect(() => parse(fixtureProfileJson({ backend: 'live2d' }))).toThrow(/backend 目前只能是 "vts"/);
  });

  it('fx 文件名必须以 .exp3.json 结尾', () => {
    const fx = { ...(fixtureProfileJson().fx as object), fx_star: { file: 'Star.json', durationMs: 100 } };
    expect(() => parse(fixtureProfileJson({ fx }))).toThrow(/fx\.fx_star\.file 必须是 \.exp3\.json/);
  });

  it('id 不能占用 auto / VTS-Default 两个保留值', () => {
    expect(() => parse(fixtureProfileJson({ id: 'auto' }))).toThrow(/保留值 auto/);
    expect(() => parse(fixtureProfileJson({ id: 'VTS-Default' }))).toThrow(/保留值 VTS-Default/);
  });
});

describe('模型档案 · 目录发现', () => {
  it('扫 live2dDir 下每个模型目录的 cortico.profile.json:坏文件与重复 id 进 errors,不连坐好档案', () => {
    const root = tmp('vtuber-live2d-');
    const good = writeProfileDir(root, 'ModelA', fixtureProfileJson());
    mkdirSync(join(root, 'NoProfile'));
    writeFileSync(join(root, 'NoProfile', 'x.vtube.json'), '{}');
    writeProfileDir(root, 'Broken', '{ not json');
    writeProfileDir(root, 'Twin', fixtureProfileJson({ vtsModelName: 'TwinModel' }));

    const reg = loadProfiles(root, PROFILE_CTX);
    expect(reg.live2dDir).toBe(root);
    expect(reg.profiles.map((p) => p.profile.id)).toEqual(['VTS-Fixture']);
    expect(reg.profiles[0].warnings).toEqual([]);
    expect(reg.profiles[0].dir).toBe(good);
    expect(reg.profiles[0].file).toBe(join(good, 'cortico.profile.json'));
    expect(reg.errors.map((e) => e.file)).toEqual([
      join(root, 'Broken', 'cortico.profile.json'),
      join(root, 'Twin', 'cortico.profile.json'),
    ]);
    expect(reg.errors[1].message).toContain('已被');
    expect(reg.errors[1].message).toContain(reg.profiles[0].file);
  });

  it('目录未设置 → 空表无错;目录不存在 → 一条错误', () => {
    expect(loadProfiles('  ', PROFILE_CTX)).toEqual({ live2dDir: '', profiles: [], errors: [] });
    const gone = join(tmp('vtuber-live2d-'), 'nope');
    const reg = loadProfiles(gone, PROFILE_CTX);
    expect(reg.profiles).toEqual([]);
    expect(reg.errors).toEqual([{ file: gone, message: 'Live2D 目录不存在' }]);
  });
});

describe('模型档案 · 定档', () => {
  function registry() {
    const root = tmp('vtuber-live2d-');
    writeProfileDir(root, 'ModelA', fixtureProfileJson());
    writeProfileDir(root, 'ModelB', fixtureProfileJson({ id: 'VTS-Other', label: '另一个', vtsModelName: 'OtherModel' }));
    return loadProfiles(root, PROFILE_CTX);
  }

  it('配置显式指定时压过模型名匹配', () => {
    const r = resolveProfile(registry(), 'VTS-Other', 'FixtureModel');
    expect(r.profile.id).toBe('VTS-Other');
    expect(r.how).toBe('configured');
    expect(r.source?.profile.id).toBe('VTS-Other');
  });

  it('auto 按 VTS 报的模型名认', () => {
    const r = resolveProfile(registry(), 'auto', 'FixtureModel');
    expect(r.profile.id).toBe('VTS-Fixture');
    expect(r.how).toBe('matched');
    expect(r.vtsModelName).toBe('FixtureModel');
  });

  it('未识别模型使用默认档案', () => {
    const r = resolveProfile(registry(), 'auto', 'SomeoneElsesModel');
    expect(r.profile).toBe(DEFAULT_PROFILE);
    expect(r.how).toBe('fallback');
    expect(r.source).toBeNull();
  });

  it('配置指了不存在的 id:照样按模型名匹配或退默认档,但 how 报 missing', () => {
    const reg = registry();
    const matched = resolveProfile(reg, 'VTS-不存在', 'FixtureModel');
    expect(matched.profile.id).toBe('VTS-Fixture');
    expect(matched.how).toBe('missing');
    const fallen = resolveProfile(reg, 'VTS-不存在', '');
    expect(fallen.profile).toBe(DEFAULT_PROFILE);
    expect(fallen.how).toBe('missing');
  });

  it('控制台选项 = auto + 全部档案;按 id / 模型名查找', () => {
    const reg = registry();
    const choices = profileChoices(reg);
    expect(choices[0].value).toBe('auto');
    expect(choices.slice(1)).toEqual([
      { value: 'VTS-Fixture', label: '测试模型', vtsModelName: 'FixtureModel' },
      { value: 'VTS-Other', label: '另一个', vtsModelName: 'OtherModel' },
    ]);
    expect(profileById(reg, 'VTS-Other')?.profile.label).toBe('另一个');
    expect(profileById(reg, 'nope')).toBeNull();
    expect(profileByModelName(reg, 'OtherModel')?.profile.id).toBe('VTS-Other');
    expect(profileByModelName(reg, '  ')).toBeNull();
  });
});

const HALF_NEUTRAL: ModelProfile = {
  ...DEFAULT_PROFILE,
  id: 'half',
  label: '半程中性',
  wiring: {
    EyeOpenLeft: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    EyeRightX: { invert: true },
  },
};

const MEASURED: ModelProfile = {
  ...DEFAULT_PROFILE,
  id: 'measured',
  label: '实测斜率',
  wiring: {
    FaceAngleY: { scale: 0.4 },
    FaceAngleZ: { scale: 0.6667 },
    MouthOpen: { scale: 0.4 },
    EyeOpenLeft: { neutral: 0.7337, scale: 0.5337, clamp: [0, 1] },
    BrowLeftY: { neutral: 0.875, scale: 0.125, clamp: [0.75, 1], aliasTo: ['Brows'] },
    BrowRightY: { neutral: 0.875, scale: 0.125, clamp: [0.75, 1], aliasTo: ['Brows'] },
  },
  unsupported: ['CheekPuff'],
};

describe('模型档案 · 换算', () => {
  it('未列出的参数原样直发', () => {
    expect(toWire(HALF_NEUTRAL, 'FaceAngleX', -26)).toEqual({ targets: ['FaceAngleX'], value: -26 });
  });

  it('unsupported 返回 null(调用方据此丢弃)', () => {
    expect(toWire(MEASURED, 'CheekPuff', 0.9)).toBeNull();
    expect(toWire(HALF_NEUTRAL, 'CheekPuff', 0.9)).not.toBeNull();
  });

  it('clamp 钳在区间内,不外推', () => {
    // (1+v)×0.5:v=+1 → 1.0 封顶,不会溢出成 1.5
    expect(toWire(HALF_NEUTRAL, 'EyeOpenLeft', 1)?.value).toBeCloseTo(1, 5);
    expect(toWire(HALF_NEUTRAL, 'EyeOpenLeft', -1)?.value).toBeCloseTo(0, 5);
    expect(toWire(HALF_NEUTRAL, 'EyeOpenLeft', 5)?.value).toBeCloseTo(1, 5);
  });

  it('invert 只翻符号,不动 neutral/scale', () => {
    expect(toWire(HALF_NEUTRAL, 'EyeRightX', 0.75)?.value).toBeCloseTo(-0.75, 5);
  });

  it('实测斜率取倒数:发进去的度数就是屏幕上的度数', () => {
    // 实机斜率 FaceAngleY→ParamAngleY = 2.5;scale 取其倒数
    const y = toWire(MEASURED, 'FaceAngleY', -26)!.value;
    expect(y * 2.5).toBeCloseTo(-26, 1);
    const z = toWire(MEASURED, 'FaceAngleZ', 23)!.value;
    expect(z * 1.5).toBeCloseTo(23, 1);
    const m = toWire(MEASURED, 'MouthOpen', 0.55)!.value;
    expect(m * 2.5).toBeCloseTo(0.55, 3);
  });

  it('眼睑中性挪位:偏移 0 落在实测的正常睁眼位,−1 落在全闭', () => {
    const open = toWire(MEASURED, 'EyeOpenLeft', 0)!.value;
    // 实测 out = −0.375 + 输入×1.874;正常睁眼 out=1.0
    expect(-0.375 + open * 1.874).toBeCloseTo(1, 2);
    const shut = toWire(MEASURED, 'EyeOpenLeft', -1)!.value;
    expect(-0.375 + shut * 1.874).toBeCloseTo(0, 2);
  });

  it('aliasTo 改发目标名;左右眉都指向合并输入 Brows', () => {
    const l = toWire(MEASURED, 'BrowLeftY', 0.4)!;
    const r = toWire(MEASURED, 'BrowRightY', 0.4)!;
    expect(l.targets).toEqual(['Brows']);
    expect(r.targets).toEqual(['Brows']);
    // 实测 Brows→ParamBrowLY 斜率 8、输入 0 时 −7:中性 0.875、±1 打满 ±1
    expect(-7 + l.value * 8).toBeCloseTo(0.4, 2);
    expect(-7 + toWire(MEASURED, 'BrowLeftY', 0)!.value * 8).toBeCloseTo(0, 2);
    expect(-7 + toWire(MEASURED, 'BrowLeftY', -1)!.value * 8).toBeCloseTo(-1, 2);
  });
});

describe('模型档案 · FX', () => {
  it('null = 这个模型没有这个特效;条目原样返回', () => {
    const p: ModelProfile = { ...DEFAULT_PROFILE, fx: { ...DEFAULT_PROFILE.fx, fx_star: { file: 'Star.exp3.json', durationMs: 900 } } };
    expect(fxFor(p, 'fx_idea')).toBeNull();
    expect(fxFor(p, 'fx_star')).toEqual({ file: 'Star.exp3.json', durationMs: 900 });
  });

  it('默认档案:fx 表为空,任何特效 id 都查不到;idle 眨眼交给 mixer', () => {
    expect(DEFAULT_PROFILE.fx).toEqual({});
    for (const id of pack.fxIds) expect(fxFor(DEFAULT_PROFILE, id), id).toBeNull();
    expect(DEFAULT_PROFILE.idleBlinks).toBe(false);
  });

});

describe('模型档案 · 参数集', () => {
  it('演出包声明的参数集覆盖了曲线真正会写的每一个参数', () => {
    const ids = new Set(pack.paramIds);
    const used = new Set<string>();
    for (const c of Object.values(pack.pulse)) for (const k of Object.keys(c.tracks)) used.add(k);
    for (const c of Object.values(pack.sustain)) for (const k of Object.keys(c.hold)) used.add(k);
    for (const k of used) expect(ids.has(k), `params.json 缺 ${k}`).toBe(true);
  });

  it('默认档案的换算项都是范例包里的参数', () => {
    const ids = new Set(pack.paramIds);
    for (const k of Object.keys(DEFAULT_PROFILE.wiring)) expect(ids.has(k), k).toBe(true);
  });
});

describe('模型档案 · 模型文件复检', () => {
  function modelDir(vtube: Record<string, unknown>, files: Record<string, unknown> = {}): string {
    const dir = tmp('vtuber-model-');
    writeFileSync(join(dir, 'x.vtube.json'), JSON.stringify(vtube));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), JSON.stringify(content));
    }
    return dir;
  }
  const profile = (over: Partial<ModelProfile>): ModelProfile =>
    ({ ...DEFAULT_PROFILE, id: 'VTS-Fixture', vtsModelName: 'FixtureModel', ...over });

  it('眼睑输入带 Smoothing 报警;头部 Smoothing 0 不报;Name 对不上报警', () => {
    const dir = modelDir({
      Name: 'FixtureModel',
      ParameterSettings: [
        { Input: 'EyeOpenLeft', OutputLive2D: 'ParamEyeLOpen', Smoothing: 50 },
        { Input: 'FaceAngleX', OutputLive2D: 'ParamAngleX', Smoothing: 0 },
      ],
    });
    const r = checkModelFile(profile({}), dir);
    expect(r.vtubeFile).toBe(join(dir, 'x.vtube.json'));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('EyeOpenLeft→ParamEyeLOpen Smoothing=50');

    const renamed = checkModelFile(profile({ vtsModelName: 'Elsewhere' }), dir);
    expect(renamed.warnings.some((w) => w.includes('vtsModelName「Elsewhere」') && w.includes('Name「FixtureModel」'))).toBe(true);
  });

  it('aliasTo 改发的目标输入同样查平滑', () => {
    const dir = modelDir({
      Name: 'FixtureModel',
      ParameterSettings: [{ Input: 'Brows', OutputLive2D: 'ParamBrowLY', Smoothing: 30 }, { Input: 'Lids', Smoothing: 30 }],
    });
    const r = checkModelFile(profile({ wiring: { EyeOpenLeft: { aliasTo: ['Lids'] }, BrowLeftY: { aliasTo: ['Brows'] } } }), dir);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Lids→? Smoothing=30');
  });

  it('档案引用的表情文件在模型目录(含子目录)里找不到就报警', () => {
    const dir = modelDir({ Name: 'FixtureModel' }, { 'Expressions/Star.exp3.json': {} });
    const r = checkModelFile(profile({
      fx: { ...DEFAULT_PROFILE.fx, fx_star: { file: 'Star.exp3.json', durationMs: 100 }, fx_idea: { file: 'Idea.exp3.json', durationMs: 100 } },
    }), dir);
    expect(r.warnings).toEqual(['表情文件 Idea.exp3.json 在模型目录里找不到']);
  });

  it('idle 动画驱动眼睑与档案 idleBlinks 不一致就报警', () => {
    const blinking = modelDir(
      { Name: 'FixtureModel', FileReferences: { IdleAnimation: 'idle.motion3.json' } },
      { 'motions/idle.motion3.json': { Curves: [{ Id: 'ParamEyeLOpen' }, { Id: 'ParamAngleX' }] } },
    );
    expect(checkModelFile(profile({ idleBlinks: false }), blinking).warnings).toEqual([
      'idle 动画 idle.motion3.json 驱动眼睑,档案却写 idleBlinks:false(空闲期会双重眨眼)',
    ]);
    expect(checkModelFile(profile({ idleBlinks: true }), blinking).warnings).toEqual([]);

    const still = modelDir(
      { Name: 'FixtureModel', FileReferences: { IdleAnimation: 'idle.motion3.json' } },
      { 'idle.motion3.json': { Curves: [{ Id: 'ParamAngleX' }] } },
    );
    const w = checkModelFile(profile({ idleBlinks: true }), still).warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('idleBlinks');
    expect(checkModelFile(profile({ idleBlinks: false }), still).warnings).toEqual([]);
  });

  it('没有 .vtube.json 的目录只报一条,不猜', () => {
    const dir = tmp('vtuber-model-');
    expect(checkModelFile(profile({}), dir)).toEqual({ vtubeFile: null, warnings: ['模型目录里没有 .vtube.json(VTS 至少加载过一次才会生成)'] });
  });
});
