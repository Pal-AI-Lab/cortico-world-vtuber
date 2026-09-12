/**
 * 模型档案面板管理 Live2D 演出资产的接线换算、只读复检与逐参数自检。档案位于模型目录的 cortico.profile.json，编写规则见 models/LIVE2D-ADAPTATION.md。
 * 换档通过 ctx.invoke("setProfile", [value]) 交由 World 写回，不直接调用通用配置端点。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { errText, setMsg, type ModelState, type WiringReport } from './client.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 目录选择键上那枚「打开的文件夹」。形状与描边与控制台图标集里的 `folder-open`
 * 一致,两颗路径选择键并排时不会一眼看出是两套画法。
 *
 * 包内自带而不从 `cortico/web/client/ui/icons.ts` 取:浏览器侧只允许 `import type`
 * 框架,框架的前端代码不随本包发布。
 */
function folderOpenIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) svg.setAttribute(key, value);
  svg.classList.add('icon');
  for (const d of ['M3 6h6l2 2h10', 'M3 6v13h15l3-8H6l-3 8']) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const HOW_TEXT: Record<string, string> = {
  configured: '配置指定',
  matched: '按模型名匹配',
  fallback: '未识别 · 默认档案',
  missing: '配置指定的档案不存在',
};

export const modelPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({
      title: '模型档案',
      en: 'model profile',
      desc: '同一套演出资产接不同 Live2D 模型时的接线换算表:头部转多少度、眼睑「正常睁眼」是多少输入量、'
        + '左右眉是不是共用一路,每个模型作者的接法都不同。词表与动作曲线不随模型变,只有这张表换。'
        + '档案放在 VTS 模型目录里的 cortico.profile.json,写法见 models/LIVE2D-ADAPTATION.md。',
    });

    const head = ui.h('div');
    const gapBox = ui.h('div');
    const fileBox = ui.h('div');
    const reportBox = ui.h('div');
    const live2dPath = ui.h('span', 'mono');
    const packPath = ui.h('span', 'mono');
    const msg = ui.msgline('');
    const say = (text: string, bad = false): void => setMsg(msg, text, bad);

    const sel = ui.select({
      onInput: (value) => { void switchProfile(value); },
    });
    const btnCheck = ui.button('接线自检');
    const btnLive2d = ui.button('', {
      size: 'sm',
      onClick: () => {
        const off = ui.disable(btnLive2d);
        void ctx.pickPath({
          kind: 'directory',
          title: '选择 VTube Studio 的 Live2DModels 目录',
          currentPath: current?.live2dDir || undefined,
          recommendedDir: 'C:/Program Files (x86)/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels',
        }).then(async (selected) => {
          if (!selected || ctx.signal.aborted) return;
          await ctx.setConfig('world:vtuber', { 'worlds.vtuber.live2dDir': selected });
          live2dPath.textContent = selected;
          say('模型目录已保存');
          await refresh();
        }).catch((err: unknown) => {
          if (!ctx.signal.aborted) say(`目录保存失败: ${errText(err)}`, true);
        }).finally(() => off.dispose());
      },
    });
    const btnPack = ui.button('', {
      size: 'sm',
      onClick: () => {
        const off = ui.disable(btnPack);
        void ctx.pickPath({
          kind: 'directory',
          title: '选择演出包目录(params.json + vocab.json + clips.json)',
          currentPath: current?.packDir || undefined,
        }).then(async (selected) => {
          if (!selected || ctx.signal.aborted) return;
          await ctx.setConfig('world:vtuber', { 'worlds.vtuber.packDir': selected });
          packPath.textContent = selected;
          say('演出包目录已保存,重启后生效');
        }).catch((err: unknown) => {
          if (!ctx.signal.aborted) say(`目录保存失败: ${errText(err)}`, true);
        }).finally(() => off.dispose());
      },
    });
    btnPack.className += ' pathpick';
    btnPack.title = '选择演出包目录';
    btnPack.setAttribute('aria-label', btnPack.title);
    btnPack.appendChild(folderOpenIcon(btnPack.ownerDocument));
    const packBar = ui.rowbar();
    packBar.append(packPath, ui.h('span', 'grow'), btnPack);
    btnLive2d.className += ' pathpick';
    btnLive2d.title = '选择 VTube Studio 的 Live2DModels 目录';
    btnLive2d.setAttribute('aria-label', btnLive2d.title);
    btnLive2d.appendChild(folderOpenIcon(btnLive2d.ownerDocument));
    const pickBar = ui.rowbar();
    pickBar.append(ui.pill('档案', 'plain'), sel, msg, ui.h('span', 'grow'), btnCheck);
    const live2dBar = ui.rowbar();
    live2dBar.append(live2dPath, ui.h('span', 'grow'), btnLive2d);

    card.body.append(
      head,
      ui.section('档案与接线'),
      pickBar,
      ui.field('模型目录', live2dBar),
      ui.field('演出包', packBar),
      gapBox,
      ui.section('档案复检'),
      fileBox,
      ui.section('自检结果'),
      reportBox,
    );
    ctx.root.appendChild(card.el);

    /** 下拉里那一项的完整文案(切换成功后回显用) */
    const labelOf = (st: ModelState, value: string): string => {
      const c = st.choices.find((x) => x.value === value);
      return c ? c.label : value;
    };

    let current: ModelState | null = null;

    const renderHead = (st: ModelState): void => {
      head.replaceChildren();
      const row = ui.rowbar();
      row.classList.add('vt-wrap');
      // 显示 VTS 当前加载的模型,供档案匹配核对
      const live = st.vtsModelName || (st.vtsConnected ? '未加载模型' : 'VTS 未连接');
      row.append(
        ui.pill('VTS 侧', 'plain'),
        ui.chip(live),
        ui.pill('生效', st.how === 'fallback' || st.how === 'missing' ? 'off' : 'on'),
        ui.chip(`${st.activeLabel}(${HOW_TEXT[st.how] ?? st.how})`),
      );
      head.appendChild(row);
    };

    const renderChoices = (st: ModelState): void => {
      sel.replaceChildren();
      for (const c of st.choices) {
        const opt = ui.h(
          'option',
          null,
          c.label
            + (c.vtsModelName ? `(${c.vtsModelName})` : '')
            // 和 VTS 侧对齐:实机加载的就是这个模型时标出来
            + (c.vtsModelName && c.vtsModelName === st.vtsModelName ? ' ← 实机' : ''),
        );
        opt.value = c.value;
        sel.appendChild(opt);
      }
      sel.value = st.configured;
    };

    const renderGaps = (st: ModelState): void => {
      gapBox.replaceChildren();
      if (st.caveat) gapBox.appendChild(ui.msgline(`⚠ ${st.caveat}`, true));
      if (st.unsupported.length) {
        gapBox.appendChild(ui.msgline(
          `这个模型演不出来的参数:${st.unsupported.join('、')}`
          + '(注入端丢弃并提醒一次;词表不变,她照样能说这些词)',
        ));
      }
    };

    const renderFile = (st: ModelState): void => {
      fileBox.replaceChildren();
      if (st.how === 'missing') {
        fileBox.appendChild(ui.msgline(
          `配置里的档案「${st.configured}」在模型目录下找不到;现在用的是 ${st.activeLabel}。`,
          true,
        ));
      }
      for (const e of st.registryErrors) fileBox.appendChild(ui.msgline(`✗ ${e.file}:${e.message}`, true));
      if (!st.profileFile) {
        if (st.registryErrors.length === 0 && st.how !== 'missing') {
          fileBox.appendChild(ui.msgline('默认档案,没有可复检的文件。给这个模型写一份 cortico.profile.json。'));
        }
        return;
      }
      const path = ui.h('div', 'mono');
      path.textContent = st.profileFile;
      fileBox.appendChild(path);
      for (const w of st.profileWarnings) fileBox.appendChild(ui.msgline(`⚠ 档案与演出包:${w}`, true));
      const mf = st.modelFile;
      if (!mf) return;
      if (mf.warnings.length === 0) {
        fileBox.appendChild(ui.msgline('✓ 档案与模型文件对得上:模型名、表情文件、idle 眨眼、平滑值'));
        return;
      }
      for (const w of mf.warnings) fileBox.appendChild(ui.msgline(`⚠ ${w}`, true));
    };

    const renderReport = (rep: WiringReport | null): void => {
      reportBox.replaceChildren();
      if (!rep) return;
      const table = ui.table({ head: ['参数', '接到', '斜率', '缺了会失去'] });
      for (const row of rep.rows ?? []) {
        const ok = row.status === 'bound';
        const hits = row.hits ?? [];
        table.addRow([
          `${ok ? '✓ ' : '✗ '}${row.id}`,
          ok
            ? hits.map((x) => x.param).join(', ')
            : row.status === 'no-input' ? 'VTS 无此输入参数' : '接线断开',
          { text: ok ? hits.map((x) => `×${x.gain.toFixed(3)}`).join(', ') : '—', cls: 'mono' },
          ok ? '' : { text: row.losesIfMissing, cls: 'bad' },
        ]);
      }
      reportBox.appendChild(table.el);
      reportBox.appendChild(ui.msgline(
        `模型「${rep.vtsModelName || '—'}」· ${((rep.elapsedMs ?? 0) / 1000).toFixed(1)}s`
        + (rep.dead?.length ? ` · 断开 ${rep.dead.join('、')}` : ' · 契约全部接上'),
      ));
    };

    const draw = (st: ModelState): void => {
      current = st;
      live2dPath.textContent = st.live2dDir || '(未设置)';
      packPath.textContent = st.packDir;
      renderHead(st);
      renderChoices(st);
      renderGaps(st);
      renderFile(st);
      renderReport(st.lastCheck);
    };

    const refresh = async (): Promise<void> => {
      try {
        const st = await ctx.invoke<ModelState>('state');
        if (ctx.signal.aborted) return;
        draw(st);
      } catch (err) {
        if (ctx.signal.aborted) return;
        head.replaceChildren(ui.placeholder(`模型档案不可用: ${errText(err)}`));
      }
    };

    async function switchProfile(value: string): Promise<void> {
      const before = current;
      say('切换中…');
      const off = ui.disable(sel, btnCheck);
      try {
        await ctx.invoke('setProfile', [value]);
        say(`已切换到 ${before ? labelOf(before, value) : value}`);
        await refresh();
      } catch (err) {
        say(`切换失败: ${errText(err)}`, true);
        // 服务端没收下:把下拉拨回原值,别让界面显示一个没生效的选择
        if (before) sel.value = before.configured;
      } finally {
        off.dispose();
      }
    }

    btnCheck.addEventListener('click', () => {
      void (async () => {
        const off = ui.disable(btnCheck, sel);
        say('自检中…逐个注入探针,约一分钟,期间形象会自己动');
        try {
          const out = await ctx.invoke<{ ok: boolean; message: string; report: WiringReport | null }>('selfCheck');
          say(out.message || 'OK', !out.ok);
          renderReport(out.report);
        } catch (err) {
          say(`自检失败: ${errText(err)}`, true);
        } finally {
          off.dispose();
        }
      })();
    }, { signal: ctx.signal });

    void refresh();
  },
};
