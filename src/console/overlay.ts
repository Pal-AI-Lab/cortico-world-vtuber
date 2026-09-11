/**
 * 面板 `overlay` —— Overlay 画面:推流链接 / 图层开关 / 字幕样式 / 试显 / 预览。
 *
 * overlay 页本身归 io-vtuber(演出流服务直接 serve),这里只是它的遥控器:配置存
 * 服务端,改动即 SSE 热推给所有订阅中的页面——包括 OBS 里那份。
 *
 * 预览是一个真 iframe:里面跑着一整份 overlay 渲染(SSE 订阅 + 动画)。所以它
 * **必须随面板收场**——`ctx.own` 登记一份清理,卸载时先把 `src` 摘掉再移除节点。
 * 只 `remove()` 不清 `src` 在部分浏览器上会留着那份文档继续跑;而 host 卸载面板时
 * 只是 `replaceChildren()` 清空 root,它不知道里面有个还在订阅的 iframe。
 */

import {
  toDisposable,
  type ConsolePanelContext,
  type ConsolePanelPlugin,
} from '../../web/shared/client-plugin.ts';
import {
  colorField,
  errText,
  numField,
  setMsg,
  type OverlayConfig,
  type OverlayState,
} from './client.ts';

const WEIGHTS = [
  { value: '400', label: '常规' },
  { value: '500', label: '中等' },
  { value: '700', label: '加粗' },
  { value: '900', label: '特粗' },
];

export const overlayPanel: ConsolePanelPlugin = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({
      title: 'Overlay 画面',
      en: 'overlay',
      desc: '演出画面层(字幕/动作气泡/弹幕),透明底。OBS 加 browser source 指向这个地址即合成进直播画面。'
        + '字幕不要放进被延迟的游戏画面源,它要跟语音走。',
    });

    let overlayUrl: string | null = null;
    /** 回填表单时不要把回填本身当成一次用户改动再存一遍 */
    let syncing = false;

    const msg = ui.msgline('');
    const say = (text: string, bad = false): void => setMsg(msg, text, bad);

    // ---- 链接 ----
    const urlBox = ui.input({ value: '(演出流未启动)', cls: 'grow mono' });
    urlBox.readOnly = true;
    const btnCopy = ui.copyButton(() => overlayUrl ?? '', {
      label: '复制链接',
      okText: '已复制;OBS browser source 直接贴',
    });
    const btnOpen = ui.button('打开', {
      size: 'sm',
      onClick: () => {
        if (overlayUrl) ctx.root.ownerDocument.defaultView?.open(overlayUrl, '_blank', 'noopener');
      },
    });
    const urlBar = ui.rowbar();
    urlBar.append(urlBox, btnCopy, btnOpen);
    card.body.append(ui.section('推流链接'), urlBar);

    // ---- 图层开关 ----
    const push = (): void => { if (!syncing) void pushConfig(); };
    const cbSub = ui.checkbox('字幕', { onChange: push });
    const cbCue = ui.checkbox('动作气泡', { onChange: push });
    const cbDan = ui.checkbox('弹幕', { onChange: push });
    const layerBar = ui.rowbar();
    layerBar.append(cbSub.el, cbCue.el, cbDan.el, msg, ui.h('span', 'grow'));
    card.body.append(ui.section('图层'), layerBar);

    // ---- 字幕样式 ----
    const fScale = numField(ctx, { value: 1, min: 0.5, max: 2.5, step: 0.05, onChange: push });
    const fWeight = ui.select({ options: WEIGHTS, onInput: push });
    const fLines = numField(ctx, { value: 2, min: 1, max: 8, cls: 'vt-num sm', onChange: push });
    const fColor = colorField(ctx, '#fffef8', push);
    const fStrokeW = numField(ctx, { value: 1, min: 0, max: 4, step: 0.5, cls: 'vt-num sm', onChange: push });
    const fStrokeC = colorField(ctx, '#000000', push);
    const fPlate = numField(ctx, { value: 0, min: 0, max: 0.85, step: 0.05, cls: 'vt-num sm', onChange: push });
    const fFont = ui.input({
      placeholder: '字体名(装在 OBS 机器上的,留空默认)',
      cls: 'grow',
      onChange: push,
    });

    const styleBar1 = ui.rowbar();
    styleBar1.classList.add('vt-wrap');
    styleBar1.append(
      ui.field('字号 ×', fScale),
      ui.field('粗细', fWeight),
      ui.field('最大行数', fLines),
    );
    const styleBar2 = ui.rowbar();
    styleBar2.classList.add('vt-wrap');
    styleBar2.append(
      ui.field('字色', fColor),
      ui.field('描边', fStrokeW),
      ui.field('描边色', fStrokeC),
      ui.field('底板', fPlate),
      ui.field('字体', fFont),
    );
    card.body.append(ui.section('字幕样式'), styleBar1, styleBar2);

    // ---- 试显 / 预览 ----
    const btnPreview = ui.button('预览窗口', { size: 'sm', onClick: () => togglePreview() });
    const demoBar = ui.rowbar();
    for (const [kind, label] of [
      ['subtitle', '试显字幕'],
      ['cue', '试显动作提示'],
      ['danmaku', '试飘弹幕'],
    ] as const) {
      const btn = ui.button(label, { size: 'sm', onClick: () => { void demo(kind, btn); } });
      demoBar.appendChild(btn);
    }
    demoBar.append(ui.h('span', 'grow'), btnPreview);
    card.body.append(ui.section('试显与预览'), demoBar);

    // 预览:按需加载的 iframe(?bg=dim 给暗背景;正式合成不带这个参数)
    const previewWrap = ui.h('div', 'vt-preview');
    const previewFrame = ui.h('iframe', 'vt-previewframe');
    previewWrap.appendChild(previewFrame);
    card.body.appendChild(previewWrap);
    // 卸载时先摘 src 再移除:光移除节点的话那份文档可能还挂着 SSE 订阅继续跑
    ctx.own(toDisposable(() => {
      previewFrame.removeAttribute('src');
      previewFrame.remove();
    }));

    ctx.root.appendChild(card.el);

    function togglePreview(): void {
      if (!overlayUrl) return;
      const showing = previewWrap.classList.contains('on');
      if (showing) {
        previewWrap.classList.remove('on');
        previewFrame.removeAttribute('src');
        btnPreview.textContent = '预览窗口';
      } else {
        previewFrame.src = overlayUrl + (overlayUrl.includes('?') ? '&' : '?') + 'bg=dim';
        previewWrap.classList.add('on');
        btnPreview.textContent = '收起预览';
      }
    }

    function renderState(st: OverlayState): void {
      overlayUrl = st.url ?? null;
      urlBox.value = overlayUrl ?? '(演出流未启动)';
      btnCopy.disabled = btnOpen.disabled = btnPreview.disabled = !overlayUrl;
      const c = st.config;
      const sub = c.subtitle;
      syncing = true;
      cbSub.setChecked(c.subtitles !== false);
      cbCue.setChecked(c.cues !== false);
      cbDan.setChecked(c.danmaku !== false);
      fScale.value = String(sub.scale);
      fWeight.value = String(sub.weight);
      fLines.value = String(sub.maxLines);
      fColor.value = sub.color;
      fStrokeW.value = String(sub.strokeW);
      fStrokeC.value = sub.strokeColor;
      fPlate.value = String(sub.plate);
      fFont.value = sub.fontFamily;
      syncing = false;
      // 演出流没起来的时候预览也开不了:此刻若正开着,收回去
      if (!overlayUrl && previewWrap.classList.contains('on')) togglePreviewOff();
    }

    function togglePreviewOff(): void {
      previewWrap.classList.remove('on');
      previewFrame.removeAttribute('src');
      btnPreview.textContent = '预览窗口';
    }

    /** 表单当前值 → 一份配置补丁。钳制归服务端,这里只负责如实读出来。 */
    function formConfig(): OverlayConfig {
      return {
        subtitles: cbSub.checked,
        cues: cbCue.checked,
        danmaku: cbDan.checked,
        subtitle: {
          scale: Number(fScale.value),
          weight: Number(fWeight.value),
          maxLines: Number(fLines.value),
          color: fColor.value,
          strokeW: Number(fStrokeW.value),
          strokeColor: fStrokeC.value,
          plate: Number(fPlate.value),
          fontFamily: fFont.value,
        },
      };
    }

    async function pushConfig(): Promise<void> {
      try {
        const out = await ctx.invoke<{ config: OverlayConfig; message: string }>(
          'setConfig',
          [formConfig()],
        );
        if (ctx.signal.aborted) return;
        say(out.message || '已生效');
        // 回填服务端钳制后的生效值(比如字号超界会被拉回来)
        renderState({ url: overlayUrl, streamUp: !!overlayUrl, config: out.config });
      } catch (err) {
        if (ctx.signal.aborted) return;
        say(`保存失败: ${errText(err)}`, true);
      }
    }

    async function demo(kind: 'subtitle' | 'cue' | 'danmaku', btn: HTMLButtonElement): Promise<void> {
      const off = ui.disable(btn);
      try {
        const out = await ctx.invoke<{ result?: string }>('demo', [kind]);
        say(out.result || '已投递');
      } catch (err) {
        say(`试显失败: ${errText(err)}`, true);
      } finally {
        off.dispose();
      }
    }

    void (async () => {
      try {
        const st = await ctx.invoke<OverlayState>('state');
        if (ctx.signal.aborted) return;
        renderState(st);
      } catch (err) {
        if (ctx.signal.aborted) return;
        say(`overlay 状态拉不到: ${errText(err)}`, true);
      }
    })();
  },
};
