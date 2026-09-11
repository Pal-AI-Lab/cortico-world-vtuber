/**
 * @vitest-environment jsdom
 *
 * 外置资源路径的两条用户路径：Provider 参数页选择 GGUF，VTuber 模型页选择
 * Live2D 目录。测试从真实按钮进入，并穿过统一路径选择与配置写回 API。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI = '../../src/web/client/ui/index.ts';
const LIFECYCLE = '../../src/web/client/core/lifecycle.ts';
const PANEL_CONTEXT = '../../src/web/client/console-pages/context.ts';
const VTUBER_MODEL = '../../src/io-vtuber/console/model.ts';
const ASR_LISTEN = '../../src/io-asr/console/listen.ts';

// Browser sources are checked by tsconfig.web.json; keeping their specifiers indirect
// prevents the Node-only root config from pulling DOM modules into its source graph.
type Any = any;

const doc = (globalThis as Any).document;

const { createConsoleUi } = (await import(UI)) as Any;
const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { createPanelContext } = (await import(PANEL_CONTEXT)) as Any;
const { modelPanel } = (await import(VTUBER_MODEL)) as Any;
const { listenPanel } = (await import(ASR_LISTEN)) as Any;

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


describe('OpenAI Compatible 模块参数页的资源路径',()=>{
  beforeEach(() => vi.useFakeTimers());
  async function mountPaths(delayed=false){
    const module=(await import('../../src/providers/openai-compat/index.ts')).default;
    const {readGroupValues,setByPath}=await import('../../src/core/configSchema.ts');
    const config={providers:{local:{kind:'openai-compat',baseUrl:'http://localhost:1',options:{managed:{serverDir:'C:/runtime',modelFile:'C:/old.gguf',mmprojFile:'C:/old-proj.gguf',contextSize:16384}}}}};
    const group=module.config('local',config.providers.local,'zh')[0];
    const writes:Any[]=[];
    vi.stubGlobal('fetch',(input:Any,init?:Any)=>{
      const url=String(input),body=init?.body?JSON.parse(init.body):undefined;calls.push({url,method:init?.method ?? 'GET',body});
      if(url==='/api/path-picker')return Promise.resolve(json({path:body.title==='GGUF 模型'?'D:/new.gguf':'D:/new-proj.gguf'}));
      if(url==='/api/config' && init?.method==='POST')return new Promise(resolve=>{
        const complete=()=>{for(const [path,value]of Object.entries(body.values))setByPath(config,path,value);resolve(json({result:'已保存'}));};
        writes.push({body,complete});if(!delayed)complete();
      });
      if(url==='/api/config')return Promise.resolve(json({groups:[{group,values:readGroupValues(config as Any,group)}]}));
      throw new Error(url);
    });
    const lifecycle=new Lifecycle();const root=doc.createElement('div');doc.body.append(root);
    const ui=createConsoleUi({memo:memo(),overlayHost:doc.body,signal:lifecycle.signal,doc});
    const VIEW='../../src/web/client/features/config/view.ts';const {createConfigView}=await import(VIEW) as Any;
    const view=createConfigView({ui,lifecycle,signal:lifecycle.signal,filter:(g:Any)=>g.id===group.id});root.append(view.el);await view.load();
    const row=(label:string)=>[...root.querySelectorAll('.trow')].find((row:Any)=>row.querySelector('.tlabel').textContent.startsWith(label));
    return {root,lifecycle,writes,config,row};
  }
  it('主模型与视觉投影使用模块声明的文件选择器，保存两条路径',async()=>{
    const view=await mountPaths();
    try{
      view.row('GGUF 模型').querySelector('button').click();await flush();
      view.row('视觉投影').querySelector('button').click();await flush();
      await vi.advanceTimersByTimeAsync(450);await flush();
      expect(view.config.providers.local.options.managed).toMatchObject({modelFile:'D:/new.gguf',mmprojFile:'D:/new-proj.gguf',serverDir:'C:/runtime'});
      expect(calls.filter(call=>call.url==='/api/path-picker').map(call=>call.body.extensions)).toEqual([['.gguf'],['.gguf']]);
      expect(view.writes[0].body.group).toBe('llm.openai-compat.local');
    }finally{view.lifecycle.dispose();}
  });
  it('连续编辑串行写回，后一次完整草稿保留先前路径',async()=>{
    const view=await mountPaths(true);
    try{
      view.row('GGUF 模型').querySelector('button').click();await flush();await vi.advanceTimersByTimeAsync(450);
      expect(view.writes).toHaveLength(1);
      view.row('视觉投影').querySelector('button').click();await flush();await vi.advanceTimersByTimeAsync(450);
      expect(view.writes).toHaveLength(1);view.writes[0].complete();await flush();
      expect(view.writes).toHaveLength(2);view.writes[1].complete();await flush();
      expect(view.config.providers.local.options.managed).toMatchObject({modelFile:'D:/new.gguf',mmprojFile:'D:/new-proj.gguf'});
    }finally{view.lifecycle.dispose();}
  });
});

describe('VTuber 模型页的 Live2D 目录', () => {
  it('选择目录后通过 provider context 写入 module:vtuber，并立即更新回显', async () => {
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
        state.live2dDir = body.values['io.vtuber.live2dDir'];
        return Promise.resolve(json({ result: '已保存' }));
      }
      throw new Error(`未声明的请求：${method} ${url}`);
    });

    const lifecycle = new Lifecycle();
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    const ctx = createPanelContext({
      pageId: 'io:vtuber',
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
      group: 'module:vtuber',
      values: { 'io.vtuber.live2dDir': selected },
    });
    expect(field(root, '模型目录').textContent).toContain(selected);
    expect(root.querySelector('.msgline')?.textContent).toBe('模型目录已保存');

    lifecycle.dispose();
  });
});

describe('ASR 外部权重错误', () => {
  it('显式路径不存在时展示后端给出的具体路径，不退回旧 runtime/models 提示', async () => {
    const missing = 'D:\\Cortico-Resources\\models\\asr\\missing.bin';
    const lifecycle = new Lifecycle();
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    const ui = createConsoleUi({ memo: memo(), overlayHost: doc.body, signal: lifecycle.signal, doc });
    const state = {
      listening: false,
      audioAvailable: true,
      devices: [],
      deviceSetting: '',
      device: '',
      level: -60,
      speaking: false,
      thresholdDb: -35,
      modelFile: missing,
      simplified: false,
      recent: [],
      counts: { utterances: 0, delivered: 0, dropped: 0 },
      server: {
        phase: 'error',
        url: 'http://127.0.0.1:8178',
        detail: `权重文件不存在: ${missing}`,
        pid: null,
        reachable: false,
        model: null,
        profile: 'gpu',
        installed: true,
        models: [],
      },
      endpoint: 'http://127.0.0.1:8178/inference',
      detail: null,
    };
    const ctx = {
      pageId: 'io:asr',
      panelId: 'listen',
      root,
      signal: lifecycle.signal,
      ui,
      invoke: (method: string) => method === 'state'
        ? Promise.resolve(state)
        : Promise.reject(new Error(`未声明的方法：${method}`)),
      invokeBinary: () => Promise.reject(new Error('本测试不取二进制')),
      pickPath: () => Promise.resolve(null),
      setConfig: () => Promise.resolve(''),
      stream: () => ({ close() {} }),
      interval: () => ({ dispose() {} }),
      timeout: () => ({ dispose() {} }),
      frame: () => ({ dispose() {} }),
      own: (value: unknown) => value,
      memo: memo(),
      guardLeave: () => ({ dispose() {} }),
    };

    listenPanel.mount(ctx);
    await flush();

    expect(root.querySelector('.mdetail')?.textContent).toBe(`权重文件不存在: ${missing}`);
    expect(root.querySelector('.mdetail')?.textContent).not.toContain('runtime/asr/whisper-server/models');
    lifecycle.dispose();
  });
});
