/**
 * VTuber 代理与子进程模组声明相同的局部面板 id，浏览器插件键与声明一致。
 * mount 按链路前缀分派，diag 处理报表与台本演出。model.setProfile 通过装配层写回口保存，未接写回口须报错。
 * 插件资源须通过框架管理，受 fetch、document.body、裸定时器、RAF、WebSocket 和直连 /api/ 的架构约束。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTemplate, templateVarNames } from 'cortico/core/template.ts';
import { VTUBER_PANEL_DECLS } from '../../src/module.ts';
import { VtuberModuleProxy } from '../../src/proxy.ts';
import { ioPageContribution } from 'cortico/bot.ts';
import type { ModulePanelDecl } from 'cortico/core/types.ts';
import { fixtureProfileJson, writeProfileDir } from '../io-vtuber/helpers.ts';

/**
 * 插件是浏览器端代码(DOM 类型,由 tsconfig.web.json 单独 check)。
 * specifier 存进变量,免得根 tsconfig 把它拉进 Node 那份检查——
 * 与 io-qq-console.test.ts 同一个理由。
 */
const VT_PLUGIN_ENTRY = '../../src/console/client.ts';
const CONSOLE_DIR = '../../src/console';

const PANEL_IDS = ['mount', 'model', 'overlay', 'clips', 'tts', 'align', 'log', 'diag'];

/** 不 start 就不会 fork 子进程:这一套断言全在主进程这一侧。 */
const proxy = (opts: ConstructorParameters<typeof VtuberModuleProxy>[0] = {}): VtuberModuleProxy =>
  new VtuberModuleProxy(opts);

const contribution = (p: VtuberModuleProxy) =>
  ioPageContribution('vtuber', 'VTuber 演出', undefined, p);

// ---------------------------------------------------------------------------

describe('VTuber 的面板声明', () => {
  it('八个面板都是局部 id + 真标题,不带模组名前缀', () => {
    const panels = (proxy().console().panels ?? []) as ModulePanelDecl[];
    expect(panels.every((p) => typeof p === 'object')).toBe(true);
    expect(panels.map((p) => p.id)).toEqual(PANEL_IDS);
    expect(panels.map((p) => p.title)).toEqual([
      '挂载', '模型档案', 'Overlay 画面', '动作调参',
      '声线档案', '时间点标注', '演出日志', '演出诊断',
    ]);
    for (const p of panels) expect(p.description).toBeTruthy();
  });


  it('主进程代理报的面板就是模组那份常量(两处不会各说各话)', () => {
    expect(proxy().console().panels).toEqual([...VTUBER_PANEL_DECLS]);
  });

  it('每个面板都显式声明无副作用的 GET 方法', () => {
    const panels = (proxy().console().panels ?? []) as ModulePanelDecl[];
    expect(panels.every((panel) => Object.prototype.hasOwnProperty.call(panel, 'getMethods'))).toBe(true);
    expect(Object.fromEntries(panels.map((panel) => [panel.id, panel.getMethods]))).toEqual({
      mount: ['state', 'vtsState', 'ttsState'],
      model: ['state'],
      overlay: ['state'],
      clips: ['state'],
      tts: ['state', 'voiceWav'],
      align: ['state', 'units'],
      log: ['entries'],
      diag: ['state', 'report', 'presets'],
    });
  });

  it('适配成 provider 贡献后:id 原样、标题与说明照带', () => {
    const c = contribution(proxy());
    expect(c.id).toBe('io:vtuber');
    expect(c.panels?.map((p) => p.id)).toEqual(PANEL_IDS);
    expect(c.panels?.[0].title).toBe('挂载');
    expect(c.panels?.[0].description).toContain('三条链路');
  });

  it('环境提示词只有 vtuber.vocab 一个洞:声明、运行时值、模板三方一致,渲染后词表行进正文', () => {
    const p = proxy();
    const docs = p.console().promptDocs ?? [];
    expect(docs.map((d) => d.key)).toEqual(['io.vtuber.envPrompt']);
    expect(docs[0].vars?.map((v) => v.name)).toEqual(['vtuber.vocab']);
    const vars = p.envPromptVars();
    expect(Object.keys(vars)).toEqual(['vtuber.vocab']);
    expect(vars['vtuber.vocab']).toContain('| 动作 |');

    const template = readFileSync(docs[0].path, 'utf8');
    expect(templateVarNames(template)).toEqual(['vtuber.vocab']);
    const rendered = renderTemplate(template, vars);
    expect(rendered).not.toContain('{{');
    expect(rendered.split(/\r?\n/).some((line) => line.startsWith('| 动作 |') && line.includes('`点头`'))).toBe(true);
  });
});

describe('invoke 按局部 id 分派', () => {
  it('不认识的面板与不认识的方法分别报"未知面板"/"未知面板方法"', async () => {
    const c = contribution(proxy());
    await expect(c.invoke!('nope', 'state', [])).rejects.toThrow('未知面板');
    await expect(c.invoke!('mount', 'nope', [])).rejects.toThrow('未知面板方法');
    // 挂载一屏管两条链路,方法名必须带链路前缀
    await expect(c.invoke!('mount', 'connect', [])).rejects.toThrow('未知面板方法');
  });

  it('旧的命名空间 id 不再是面板(vts / perform 合进了 mount / diag)', async () => {
    const c = contribution(proxy());
    await expect(c.invoke!('vts', 'state', [])).rejects.toThrow('未知面板');
    await expect(c.invoke!('perform', 'presets', [])).rejects.toThrow('未知面板');
  });

  it('tts / align 的方法名与语义一字未改:白名单内放行到引擎,白名单外仍然拦', async () => {
    const c = contribution(proxy());
    // 引擎没起来 = 报"子进程未运行";重点是它**进得去分派**,不是"未知面板"
    for (const m of ['state', 'start', 'stop', 'setProfile', 'saveVoice', 'voiceWav', 'test']) {
      await expect(c.invoke!('tts', m, [])).rejects.toThrow('子进程未运行');
    }
    for (const m of ['state', 'units', 'align', 'synth']) {
      await expect(c.invoke!('align', m, ['你好'])).rejects.toThrow('子进程未运行');
    }
    await expect(c.invoke!('tts', 'nope', [])).rejects.toThrow('未知面板方法');
    await expect(c.invoke!('align', 'nope', [])).rejects.toThrow('未知面板方法');
    // tts 那屏管的是声线,不管 server 启停之外的形象链路
    await expect(c.invoke!('tts', 'vtsConnect', [])).rejects.toThrow('未知面板方法');
  });

  it('mount.state:三条链路各自成败,一条拿不到不连坐另外两条', async () => {
    const c = contribution(proxy());
    // 引擎没起来 = 三条都问不到。这里要的是**它不抛**——面板据此把三行画成"不可用"
    expect(await c.invoke!('mount', 'state', [])).toEqual({ vts: null, tts: null, stream: null });
  });

  it('diag.presets 是主进程静态数据,引擎没起来也拿得到', async () => {
    const c = contribution(proxy());
    const out = await c.invoke!('diag', 'presets', []) as { presets: Array<{ label: string; script: string }> };
    expect(out.presets.length).toBeGreaterThanOrEqual(5);
    expect(out.presets[0].label).toBeTruthy();
    // 引擎那侧的方法照旧要子进程
    await expect(c.invoke!('diag', 'perform', ['【点头】好。'])).rejects.toThrow('子进程未运行');
  });
});

describe('模型档案不再绕过自己的数据面', () => {
  it('setProfile 经装配层写回口落地,并回报生效值;选单来自 live2dDir 下的档案', async () => {
    const live2d = mkdtempSync(join(tmpdir(), 'vtuber-live2d-'));
    writeProfileDir(live2d, 'FixtureModel', fixtureProfileJson());
    try {
      let stored = 'auto';
      const c = contribution(proxy({
        modelProfile: () => stored,
        onModelProfile: (v) => { stored = v; },
        live2dDir: () => live2d,
      }));
      expect(await c.invoke!('model', 'setProfile', ['VTS-Fixture']))
        .toEqual({ ok: true, configured: 'VTS-Fixture' });
      expect(stored).toBe('VTS-Fixture');
    } finally {
      rmSync(live2d, { recursive: true, force: true });
    }
  });

  it('档案值不在选单里就拒收(不写回、不落盘)', async () => {
    let stored = 'auto';
    const c = contribution(proxy({ onModelProfile: (v) => { stored = v; } }));
    await expect(c.invoke!('model', 'setProfile', ['不存在的档案'])).rejects.toThrow('未知模型档案');
    await expect(c.invoke!('model', 'setProfile', [])).rejects.toThrow('未知模型档案');
    expect(stored).toBe('auto');
  });

  it('装配层没接写回口时显式报错,而不是改完悄悄回弹', async () => {
    const c = contribution(proxy());
    await expect(c.invoke!('model', 'setProfile', ['auto'])).rejects.toThrow('没有提供写回口');
  });
});

describe('浏览器插件', () => {
  it('default export 的九个面板键与服务端声明的局部 id 一一对应,且都能 mount', async () => {
    const plugin = ((await import(VT_PLUGIN_ENTRY)) as any).default;
    expect(Object.keys(plugin.panels).sort()).toEqual([...PANEL_IDS].sort());
    for (const id of PANEL_IDS) expect(typeof plugin.panels[id].mount).toBe('function');
    // 两份清单同进同退:服务端声明的每一条都得有插件,反过来也一样
    const declared = ((proxy().console().panels ?? []) as ModulePanelDecl[]).map((p) => p.id);
    expect(Object.keys(plugin.panels).sort()).toEqual([...declared].sort());
  });

  it('插件没有直连 /api/ 的路径', async () => {
    const offenders = await scan(/['"`]\/api\//);
    expect(offenders).toEqual([]);
  });

  it('动画帧走 ctx.frame:没有裸 requestAnimationFrame / cancelAnimationFrame', async () => {
    const offenders = await scan(/\b(request|cancel)AnimationFrame\s*\(/);
    expect(offenders).toEqual([]);
  });

});

/** 扫插件目录里的所有 .ts,回违规的 `文件:行`。注释行不算(那是在解释"为什么不用")。 */
async function scan(re: RegExp): Promise<string[]> {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(import.meta.dirname, CONSOLE_DIR);
  const offenders: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    readFileSync(join(dir, name), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*[/*]/.test(line)) return;
      if (re.test(line)) offenders.push(`${name}:${i + 1}`);
    });
  }
  return offenders;
}
