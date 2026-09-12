/**
 * @vitest-environment jsdom
 *
 * 外置资源路径:VTuber 模型页选择 Live2D 目录。测试从真实按钮进入，并穿过统一
 * 路径选择与配置写回 API;框架的面板上下文与生命周期都是真件。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LIFECYCLE = 'cortico/web/client/core/lifecycle.ts';
const PANEL_CONTEXT = 'cortico/web/client/console-pages/context.ts';
const VTUBER_MODEL = '../../src/console/model.ts';

// 浏览器端源码带 DOM 类型;specifier 存进变量,免得 Node 那份 typecheck 把它们拉进源图。
type Any = any;

const doc = (globalThis as Any).document;

const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { createPanelContext } = (await import(PANEL_CONTEXT)) as Any;
const { modelPanel } = (await import(VTUBER_MODEL)) as Any;

interface Call {
  url: string;
  method: string;
  body: Any;
}

let calls: Call[] = [];

const flush = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

function json(body: unknown): Any {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function field(root: Any, label: string): Any {
  const hit = Array.from(root.querySelectorAll('.fieldrow') as Any[])
    .find((row: Any) => row.querySelector(':scope > .fieldlabel')?.textContent === label);
  if (!hit) throw new Error(`没有找到字段：${label}`);
  return hit;
}

function memo(): Any {
  const values = new Map<string, unknown>();
  return {
    get: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
    set: (key: string, value: unknown) => values.set(key, value),
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe('VTuber 模型页的 Live2D 目录', () => {
  it('选择目录后通过 provider context 写入 world:vtuber，并立即更新回显', async () => {
    const selected = 'D:\\Cortico-Resources\\live2d\\Corti';
    const state = {
      configured: 'auto',
      activeId: 'default',
      activeLabel: '默认',
      how: 'fallback',
      vtsModelName: '',
      vtsConnected: false,
      live2dDir: 'C:\\VTubeStudio\\Live2DModels\\Old',
      choices: [{ value: 'auto', label: '自动', vtsModelName: '' }],
      caveat: null,
      unsupported: [],
      lastCheck: null,
    };

    vi.stubGlobal('fetch', (input: Any, init?: Any) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/panels/model/state')) return Promise.resolve(json(state));
      if (url === '/api/path-picker') return Promise.resolve(json({ path: selected }));
      if (url === '/api/config') {
        // 热配置:保存之后状态接口回显的就是新目录
        state.live2dDir = body.values['worlds.vtuber.live2dDir'];
        return Promise.resolve(json({ result: '已保存' }));
      }
      throw new Error(`未声明的请求：${method} ${url}`);
    });

    const lifecycle = new Lifecycle();
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    const ctx = createPanelContext({
      pageId: 'world:vtuber',
      panelId: 'model',
      root,
      lifecycle,
      overlayHost: doc.body,
      refresh: async () => {},
      addLeaveGuard: () => ({ dispose() {} }),
      memo: memo(),
      createSocket: () => { throw new Error('本测试不建立流'); },
      wsUrl: (path: string) => path,
      onError: vi.fn(),
      doc,
    });
    modelPanel.mount(ctx);
    await flush();

    calls = [];
    field(root, '模型目录').querySelector('button').click();
    await flush();

    expect(calls.find((call) => call.url === '/api/path-picker')?.body).toEqual({
      kind: 'directory',
      title: '选择 VTube Studio 的 Live2DModels 目录',
      currentPath: 'C:\\VTubeStudio\\Live2DModels\\Old',
      recommendedDir: 'C:/Program Files (x86)/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels',
    });
    expect(calls.find((call) => call.url === '/api/config')?.body).toEqual({
      group: 'world:vtuber',
      values: { 'worlds.vtuber.live2dDir': selected },
    });
    expect(field(root, '模型目录').textContent).toContain(selected);
    expect(root.querySelector('.msgline')?.textContent).toBe('模型目录已保存');

    lifecycle.dispose();
  });
});
