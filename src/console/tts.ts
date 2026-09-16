/**
 * 声线档案面板管理 TTS 服务表:页面最上面选当前服务(热生效),下面每条服务一张折叠卡,
 * 展开哪条就改哪条——内置的默认配置那张铺声线档案与本地运行时,别条铺服务表单与试听。
 * 表单只有一份,展开时挪进那条条目的 body,收起时摘下来,所以一次只铺一条的控件。
 * 参考音频、转写与本地运行时只属于 voxcpm-legacy;运行时与权重的下载只属于 managed-voxcpm。
 * 编辑不即时影响演出:保存作用于此后的新合成,切换当前服务也是保存动作。
 * 音频经随 ctx.signal 取消的 ctx.invokeBinary 读取;ownedAudio 与 urlSlot 在卸载时暂停、移除 src 并释放 URL。
 * 离开未保存的改动时由 ctx.guardLeave 确认;展开别条会覆盖表单,所以那之前先问一句。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
  ConsoleSheet,
} from 'cortico/web/shared/client-panel.ts';
import type { PathPickerOptions } from 'cortico/web/shared/path-picker.ts';
import {
  base64ToBytes,
  bytesToBase64,
  dimLine,
  errText,
  numField,
  ownedAudio,
  setMsg,
  speechUrlOf,
  urlSlot,
  TTS_TIMEOUT_DEFAULT_MS,
  TTS_TIMEOUT_MAX_MS,
  TTS_TIMEOUT_MIN_MS,
  type JsonValue,
  type PublicTtsService,
  type SavedVoice,
  type TtsDelivery,
  type TtsLegacyRuntime,
  type TtsManagement,
  type TtsPanelState,
  type TtsProfile,
  type TtsProtocol,
  type TtsResponseFormat,
  type TtsSaveReceipt,
  type TtsServiceAuth,
  type TtsServicesState,
  type TtsTestResult,
  type TtsVoiceInfo,
} from './client.ts';

/** 试听回来的那段 wav:字节留着,既要播也要能存 */
interface TestWav {
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
}

const DESC =
  '注册多条 TTS 服务并选一条作为当前服务。切换立即对之后新发起的合成生效;'
  + '已经合成、在途或已预取的音频仍按原服务放完。';

/** 服务列表末尾那行:展开即编辑;切换与保存是两回事。 */
const LIST_HINT =
  '展开哪一条就改哪一条;「设为当前」只切换服务,不改配置。保存当前服务后才对之后的合成生效。';

const HIFI_NOTE =
  'Hi-Fi 克隆下 (风格词) 这类括号指令会被念出来:转写与参考音频逐字对应,括号里的字没有对应音频。';

const IMPORT_HINT =
  '导入 mp3 / m4a 这类压缩格式会先经本机 ffmpeg 转成 24kHz 单声道 wav;没装 ffmpeg 就只收 wav。';

const AUDIO_ACCEPT = '.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wma,audio/*';

const RUNTIME_DESC =
  '运行时是 llama-tts-server 的二进制,权重是它加载的 GGUF。两样都不随包发布,'
  + '这里下到部署根的 runtimes/ 与 models/vtuber/ 下。运行时目录填了就不下载。'
  + '对齐器权重需要按 README 转换后放入 models/vtuber/。';

/** 服务端 `speechUrlOf` 的缺省路径段;面板只显示它,不替服务端决定。 */
const SPEECH_PATH_PLACEHOLDER = 'audio/speech';

const PROTOCOL_OPTIONS: ReadonlyArray<{ value: TtsProtocol; label: string }> = [
  { value: 'openai-speech', label: 'OpenAI Speech(标准请求)' },
  { value: 'voxcpm-legacy', label: 'VoxCPM2 Legacy(旧请求与私有流式)' },
];

const MANAGEMENT_OPTIONS: ReadonlyArray<{ value: TtsManagement; label: string }> = [
  { value: 'external', label: 'external(自己跑,World 不启停进程)' },
  { value: 'managed-voxcpm', label: 'managed-voxcpm(World 管本地进程)' },
];

const FORMAT_OPTIONS: readonly TtsResponseFormat[] = ['wav', 'pcm', 'mp3', 'opus', 'aac', 'flac'];

const DELIVERY_OPTIONS: ReadonlyArray<{ value: TtsDelivery; label: string }> = [
  { value: 'auto', label: 'auto(能流式就流式)' },
  { value: 'buffered', label: 'buffered(整片回来再播)' },
];

const LEGACY_MANAGED_ERROR = '通用 OpenAI 协议没有本地托管进程可管:management 只能是 external。';

const DRAFT_HINT =
  '合成试听按面板上的草稿走:不保存、不切换、不落盘,声音只在浏览器里放'
  + '(调远程服务时不该意外进 OBS)。';

/**
 * 生成参数的上下界。与 World 的 `TTS_PROFILE_LIMITS` 同值:钳制仍归服务端
 * (面板改不了那份判断),这里只是让数字框的箭头与浏览器校验落在同一个区间里。
 */
const LIMITS = {
  seed: { min: 0, max: 2 ** 31 - 2, step: 1 },
  cfgValue: { min: 0.1, max: 10, step: 0.1 },
  inferenceTimesteps: { min: 1, max: 100, step: 1 },
  maxSteps: { min: 10, max: 2000, step: 10 },
  temperature: { min: 0.05, max: 2, step: 0.05 },
} as const;

/** 服务端的报错形状:`<前缀> <内容> (来自本地服务 <端点>)`。 */
const LOCAL_PREFIX = '(来自本地服务 ';

/** 复制配置时带的运行时路径。 */
const EMPTY_RUNTIME: TtsLegacyRuntime = {
  runtimeDir: '',
  runtimeRelease: '',
  baseLmFile: '',
  acousticFile: '',
  alignerLmFile: '',
  alignerAudioFile: '',
  voicesDir: '',
};

/**
 * 起播。`play()` 返回的未必是 promise(旧实现与 jsdom 都给 undefined),
 * 自动播放策略也可能直接拒绝——两种都不该变成合成失败,所以这里只发不等。
 */
function startPlayback(audio: HTMLAudioElement, src: string): void {
  audio.src = src;
  const started = audio.play() as Promise<void> | undefined;
  void started?.catch(() => {});
}

/** 试听回来的那段 wav:字节留着,既要播也要能存 */
interface TestWav {
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
}

/** 面板上正在编辑的那份值;JSON 文本框按文本留着,解析只在取用时发生。 */
interface ServiceForm {
  id: string;
  name: string;
  protocol: TtsProtocol;
  management: TtsManagement;
  baseUrl: string;
  speechPath: string;
  authType: 'none' | 'bearer';
  /** 编辑凭据时只带已经生效的那个密钥名;留空则服务端沿用它自己那份 */
  secretRef: string;
  model: string;
  voice: string;
  responseFormat: TtsResponseFormat;
  delivery: TtsDelivery;
  timeoutMs: number;
  /** 输出格式为 pcm 时必须给出:服务端不给默认,猜采样率会把整片音频解成噪音 */
  pcmSampleRate: string;
  pcmChannels: '1' | '2';
  speed: string;
  instructions: string;
  extraBody: string;
  headers: string;
}

/** 声线库刷新时要不要回填表单,由选声线那一步记录下来。 */
interface VoicePicked {
  current: boolean;
}

export const ttsPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({ title: 'TTS', en: 'TTS services', desc: DESC });

    // ---- 当前服务 ----
    const curSel = ui.select({ cls: 'grow', onInput: () => { void pickCurrent(); } });
    const curState = ui.pill('—', 'plain');
    const curMsg = ui.msgline('');
    const sayCur = (text: string, bad = false): void => setMsg(curMsg, text, bad);
    const btnRefresh = ui.button('刷新', { size: 'sm', onClick: () => { sayCur(''); void refreshAll(); } });
    const curBar = ui.rowbar();
    curBar.append(ui.h('span', null, '当前 TTS 服务'), curSel, curState, ui.h('span', 'grow'), btnRefresh);
    const curUrl = dimLine(ctx);
    const curDiag = dimLine(ctx);
    curDiag.hidden = true;
    card.body.append(curBar, curUrl, curDiag, curMsg);

    // ---- 服务列表 ----
    const rowsBox = ui.h('div');
    const listMsg = ui.msgline('');
    const sayList = (text: string, bad = false): void => setMsg(listMsg, text, bad);
    const btnAdd = ui.button('＋ 添加 TTS 服务', { variant: 'plain', onClick: () => { addService(); } });
    btnAdd.classList.add('vt-add');
    const addBar = ui.rowbar();
    addBar.append(btnAdd);
    card.body.append(ui.section('服务列表'), rowsBox, listMsg, addBar, dimLine(ctx, LIST_HINT));

    // 播放器与两个 ObjectURL 槽:播放一个、下载一个,互不掀桌
    const player = ownedAudio(ctx);
    const playUrl = urlSlot(ctx);
    const saveUrl = urlSlot(ctx);
    card.body.appendChild(player);

    ctx.root.appendChild(card.el);

    // -----------------------------------------------------------------------
    // 状态

    let services: PublicTtsService[] = [];
    let protectedIds: string[] = [];
    let registryRevision = 0;
    let activeServiceId = '';
    let appliedServiceId = '';
    let appliedRevision = 0;
    let registryError: string | undefined;
    let notes: string[] = [];
    /** 表单里装的是哪条服务 */
    let selectedId = '';
    /** 表单里那份值是哪条服务的(收起时也留着);空串 = 表单还没铺过 */
    let formId = '';
    /** 还没落盘的新服务:先占一条条目,保存成功后才进服务表 */
    let draft: PublicTtsService | null = null;
    /** 表单里这条在服务表里;false = 还没保存过的新服务 */
    let editingExisting = false;
    /** 这份表单是照哪条服务铺出来的;null = 新服务或还没铺过 */
    let formService: PublicTtsService | null = null;
    /** 上次保存/切换时表单的值;与当前值一比就知道有没有未保存的改动 */
    let savedAt: ServiceForm | null = null;
    let inAuthType: 'none' | 'bearer' = 'none';
    let clearKeyRequested = false;
    let local: TtsPanelState['local'] = null;
    /** World 当作内置 legacy 条目的那一条;声线档案与本地运行时路径只归它 */
    let builtinServiceId = '';
    let testWav: TestWav | null = null;
    /** 声线库:取数时表单可能还没铺出来,先记着,铺的时候再填下拉 */
    let voiceList: TtsVoiceInfo[] = [];
    let voiceDir = '';
    const voicePicked: VoicePicked = { current: false };
    /** 每条条目的展开状态:条目是重铺的,不能每次都按 defaultOpen 弹开 */
    const openState = new Map<string, boolean>();
    const entries = new Map<string, Entry>();

    /**
     * 表单只有一份:展开哪条条目就把它挪到哪条的 body 里,收起时整块从 DOM 上摘下来。
     * 所以一次只铺一条条目的控件,收起的那几条既不铺表单也不去问运行时。
     */
    let formBox: HTMLElement | null = null;
    let legacyProfile: LegacyProfileHandles;
    let runtimePaths: RuntimePathHandles;
    let legacyBox: HTMLElement;
    /** 这条 legacy 条目不是当前服务时,声线档案改了也不生效;这里说明差在哪一步 */
    let legacyHint: HTMLElement;
    let managedBox: HTMLElement;
    let runtimeSlot: HTMLElement;
    let runtimeMounted = false;
    let inId: HTMLInputElement;
    let inName: HTMLInputElement;
    let selProtocol: HTMLSelectElement;
    let selManagement: HTMLSelectElement;
    let inBase: HTMLInputElement;
    let inPath: HTMLInputElement;
    let urlLine: HTMLElement;
    let selAuth: HTMLSelectElement;
    let inKey: HTMLInputElement;
    let btnClearKey: HTMLButtonElement;
    let inModel: HTMLInputElement;
    let inVoice: HTMLInputElement;
    let advOpen = false;
    let adv: HTMLElement;
    let selFormat: HTMLSelectElement;
    let selDelivery: HTMLSelectElement;
    let inTimeout: HTMLInputElement;
    /** 只在输出格式是 pcm 时露出 */
    let pcmBox: HTMLElement;
    let inPcmRate: HTMLInputElement;
    let selPcmChannels: HTMLSelectElement;
    let inSpeed: HTMLInputElement;
    let inInstr: HTMLInputElement;
    let inBody: HTMLTextAreaElement;
    let inHeaders: HTMLTextAreaElement;
    let btnAdv: HTMLButtonElement;
    let btnSave: HTMLButtonElement;
    let btnActivate: HTMLButtonElement;
    let btnDup: HTMLButtonElement;
    let testInput: HTMLInputElement;
    let btnTestDraft: HTMLButtonElement;
    let btnTestDevice: HTMLButtonElement;
    let btnSaveWav: HTMLButtonElement;
    let draftMsg: HTMLElement;
    let deviceMsg: HTMLElement;
    let sayDraft: (text: string, bad?: boolean) => void;
    let sayDevice: (text: string, bad?: boolean) => void;
    let authKeyFocused = false;

    /** 列表里的一条:一张折叠卡 + 它自己那两颗按钮 */
    interface Entry {
      sheet: ConsoleSheet;
      details: HTMLDetailsElement;
      btnCurrent: HTMLButtonElement | null;
      btnDelete: HTMLButtonElement | null;
    }

    // ---- 表单读写 ----

    /** 面板当前的值。解析推迟到用它的那一步。 */
    function formNow(): ServiceForm {
      return {
        id: inId.value.trim(),
        name: inName.value,
        protocol: selProtocol.value as TtsProtocol,
        management: selManagement.value as TtsManagement,
        baseUrl: inBase.value,
        speechPath: inPath.value,
        authType: inAuthType,
        secretRef: formService?.auth.type === 'bearer' ? formService.auth.secretRef : '',
        model: inModel.value,
        voice: inVoice.value,
        responseFormat: selFormat.value as TtsResponseFormat,
        delivery: selDelivery.value as TtsDelivery,
        timeoutMs: Number(inTimeout.value),
        pcmSampleRate: inPcmRate.value,
        pcmChannels: selPcmChannels.value === '2' ? '2' : '1',
        speed: inSpeed.value,
        instructions: inInstr.value,
        extraBody: inBody.value,
        headers: inHeaders.value,
      };
    }

    function isDirty(): boolean {
      // 表单还没铺出来就谈不上改动(新服务也不比:它没有可比的已保存那份)
      if (!formBox || !savedAt) return false;
      const now = formNow() as unknown as Record<string, unknown>;
      const before = savedAt as unknown as Record<string, unknown>;
      return Object.keys(now).some((k) => String(now[k] ?? '') !== String(before[k] ?? ''));
    }

    function renderDirty(): void {
      const dirty = isDirty();
      sayList(dirty ? '⚠ 面板上的改动还没保存:试听按草稿走,演出仍用已保存的那份。' : '', dirty);
      updateUrlPreview();
    }

    /** raw PCM 的采样率与声道数只在那个格式下要填。 */
    function renderPcmFields(): void {
      if (!pcmBox) return;
      pcmBox.hidden = selFormat.value !== 'pcm';
    }

    /** 「最终请求地址」的拼法见 client.ts 的 speechUrlOf。 */
    function updateUrlPreview(): void {
      const url = speechUrlOf({ baseUrl: inBase.value, speechPath: inPath.value });
      urlLine.textContent = inBase.value.trim()
        ? `最终请求地址:${url}`
        : `最终请求地址:${url}(Base URL 还是空的)`;
    }

    function renderAdvanced(): void {
      adv.hidden = !advOpen;
      btnAdv.textContent = advOpen ? '收起' : '展开';
    }

    function renderSecretHint(): void {
      if (inAuthType === 'none') {
        inKey.value = '';
        inKey.disabled = true;
        inKey.placeholder = '这条服务不带鉴权';
        clearKeyRequested = false;
        btnClearKey.disabled = true;
        return;
      }
      inKey.disabled = false;
      const configured = formService?.auth.type === 'bearer' && formService.auth.apiKeyConfigured;
      btnClearKey.disabled = !configured;
      inKey.placeholder = authKeyFocused
        ? '输入新密钥可替换已存的那把'
        : configured
          ? '已设置(留空即沿用)'
          : '未设置';
    }

    /**
     * 哪几个区块跟表单里那条服务有关。
     *
     * 参考音频与旧运行时路径只属于 voxcpm-legacy;运行时与权重的下载只属于 managed-voxcpm,
     * 那一块等真正需要时再挂——它会轮询运行时装没装。
     */
    function renderVisibility(): void {
      const isLegacy = selProtocol.value === 'voxcpm-legacy';
      const isManaged = isLegacy && selManagement.value === 'managed-voxcpm';
      /*
       * 声线档案与本地运行时路径只从内置 legacy 条目读,而声线档案在演出引擎里
       * 又只认**当前服务**。两样都不成立时摆出这些控件,编辑就会落到另一条身上
       * (或者被服务端拒掉),所以按"这条就是内置条目"来定显隐,并说明差在哪一步。
       */
      const builtin = builtinServiceId !== '' && selectedId === builtinServiceId;
      const current = selectedId !== '' && selectedId === activeServiceId;
      legacyBox.hidden = !(builtin && current);
      legacyHint.hidden = !builtin || current;
      managedBox.hidden = !(isManaged && builtin && current);
      if (isManaged && builtin && current && !runtimeMounted) {
        runtimeMounted = true;
        mountRuntimeSection(ctx, runtimeSlot);
      }
    }

    /**
     * 这条服务在列表上报什么状态。只有当前服务报:别条没在跑,说"已应用"没有意义。
     */
    function statusOf(svc: PublicTtsService): { text: string; cls: string } | null {
      if (registryError) return { text: '配置错误', cls: 'pill off' };
      if (svc.id !== activeServiceId) return null;
      const applied = appliedServiceId === svc.id && appliedRevision >= registryRevision;
      return applied ? { text: '● 已应用', cls: 'pill on' } : { text: '待应用', cls: 'pill warn' };
    }

    /** 顶部那行:当前服务的名字、状态、最终请求地址与注册表的诊断。 */
    function renderCurrent(): void {
      const svc = services.find((s) => s.id === activeServiceId);
      if (!svc) {
        curState.className = 'pill off';
        curState.textContent = registryError ? '配置错误' : '空';
        curUrl.textContent = '';
      } else {
        const state = statusOf(svc) ?? { text: '待应用', cls: 'pill warn' };
        curState.className = state.cls;
        curState.textContent = state.text;
        curUrl.textContent = `最终请求地址:${speechUrlOf(svc)}`;
      }
      const diag = registryError ?? notes.join(' ');
      curDiag.textContent = diag;
      curDiag.hidden = !diag;
    }

    function renderPicker(): void {
      curSel.replaceChildren();
      if (!services.length) {
        const opt = ui.h('option', null, registryError ? '(配置读不出来)' : '(没有服务)');
        opt.value = '';
        curSel.appendChild(opt);
        curSel.disabled = true;
        return;
      }
      for (const s of services) {
        const opt = ui.h('option', null, `${s.name}(${s.id})`);
        opt.value = s.id;
        curSel.appendChild(opt);
      }
      curSel.disabled = false;
      curSel.value = services.some((s) => s.id === activeServiceId) ? activeServiceId : '';
    }

    /**
     * 建出表单那一坨。展开某条条目时才调,建过之后一直复用同一份控件。
     *
     * 服务字段 / 高级选项 / 保存 / 合成试听 / 设备联调,加上只对特定协议出现的
     * 声线档案与本地运行时两块——它们跟着表单一起挪,显隐仍由 `renderVisibility` 定。
     */
    function buildForm(): HTMLElement {
      const box = ui.h('div');
      box.dataset.vtBlock = 'form';

      inId = ui.input({
        cls: 'mono',
        placeholder: '小写字母、数字、点、下划线、连字符',
        onInput: () => renderDirty(),
      });
      inName = ui.input({
        placeholder: '这条服务叫什么',
        onInput: () => {
          if (!editingExisting) inId.value = idFromName(inName.value);
          renderDirty();
        },
      });
      selProtocol = ui.select({
        options: PROTOCOL_OPTIONS,
        onInput: (v) => onProtocolPicked(v as TtsProtocol),
      });
      selManagement = ui.select({
        options: MANAGEMENT_OPTIONS,
        onInput: (v) => onManagementPicked(v as TtsManagement),
      });
      inBase = ui.input({
        cls: 'mono grow',
        placeholder: 'http://127.0.0.1:8020/v1',
        onInput: () => renderDirty(),
      });
      inPath = ui.input({
        cls: 'mono',
        placeholder: SPEECH_PATH_PLACEHOLDER,
        onInput: () => renderDirty(),
      });
      urlLine = dimLine(ctx);
      selAuth = ui.select({
        options: [{ value: 'none', label: '无' }, { value: 'bearer', label: 'Bearer' }],
        onInput: (v) => {
          inAuthType = v === 'bearer' ? 'bearer' : 'none';
          renderSecretHint();
          renderDirty();
        },
      });
      inKey = ui.input({
        type: 'password',
        cls: 'mono grow',
        onInput: () => { clearKeyRequested = false; renderSecretHint(); },
      });
      // 密钥框留空 = 保持已存的那把;所以这里的提示说的是"填了会怎样",不是输入内容
      inKey.addEventListener('focus', () => { authKeyFocused = true; renderSecretHint(); }, { signal: ctx.signal });
      inKey.addEventListener('blur', () => { authKeyFocused = false; renderSecretHint(); }, { signal: ctx.signal });
      btnClearKey = ui.button('清除密钥', { size: 'sm', variant: 'danger', onClick: () => { void clearApiKey(); } });
      const keyRow = ui.rowbar();
      keyRow.append(inKey, btnClearKey);
      inModel = ui.input({ cls: 'mono grow', placeholder: '服务商要的 model 名', onInput: () => renderDirty() });
      inVoice = ui.input({ cls: 'mono grow', placeholder: '声音 id,或 {"id": "..."}', onInput: () => renderDirty() });
      box.append(
        ui.section('服务'),
        ui.field('名称', inName),
        ui.field('服务 ID', inId),
        ui.field('协议类型', selProtocol),
        ui.field('管理方式', selManagement),
        ui.field('Base URL(API 前缀)', inBase),
        ui.field('speechPath(可空)', inPath),
        urlLine,
        ui.field('鉴权', selAuth),
        ui.field('密钥', keyRow),
        ui.field('Model', inModel),
        ui.field('Voice', inVoice),
      );

      // ---- 高级选项 ----
      adv = ui.h('div');
      adv.dataset.vtBlock = 'advanced';
      selFormat = ui.select({ options: FORMAT_OPTIONS, onInput: () => { renderPcmFields(); renderDirty(); } });
      selDelivery = ui.select({ options: DELIVERY_OPTIONS, onInput: () => renderDirty() });
      inTimeout = numField(ctx, {
        value: TTS_TIMEOUT_DEFAULT_MS,
        min: TTS_TIMEOUT_MIN_MS,
        max: TTS_TIMEOUT_MAX_MS,
        step: 1000,
        cls: 'vt-num md',
        onChange: () => renderDirty(),
      });
      inSpeed = ui.input({ type: 'number', cls: 'vt-num sm', onInput: () => renderDirty() });
      inSpeed.min = '0.25';
      inSpeed.max = '4';
      inSpeed.step = '0.05';
      inInstr = ui.input({ cls: 'grow', placeholder: '风格指令(只有部分服务商认)', onInput: () => renderDirty() });
      /*
       * raw PCM 的采样率与声道数服务端不猜:官方服务是 24kHz 单声道,自部署的不一定,
       * 猜错就是把整片音频解成噪音。默认值只是把框填上,值仍然是操作者看得见、改得动的。
       */
      inPcmRate = numField(ctx, {
        value: 24_000,
        min: 8_000,
        max: 192_000,
        step: 1_000,
        cls: 'vt-num md',
        onChange: () => renderDirty(),
      });
      selPcmChannels = ui.select({ options: ['1', '2'], onInput: () => renderDirty() });
      pcmBox = ui.h('div');
      pcmBox.dataset.vtBlock = 'pcm';
      pcmBox.append(
        ui.field('PCM 采样率(Hz)', inPcmRate),
        ui.field('PCM 声道数', selPcmChannels),
      );
      inBody = ui.textarea({ rows: 3, cls: 'mono', placeholder: '{ "foo": 1 }', onInput: () => renderDirty() });
      inHeaders = ui.textarea({ rows: 3, cls: 'mono', placeholder: 'X-Example: value', onInput: () => renderDirty() });
      btnAdv = ui.button('展开', { size: 'sm', onClick: () => { advOpen = !advOpen; renderAdvanced(); } });
      const advBar = ui.rowbar();
      advBar.append(btnAdv, ui.h('span', 'grow'));
      adv.append(
        ui.field('输出格式', selFormat),
        ui.field('交付方式', selDelivery),
        pcmBox,
        ui.field('单片超时(ms)', inTimeout),
        ui.field('speed', inSpeed),
        ui.field('instructions', inInstr),
        ui.field('扩展 JSON 参数', inBody),
        dimLine(ctx, 'input / model / voice / response_format / speed / instructions / seed / cfg_value 这些受控字段不接受覆盖,要改请用上面那几项。'),
        ui.field('扩展头(每行一条 Name: value)', inHeaders),
        dimLine(ctx, '鉴权头走「鉴权」那栏,写在这里会被服务端拒绝。'),
      );
      box.append(ui.section('高级选项'), advBar, adv);

      // ---- 保存动作行 ----
      btnDup = ui.button('复制', { size: 'sm', onClick: () => duplicateService() });
      btnSave = ui.button('保存配置', { variant: 'primary', onClick: () => { void invokeSave(false); } });
      btnActivate = ui.button('保存并设为当前', { onClick: () => { void invokeSave(true); } });
      const saveBar = ui.actions();
      saveBar.append(ui.h('span', 'grow'), btnDup, btnActivate, btnSave);
      box.appendChild(saveBar);

      // ---- 合成试听 / 设备联调 ----
      testInput = ui.input({
        cls: 'grow',
        placeholder: '测试文本(空 = 固定测试句)',
        onCommit: () => { void testDraft(); },
      });
      testInput.maxLength = 200;
      btnTestDraft = ui.button('合成试听', { onClick: () => { void testDraft(); } });
      btnTestDevice = ui.button('设备联调', { onClick: () => { void testDevice(); } });
      btnSaveWav = ui.button('保存 wav', { size: 'sm', onClick: () => saveWav() });
      btnSaveWav.disabled = true;
      draftMsg = ui.msgline('');
      deviceMsg = ui.msgline('');
      sayDraft = (text, bad = false) => setMsg(draftMsg, text, bad);
      sayDevice = (text, bad = false) => setMsg(deviceMsg, text, bad);
      const draftBar = ui.rowbar();
      draftBar.append(testInput, btnTestDraft, btnSaveWav);
      const deviceBar = ui.rowbar();
      deviceBar.append(ui.pill('设备联调', 'plain'), btnTestDevice);
      box.append(ui.section('合成试听'), draftBar, dimLine(ctx, DRAFT_HINT), draftMsg);
      box.append(
        ui.section('设备联调'),
        dimLine(ctx, '按生效服务合成并从本机声卡播出,用于验证 OBS 采到的那一路;只有 managed 的本地服务能联调。'),
        deviceBar,
        deviceMsg,
      );

      // ---- voxcpm-legacy:声线档案 ----
      legacyBox = ui.h('div');
      legacyBox.dataset.vtBlock = 'legacy';
      legacyProfile = mountLegacyProfile(ctx, legacyBox, voicePicked, refreshList);
      // 声线库可能比表单先到:那几份读数先记着,这里补进下拉
      legacyProfile.setVoices(voiceList, voiceDir);
      box.appendChild(legacyBox);
      legacyHint = dimLine(ctx, '声线档案只在它是当前服务时可改:演出引擎按当前服务取声线,先「设为当前」再改。');
      legacyHint.hidden = true;
      box.appendChild(legacyHint);

      // ---- managed-voxcpm:旧运行时路径 + 运行时与权重 ----
      managedBox = ui.h('div');
      managedBox.dataset.vtBlock = 'managed';
      runtimePaths = mountRuntimePaths(ctx, managedBox);
      runtimeSlot = ui.h('div');
      managedBox.appendChild(runtimeSlot);
      box.appendChild(managedBox);

      renderAdvanced();
      renderSecretHint();
      updateUrlPreview();
      return box;
    }

    /** 表单那一坨:建过就是它,没建过现建。 */
    function ensureForm(): HTMLElement {
      if (formBox) return formBox;
      const box = buildForm();
      formBox = box;
      return box;
    }

    /** 收起:控件整块从 DOM 上摘下来,值留在内存里。 */
    function detachForm(): void {
      formBox?.remove();
    }

    /** 铺完一份表单之后要一起做的几件事。 */
    function renderSections(): void {
      renderVisibility();
      renderPcmFields();
      renderAdvanced();
      renderSecretHint();
      updateUrlPreview();
      renderDirty();
      renderActions();
    }

    function renderActions(): void {
      // 表单还没建过(一次都没展开过条目)时没有可更新的动作
      if (!formBox) return;
      const legacy = selProtocol.value === 'voxcpm-legacy';
      btnTestDraft.disabled = !selectedId && !inName.value.trim();
      btnTestDevice.disabled = !legacy || !(local?.reachable ?? false);
      btnSaveWav.disabled = !testWav;
      btnDup.disabled = !editingExisting;
      btnClearKey.disabled = inAuthType !== 'bearer'
        || !(formService?.auth.type === 'bearer' && formService.auth.apiKeyConfigured);
      legacyProfile.renderActions(legacy);
    }

    /**
     * 离开未保存的改动前请求确认。
     *
     * 「离开」是离开这个面板;面板里换一条条目同样会覆盖表单,那一处单独问。
     */
    ctx.guardLeave(() => (isDirty() ? '这条 TTS 服务有未保存的改动,离开就丢了' : null));

    // ---- 铺表单 ----

    function loadForm(svc: PublicTtsService): void {
      inId.value = svc.id;
      inName.value = svc.name;
      selProtocol.value = svc.protocol;
      selManagement.value = svc.management;
      inBase.value = svc.baseUrl;
      inPath.value = svc.speechPath ?? '';
      inAuthType = svc.auth.type === 'bearer' ? 'bearer' : 'none';
      selAuth.value = inAuthType;
      inKey.value = '';
      clearKeyRequested = false;
      inModel.value = svc.model;
      inVoice.value = typeof svc.voice === 'string' ? svc.voice : JSON.stringify(svc.voice);
      selFormat.value = svc.responseFormat;
      selDelivery.value = svc.delivery;
      inTimeout.value = String(svc.timeoutMs);
      inPcmRate.value = String(svc.pcm?.sampleRate ?? 24_000);
      selPcmChannels.value = svc.pcm?.channels === 2 ? '2' : '1';
      inSpeed.value = svc.speed === undefined ? '' : String(svc.speed);
      inInstr.value = svc.instructions ?? '';
      inBody.value = svc.extraBody && Object.keys(svc.extraBody).length ? JSON.stringify(svc.extraBody) : '';
      inHeaders.value = svc.headers && Object.keys(svc.headers).length
        ? Object.entries(svc.headers).map(([k, v]) => `${k}: ${v}`).join('\n')
        : '';
      if (svc.legacy) {
        legacyProfile.setProfile(svc.legacy.profile);
        runtimePaths.setRuntime(svc.legacy.runtime);
      } else {
        legacyProfile.setProfile(null);
        runtimePaths.setRuntime(EMPTY_RUNTIME);
      }
      // pcm 的两项就在高级选项里,这个格式展开着才看得见
      advOpen = Boolean(
        inBody.value || inHeaders.value || svc.instructions || svc.speed !== undefined
        || svc.responseFormat === 'pcm',
      );
      formService = svc;
      editingExisting = true;
      formId = svc.id;
      // 服务 id 是配置里的稳定标识,改名不改它
      inId.disabled = true;
      selProtocol.disabled = true;
      selManagement.disabled = true;
      selProtocol.title = selManagement.title = '更换协议或管理方式请复制为新服务。';
      voicePicked.current = false;
      savedAt = formNow();
      legacyProfile.renderOptions();
      renderSections();
    }

    function loadNew(svc: PublicTtsService): void {
      inId.value = svc.id;
      inName.value = svc.name;
      selProtocol.value = svc.protocol;
      selManagement.value = svc.management;
      inBase.value = svc.baseUrl;
      inPath.value = '';
      inAuthType = 'none';
      selAuth.value = 'none';
      inKey.value = '';
      clearKeyRequested = false;
      inModel.value = svc.model;
      inVoice.value = typeof svc.voice === 'string' ? svc.voice : JSON.stringify(svc.voice);
      selFormat.value = svc.responseFormat;
      selDelivery.value = svc.delivery;
      inTimeout.value = String(svc.timeoutMs);
      inPcmRate.value = String(svc.pcm?.sampleRate ?? 24_000);
      selPcmChannels.value = svc.pcm?.channels === 2 ? '2' : '1';
      inSpeed.value = '';
      inInstr.value = '';
      inBody.value = '';
      inHeaders.value = '';
      legacyProfile.setProfile(null);
      runtimePaths.setRuntime(EMPTY_RUNTIME);
      advOpen = false;
      formService = null;
      editingExisting = false;
      formId = svc.id;
      inId.disabled = false;
      selProtocol.disabled = false;
      selManagement.disabled = false;
      selProtocol.title = selManagement.title = '';
      voicePicked.current = false;
      savedAt = null;
      legacyProfile.renderOptions();
      renderSections();
    }

    // ---- 条目:一张折叠卡 + 表单挪进挪出 ----

    /** summary 里那颗按钮:掐掉默认动作与冒泡,不然点一下会连带开合这张卡。 */
    function quiet(ev: MouseEvent): void {
      ev.preventDefault();
      ev.stopPropagation();
    }

    /** 展开/收起自己翻:先改 open,再决定要不要把表单挪过来或摘下去。 */
    function onSummary(ev: MouseEvent, svc: PublicTtsService, entry: Entry): void {
      ev.preventDefault();
      const next = !entry.details.open;
      entry.details.open = next;
      openState.set(svc.id, next);
      if (!next) {
        if (selectedId === svc.id) detachForm();
        return;
      }
      void openEntry(svc, entry);
    }

    /** 手风琴:同时只开一条,表单也就只有一处放。 */
    function closeOthers(id: string): void {
      for (const [other, entry] of entries) {
        if (other !== id && entry.details.open) {
          entry.details.open = false;
          openState.set(other, false);
        }
      }
    }

    /**
     * 展开某条:表单挪过去并铺那条的值。有未保存的改动就先问一句,
     * 问不答应就把刚展开的那条收回去。
     */
    async function openEntry(svc: PublicTtsService, entry: Entry): Promise<void> {
      if (selectedId !== svc.id && formBox && isDirty()) {
        const ok = await ui.confirm({
          title: `切到「${svc.name}」`,
          body: '当前表单上有未保存的改动,切过去就丢了。',
          danger: true,
        });
        if (!ok) {
          entry.details.open = false;
          openState.set(svc.id, false);
          return;
        }
      }
      closeOthers(svc.id);
      hostForm(svc, entry);
    }

    /**
     * 把表单挪到这条条目的 body 里。表单里不是这条服务的值就按它重铺一遍;
     * 挪走时那条还没落盘的新服务随表单一起丢——它本来就只活在表单里。
     */
    function hostForm(svc: PublicTtsService, entry: Entry): void {
      const reload = formId !== svc.id;
      if (reload && draft && draft.id !== svc.id) {
        draft = null;
        selectedId = svc.id;
        // 少了一条,列表要重铺;重铺时表单按 selectedId 挂回 svc 这条
        renderRows();
      } else {
        entry.sheet.body.appendChild(ensureForm());
        entry.details.open = true;
        openState.set(svc.id, true);
      }
      if (!reload) return;
      selectedId = svc.id;
      if (svc === draft) loadNew(svc);
      else loadForm(svc);
    }

    function makeEntry(svc: PublicTtsService, isDraft: boolean): Entry {
      const sheet = ui.foldSheet(`svc:${svc.id}`, {
        title: svc.name,
        desc: `${svc.protocol} · ${svc.management} · ${speechUrlOf(svc)}`,
        defaultOpen: openState.get(svc.id) ?? (!isDraft && svc.id === activeServiceId),
      });
      const details = sheet.el as HTMLDetailsElement;
      const entry: Entry = { sheet, details, btnCurrent: null, btnDelete: null };
      openState.set(svc.id, details.open);

      // 摘要右侧那排:内置标记、状态、设为当前 / 删除。
      sheet.note.classList.add('vt-svcnote');
      if (protectedIds.includes(svc.id)) sheet.note.appendChild(ui.pill('默认', 'plain'));
      if (isDraft) {
        sheet.note.appendChild(ui.pill('未保存', 'plain'));
      } else {
        const state = statusOf(svc);
        if (state) {
          const pill = ui.pill(state.text);
          pill.className = state.cls;
          sheet.note.appendChild(pill);
        }
        entry.btnCurrent = ui.button('设为当前', {
          size: 'sm',
          onClick: (ev) => { quiet(ev); void activate(svc.id); },
        });
        entry.btnCurrent.disabled = svc.id === activeServiceId;
        if (entry.btnCurrent.disabled) entry.btnCurrent.title = '已经是当前服务';
        sheet.note.appendChild(entry.btnCurrent);
        if (!protectedIds.includes(svc.id)) {
          entry.btnDelete = ui.button('删除', {
            size: 'sm',
            variant: 'danger',
            onClick: (ev) => { quiet(ev); void removeService(svc, entry); },
          });
          sheet.note.appendChild(entry.btnDelete);
        }
      }
      details.querySelector('summary')?.addEventListener(
        'click',
        (ev) => onSummary(ev, svc, entry),
        { signal: ctx.signal },
      );
      return entry;
    }

    /** 重铺列表里的条目。节点会重建,表单按 `selectedId` 挂回它那条。 */
    function renderRows(): void {
      const list = draft ? [...services, draft] : services;
      const hostOpen = openState.get(selectedId) ?? false;
      rowsBox.replaceChildren();
      entries.clear();
      for (const svc of list) {
        const entry = makeEntry(svc, svc === draft);
        entries.set(svc.id, entry);
        rowsBox.appendChild(entry.sheet.el);
      }
      const host = entries.get(selectedId);
      if (!formBox) return;
      // 表单里那条还收着(用户刚折叠过):不重新铺上去
      if (host && hostOpen) {
        host.sheet.body.appendChild(formBox);
        host.details.open = true;
        openState.set(selectedId, true);
        return;
      }
      if (host) return;
      // 表单里那条已经不在列表里了(刚被删掉):先摘下来,由调用方挂到替代条目上
      detachForm();
    }

    // ---- 取数 ----

    async function refreshList(): Promise<void> {
      const st = await ctx.invoke<TtsServicesState>('services');
      if (ctx.signal.aborted) return;
      services = st.services ?? [];
      protectedIds = st.protectedIds ?? [];
      registryRevision = st.revision;
      activeServiceId = st.activeServiceId;
      appliedServiceId = st.appliedServiceId;
      appliedRevision = st.appliedRevision;
      registryError = st.error;
      notes = st.notes ?? [];
      const list = draft ? [...services, draft] : services;
      if (!list.some((s) => s.id === selectedId)) {
        selectedId = services.some((s) => s.id === activeServiceId)
          ? activeServiceId
          : services[0]?.id ?? '';
      }
      renderPicker();
      renderCurrent();
      renderRows();
    }

    async function refreshState(): Promise<void> {
      const st = await ctx.invoke<TtsPanelState>('state');
      if (ctx.signal.aborted) return;
      local = st.local;
      builtinServiceId = st.builtinServiceId ?? '';
      voiceList = st.voices ?? [];
      voiceDir = st.voicesDir || '';
      if (formBox) {
        legacyProfile.setVoices(voiceList, voiceDir);
        // 声线档案只属于 legacy 服务;表单里选过声线时不要用服务端那份盖掉
        if (formService?.protocol === 'voxcpm-legacy' && !voicePicked.current) {
          legacyProfile.setProfile(st.profile);
        }
      }
      renderActions();
    }

    async function refreshAll(): Promise<void> {
      try {
        await Promise.all([refreshList(), refreshState()]);
      } catch (err) {
        if (ctx.signal.aborted) return;
        local = null;
        sayCur(`不可用: ${errText(err)}`, true);
      } finally {
        /*
         * 声线档案与本地运行时两块的显隐取决于「当前服务是哪条」,而那是这次刷新
         * 才可能变的东西。条目重铺未必重新挂表单(位置没变就不挂),所以这里显式
         * 再算一次,不搭在铺表单那条路上。
         */
        if (formBox && !ctx.signal.aborted) renderVisibility();
        renderActions();
      }
    }

    // ---- 列表上的动作 ----

    /** 顶部选择器换的是当前服务:热生效,页面跟着挪到那一条。 */
    async function pickCurrent(): Promise<void> {
      const id = curSel.value;
      const svc = services.find((s) => s.id === id);
      if (!svc || svc.id === activeServiceId) {
        curSel.value = activeServiceId;
        return;
      }
      if (formBox && isDirty()) {
        const ok = await ui.confirm({
          title: `切到「${svc.name}」`,
          body: '当前表单上有未保存的改动,切过去就丢了。',
          danger: true,
        });
        if (!ok) {
          curSel.value = activeServiceId;
          return;
        }
      }
      await activate(svc.id);
      if (ctx.signal.aborted) return;
      const fresh = services.find((s) => s.id === svc.id);
      const entry = fresh ? entries.get(fresh.id) : undefined;
      if (fresh && entry) {
        closeOthers(fresh.id);
        hostForm(fresh, entry);
      }
    }

    /** 换当前服务。已经合成、在途或已预取的音频仍按原服务放完。 */
    async function activate(id: string): Promise<void> {
      const svc = services.find((s) => s.id === id);
      if (!svc || svc.id === activeServiceId) return;
      const lock = ui.disable(curSel, ...lockables());
      sayCur('切换中…');
      try {
        const out = await ctx.invoke<TtsSaveReceipt>('activateService', [{
          id: svc.id,
          baseRevision: registryRevision,
        }]);
        if (ctx.signal.aborted) return;
        await refreshAll();
        const text = `已切到「${svc.name}」(版本 ${out.savedRevision})。`
          + (out.pendingApply ? '已保存但演出引擎尚未确认应用。' : '');
        sayCur(text);
        ui.toast(text, out.pendingApply ? undefined : 'ok');
      } catch (err) {
        if (ctx.signal.aborted) return;
        const text = `切换失败: ${errText(err)}`;
        sayCur(text, true);
        ui.toast(text, 'bad');
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    /** 动作期间要锁的控件。表单没铺出来时那几个按钮也不存在。 */
    function lockables(): HTMLButtonElement[] {
      return formBox
        ? [btnAdd, btnSave, btnActivate, btnDup, btnTestDraft]
        : [btnAdd];
    }

    function addService(): void {
      const id = freshId('service');
      draft = {
        id,
        name: '新服务',
        protocol: 'openai-speech',
        management: 'external',
        baseUrl: 'http://127.0.0.1:8020/v1',
        auth: { type: 'none' },
        model: 'my-tts-model',
        voice: 'my-voice',
        responseFormat: 'wav',
        delivery: 'auto',
        timeoutMs: TTS_TIMEOUT_DEFAULT_MS,
      };
      const svc = draft;
      renderRows();
      const entry = entries.get(svc.id);
      if (!entry) return;
      closeOthers(svc.id);
      hostForm(svc, entry);
      sayList('新服务还没落盘:填好后点「保存配置」。');
    }

    function duplicateService(): void {
      const src = services.find((s) => s.id === selectedId);
      if (!src) return;
      const id = freshId(`${src.id}-copy`);
      draft = {
        ...src,
        id,
        name: `${src.name} 副本`,
        // 密钥按服务 id 存,不跟着复制:新的一条以"未设置"起步
        auth: { type: 'none' },
      };
      const svc = draft;
      renderRows();
      const entry = entries.get(svc.id);
      if (!entry) return;
      closeOthers(svc.id);
      hostForm(svc, entry);
      sayList('复制出来的这条还没有密钥(密钥按服务 id 存,不跟着复制)。');
    }

    async function removeService(svc: PublicTtsService, entry: Entry): Promise<void> {
      if (protectedIds.includes(svc.id)) {
        sayList('内置的旧配置兼容条目不能删除。', true);
        return;
      }
      const alternatives = services.filter((s) => s.id !== svc.id);
      let replacement: string | undefined;
      if (svc.id === activeServiceId) {
        if (!alternatives.length) {
          sayList('至少要留一条服务。', true);
          return;
        }
        const ok = await ui.confirm({
          title: `删除当前服务「${svc.name}」`,
          body: `当前服务删掉后要换到「${alternatives[0]?.name ?? ''}」;也可以先用「设为当前」切到别的服务再删。`,
          danger: true,
        });
        if (!ok) return;
        replacement = alternatives[0]?.id;
      } else {
        const ok = await ui.confirm({
          title: `删除服务「${svc.name}」`,
          body: '这条不是当前服务,删掉不影响正在放的演出。',
          danger: true,
        });
        if (!ok) return;
      }
      const lock = ui.disable(entry.btnDelete, entry.btnCurrent, ...lockables());
      sayList('');
      try {
        await ctx.invoke('deleteService', [{
          id: svc.id,
          baseRevision: registryRevision,
          ...(replacement ? { replacementId: replacement } : {}),
        }]);
        if (ctx.signal.aborted) return;
        const wasEditing = selectedId === svc.id;
        const nextId = replacement ?? alternatives[0]?.id ?? '';
        await refreshAll();
        if (wasEditing) {
          const next = services.find((s) => s.id === nextId);
          const nextEntry = next ? entries.get(next.id) : undefined;
          if (next && nextEntry) {
            closeOthers(next.id);
            hostForm(next, nextEntry);
          }
        }
        const swapped = replacement ? `,当前服务换成「${services.find((s) => s.id === replacement)?.name ?? ''}」` : '';
        sayList(`已删除「${svc.name}」${swapped}。`);
      } catch (err) {
        if (!ctx.signal.aborted) sayList(`删除失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    // ---- 保存与切换 ----

    async function invokeSave(activate: boolean): Promise<void> {
      const form = formNow();
      if (!form.name.trim()) {
        sayList('服务名不能为空。', true);
        return;
      }
      const parsed = parseMetadata(form);
      if ('error' in parsed) {
        sayList(parsed.error, true);
        return;
      }
      if (form.management === 'managed-voxcpm' && form.protocol !== 'voxcpm-legacy') {
        sayList(LEGACY_MANAGED_ERROR, true);
        return;
      }
      const lock = ui.disable(...lockables(), btnClearKey, btnSaveWav);
      const wasNew = !editingExisting;
      sayList(activate ? '保存并切换中…' : '保存中…');
      try {
        const args: Record<string, unknown> = {
          service: buildService(form, parsed),
          baseRevision: registryRevision,
        };
        if (activate) args.activate = true;
        if (form.authType === 'bearer') {
          if (inKey.value) args.apiKey = inKey.value;
          if (clearKeyRequested) args.clearApiKey = true;
        }
        const out = await ctx.invoke<TtsSaveReceipt>('saveService', [args]);
        if (ctx.signal.aborted) return;
        if (wasNew) draft = null;
        selectedId = form.id;
        await refreshAll();
        if (wasNew) {
          const svc = services.find((s) => s.id === form.id);
          if (svc) {
            selectedId = svc.id;
            const entry = entries.get(svc.id);
            if (entry) hostForm(svc, entry);
            loadForm(svc);
          }
        } else {
          // 保存后立即采用服务端结果，尤其是新的密钥引用及被清空的可选项。
          const saved = services.find((s) => s.id === form.id);
          if (saved) loadForm(saved);
        }
        sayList(out.message);
        sayCur('');
      } catch (err) {
        if (ctx.signal.aborted) return;
        const text = errText(err);
        sayList(`保存失败: ${text}`, true);
        // 服务端把本地端点的报错接在末尾;那一段单独说,免得把配置错误也读成端点故障
        const at = text.lastIndexOf(LOCAL_PREFIX);
        if (at >= 0) sayCur(text.slice(at + 1).trim());
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    async function clearApiKey(): Promise<void> {
      const form = formNow();
      const svc = services.find((s) => s.id === form.id);
      if (!svc || svc.auth.type !== 'bearer') return;
      const ok = await ui.confirm({
        title: `清除「${svc.name}」的密钥`,
        body: '清掉之后这条服务的合成会报未授权,直到重新填入密钥。',
        danger: true,
      });
      if (!ok) return;
      const parsed = parseMetadata(form);
      if ('error' in parsed) {
        sayList(parsed.error, true);
        return;
      }
      const lock = ui.disable(btnClearKey, ...lockables());
      sayList('清除密钥中…');
      try {
        const out = await ctx.invoke<TtsSaveReceipt>('saveService', [{
          service: buildService(form, parsed),
          baseRevision: registryRevision,
          clearApiKey: true,
        }]);
        if (ctx.signal.aborted) return;
        inKey.value = '';
        clearKeyRequested = false;
        savedAt = formNow();
        await refreshAll();
        sayList(out.message);
      } catch (err) {
        if (!ctx.signal.aborted) sayList(`清除失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    // ---- 协议 / 管理方式的联动 ----

    function onProtocolPicked(next: TtsProtocol): void {
      if (next === 'openai-speech' && selManagement.value === 'managed-voxcpm') {
        selManagement.value = 'external';
        sayList(LEGACY_MANAGED_ERROR, true);
      }
      renderVisibility();
      renderDirty();
      renderActions();
    }

    function onManagementPicked(next: TtsManagement): void {
      if (next === 'managed-voxcpm' && selProtocol.value !== 'voxcpm-legacy') {
        selProtocol.value = 'voxcpm-legacy';
        sayList('managed-voxcpm 是本地 VoxCPM2 进程的管理方式,协议已切到 voxcpm-legacy。');
      }
      renderVisibility();
      renderDirty();
      renderActions();
    }

    // ---- 合成试听(草稿,只在本页放) ----

    /** 起播不参与等待;`startPlayback` 说明为什么不 await。 */
    function play(blob: Blob): void {
      startPlayback(player, playUrl.set(blob));
    }

    async function testDraft(): Promise<void> {
      const form = formNow();
      const parsed = parseMetadata(form);
      if ('error' in parsed) {
        sayDraft(parsed.error, true);
        return;
      }
      const lock = ui.disable(btnTestDraft, btnTestDevice, btnSaveWav);
      sayDraft('合成中…');
      const t0 = Date.now();
      try {
        const args: unknown[] = [buildService(form, parsed), testInput.value];
        if (inKey.value) args.push(inKey.value);
        const out = await ctx.invoke<TtsTestResult>('testService', args);
        if (ctx.signal.aborted) return;
        sayDraft(`${out.message}(页面等待 ${Date.now() - t0}ms)`, !out.wav);
        playBack(out.wav);
      } catch (err) {
        if (!ctx.signal.aborted) sayDraft(`试听失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    /** 设备联调走的是生效服务(和直播同一条路径),会从本机声卡出声 */
    async function testDevice(): Promise<void> {
      if (btnTestDevice.disabled) return;
      const lock = ui.disable(btnTestDevice, btnTestDraft, btnSaveWav);
      sayDevice('合成中…');
      const t0 = Date.now();
      try {
        const profile = selProtocol.value === 'voxcpm-legacy' ? legacyProfile.formProfile() : undefined;
        const out = await ctx.invoke<TtsTestResult>('test', [testInput.value, profile]);
        if (ctx.signal.aborted) return;
        sayDevice(`${out.message}(页面等待 ${Date.now() - t0}ms)`, !out.wav);
        playBack(out.wav);
      } catch (err) {
        if (!ctx.signal.aborted) sayDevice(`设备联调失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    function playBack(wav: string | null): void {
      if (!wav) return;
      const bytes = base64ToBytes(wav);
      testWav = { bytes, name: testWavName(testInput.value) };
      play(new Blob([bytes], { type: 'audio/wav' }));
    }

    function saveWav(): void {
      if (!testWav) return;
      const a = ui.h('a');
      a.href = saveUrl.set(new Blob([testWav.bytes], { type: 'audio/wav' }));
      a.download = testWav.name;
      a.click();
    }

    // ---- 文本 → 提交形状 ----

    /**
     * 两个 JSON 文本框解析成对象。解析在提交前一次做完:面板只说"这行不是 JSON",
     * 扩展头名合不合法、值有没有换行由服务端说。
     */
    function parseMetadata(form: ServiceForm): {
      extraBody?: Record<string, JsonValue>;
      headers?: Record<string, string>;
    } | { error: string } {
      let extraBody: Record<string, JsonValue> | undefined;
      if (form.extraBody.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(form.extraBody);
        } catch (err) {
          return { error: `扩展参数不是合法 JSON:${errText(err)}` };
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { error: '扩展参数必须是一个 JSON 对象。' };
        }
        extraBody = value as Record<string, JsonValue>;
      }
      let headers: Record<string, string> | undefined;
      if (form.headers.trim()) {
        const out: Record<string, string> = {};
        for (const line of form.headers.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const at = trimmed.indexOf(':');
          if (at < 0) return { error: `扩展头「${trimmed}」不合法:每行要是 Name: value。` };
          out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
        }
        if (Object.keys(out).length) headers = out;
      }
      return { ...(extraBody ? { extraBody } : {}), ...(headers ? { headers } : {}) };
    }

    function buildService(
      form: ServiceForm,
      parsed: { extraBody?: Record<string, JsonValue>; headers?: Record<string, string> },
    ): Record<string, unknown> {
      const auth: TtsServiceAuth = form.authType === 'bearer'
        ? (form.secretRef ? { type: 'bearer', secretRef: form.secretRef } : { type: 'bearer' })
        : { type: 'none' };
      const svc: Record<string, unknown> = {
        id: form.id,
        name: form.name.trim(),
        protocol: form.protocol,
        management: form.management,
        baseUrl: form.baseUrl.trim(),
        auth,
        model: form.model.trim(),
        voice: parseVoice(form.voice),
        responseFormat: form.responseFormat,
        delivery: form.delivery,
        timeoutMs: form.timeoutMs,
      };
      const path = form.speechPath.trim();
      svc.speechPath = path || null;
      // 服务端对 pcm 不猜采样率:这里跟着格式一起给,否则保存与试听都会被拒。
      // 声道数是数字,不是 select 的字符串——服务端按 1/2 判,给 '2' 会被当成单声道。
      if (form.responseFormat === 'pcm') {
        svc.pcm = {
          sampleRate: Number(form.pcmSampleRate),
          channels: form.pcmChannels === '2' ? 2 : 1,
          encoding: 's16le',
        };
      }
      svc.speed = form.speed.trim() ? Number(form.speed) : null;
      svc.instructions = form.instructions.trim() ? form.instructions : null;
      svc.extraBody = parsed.extraBody ?? null;
      svc.headers = parsed.headers ?? null;
      // legacy 段只对 voxcpm-legacy 有意义;别的协议带上它会被服务端拒绝
      if (form.protocol === 'voxcpm-legacy') {
        svc.legacy = { profile: legacyProfile.formProfile(), runtime: runtimePaths.formRuntime() };
      }
      return svc;
    }

    /** 服务表里没有的 id:在名字或既有 id 上接一个 -2 / -3。没落盘的那条也占着 id。 */
    function freshId(base: string): string {
      const root = idFromName(base) || 'service';
      const taken = new Set([...services, ...(draft ? [draft] : [])].map((s) => s.id));
      if (!taken.has(root)) return root;
      for (let i = 2; i < 1000; i++) {
        const candidate = `${root}-${i}`;
        if (!taken.has(candidate)) return candidate;
      }
      return `${root}-${Date.now()}`;
    }

    // 列表与当前服务那行先按空服务表铺一遍;取数回来再把表单挂到展开着的那条上,
    // 都收着就铺当前服务那条(展开状态记在 memo 里,重启面板沿用上一次的样子)
    renderPicker();
    renderCurrent();
    renderRows();
    void (async () => {
      await refreshAll();
      const shown = services.find((s) => entries.get(s.id)?.details.open)
        ?? services.find((s) => s.id === selectedId);
      const entry = shown ? entries.get(shown.id) : undefined;
      if (shown && entry) {
        hostForm(shown, entry);
      } else {
        renderActions();
      }
    })();
  },
};

// ---------------------------------------------------------------------------
// voxcpm-legacy 的声线档案
// ---------------------------------------------------------------------------

interface LegacyProfileHandles {
  /** 声线库变了:重铺下拉,尽量留住表单上的选择 */
  setVoices(list: TtsVoiceInfo[], dir: string): void;
  setProfile(p: TtsProfile | null): void;
  renderOptions(): void;
  formProfile(): TtsProfile;
  renderActions(enabled: boolean): void;
}

/**
 * 参考音频、转写与生成参数。**只对 voxcpm-legacy 服务显示**:别的协议没有本地声线库,
 * 这些值经 `setProfile` 落到那条 legacy 条目上。
 */
function mountLegacyProfile(
  ctx: ConsolePanelContext,
  host: HTMLElement,
  voicePicked: VoicePicked,
  onSaved: () => Promise<void>,
): LegacyProfileHandles {
  const { ui } = ctx;
  const box = ui.h('div');

  const filePick = ui.h('input', 'vt-hidden');
  filePick.type = 'file';
  filePick.accept = AUDIO_ACCEPT;
  const voiceSel = ui.select({ cls: 'grow', onInput: () => onVoicePicked() });
  const btnImport = ui.button('从本地导入…', { size: 'sm', onClick: () => filePick.click() });
  const btnPreview = ui.button('试听参考', { size: 'sm', onClick: () => { void preview(); } });
  const voiceRow = ui.rowbar();
  voiceRow.append(voiceSel, btnImport, btnPreview, filePick);
  const voicePath = dimLine(ctx);
  box.append(ui.section('参考音频'), voiceRow, dimLine(ctx, IMPORT_HINT), voicePath);

  const refText = ui.textarea({ rows: 2, placeholder: '(空 = 纯克隆模式)', onInput: () => renderDirty() });
  box.append(ui.section('参考转写 ref_text'), refText);

  const inSeed = numField(ctx, { value: 42, ...LIMITS.seed, cls: 'vt-num md' });
  const inCfg = numField(ctx, { value: 2, ...LIMITS.cfgValue });
  const inSteps = numField(ctx, { value: 10, ...LIMITS.inferenceTimesteps });
  const inMax = numField(ctx, { value: 200, ...LIMITS.maxSteps, cls: 'vt-num md' });
  const inTemp = numField(ctx, { value: 1, ...LIMITS.temperature });
  // numField 只接 onChange(失焦才响);未保存提示要跟着每一次击键走,所以补一条
  for (const el of [inSeed, inCfg, inSteps, inMax, inTemp]) {
    el.addEventListener('input', () => renderDirty(), { signal: ctx.signal });
  }
  const grid = ui.rowbar();
  grid.classList.add('vt-wrap');
  grid.append(
    ui.field('seed', inSeed),
    ui.field('cfg_value', inCfg),
    ui.field('timesteps', inSteps),
    ui.field('max_steps', inMax),
    ui.field('temperature', inTemp),
  );
  const dirtyHint = ui.msgline('');
  const profMsg = ui.msgline('');
  const sayProf = (text: string, bad = false): void => setMsg(profMsg, text, bad);
  const btnSave = ui.button('保存档案', { variant: 'primary', onClick: () => { void save(); } });
  const profBar = ui.actions();
  profBar.append(profMsg, ui.h('span', 'grow'), btnSave);
  box.append(ui.section('生成参数'), grid, dirtyHint, profBar, dimLine(ctx, HIFI_NOTE));

  const player = ownedAudio(ctx);
  const playUrl = urlSlot(ctx);
  box.appendChild(player);
  host.appendChild(box);

  let voices: TtsVoiceInfo[] = [];
  let voicesDir = '';
  /** 服务器上生效的那份档案;面板上的值与它一比就知道有没有未保存的改动 */
  let savedProfile: TtsProfile | null = null;

  function formProfile(): TtsProfile {
    return {
      refAudio: voiceSel.value || null,
      refText: refText.value,
      seed: Number(inSeed.value),
      cfgValue: Number(inCfg.value),
      inferenceTimesteps: Number(inSteps.value),
      maxSteps: Number(inMax.value),
      temperature: Number(inTemp.value),
    };
  }

  function isDirty(): boolean {
    if (!savedProfile) return false;
    const f = formProfile() as unknown as Record<string, unknown>;
    const s = savedProfile as unknown as Record<string, unknown>;
    return Object.keys(f).some((k) => String(f[k] ?? '') !== String(s[k] ?? ''));
  }

  function renderDirty(): void {
    const dirty = isDirty();
    setMsg(
      dirtyHint,
      dirty ? '⚠ 面板上的档案还没保存:试听按面板上的值合成,直播演出仍用已保存的那份。' : '',
      dirty,
    );
  }

  function renderPath(): void {
    const f = voiceSel.value;
    voicePath.textContent = f ? `缓存路径: ${voicesDir ? voicesDir + '\\' : ''}${f}` : '';
  }

  /** 转写始终跟着选中的声线走;换到没有转写的那条就清空,不留上一条的文本 */
  function onVoicePicked(): void {
    const v = voices.find((x) => x.file === voiceSel.value);
    refText.value = v ? v.text : '';
    voicePicked.current = true;
    renderPath();
    renderDirty();
  }

  function renderOptions(): void {
    const keep = voiceSel.value;
    voiceSel.replaceChildren();
    const none = ui.h('option', null, '(不用参考音频)');
    none.value = '';
    voiceSel.appendChild(none);
    for (const v of voices) {
      const opt = ui.h('option', null, v.file + (v.text ? '(有转写)' : ''));
      opt.value = v.file;
      voiceSel.appendChild(opt);
    }
    voiceSel.value = keep;
    renderPath();
  }

  function setProfile(p: TtsProfile | null): void {
    if (!p) {
      savedProfile = null;
      return;
    }
    savedProfile = { ...p, refText: p.refText || '', refAudio: p.refAudio || null };
    voiceSel.value = p.refAudio || '';
    refText.value = p.refText || '';
    inSeed.value = String(p.seed);
    inCfg.value = String(p.cfgValue);
    inSteps.value = String(p.inferenceTimesteps);
    inMax.value = String(p.maxSteps);
    inTemp.value = String(p.temperature);
    renderPath();
    renderDirty();
  }

  /** 起播不参与等待;`startPlayback` 说明为什么不 await。 */
  function play(blob: Blob): void {
    startPlayback(player, playUrl.set(blob));
  }

  async function preview(): Promise<void> {
    const file = voiceSel.value;
    if (!file) return;
    const lock = ui.disable(btnPreview);
    sayProf('');
    try {
      const blob = await ctx.invokeBinary('voiceWav', [file]);
      if (ctx.signal.aborted) return;
      play(blob);
    } catch (err) {
      if (!ctx.signal.aborted) sayProf(`试听失败: ${errText(err)}`, true);
    } finally {
      lock.dispose();
    }
  }

  filePick.addEventListener('change', () => {
    const f = filePick.files?.[0];
    filePick.value = '';
    if (f) void importVoice(f);
  }, { signal: ctx.signal });

  async function importVoice(file: File): Promise<void> {
    const lock = ui.disable(btnImport, btnSave, btnPreview);
    sayProf('导入中…');
    try {
      const b64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      if (ctx.signal.aborted) return;
      const out = await ctx.invoke<SavedVoice>('saveVoice', [file.name, b64]);
      if (ctx.signal.aborted) return;
      voices = [...voices, { file: out.file, text: '' }];
      renderOptions();
      sayProf(
        `已存入 ${out.path}${out.converted ? `(已从 ${out.converted} 转码)` : ''}`
        + '。选它、填好参考转写,再点「保存档案」才会生效。',
      );
    } catch (err) {
      if (!ctx.signal.aborted) sayProf(`导入失败: ${errText(err)}`, true);
    } finally {
      lock.dispose();
    }
  }

  async function save(): Promise<void> {
    const lock = ui.disable(btnSave, btnImport, btnPreview);
    sayProf('');
    try {
      const p = await ctx.invoke<TtsProfile>('setProfile', [formProfile()]);
      if (ctx.signal.aborted) return;
      // 让回填按服务器返回的生效值走,而不是当成未保存的编辑
      savedProfile = null;
      setProfile(p);
      await onSaved();
      sayProf(`已保存,声线 ${p.refAudio || '(无参考音频)'} 已生效`);
    } catch (err) {
      if (!ctx.signal.aborted) sayProf(`保存失败: ${errText(err)}`, true);
    } finally {
      lock.dispose();
    }
  }

  return {
    setVoices(list, dir) {
      voices = list;
      voicesDir = dir;
      // 表单里的选择留着:这是顺手刷新声线库,不是换档案
      renderOptions();
    },
    setProfile,
    renderOptions,
    formProfile,
    renderActions(enabled) {
      btnImport.disabled = !enabled;
      btnSave.disabled = !enabled;
      btnPreview.disabled = !enabled || !voiceSel.value;
    },
  };
}

// ---------------------------------------------------------------------------
// managed-voxcpm 的旧运行时路径
// ---------------------------------------------------------------------------

interface RuntimePathHandles {
  setRuntime(rt: TtsLegacyRuntime): void;
  formRuntime(): TtsLegacyRuntime;
}

/** 旧的本地运行时路径。改成它们要经「保存配置」,和别的字段一起落盘。 */
function mountRuntimePaths(ctx: ConsolePanelContext, host: HTMLElement): RuntimePathHandles {
  const { ui } = ctx;
  const box = ui.h('div');
  const inputs = new Map<keyof TtsLegacyRuntime, HTMLInputElement>();
  const dirtyLine = ui.msgline('');
  const showDirty = (): void => setMsg(dirtyLine, '运行时路径的改动与「保存配置」一起生效。');

  const make = (key: keyof TtsLegacyRuntime, label: string, pick: PathPickerOptions): HTMLElement => {
    const el = ui.input({
      cls: 'mono grow',
      placeholder: pick.kind === 'directory' ? '目录路径' : '文件路径',
      onInput: showDirty,
    });
    const btn = ui.button('选择…', {
      size: 'sm',
      onClick: () => {
        void (async () => {
          const lock = ui.disable(btn, el);
          try {
            const path = await ctx.pickPath({ ...pick, currentPath: el.value || undefined });
            if (ctx.signal.aborted || !path) return;
            el.value = path;
            showDirty();
          } finally {
            lock.dispose();
          }
        })();
      },
    });
    const row = ui.rowbar();
    row.append(el, btn);
    inputs.set(key, el);
    return ui.field(label, row);
  };

  box.append(
    ui.section('本地运行时路径'),
    dimLine(ctx, '运行时目录填了就用自己的那份,不再下载。'),
    make('runtimeDir', '运行时目录', { kind: 'directory', title: '选择 llama-tts-server 的运行时目录' }),
    make('runtimeRelease', '运行时版本', { kind: 'directory', title: '选择随包发布的运行时根目录' }),
    make('baseLmFile', 'BaseLM 权重', { kind: 'file', title: '选择 BaseLM 的 GGUF', extensions: ['.gguf'] }),
    make('acousticFile', 'Acoustic 权重', { kind: 'file', title: '选择 Acoustic 的 GGUF', extensions: ['.gguf'] }),
    make('alignerLmFile', 'Aligner LM', { kind: 'file', title: '选择对齐器 LM 的 GGUF', extensions: ['.gguf'] }),
    make('alignerAudioFile', 'Aligner Audio', { kind: 'file', title: '选择对齐器音频编码器的 GGUF', extensions: ['.gguf'] }),
    make('voicesDir', '声线库目录', { kind: 'directory', title: '选择参考音频存放目录' }),
    dirtyLine,
  );
  host.appendChild(box);

  return {
    setRuntime(rt) {
      for (const [key, el] of inputs) el.value = rt[key] ?? '';
      setMsg(dirtyLine, '');
    },
    formRuntime() {
      const out = { ...EMPTY_RUNTIME };
      for (const [key, el] of inputs) out[key] = el.value;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// managed-voxcpm 的运行时与权重
// ---------------------------------------------------------------------------

/** 面板顶部那块:运行时装没装、四个权重在不在,各带一个下载按钮 */
interface RuntimePanelState {
  release: string;
  key: string | null;
  dir: string;
  own: boolean;
  supported: boolean;
  install: { phase: string; file: string | null; done: number; total: number | null; detail: string | null };
  models: {
    id: string;
    file: string;
    path: string;
    phase: string;
    bytes: number;
    done: number;
    total: number | null;
    detail: string | null;
    required: boolean;
    downloadable: boolean;
    source: string;
  }[];
}

function gb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function progressText(done: number, total: number | null): string {
  return total ? `${gb(done)} / ${gb(total)}(${Math.round((done / total) * 100)}%)` : gb(done);
}

function mountRuntimeSection(ctx: ConsolePanelContext, host: HTMLElement): void {
  const { ui } = ctx;
  const card = ui.sheet({ title: '运行时与权重', en: 'Runtime', desc: RUNTIME_DESC });

  const msg = ui.msgline('');
  const chip = ui.chip('—');
  const btnInstall = ui.button('安装运行时', { size: 'sm', onClick: () => void install() });
  const head = ui.rowbar();
  head.append(ui.pill('运行时', 'plain'), chip, msg, ui.h('span', 'grow'), btnInstall);
  card.body.appendChild(head);

  const dirLine = dimLine(ctx, '');
  card.body.appendChild(dirLine);

  const rows = ui.h('div');
  card.body.appendChild(rows);
  host.appendChild(card.el);

  /** 有活在跑就提高轮询频率,静止时一次就够 */
  let busy = false;

  async function refresh(): Promise<void> {
    let st: RuntimePanelState;
    try {
      st = await ctx.invoke<RuntimePanelState>('runtime');
    } catch (error) {
      if (!ctx.signal.aborted) setMsg(msg, errText(error), true);
      return;
    }
    if (ctx.signal.aborted) return;

    const phase = st.install.phase;
    busy = phase === 'downloading' || phase === 'extracting'
      || st.models.some((m) => m.phase === 'downloading');

    chip.textContent = st.own
      ? '自备目录'
      : !st.supported
        ? '本平台无构建'
        : phase === 'installed'
          ? st.release
          : phase === 'downloading'
            ? `下载中 ${st.install.file ?? ''} ${progressText(st.install.done, st.install.total)}`
            : phase === 'extracting'
              ? `解压中 ${st.install.file ?? ''}`
              : phase === 'error'
                ? '装失败'
                : '未安装';
    dirLine.textContent = st.dir || '(还没有目录)';
    btnInstall.disabled = busy || st.own || !st.supported;
    btnInstall.textContent = phase === 'installed' ? '重装运行时' : '安装运行时';
    if (st.install.detail) setMsg(msg, st.install.detail, true);

    rows.replaceChildren();
    for (const m of st.models) {
      const row = ui.rowbar();
      const state = m.phase === 'present'
        ? gb(m.bytes)
        : m.phase === 'downloading'
          ? progressText(m.done, m.total)
          : m.phase === 'error'
            ? (m.detail ?? '下载失败')
            : m.downloadable ? '未下载' : '要自己放进来';
      row.append(
        ui.pill(m.required ? '必需' : '选配', 'plain'),
        ui.chip(m.file),
        ui.h('span', '', state),
        ui.h('span', 'grow'),
      );
      if (m.downloadable) {
        const btn = ui.button('下载', {
          size: 'sm',
          onClick: () => void download(m.id, m.file),
        });
        btn.disabled = busy || m.phase === 'present';
        row.append(btn);
      }
      rows.appendChild(row);
      rows.appendChild(dimLine(ctx, m.source));
    }
  }

  async function install(): Promise<void> {
    setMsg(msg, '开始安装,压缩包几百 MB,别关页面');
    try {
      await ctx.invoke('installRuntime');
      setMsg(msg, '运行时装好了');
    } catch (error) {
      setMsg(msg, errText(error), true);
    }
    void refresh();
  }

  async function download(id: string, file: string): Promise<void> {
    setMsg(msg, `开始下载 ${file}`);
    try {
      await ctx.invoke('downloadModel', [id]);
      setMsg(msg, `${file} 下好了`);
    } catch (error) {
      setMsg(msg, errText(error), true);
    }
    void refresh();
  }

  ctx.interval(() => { if (busy) void refresh(); }, 1000);
  void refresh();
}

// ---------------------------------------------------------------------------
// 文本 → 值
// ---------------------------------------------------------------------------

/** 名字 → 服务 id 的种子;服务端只收小写字母、数字、点、下划线与连字符。 */
function idFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/**
 * voice 输入框:纯文本就是字符串,`{"id": "..."}` 这样的对象按 JSON 解析。
 * 解析不出对象就按字符串交出去,由服务端说它不合法。
 */
function parseVoice(text: string): string | { id: string } {
  const value = text.trim();
  if (!value.startsWith('{')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && typeof (parsed as { id?: unknown }).id === 'string') {
      return { id: (parsed as { id: string }).id };
    }
  } catch {
    // 落回字符串
  }
  return value;
}

/** tts-<文本前几个字>-<时间戳>.wav;文件名里非法的字符全去掉 */
function testWavName(text: string): string {
  const stamp = new Date().toISOString().replace(/[:-]/g, '').replace(/\..+$/, '');
  const slug = (text || '').replace(/\s+/g, '').replace(/[\\/:*?"<>|.]/g, '').slice(0, 16);
  return `tts-${slug ? slug + '-' : ''}${stamp}.wav`;
}
