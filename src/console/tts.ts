/**
 * 声线档案面板管理参考音频、转写、生成参数与合成试听。
 * 音频经随 ctx.signal 取消的 ctx.invokeBinary 读取；ownedAudio 与 urlSlot 在卸载时暂停、移除 src 并释放 URL。播放与下载各用一个 URL 槽，互不撤销对方资源。
 * renderActions() 在 lock.dispose() 后运行，以新状态覆盖禁用操作恢复的旧值。试听使用未保存值，直播使用已保存值；离开未保存档案时由 ctx.guardLeave 确认。
 */

import type {
  ConsolePanelContext,
  ConsolePanelPlugin,
} from '../../web/shared/client-plugin.ts';
import {
  base64ToBytes,
  bytesToBase64,
  dimLine,
  errText,
  numField,
  ownedAudio,
  setMsg,
  urlSlot,
  type SavedVoice,
  type TtsPanelState,
  type TtsProfile,
  type TtsTestResult,
  type TtsVoiceInfo,
} from './client.ts';

const DESC =
  '参考音频存放在参数页选定的声线库目录,同名 .txt 是它的转写。带转写按续写克隆(Hi-Fi)合成,'
  + '音色最接近;只给音频是纯克隆。「保存档案」是唯一的生效动作。';

const HIFI_NOTE =
  'Hi-Fi 克隆下 (风格词) 这类括号指令会被念出来:转写与参考音频逐字对应,括号里的字没有对应音频。';

const IMPORT_HINT =
  '导入 mp3 / m4a 这类压缩格式会先经本机 ffmpeg 转成 24kHz 单声道 wav;没装 ffmpeg 就只收 wav。';

const AUDIO_ACCEPT = '.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wma,audio/*';

/**
 * 生成参数的上下界。与模组的 `TTS_PROFILE_LIMITS` 同值:钳制仍归服务端
 * (面板改不了那份判断),这里只是让数字框的箭头与浏览器校验落在同一个区间里。
 */
const LIMITS = {
  seed: { min: 0, max: 2 ** 31 - 1, step: 1 },
  cfgValue: { min: 0.1, max: 10, step: 0.1 },
  inferenceTimesteps: { min: 1, max: 100, step: 1 },
  maxSteps: { min: 10, max: 2000, step: 10 },
  temperature: { min: 0.05, max: 2, step: 0.05 },
} as const;

/** 试听回来的那段 wav:字节留着,既要播也要能存 */
interface TestWav {
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
}

export const ttsPanel: ConsolePanelPlugin = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({ title: '声线档案', en: 'VoxCPM2', desc: DESC });
    card.body.appendChild(dimLine(ctx, HIFI_NOTE));

    // ---- 头一行:生效中的那条声线 + 刷新 ----
    const activeChip = ui.chip('—');
    const msg = ui.msgline('');
    const say = (text: string, bad = false): void => setMsg(msg, text, bad);
    const btnRefresh = ui.button('刷新', { size: 'sm', onClick: () => { say(''); void refresh(); } });
    const headBar = ui.rowbar();
    headBar.append(ui.pill('已生效', 'plain'), activeChip, msg, ui.h('span', 'grow'), btnRefresh);
    card.body.appendChild(headBar);

    // ---- 参考音频 ----
    const filePick = ui.h('input', 'vt-hidden');
    filePick.type = 'file';
    filePick.accept = AUDIO_ACCEPT;
    const voiceSel = ui.select({ cls: 'grow', onInput: () => onVoicePicked() });
    const btnImport = ui.button('从本地导入…', { size: 'sm', onClick: () => filePick.click() });
    const btnPreview = ui.button('试听参考', { size: 'sm', onClick: () => { void preview(); } });
    const voiceRow = ui.rowbar();
    voiceRow.append(voiceSel, btnImport, btnPreview, filePick);
    const voicePath = dimLine(ctx);
    card.body.append(
      ui.section('参考音频'),
      voiceRow,
      dimLine(ctx, IMPORT_HINT),
      voicePath,
    );

    // ---- 参考转写 ----
    const refText = ui.textarea({
      rows: 2,
      placeholder: '(空 = 纯克隆模式)',
      onInput: () => renderDirty(),
    });
    card.body.append(ui.section('参考转写 ref_text'), refText);

    // ---- 生成参数 ----
    const inSeed = numField(ctx, { value: 42, ...LIMITS.seed, cls: 'vt-num md' });
    const inCfg = numField(ctx, { value: 2, ...LIMITS.cfgValue });
    const inSteps = numField(ctx, { value: 10, ...LIMITS.inferenceTimesteps });
    const inMax = numField(ctx, { value: 200, ...LIMITS.maxSteps, cls: 'vt-num md' });
    const inTemp = numField(ctx, { value: 1, ...LIMITS.temperature });
    const numbers = [inSeed, inCfg, inSteps, inMax, inTemp];
    // numField 只接 onChange(失焦才响);未保存提示要跟着每一次击键走,所以补一条
    for (const el of numbers) {
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
    card.body.append(ui.section('生成参数'), grid, dirtyHint, profBar);

    // ---- 合成试听 ----
    const testInput = ui.input({
      cls: 'grow',
      placeholder: '测试文本(空 = 固定测试句;填了转写时括号会被念出来)',
      onCommit: () => { void test(); },
    });
    testInput.maxLength = 200;
    const btnTest = ui.button('合成试听', { onClick: () => { void test(); } });
    const btnSaveWav = ui.button('保存 wav', { size: 'sm', onClick: () => saveWav() });
    btnSaveWav.disabled = true;
    const testBar = ui.rowbar();
    testBar.append(testInput, btnTest, btnSaveWav);
    card.body.append(ui.section('合成试听'), testBar);

    // 播放器与两个 ObjectURL 槽:播放一个、下载一个,互不掀桌
    const player = ownedAudio(ctx);
    const playUrl = urlSlot(ctx);
    const saveUrl = urlSlot(ctx);
    card.body.appendChild(player);

    ctx.root.appendChild(card.el);

    // -----------------------------------------------------------------------

    let voices: TtsVoiceInfo[] = [];
    let voicesDir = '';
    let reachable = false;
    /** 服务器上生效的那份档案;面板上的值与它一比就知道有没有未保存的改动 */
    let savedProfile: TtsProfile | null = null;
    let lastTestWav: TestWav | null = null;

    /** 面板当前值。试听按这份合成,保存档案也提交这份 */
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

    // 离开尚未保存的档案前请求确认。
    ctx.guardLeave(() => (isDirty() ? '声线档案有未保存的改动,离开就丢了' : null));

    /**
     * 按当前状态重设各颗按钮的可用性。
     *
     * **一定要在 `lock.dispose()` 之后调**:`ui.disable` 恢复的是加锁前的原值,
     * 在它之后重设才算数。
     */
    function renderActions(): void {
      btnTest.disabled = !reachable;
      btnPreview.disabled = !voiceSel.value;
      btnSaveWav.disabled = !lastTestWav;
    }

    function renderVoicePath(): void {
      const f = voiceSel.value;
      voicePath.textContent = f ? `缓存路径: ${voicesDir ? voicesDir + '\\' : ''}${f}` : '';
    }

    /** 转写始终跟着选中的声线走;换到没有转写的那条就清空,不留上一条的文本 */
    function onVoicePicked(): void {
      const v = voices.find((x) => x.file === voiceSel.value);
      refText.value = v ? v.text : '';
      renderVoicePath();
      renderDirty();
      renderActions();
    }

    /** 有未保存改动时仅重建下拉选项,保留当前表单字段。 */
    function renderProfile(p: TtsProfile | null, voiceList: TtsVoiceInfo[]): void {
      const keepEdits = isDirty();
      const selected = voiceSel.value;
      voices = voiceList ?? [];
      voiceSel.replaceChildren();
      const none = ui.h('option', null, '(不用参考音频)');
      none.value = '';
      voiceSel.appendChild(none);
      for (const v of voices) {
        const opt = ui.h('option', null, v.file + (v.text ? '(有转写)' : ''));
        opt.value = v.file;
        voiceSel.appendChild(opt);
      }
      if (p) {
        savedProfile = { ...p, refText: p.refText || '', refAudio: p.refAudio || null };
        activeChip.textContent = (p.refAudio || '无参考音频') + (p.refText ? ' · 带转写' : '');
      }
      if (keepEdits) {
        voiceSel.value = selected;
      } else if (p) {
        voiceSel.value = p.refAudio || '';
        refText.value = p.refText || '';
        inSeed.value = String(p.seed);
        inCfg.value = String(p.cfgValue);
        inSteps.value = String(p.inferenceTimesteps);
        inMax.value = String(p.maxSteps);
        inTemp.value = String(p.temperature);
      }
      renderVoicePath();
      renderDirty();
    }

    /** 合成要 server 在跑;它的启停在「挂载」面板,这里只跟着它的可达性开关试听 */
    async function refresh(): Promise<void> {
      try {
        const st = await ctx.invoke<TtsPanelState>('state');
        if (ctx.signal.aborted) return;
        voicesDir = st.voicesDir || '';
        reachable = !!st.reachable;
        if (!reachable) say('TTS server 不在跑,去「挂载」里启动');
        renderProfile(st.profile, st.voices);
      } catch (err) {
        if (ctx.signal.aborted) return;
        reachable = false;
        say(`不可用: ${errText(err)}`, true);
      } finally {
        renderActions();
      }
    }

    // ---- 动作 ----

    /** 换一份音频进播放器。上一份 URL 由槽自己撤掉。 */
    async function play(blob: Blob): Promise<void> {
      player.src = playUrl.set(blob);
      await player.play();
    }

    async function preview(): Promise<void> {
      const file = voiceSel.value;
      if (!file) return;
      const lock = ui.disable(btnPreview);
      sayProf('');
      try {
        const blob = await ctx.invokeBinary('voiceWav', [file]);
        if (ctx.signal.aborted) return;
        await play(blob);
      } catch (err) {
        if (!ctx.signal.aborted) sayProf(`试听失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    filePick.addEventListener('change', () => {
      const f = filePick.files?.[0];
      filePick.value = '';
      if (f) void importVoice(f);
    }, { signal: ctx.signal });

    async function importVoice(file: File): Promise<void> {
      const lock = ui.disable(btnImport, btnSave, btnTest, btnPreview);
      sayProf('导入中…');
      try {
        const b64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        if (ctx.signal.aborted) return;
        const out = await ctx.invoke<SavedVoice>('saveVoice', [file.name, b64]);
        if (ctx.signal.aborted) return;
        await refresh();
        // 新导入的声线没有转写;选中后清空文本框供录入
        voiceSel.value = out.file;
        refText.value = '';
        renderVoicePath();
        renderDirty();
        sayProf(
          `已存入 ${out.path}${out.converted ? `(已从 ${out.converted} 转码)` : ''}`
          + '。填好参考转写后点「保存档案」才会生效。',
        );
      } catch (err) {
        if (!ctx.signal.aborted) sayProf(`导入失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    async function save(): Promise<void> {
      const lock = ui.disable(btnSave, btnTest, btnImport);
      sayProf('');
      try {
        const p = await ctx.invoke<TtsProfile>('setProfile', [formProfile()]);
        if (ctx.signal.aborted) return;
        // 让 renderProfile 按服务器返回的生效值回填,而不是当成未保存的编辑
        savedProfile = null;
        await refresh();
        sayProf(`已保存,声线 ${p.refAudio || '(无参考音频)'} 已生效`);
      } catch (err) {
        if (!ctx.signal.aborted) sayProf(`保存失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    async function test(): Promise<void> {
      if (!reachable) return;
      const lock = ui.disable(btnTest, btnSave, btnImport, btnPreview, btnSaveWav);
      say('合成中…');
      try {
        // 带上面板当前的档案:选了新声线还没保存时,试听听到的就是它
        const out = await ctx.invoke<TtsTestResult>('test', [testInput.value, formProfile()]);
        if (ctx.signal.aborted) return;
        say(out.message || 'OK');
        if (out.wav) {
          lastTestWav = { bytes: base64ToBytes(out.wav), name: testWavName(testInput.value) };
          await play(new Blob([lastTestWav.bytes], { type: 'audio/wav' }));
        }
      } catch (err) {
        if (!ctx.signal.aborted) say(`试听失败: ${errText(err)}`, true);
      } finally {
        // 先解锁再按新状态重设:反了的话「保存 wav」刚点亮就被恢复动作按回灰色
        lock.dispose();
        renderActions();
      }
    }

    function saveWav(): void {
      if (!lastTestWav) return;
      const a = ui.h('a');
      a.href = saveUrl.set(new Blob([lastTestWav.bytes], { type: 'audio/wav' }));
      a.download = lastTestWav.name;
      a.click();
    }

    void refresh();
  },
};

/** tts-<文本前几个字>-<时间戳>.wav;文件名里非法的字符全去掉 */
function testWavName(text: string): string {
  const stamp = new Date().toISOString().replace(/[:-]/g, '').replace(/\..+$/, '');
  const slug = (text || '').replace(/\s+/g, '').replace(/[\\/:*?"<>|.]/g, '').slice(0, 16);
  return `tts-${slug ? slug + '-' : ''}${stamp}.wav`;
}
