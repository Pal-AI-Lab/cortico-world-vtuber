/**
 * 时间点标注面板，将音频与逐字稿交给对齐器，展示波形、时间刻度与单元区间，并支持播放和定位。
 * 每次挂载最多创建一个 AudioContext，在首次解码时懒创建，经 ctx.own 在卸载时 close；音频 URL 由 urlSlot 在替换或卸载时 revoke，ownedAudio 在卸载时暂停、移除 src 并 load。
 * 播放 RAF 使用 ctx.frame，暂停或结束时返回 false；ResizeObserver 经 ctx.own 断开，监听绑定 ctx.signal，单元表轮询使用 ctx.interval。
 * 波形、PCM 和采样率归 provider；卡片、按钮、消息行与 kv 表使用通用 UI 原语。
 */

import { toDisposable } from '../../web/shared/client-plugin.ts';
import type {
  ConsolePanelContext,
  ConsolePanelPlugin,
  Disposable,
} from '../../web/shared/client-plugin.ts';
import {
  base64ToBytes,
  bytesToBase64,
  dimLine,
  errText,
  ownedAudio,
  setMsg,
  urlSlot,
  type AlignRun,
  type AlignState,
  type AlignUnit,
} from './client.ts';

const DESC =
  '把一段音频和它的逐字稿交给对齐器,得到逐单元的起止时间:中日文逐字,英文逐词,'
  + '标点不参与。对齐器随 TTS server 一起加载。';

/** 画布高度(CSS 像素)。后备位图按 dpr 放大,坐标系再缩回来。 */
const WAVE_H = 176;
/** 波络的采样列数。画的时候按画布宽度重采样,所以与实际宽度无关。 */
const ENVELOPE_COLS = 2048;
/** 逐字稿改动的合流拍:最多每这么久问一次单元表,最后一次输入说了算 */
const UNITS_TICK_MS = 300;
const DEFAULT_TEXT = '我觉得我没想到嘿嘿这个确实';

export const alignPanel: ConsolePanelPlugin = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const view = ctx.root.ownerDocument.defaultView;
    const card = ui.sheet({ title: '时间点标注', en: 'Qwen3-ForcedAligner', desc: DESC });

    // ---- 状态表 ----
    const statusBox = ui.h('div');
    card.body.appendChild(statusBox);

    // ---- 音频与逐字稿 ----
    const textIn = ui.textarea({
      rows: 2,
      value: DEFAULT_TEXT,
      placeholder: '逐字稿(选本地文件时要自己填;用 TTS 合成时就是合成文本)',
      onInput: (v) => { pendingText = v; },
    });
    const filePick = ui.h('input', 'vt-hidden');
    filePick.type = 'file';
    filePick.accept = '.wav,.mp3,.flac,audio/*';
    const btnLocal = ui.button('选本地音频…', { size: 'sm', onClick: () => filePick.click() });
    const btnSynth = ui.button('用 TTS 合成这句', { size: 'sm', onClick: () => { void synth(); } });
    const btnRun = ui.button('标注', { variant: 'primary', onClick: () => { void run(); } });
    const srcName = ui.msgline('');
    srcName.classList.add('grow');
    const srcBar = ui.actions();
    srcBar.append(btnLocal, btnSynth, srcName, btnRun, filePick);
    const unitPrev = dimLine(ctx);
    card.body.append(ui.section('音频与逐字稿'), textIn, unitPrev, srcBar);

    // ---- 波形 ----
    const canvas = ui.h('canvas', 'vt-wave');
    canvas.style.height = `${WAVE_H}px`;
    const g = canvas.getContext('2d');
    const btnPlay = ui.button('播放', { size: 'sm', onClick: () => togglePlay() });
    btnPlay.disabled = true;
    const timeTxt = ui.msgline('');
    timeTxt.classList.add('vt-time');
    const verdict = ui.msgline('');
    verdict.classList.add('grow');
    const playBar = ui.rowbar();
    playBar.classList.add('vt-playbar');
    playBar.append(btnPlay, timeTxt, verdict);
    const audio = ownedAudio(ctx);
    card.body.append(ui.section('波形与时间点'), canvas, playBar, audio);

    ctx.root.appendChild(card.el);

    // -----------------------------------------------------------------------

    /** 波络:每列一个 RMS,画的时候按画布宽度重采样 */
    let envelope: Float32Array | null = null;
    let units: AlignUnit[] = [];
    let duration = 0;
    /** 当前这段音频的 base64;标注时原样交给服务端 */
    let audioB64 = '';
    let available = false;
    /** 逐字稿的最新值,等下一拍合流去问单元表;null = 没有待问的改动 */
    let pendingText: string | null = null;
    /** 播放中的 RAF 循环;暂停即自停 */
    let loop: Disposable | null = null;

    const audioUrl = urlSlot(ctx);

    /**
     * 解码用的 AudioContext 在首次解码时懒创建，每次面板挂载最多一个，卸载时 close。
     */
    let ac: AudioContext | null = null;
    function audioContext(): AudioContext {
      if (ac) return ac;
      const Ctor = view?.AudioContext;
      if (!Ctor) throw new Error('这个浏览器不给 AudioContext,画不了波形');
      ac = new Ctor();
      ctx.own(toDisposable(() => {
        const dying = ac;
        ac = null;
        void dying?.close();
      }));
      return ac;
    }

    const say = (el: HTMLElement, text: string, bad = false): void => setMsg(el, text, bad);
    const cssVar = (name: string): string =>
      view?.getComputedStyle(canvas).getPropertyValue(name).trim() || '#888';

    // ---- 画 ----

    /**
     * 后备位图跟 CSS 尺寸对齐。每次 draw 都先过一遍:面板可能是在页面不渲染时
     * 构造的(标签页在后台),那时 rAF 与 ResizeObserver 都不会回调,量不到宽度。
     */
    function syncSize(): number {
      const w = Math.max(320, canvas.clientWidth || 320);
      const dpr = view?.devicePixelRatio || 1;
      const bw = Math.round(w * dpr);
      const bh = Math.round(WAVE_H * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      g?.setTransform(dpr, 0, 0, dpr, 0, 0);
      return w;
    }

    function draw(): void {
      if (!g) return;
      const w = syncSize();
      g.clearRect(0, 0, w, WAVE_H);
      g.fillStyle = cssVar('--sheet-2');
      g.fillRect(0, 0, w, WAVE_H);
      if (!duration) {
        g.fillStyle = cssVar('--ink-dim');
        g.font = '12px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('先选一段音频并标注', w / 2, WAVE_H / 2);
        g.textAlign = 'left';
        return;
      }
      const waveTop = 8;
      const waveH = 68;
      const waveMid = waveTop + waveH / 2;
      const rulerY = waveTop + waveH + 14;
      const bandTop = rulerY + 10;
      const bandH = WAVE_H - bandTop - 8;
      const x = (t: number): number => (t / duration) * w;

      // 波络:以中线为轴上下镜像
      const env = envelope;
      if (env) {
        const at = (px: number): number =>
          env[Math.min(env.length - 1, Math.floor((px / w) * env.length))];
        g.fillStyle = cssVar('--chart-2');
        g.globalAlpha = 0.55;
        g.beginPath();
        g.moveTo(0, waveMid);
        for (let px = 0; px < w; px++) g.lineTo(px, waveMid - at(px) * (waveH / 2));
        for (let px = w - 1; px >= 0; px--) g.lineTo(px, waveMid + at(px) * (waveH / 2));
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
      }

      // 时间刻度:按时长挑一个不挤的步长
      const step = duration <= 3 ? 0.25 : duration <= 10 ? 0.5 : duration <= 30 ? 2 : 5;
      g.strokeStyle = cssVar('--line-2');
      g.fillStyle = cssVar('--ink-dim');
      g.font = '10px system-ui, sans-serif';
      g.lineWidth = 1;
      for (let t = 0; t <= duration + 1e-6; t += step) {
        const px = Math.round(x(t)) + 0.5;
        g.beginPath();
        g.moveTo(px, rulerY - 5);
        g.lineTo(px, rulerY);
        g.stroke();
        g.fillText(`${t.toFixed(step < 1 ? 2 : 0)}s`, px + 2, rulerY - 6);
      }

      // 单元块:相邻块交替深浅好数边界;退化的块(零长/反向)标出来
      g.font = '12px system-ui, sans-serif';
      g.textBaseline = 'middle';
      units.forEach((u, i) => {
        const bad = u.end <= u.start;
        const x0 = x(u.start);
        const x1 = Math.max(x(u.end), x0 + 1.5);
        g.fillStyle = bad ? cssVar('--chart-6') : cssVar(i % 2 ? '--chart-1' : '--chart-4');
        g.globalAlpha = bad ? 0.85 : 0.42;
        g.fillRect(x0, bandTop, x1 - x0, bandH);
        g.globalAlpha = 1;
        g.strokeStyle = cssVar('--line-strong');
        g.beginPath();
        g.moveTo(Math.round(x0) + 0.5, bandTop);
        g.lineTo(Math.round(x0) + 0.5, bandTop + bandH);
        g.stroke();
        // 标签放得下才写,放不下就只留色块,避免糊成一片
        if (g.measureText(u.text).width < x1 - x0 - 2) {
          g.fillStyle = cssVar('--ink');
          g.textAlign = 'center';
          g.fillText(u.text, (x0 + x1) / 2, bandTop + bandH / 2);
          g.textAlign = 'left';
        }
      });
      g.textBaseline = 'alphabetic';

      const t = audio.currentTime || 0;
      if (t > 0) {
        const px = Math.round(x(t)) + 0.5;
        g.strokeStyle = cssVar('--chart-3');
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(px, 0);
        g.lineTo(px, WAVE_H);
        g.stroke();
        g.lineWidth = 1;
      }
    }

    /** 一帧:重画 + 读数。播放时由 RAF 循环调,停下时手动补一次。 */
    function paint(): void {
      draw();
      const t = audio.currentTime || 0;
      const cur = units.find((u) => t >= u.start && t < u.end);
      timeTxt.textContent = `${t.toFixed(2)} / ${duration.toFixed(2)}s`
        + (cur ? `  「${cur.text}」` : '');
    }

    /**
     * 播放 RAF 由 ctx.frame 管理，暂停或播放结束时返回 false 自停，面板卸载时停止。
     */
    function startLoop(): void {
      if (loop) return;
      loop = ctx.frame(() => {
        paint();
        if (!audio.paused) return;
        loop = null;
        return false;
      });
    }

    function stopLoop(): void {
      loop?.dispose();
      loop = null;
    }

    function togglePlay(): void {
      if (audio.paused) void audio.play().catch((err: unknown) => {
        say(srcName, `放不出来: ${errText(err)}`, true);
      });
      else audio.pause();
    }

    audio.addEventListener('play', () => {
      btnPlay.textContent = '暂停';
      startLoop();
    }, { signal: ctx.signal });
    audio.addEventListener('pause', () => {
      btnPlay.textContent = '播放';
      stopLoop();
      paint();
    }, { signal: ctx.signal });
    audio.addEventListener('ended', () => { btnPlay.textContent = '播放'; }, { signal: ctx.signal });

    // 点波形跳到那个时刻
    canvas.addEventListener('click', (ev: MouseEvent) => {
      if (!duration) return;
      const r = canvas.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(duration, ((ev.clientX - r.left) / r.width) * duration));
      paint();
    }, { signal: ctx.signal });

    /**
     * 面板是先构造后挂载的,构造时量不到宽度;交给 ResizeObserver 在真正有宽度时
     * 定尺寸。`disconnect` 交给 `ctx.own`——observer 不认 `AbortSignal`,不登记的话
     * 它会连着一份已经没人要的画布一起活到页面关掉。
     */
    const RO = view?.ResizeObserver;
    if (RO) {
      const ro = new RO(() => draw());
      ro.observe(canvas);
      ctx.own(toDisposable(() => ro.disconnect()));
    }

    // ---- 取数 ----

    async function refresh(): Promise<void> {
      try {
        const st = await ctx.invoke<AlignState>('state');
        if (ctx.signal.aborted) return;
        available = !!st.available;
        const last = st.lastOk == null ? '还没跑过' : st.lastOk ? '正常' : '上次失败';
        statusBox.replaceChildren(ui.kv([
          {
            k: '对齐器',
            v: available
              ? ui.pill('已加载', 'on')
              : ui.pill('未加载(TTS server 启动时没带对齐模型)', 'off'),
          },
          {
            k: '演出流水线',
            v: st.enabled ? '每片标注中' : '未开启(配置里的「逐分片时间点标注」)',
          },
          { k: '最近一次', v: last },
        ]));
      } catch (err) {
        if (ctx.signal.aborted) return;
        available = false;
        statusBox.replaceChildren(ui.kv([{ k: '状态', v: `不可用: ${errText(err)}` }]));
      } finally {
        renderActions();
      }
    }

    /** 按当前状态重设按钮。**在 `ui.disable` 的 `dispose()` 之后调才算数。** */
    function renderActions(): void {
      btnRun.disabled = !available;
      btnSynth.disabled = !available;
      btnPlay.disabled = !duration;
    }

    async function refreshUnits(text: string): Promise<void> {
      if (!text.trim()) {
        unitPrev.textContent = '';
        return;
      }
      try {
        const out = await ctx.invoke<{ units: string[] }>('units', [text.trim()]);
        if (ctx.signal.aborted) return;
        unitPrev.textContent = `将对齐 ${out.units.length} 个单元:${out.units.join(' · ')}`;
      } catch {
        // 单元预览是顺手的提示,拉不到就不显示;真正的失败在标注那条路上会说话
        if (!ctx.signal.aborted) unitPrev.textContent = '';
      }
    }

    // 合流拍:边打字边发请求会把对齐器问穿,这里最多每 300ms 问一次,最后一次输入说了算
    ctx.interval(() => {
      if (pendingText === null) return;
      const text = pendingText;
      pendingText = null;
      void refreshUnits(text);
    }, UNITS_TICK_MS);

    // ---- 换音频 ----

    /** 从解码后的采样按列归并成 RMS,p95 归一(与口型用的那份口径一致) */
    function buildEnvelope(buf: AudioBuffer, cols: number): Float32Array {
      const ch = buf.getChannelData(0);
      const per = ch.length / cols;
      const out = new Float32Array(cols);
      for (let i = 0; i < cols; i++) {
        const a = Math.floor(i * per);
        const b = Math.min(ch.length, Math.floor((i + 1) * per));
        let acc = 0;
        for (let j = a; j < b; j++) acc += ch[j] * ch[j];
        out[i] = Math.sqrt(acc / Math.max(1, b - a));
      }
      const sorted = Array.from(out).sort((x, y) => x - y);
      const p95 = sorted[Math.min(cols - 1, Math.floor(cols * 0.95))] || 1;
      for (let i = 0; i < cols; i++) out[i] = Math.min(1, out[i] / p95);
      return out;
    }

    async function setAudio(b64: string, label: string, mime = 'audio/wav'): Promise<void> {
      audio.pause();
      audioB64 = b64;
      units = [];
      duration = 0;
      envelope = null;
      const bytes = base64ToBytes(b64);
      // 播放走 blob URL(槽自己顶掉上一份);解码另给一份缓冲——decodeAudioData 会把
      // 传进去的 ArrayBuffer 摘走(detach),复用同一份的话 Blob 那边就成了空壳
      audio.src = audioUrl.set(new Blob([bytes], { type: mime }));
      const buf = await audioContext().decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      if (ctx.signal.aborted) return;
      duration = buf.duration;
      envelope = buildEnvelope(buf, ENVELOPE_COLS);
      say(srcName, `${label} · ${duration.toFixed(2)}s`);
      say(verdict, '还没标注');
      renderActions();
      paint();
    }

    filePick.addEventListener('change', () => {
      const f = filePick.files?.[0];
      filePick.value = '';
      if (f) void loadLocal(f);
    }, { signal: ctx.signal });

    async function loadLocal(file: File): Promise<void> {
      const lock = ui.disable(btnLocal, btnSynth, btnRun, btnPlay);
      say(srcName, '读取中…');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (ctx.signal.aborted) return;
        await setAudio(bytesToBase64(bytes), file.name, file.type || 'audio/wav');
      } catch (err) {
        if (!ctx.signal.aborted) say(srcName, `读不了这个文件: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    async function synth(): Promise<void> {
      const text = textIn.value.trim();
      if (!text) {
        say(srcName, '先填一句要合成的文本', true);
        return;
      }
      const lock = ui.disable(btnLocal, btnSynth, btnRun, btnPlay);
      say(srcName, '合成中…');
      try {
        const out = await ctx.invoke<{ wav: string; durationMs: number }>('synth', [text]);
        if (ctx.signal.aborted) return;
        await setAudio(out.wav, 'TTS 输出');
      } catch (err) {
        if (!ctx.signal.aborted) say(srcName, `合成失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    // ---- 标注 ----

    async function run(): Promise<void> {
      if (!audioB64) {
        say(verdict, '先选一段音频', true);
        return;
      }
      const text = textIn.value.trim();
      if (!text) {
        say(verdict, '要有逐字稿才能对齐', true);
        return;
      }
      const lock = ui.disable(btnRun, btnSynth, btnLocal);
      say(verdict, '标注中…');
      try {
        const out = await ctx.invoke<AlignRun>('align', [audioB64, text]);
        if (ctx.signal.aborted) return;
        units = out.units ?? [];
        duration = out.duration || duration;
        const v = out.verdict ?? { ok: false, reasons: [], coverage: 0 };
        const head = v.ok ? '✅ 过门' : `⚠ 不过门:${(v.reasons ?? []).join('、')}`;
        say(
          verdict,
          `${head} · ${units.length} 单元 · 覆盖 ${Math.round((v.coverage || 0) * 100)}%`
          + ` · 耗时 ${out.elapsedMs}ms`,
          !v.ok,
        );
        paint();
      } catch (err) {
        if (!ctx.signal.aborted) say(verdict, `标注失败: ${errText(err)}`, true);
      } finally {
        lock.dispose();
        renderActions();
      }
    }

    void refresh();
    void refreshUnits(textIn.value);
    draw();
  },
};
