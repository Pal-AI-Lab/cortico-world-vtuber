/**
 * @vitest-environment jsdom
 *
 * 声线档案面板(TTS 服务表)与服务注册表数据面的交互:服务表铺进下拉、保存带上
 * 读到的 revision、草稿试听只走 testService、legacy 与 managed 两块只跟着选中的
 * 服务出现,以及「挂载」那行对 external 服务的处理。
 * 框架的面板上下文是真件,`ctx.invoke` 落到被拦截的 fetch 上,按 wire 形状回话。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LIFECYCLE = 'cortico/web/client/core/lifecycle.ts';
const PANEL_CONTEXT = 'cortico/web/client/console-pages/context.ts';
const VTUBER_TTS = '../../src/console/tts.ts';
const VTUBER_MOUNT = '../../src/console/mount.ts';

// 浏览器端源码带 DOM 类型;specifier 存进变量,免得 Node 那份 typecheck 把它们拉进源图。
type Any = any;

const doc = (globalThis as Any).document;

const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { createPanelContext } = (await import(PANEL_CONTEXT)) as Any;
const { ttsPanel } = (await import(VTUBER_TTS)) as Any;
const { mountPanel } = (await import(VTUBER_MOUNT)) as Any;

interface Call {
  method: string;
  args: Any[];
}

/** 一条 external 的通用 OpenAI 服务。 */
const openAiService = {
  id: 'remote-a',
  name: '远程 A',
  protocol: 'openai-speech',
  management: 'external',
  baseUrl: 'https://tts.example.com/proxy/v1',
  speechPath: '',
  auth: { type: 'none' as const },
  model: 'tts-1',
  voice: 'alloy',
  responseFormat: 'wav' as const,
  delivery: 'auto' as const,
  timeoutMs: 60000,
};

/** 一条受管的本地 VoxCPM2 服务:参考音频、旧运行时路径与运行时下载都挂在它上面。 */
const legacyService = {
  id: 'legacy-default',
  name: '默认 VoxCPM2',
  protocol: 'voxcpm-legacy',
  management: 'managed-voxcpm',
  baseUrl: 'http://127.0.0.1:8020/v1',
  auth: { type: 'none' as const },
  model: 'voxcpm2',
  voice: 'default',
  responseFormat: 'wav' as const,
  delivery: 'auto' as const,
  timeoutMs: 60000,
  legacy: {
    profile: {
      refAudio: 'mei.wav',
      refText: '你好',
      seed: 42,
      cfgValue: 2,
      inferenceTimesteps: 10,
      maxSteps: 200,
      temperature: 1,
    },
    runtime: {
      runtimeDir: 'D:\\rt',
      runtimeRelease: 'b4200',
      baseLmFile: 'base.gguf',
      acousticFile: 'acoustic.gguf',
      alignerLmFile: '',
      alignerAudioFile: '',
      voicesDir: 'D:\\voices',
    },
  },
};

const LOCAL_RESOURCES = {
  server: { path: 'srv', ready: true },
  baseLm: { path: 'a', ready: true, configured: false },
  acoustic: { path: 'b', ready: true, configured: false },
  alignerLm: { path: '', ready: false, configured: false },
  alignerAudio: { path: '', ready: false, configured: false },
  alignerRequired: false,
  alignerReady: false,
  ready: true,
};

const DEFAULT_PROFILE = {
  refAudio: null,
  refText: '',
  seed: 42,
  cfgValue: 2,
  inferenceTimesteps: 10,
  maxSteps: 200,
  temperature: 1,
};

interface Fixture {
  services: Any;
  state: Any;
  runtime: Any;
  calls: Call[];
  replies: Record<string, Any>;
  blob: Blob;
}

function fixture(active: Any = openAiService, extra: Any[] = []): Fixture {
  const managed = active.management === 'managed-voxcpm';
  const services = {
    version: 1,
    revision: 7,
    activeServiceId: active.id,
    services: [active, ...extra],
    notes: [],
    protectedIds: ['legacy-default'],
    savedRevision: 7,
    appliedRevision: 7,
    appliedServiceId: active.id,
    pendingApply: false,
  };
  const state = {
    registry: services,
    appliedRevision: 7,
    local: managed
      ? {
          phase: 'running',
          url: 'http://127.0.0.1:8020',
          pid: 42,
          detail: null,
          reachable: true,
          resources: LOCAL_RESOURCES,
        }
      : null,
    managed,
    legacy: active.protocol === 'voxcpm-legacy',
    // 服务端按"第一条带 legacy 段的条目"定内置条目;声线档案与本地运行时路径只归它
    builtinServiceId: (services.services as Any[]).find((s) => s.legacy)?.id ?? '',
    profile: active.legacy?.profile ?? DEFAULT_PROFILE,
    voices: [{ file: 'mei.wav', text: '你好' }],
    voicesDir: 'D:\\voices',
  };
  const runtime = {
    release: 'b4200',
    key: null,
    dir: 'D:\\rt',
    own: false,
    supported: true,
    install: { phase: 'installed', file: null, done: 0, total: null, detail: null },
    models: [{
      id: 'baseLm',
      file: 'base.gguf',
      path: 'D:\\models\\base.gguf',
      phase: 'present',
      bytes: 1024,
      done: 0,
      total: null,
      detail: null,
      required: true,
      source: 'https://example.invalid/base.gguf',
    }],
  };
  return { services, state, runtime, calls: [], replies: {}, blob: new Blob(['RIFF'], { type: 'audio/wav' }) };
}

function json(body: unknown): Any {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}

/** 面板 mount 时按方法名回话;未声明的请求直接抛,免得测试悄悄漏掉一条数据面。 */
function install(fx: Fixture, extra: Record<string, unknown> = {}): void {
  vi.stubGlobal('fetch', (input: Any, init?: Any) => {
    const url = String(input);
    const method = url.split('/').pop() ?? '';
    const args = init?.body ? (JSON.parse(String(init.body)).args ?? []) : [];
    fx.calls.push({ method, args });
    if (Object.prototype.hasOwnProperty.call(extra, method)) return Promise.resolve(json(extra[method]));
    if (method === 'services') return Promise.resolve(json(fx.services));
    if (method === 'state') return Promise.resolve(json(fx.state));
    if (method === 'runtime') return Promise.resolve(json(fx.runtime));
    if (method === 'voiceWav') {
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(fx.blob),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });
    }
    if (method in fx.replies) return Promise.resolve(json(fx.replies[method]));
    throw new Error(`未声明的请求：${method}`);
  });
}

const flush = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

function context(panelId: string, root: Any): Any {
  return createPanelContext({
    pageId: 'world:vtuber',
    panelId,
    root,
    lifecycle: new Lifecycle(),
    overlayHost: doc.body,
    refresh: async () => {},
    addLeaveGuard: () => ({ dispose() {} }),
    memo: (() => {
      const values = new Map<string, unknown>();
      return {
        get: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
        set: (key: string, value: unknown) => values.set(key, value),
      };
    })(),
    createSocket: () => { throw new Error('本测试不建立流'); },
    wsUrl: (path: string) => path,
    onError: vi.fn(),
    doc,
    mountSlot: async () => ({ dispose() {} }),
  });
}

/** 找一个字段行里的控件。`ui.field` 的标签是 `.fieldlabel`。 */
function field(root: Any, label: string): Any {
  const hit = Array.from(root.querySelectorAll('.fieldrow') as Any[])
    .find((row: Any) => row.querySelector(':scope > .fieldlabel')?.textContent === label);
  if (!hit) throw new Error(`没有找到字段：${label}`);
  return hit;
}

/** 参考转写是裸 textarea(不走 `ui.field`),也是 legacy 区块里唯一的多行框。 */
function transcript(root: Any): Any {
  const hit = block(root, 'legacy').querySelector('textarea');
  if (!hit) throw new Error('没有找到参考转写');
  return hit;
}

function button(scope: Any, label: string): Any {
  const hit = Array.from(scope.querySelectorAll('button') as Any[]).find((b: Any) => b.textContent === label);
  if (!hit) throw new Error(`没有找到按钮：${label}`);
  return hit;
}

const text = (root: Any): string => root.textContent ?? '';

const callsOf = (fx: Fixture, method: string): Call[] => fx.calls.filter((c) => c.method === method);

async function mountTts(fx: Fixture, extra: Record<string, unknown> = {}): Promise<Any> {
  install(fx, extra);
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  ttsPanel.mount(context('tts', root));
  await flush();
  return root;
}

/** jsdom 不实现 ObjectURL;面板拿它喂播放器,这里给一对最小替身。 */
function stubObjectUrl(): void {
  let seq = 0;
  const view = doc.defaultView;
  view.URL.createObjectURL = () => `blob:test/${++seq}`;
  view.URL.revokeObjectURL = () => {};
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubObjectUrl();
});

afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

/** 面板里那几个按当前服务开关的区块;`hidden` 是切区块的唯一手段。 */
function block(root: Any, name: string): Any {
  const hit = root.querySelector(`[data-vt-block=${name}]`);
  if (!hit) throw new Error(`没有找到区块：${name}`);
  return hit;
}

/** 页面最上面那个「当前 TTS 服务」下拉:卡片体里第一排那个 select。 */
function picker(root: Any): Any {
  const hit = root.querySelector('.sheetbody > .rowbar select');
  if (!hit) throw new Error('没有找到当前服务选择器');
  return hit;
}

/** 服务列表里的一条折叠卡,按条文名找(标题的第一个文本节点)。 */
function row(root: Any, name: string): Any {
  const hit = Array.from(root.querySelectorAll('details.sheet.fold') as Any[])
    .find((d: Any) => d.querySelector('summary h3')?.firstChild?.textContent === name);
  if (!hit) throw new Error(`没有找到服务条目：${name}`);
  return hit;
}

function summaryOf(card: Any): Any {
  const hit = card.querySelector('summary');
  if (!hit) throw new Error('没有找到折叠条目的摘要行');
  return hit;
}

/** 摘要行右侧那排:内置标记、状态与两颗按钮。 */
function noteOf(card: Any): Any {
  const hit = card.querySelector('summary .foldnote');
  if (!hit) throw new Error('没有找到摘要行右侧那排');
  return hit;
}

/** 在给定范围内按文字找按钮点一下。 */
function clickText(scope: Any, label: string): void {
  const hit = Array.from((scope ?? doc.body).querySelectorAll('button') as Any[])
    .find((b: Any) => b.textContent === label);
  if (!hit) throw new Error(`没有找到按钮：${label}`);
  hit.click();
}

/** 按文字找按钮并派发给定的事件(用来核对 preventDefault 有没有被调过)。 */
function clickTextWith(scope: Any, label: string, ev: Any): void {
  const hit = Array.from(scope.querySelectorAll('button') as Any[])
    .find((b: Any) => b.textContent === label);
  if (!hit) throw new Error(`没有找到按钮：${label}`);
  hit.dispatchEvent(ev);
}

/** 确认弹窗(挂在 overlayHost 上,也就是 doc.body)。 */
function modal(): Any {
  const hit = doc.body.querySelector('.modal .modalcard');
  if (!hit) throw new Error('没有弹确认窗');
  return hit;
}

/**
 * `activateService` 的回执:装的是一段 getter,取它的那一刻顺手把服务表也翻过去,
 * 像服务端真把当前服务换了那样——切完的那次 `services()` 读到的就是新值。
 */
function onActivate(fx: Fixture, id: string, pendingApply = false): void {
  Object.defineProperty(fx.replies, 'activateService', {
    configurable: true,
    enumerable: true,
    get: () => {
      fx.services.activeServiceId = id;
      fx.services.appliedServiceId = id;
      fx.services.appliedRevision = pendingApply ? 7 : 8;
      fx.services.revision = 8;
      return {
        savedRevision: 8,
        appliedRevision: pendingApply ? 7 : 8,
        activeServiceId: id,
        appliedServiceId: id,
        pendingApply,
        message: pendingApply
          ? '已保存(版本 8),但演出引擎尚未确认应用:未连接。可重试应用。'
          : '已保存并应用到演出引擎(版本 8)。',
      };
    },
  });
}

describe('声线档案面板：服务表', () => {
  it('服务表从 services() 铺进下拉，当前服务那行报服务名与修订状态', async () => {
    const fx = fixture();
    const root = await mountTts(fx);

    const options = Array.from(root.querySelectorAll('select option') as Any[]).map((o: Any) => o.value);
    expect(options).toContain('remote-a');
    expect(text(root)).toContain('远程 A');
    expect(text(root)).toContain('已应用');
    // 地址预览按服务端的拼法接出来:代理前缀留在原地,空 speechPath 落回 audio/speech
    expect(text(root)).toContain('https://tts.example.com/proxy/v1/audio/speech');
    expect(callsOf(fx, 'services').length).toBeGreaterThan(0);
  });

  it('openai-speech + external：参考音频、运行时与设备联调都不出现', async () => {
    const fx = fixture();
    const root = await mountTts(fx);

    expect(block(root, 'legacy').hidden).toBe(true);
    expect(block(root, 'managed').hidden).toBe(true);
    expect(button(root, '设备联调').disabled).toBe(true);
    // 没挂进 DOM 的区块不会去问运行时装没装
    expect(callsOf(fx, 'runtime')).toEqual([]);
    // 参考音频那两个入口跟着 legacy 区块一起关掉
    expect(button(root, '试听参考').disabled).toBe(true);
  });

  it('保存提交读到的 revision 与整份草稿；「保存并设为当前」带上 activate', async () => {
    const fx = fixture();
    fx.replies.saveService = {
      savedRevision: 8,
      appliedRevision: 8,
      activeServiceId: 'remote-a',
      pendingApply: false,
      message: '已保存并应用到演出引擎(版本 8)。',
    };
    const root = await mountTts(fx);

    field(root, '名称').querySelector('input').value = '远程 A 改名';
    button(root, '保存并设为当前').click();
    await flush();

    const saved = callsOf(fx, 'saveService');
    expect(saved).toHaveLength(1);
    const request = saved[0].args[0];
    expect(request.baseRevision).toBe(7);
    expect(request.activate).toBe(true);
    expect(request.service.id).toBe('remote-a');
    expect(request.service.name).toBe('远程 A 改名');
    // openai-speech 不该把 legacy 段带过去(服务端会拒)
    expect(request.service.legacy).toBeUndefined();
    expect(text(root)).toContain('已保存并应用到演出引擎');
  });

  it('扩展 JSON 参数写坏时在本地拦下，不发保存请求', async () => {
    const fx = fixture();
    const root = await mountTts(fx);

    button(root, '展开').click();
    field(root, '扩展 JSON 参数').querySelector('textarea').value = '{ 不是 JSON';
    button(root, '保存配置').click();
    await flush();

    expect(callsOf(fx, 'saveService')).toEqual([]);
    expect(text(root)).toContain('扩展参数不是合法 JSON');
  });
});

describe('声线档案面板：草稿试听', () => {
  it('合成试听走 testService，不保存也不切换，voice 对象按 JSON 解析回去', async () => {
    const fx = fixture();
    fx.replies.testService = { message: '试听 OK:900ms 音频,耗时 12ms;服务「远程 A」;仅本页播放', wav: 'UklGRg==' };
    const root = await mountTts(fx);

    field(root, 'Voice').querySelector('input').value = '{"id": "nova"}';
    button(root, '合成试听').click();
    await flush();

    const auditions = callsOf(fx, 'testService');
    expect(auditions).toHaveLength(1);
    expect(auditions[0].args[0].voice).toEqual({ id: 'nova' });
    expect(auditions[0].args[0].baseUrl).toBe('https://tts.example.com/proxy/v1');
    // 这条链路只该碰 testService:不落盘、不切换、也不走设备联调那条
    expect(callsOf(fx, 'saveService')).toEqual([]);
    expect(callsOf(fx, 'activateService')).toEqual([]);
    expect(callsOf(fx, 'test')).toEqual([]);
    expect(text(root)).toContain('试听 OK');
    expect(text(root)).toContain('页面等待');
  });
});

describe('声线档案面板：legacy 与 managed 两块', () => {
  it('voxcpm-legacy + managed-voxcpm：参考音频、旧运行时路径与运行时下载都出来', async () => {
    const fx = fixture(legacyService);
    const root = await mountTts(fx);

    expect(block(root, 'legacy').hidden).toBe(false);
    expect(block(root, 'managed').hidden).toBe(false);
    expect(text(root)).toContain('参考转写 ref_text');
    expect(text(root)).toContain('本地运行时路径');
    expect(text(root)).toContain('运行时与权重');
    expect(field(root, '运行时目录').querySelector('input').value).toBe('D:\\rt');
    expect(callsOf(fx, 'runtime').length).toBeGreaterThan(0);
    expect(button(root, '设备联调').disabled).toBe(false);
  });

  it('保存 legacy 服务时带上声线档案与运行时路径', async () => {
    const fx = fixture(legacyService);
    fx.replies.saveService = {
      savedRevision: 8,
      appliedRevision: 7,
      activeServiceId: 'legacy-default',
      pendingApply: true,
      message: '已保存(版本 8),但演出引擎尚未确认应用。',
    };
    const root = await mountTts(fx);

    // 转写跟着选中的声线走:先选声线再改文本
    const sel = block(root, 'legacy').querySelector('select');
    sel.value = 'mei.wav';
    sel.dispatchEvent(new doc.defaultView.Event('change'));
    transcript(root).value = '你好呀';
    button(root, '保存配置').click();
    await flush();

    const request = callsOf(fx, 'saveService')[0].args[0];
    expect(request.activate).toBeUndefined();
    expect(request.service.legacy.profile.refText).toBe('你好呀');
    expect(request.service.legacy.profile.refAudio).toBe('mei.wav');
    expect(request.service.legacy.runtime.runtimeDir).toBe('D:\\rt');
    expect(request.service.legacy.runtime.voicesDir).toBe('D:\\voices');
  });

  it('放进本地参考音频走 saveVoice，并按新声线补一个下拉选项', async () => {
    const fx = fixture(legacyService);
    fx.replies.saveVoice = { file: 'new.wav', path: 'D:\\voices\\new.wav', converted: null };
    const root = await mountTts(fx);

    const picker = root.querySelector('input[type=file]') as Any;
    const file = new doc.defaultView.File([new Uint8Array([1, 2, 3])], 'new.wav', { type: 'audio/wav' });
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    picker.dispatchEvent(new doc.defaultView.Event('change'));
    await flush();

    expect(callsOf(fx, 'saveVoice')[0].args[0]).toBe('new.wav');
    const options = Array.from(root.querySelectorAll('select option') as Any[]).map((o: Any) => o.value);
    expect(options).toContain('new.wav');
  });
});

/**
 * `saveService` 的回执:同样是 getter,取它的那一刻把落盘后的服务表换掉——
 * 保存之后的那次 `services()` 读到的就是刚存下的这一条。
 */
function onSave(fx: Fixture, saved: Any, message = '已保存并应用到演出引擎(版本 8)。'): void {
  Object.defineProperty(fx.replies, 'saveService', {
    configurable: true,
    enumerable: true,
    get: () => {
      const exists = fx.services.services.some((s: Any) => s.id === saved.id);
      fx.services.services = exists
        ? fx.services.services.map((s: Any) => (s.id === saved.id ? saved : s))
        : [...fx.services.services, saved];
      fx.services.revision = 8;
      fx.services.savedRevision = 8;
      fx.services.appliedRevision = 8;
      return {
        savedRevision: 8,
        appliedRevision: 8,
        activeServiceId: fx.services.activeServiceId,
        appliedServiceId: fx.services.activeServiceId,
        pendingApply: false,
        message,
      };
    },
  });
}

/** 服务列表里各条的名字,按列表顺序。 */
function titles(root: Any): string[] {
  return Array.from(root.querySelectorAll('details.sheet.fold summary h3') as Any[])
    .map((h: Any) => h.firstChild?.textContent ?? '');
}

/**
 * `deleteService` 的回执:取它的那一刻把这条从服务表里去掉,
 * 当前服务被删时按服务端那样换到剩下的一条上。
 */
function onDelete(fx: Fixture, id: string): void {
  Object.defineProperty(fx.replies, 'deleteService', {
    configurable: true,
    enumerable: true,
    get: () => {
      const gone = fx.services.services.find((s: Any) => s.id === id);
      fx.services.services = fx.services.services.filter((s: Any) => s.id !== id);
      fx.services.revision = 8;
      const active = fx.services.activeServiceId === id
        ? (fx.services.services[0]?.id ?? '')
        : fx.services.activeServiceId;
      fx.services.activeServiceId = active;
      return {
        savedRevision: 8,
        appliedRevision: 8,
        activeServiceId: active,
        appliedServiceId: active,
        pendingApply: false,
        message: `已删除「${gone?.name ?? id}」。`,
      };
    },
  });
}

describe('声线档案面板：当前服务选择器', () => {
  it('列出全部服务；换一条调 activateService(带读到的 revision)，并说明切到了谁', async () => {
    const fx = fixture(openAiService, [legacyService]);
    onActivate(fx, 'legacy-default');
    const root = await mountTts(fx);

    const sel = picker(root);
    expect(Array.from(sel.options as Any[]).map((o: Any) => o.value)).toEqual(['remote-a', 'legacy-default']);
    expect(sel.value).toBe('remote-a');
    // 当前那行的最终请求地址按当前服务拼
    expect(text(root)).toContain('最终请求地址:https://tts.example.com/proxy/v1/audio/speech');

    sel.value = 'legacy-default';
    sel.dispatchEvent(new doc.defaultView.Event('change'));
    await flush();

    const acts = callsOf(fx, 'activateService');
    expect(acts).toHaveLength(1);
    expect(acts[0].args[0]).toEqual({ id: 'legacy-default', baseRevision: 7 });
    // 切换只动当前服务:没有顺手保存什么
    expect(callsOf(fx, 'saveService')).toEqual([]);
    expect(text(root)).toContain('已切到「默认 VoxCPM2」(版本 8)');
    expect(picker(root).value).toBe('legacy-default');
  });

  it('演出引擎没确认应用时说清楚，不是当成失败', async () => {
    const fx = fixture(openAiService, [legacyService]);
    onActivate(fx, 'legacy-default', true);
    const root = await mountTts(fx);

    const sel = picker(root);
    sel.value = 'legacy-default';
    sel.dispatchEvent(new doc.defaultView.Event('change'));
    await flush();

    expect(text(root)).toContain('已切到「默认 VoxCPM2」(版本 8)');
    expect(text(root)).toContain('已保存但演出引擎尚未确认应用');
  });
});

describe('声线档案面板：未保存的改动', () => {
  it('表单上有未保存的编辑时，换当前服务先问一句；不答应就不切', async () => {
    const fx = fixture(openAiService, [legacyService]);
    onActivate(fx, 'legacy-default');
    const root = await mountTts(fx);

    field(root, '名称').querySelector('input').value = '远程 A 改名';

    const sel = picker(root);
    sel.value = 'legacy-default';
    sel.dispatchEvent(new doc.defaultView.Event('change'));
    await flush();

    expect(modal().textContent).toContain('未保存');
    clickText(modal(), '取消');
    await flush();

    expect(callsOf(fx, 'activateService')).toEqual([]);
    expect(picker(root).value).toBe('remote-a');
    expect(field(root, '名称').querySelector('input').value).toBe('远程 A 改名');

    picker(root).value = 'legacy-default';
    picker(root).dispatchEvent(new doc.defaultView.Event('change'));
    await flush();
    clickText(modal(), '仍要继续');
    await flush();

    expect(callsOf(fx, 'activateService')[0].args[0].id).toBe('legacy-default');
  });

  it('展开别条条目同样先问：问不答应就把刚展开的那条收回去', async () => {
    const fx = fixture(openAiService, [legacyService]);
    const root = await mountTts(fx);

    field(root, '名称').querySelector('input').value = '远程 A 改名';
    summaryOf(row(root, '默认 VoxCPM2')).click();
    await flush();

    expect(modal().textContent).toContain('未保存');
    clickText(modal(), '取消');
    await flush();

    // 表单还铺在原来那条上:收起来的这条里没有 [data-vt-block=form]
    expect(row(root, '默认 VoxCPM2').open).toBe(false);
    expect(row(root, '远程 A').querySelector('[data-vt-block=form]')).toBeTruthy();
    expect(field(root, '名称').querySelector('input').value).toBe('远程 A 改名');
  });
});

describe('声线档案面板：服务条目', () => {
  it('收起当前那条就把表单摘下来，再展开还是原来那份值', async () => {
    const fx = fixture();
    const root = await mountTts(fx);

    field(root, '名称').querySelector('input').value = '没保存的名字';
    summaryOf(row(root, '远程 A')).click();
    await flush();

    // 收起来就不铺表单:控件留在内存里,值不丢
    expect(root.querySelector('[data-vt-block=form]')).toBeNull();
    expect(callsOf(fx, 'saveService')).toEqual([]);

    summaryOf(row(root, '远程 A')).click();
    await flush();

    expect(field(root, '名称').querySelector('input').value).toBe('没保存的名字');
  });

  it('删除走条目上的那颗按钮：删当前服务时带上替代服务', async () => {
    const fx = fixture(openAiService, [legacyService]);
    onDelete(fx, 'remote-a');
    const root = await mountTts(fx);

    clickText(row(root, '远程 A'), '删除');
    await flush();
    expect(modal().textContent).toContain('删除当前服务');
    clickText(modal(), '仍要继续');
    await flush();

    const calls = callsOf(fx, 'deleteService');
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toEqual({ id: 'remote-a', baseRevision: 7, replacementId: 'legacy-default' });
    // 删完当前服务换成替代那条:列表里少了它,表单铺到替代那条上
    expect(titles(root)).toEqual(['默认 VoxCPM2']);
    expect(field(root, '服务 ID').querySelector('input').value).toBe('legacy-default');
    expect(block(root, 'legacy').hidden).toBe(false);
    expect(picker(root).value).toBe('legacy-default');
  });

  it('条目上的「设为当前」只切换服务，不连带折叠', async () => {
    const fx = fixture(openAiService, [legacyService]);
    onActivate(fx, 'legacy-default');
    const root = await mountTts(fx);

    const legacyRow = row(root, '默认 VoxCPM2');
    expect(legacyRow.open).toBe(false);

    const ev = new doc.defaultView.MouseEvent('click', { bubbles: true, cancelable: true });
    clickTextWith(legacyRow, '设为当前', ev);
    // 摘要行里的按钮自己掐掉默认动作,不然点一下会连带开合这张卡
    expect(ev.defaultPrevented).toBe(true);
    expect(legacyRow.open).toBe(false);

    await flush();
    expect(callsOf(fx, 'activateService')[0].args[0].id).toBe('legacy-default');
    expect(callsOf(fx, 'saveService')).toEqual([]);
    // 重铺之后仍是那条收起、这条展开
    expect(row(root, '默认 VoxCPM2').open).toBe(false);
    expect(row(root, '远程 A').open).toBe(true);
  });

  it('内置那条标着「默认」；它不是当前服务时不摆声线档案，切过去才摆', async () => {
    const fx = fixture(openAiService, [legacyService]);
    onActivate(fx, 'legacy-default');
    const root = await mountTts(fx);

    const legacyRow = row(root, '默认 VoxCPM2');
    expect(noteOf(legacyRow).textContent).toContain('默认');
    expect(legacyRow.open).toBe(false);
    expect(legacyRow.querySelector('[data-vt-block=legacy]')).toBeNull();
    expect(callsOf(fx, 'runtime')).toEqual([]);

    summaryOf(legacyRow).click();
    await flush();

    const opened = row(root, '默认 VoxCPM2');
    expect(opened.open).toBe(true);
    /*
     * 声线档案在演出引擎里只认当前服务,本地运行时路径也只从内置条目读。这条还不
     * 是当前服务时把控件摆出来,编辑会落到正在用的那条身上(或被服务端拒掉),
     * 所以只给一句说明,控件本身不进 DOM。
     */
    expect(block(root, 'legacy').hidden).toBe(true);
    expect(block(root, 'managed').hidden).toBe(true);
    expect(text(root)).toContain('先「设为当前」再改');
    expect(callsOf(fx, 'runtime')).toEqual([]);
    // 换了一条展开:原来那条收起来,表单只有一份
    expect(row(root, '远程 A').open).toBe(false);
    expect(root.querySelectorAll('[data-vt-block=form]').length).toBe(1);

    // 切到它之后,声线档案与本地运行时两块才出来
    clickText(row(root, '默认 VoxCPM2'), '设为当前');
    await flush();
    expect(block(root, 'legacy').hidden).toBe(false);
    expect(block(root, 'managed').hidden).toBe(false);
    expect(text(root)).toContain('参考转写 ref_text');
    expect(text(root)).toContain('运行时与权重');
    expect(field(root, '运行时目录').querySelector('input').value).toBe('D:\\rt');
    expect(callsOf(fx, 'runtime').length).toBeGreaterThan(0);
  });

  it('别的条目展开铺服务表单，试听只走 testService', async () => {
    const fx = fixture(legacyService, [openAiService]);
    fx.replies.testService = { message: '试听 OK:900ms 音频,耗时 12ms;服务「远程 A」;仅本页播放', wav: 'UklGRg==' };
    const root = await mountTts(fx);

    expect(block(root, 'legacy').hidden).toBe(false);
    summaryOf(row(root, '远程 A')).click();
    await flush();

    const aiRow = row(root, '远程 A');
    expect(aiRow.open).toBe(true);
    // 表单挪到这条的 body 里了:服务字段在这里,legacy 那两块收起来
    expect(field(aiRow, '名称')).toBeTruthy();
    expect(field(aiRow, 'Base URL(API 前缀)').querySelector('input').value)
      .toBe('https://tts.example.com/proxy/v1');
    expect(block(root, 'legacy').hidden).toBe(true);
    expect(block(root, 'managed').hidden).toBe(true);

    button(root, '合成试听').click();
    await flush();

    const auditions = callsOf(fx, 'testService');
    expect(auditions).toHaveLength(1);
    expect(auditions[0].args[0].id).toBe('remote-a');
    // 这条链路只该碰 testService:不落盘、不切换、也不走设备联调那条
    expect(callsOf(fx, 'saveService')).toEqual([]);
    expect(callsOf(fx, 'activateService')).toEqual([]);
    expect(callsOf(fx, 'test')).toEqual([]);
  });

  it('输出格式是 pcm 时试听草稿带上采样率与声道数:服务端不猜,缺了就被拒', async () => {
    const pcmService = {
      ...openAiService,
      id: 'pcm-svc',
      name: 'PCM 服务',
      responseFormat: 'pcm',
      pcm: { sampleRate: 24000, channels: 1, encoding: 's16le' },
    };
    const fx = fixture(pcmService);
    fx.replies.testService = { message: '试听 OK:900ms 音频', wav: 'UklGRg==' };
    const root = await mountTts(fx);

    // 高级选项在这个格式下默认展开,两个框就在里面
    expect(block(root, 'pcm').hidden).toBe(false);
    expect(field(root, 'PCM 采样率(Hz)').querySelector('input').value).toBe('24000');
    expect(field(root, 'PCM 声道数').querySelector('select').value).toBe('1');

    const text = root.querySelector('input[placeholder^="测试文本"]');
    text.value = '试听一句';
    button(root, '合成试听').click();
    await flush();

    const draft = callsOf(fx, 'testService')[0].args[0];
    expect(draft.responseFormat).toBe('pcm');
    expect(draft.pcm).toEqual({ sampleRate: 24000, channels: 1, encoding: 's16le' });
  });

  it('换成非 pcm 格式时那两个框收起来,草稿里也不带 pcm', async () => {
    const pcmService = {
      ...openAiService,
      id: 'pcm-svc',
      name: 'PCM 服务',
      responseFormat: 'pcm',
      pcm: { sampleRate: 24000, channels: 1, encoding: 's16le' },
    };
    const fx = fixture(pcmService);
    onSave(fx, { ...pcmService, responseFormat: 'wav', pcm: undefined });
    const root = await mountTts(fx);

    const sel = field(root, '输出格式').querySelector('select');
    sel.value = 'wav';
    sel.dispatchEvent(new doc.defaultView.Event('change'));
    await flush();

    expect(block(root, 'pcm').hidden).toBe(true);
    button(root, '保存配置').click();
    await flush();
    expect(callsOf(fx, 'saveService')[0].args[0].service.pcm).toBeUndefined();
  });

  it('「添加 TTS 服务」在列表里挂一条未落盘的新条目，填完保存就进服务表', async () => {
    const fx = fixture();
    onSave(fx, {
      id: 'service',
      name: '本地新声',
      protocol: 'openai-speech',
      management: 'external',
      baseUrl: 'http://127.0.0.1:8020/v1',
      auth: { type: 'none' },
      model: 'my-tts-model',
      voice: 'my-voice',
      responseFormat: 'wav',
      delivery: 'auto',
      timeoutMs: 60000,
    });
    const root = await mountTts(fx);

    button(root, '＋ 添加 TTS 服务').click();
    await flush();

    const fresh = row(root, '新服务');
    expect(fresh.open).toBe(true);
    expect(noteOf(fresh).textContent).toContain('未保存');
    expect(field(fresh, '服务 ID').querySelector('input').disabled).toBe(false);

    field(root, '名称').querySelector('input').value = '本地新声';
    button(root, '保存配置').click();
    await flush();

    const saved = callsOf(fx, 'saveService')[0].args[0];
    expect(saved.baseRevision).toBe(7);
    expect(saved.service.name).toBe('本地新声');
    expect(saved.service.id).toBe('service');
    // 保存之后表单里那条就是服务表里的那条:ID 锁上,条目名跟着改
    expect(field(root, '服务 ID').querySelector('input').disabled).toBe(true);
    expect(row(root, '本地新声')).toBeTruthy();
  });
});

describe('挂载面板：声音那行', () => {
  const rowOf = (root: Any): Any => Array.from(root.querySelectorAll('.vt-mountrow') as Any[])
    .find((r: Any) => r.querySelector('.vt-mname')?.textContent === '声音');

  /** mount.state 的两条链路各回各的,别的请求照旧抛。 */
  async function mountRows(tts: Any): Promise<Any> {
    const fx = fixture();
    install(fx, {
      state: { vts: null, tts, stream: null },
      ttsState: tts,
    });
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    mountPanel.mount(context('mount', root));
    await flush();
    return root;
  }

  it('external 服务如实报服务名与待应用，不画成错误，也没有启停按钮', async () => {
    const root = await mountRows({
      serviceId: 'remote-a',
      serviceName: '远程 A',
      protocol: 'openai-speech',
      savedRevision: 7,
      appliedRevision: 6,
      pendingApply: true,
      managed: false,
      local: null,
      phase: 'external',
      pid: null,
      detail: null,
      url: 'https://tts.example.com/proxy/v1',
      reachable: true,
    });

    const sound = rowOf(root);
    expect(sound.textContent).toContain('远程 A');
    expect(sound.textContent).toContain('待应用');
    expect(sound.textContent).not.toContain('异常');
    const acts = sound.querySelector('.vt-macts');
    const buttons = Array.from(acts.querySelectorAll('button') as Any[]);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b: Any) => b.hidden)).toBe(true);
  });

  it('managed 服务保持原来的运行中读数与启停', async () => {
    const root = await mountRows({
      serviceId: 'legacy-default',
      serviceName: '默认 VoxCPM2',
      protocol: 'voxcpm-legacy',
      savedRevision: 7,
      appliedRevision: 7,
      pendingApply: false,
      managed: true,
      local: { phase: 'running', url: 'http://127.0.0.1:8020', pid: 42, detail: null, resources: LOCAL_RESOURCES },
      phase: 'running',
      pid: 42,
      detail: null,
      url: 'http://127.0.0.1:8020',
      reachable: true,
    });

    const sound = rowOf(root);
    expect(sound.textContent).toContain('运行中');
    expect(sound.textContent).toContain('pid 42');
    expect(sound.textContent).toContain('已应用');
    const buttons = Array.from(sound.querySelectorAll('.vt-macts button') as Any[]);
    expect(buttons).toHaveLength(2);
    expect(buttons.some((b: Any) => b.hidden)).toBe(false);
    expect(button(root, '停止').disabled).toBe(false);
  });
});
