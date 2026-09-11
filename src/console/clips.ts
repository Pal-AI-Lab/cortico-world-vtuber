/**
 * 面板 `clips` —— 动作调参:逐条试跳动作 / 姿态 / 表情 / 看向 / 特效。
 *
 * 改演出包(vtuber-pack/ 的 vocab.json 与 clips.json)后按「重载参数」即刻生效(从磁盘重读,失败则旧包保持)。
 * 点条目把单个 cue 直发进 VTS;姿态 / 表情 / 看向是保持型,试完按「回中性」撤掉。
 */

import type {
  ConsolePanelContext,
  ConsolePanelPlugin,
} from 'cortico/web/shared/client-plugin.ts';
import { errText, numField, setMsg, type ClipsItem, type ClipsState } from './client.ts';

export const clipsPanel: ConsolePanelPlugin = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({
      title: '动作调参',
      en: 'clips',
      desc: '改演出包 vocab.json / clips.json 后按「重载参数」即刻生效。点条目把单个 cue 直发进 VTS;'
        + '姿态 / 表情 / 看向是保持型,试完按「回中性」撤掉。',
    });

    const statBar = ui.rowbar();
    const groupsBox = ui.h('div');
    const warnBox = ui.h('div');
    const msg = ui.msgline('');
    const say = (text: string, bad = false): void => setMsg(msg, text, bad);

    // 幅度:试跳时的强度倍率(服务端夹在 0.1–1.5)
    const amp = numField(ctx, { value: 1, min: 0.1, max: 1.5, step: 0.1 });
    const btnReset = ui.button('回中性', { onClick: () => { void reset(); } });
    const btnReload = ui.button('↻ 重载参数', { variant: 'primary', onClick: () => { void reload(); } });
    const bar = ui.actions();
    bar.append(msg, ui.h('span', 'grow'), ui.field('幅度', amp), btnReset, btnReload);

    card.body.append(statBar, ui.section('动作词表'), groupsBox, warnBox, bar);
    ctx.root.appendChild(card.el);

    const trigger = async (item: ClipsItem): Promise<void> => {
      try {
        const out = await ctx.invoke<{ message?: string }>(
          'trigger',
          [item.kind, item.clipId, Number(amp.value) || 1],
        );
        const text = out.message ?? 'OK';
        say(text, text.startsWith('[失败]'));
      } catch (err) {
        say(`试跳失败: ${errText(err)}`, true);
      }
    };

    const renderGroups = (st: ClipsState): void => {
      groupsBox.replaceChildren();
      statBar.replaceChildren();
      const total = st.groups.reduce((n, g) => n + g.items.length, 0);
      statBar.append(
        ui.chip(`${total} 个 cue`),
        ui.pill(st.vtsConnected ? 'VTS 已连' : 'VTS 未连', st.vtsConnected ? 'on' : 'off'),
        ui.chip(st.file),
        ui.h('span', 'grow'),
      );
      if (!st.vtsConnected) {
        groupsBox.appendChild(ui.msgline('⚠ VTS 未连接,试跳看不到效果;先在「挂载」里连上。'));
      }
      for (const g of st.groups) {
        const row = ui.rowbar();
        row.classList.add('vt-wrap');
        row.appendChild(ui.pill(g.label, 'plain'));
        for (const item of g.items) {
          const dur = item.durationMs ? ` ${(item.durationMs / 1000).toFixed(1)}s` : '';
          const btn = ui.button(item.word + dur, {
            size: 'sm',
            onClick: () => { void trigger(item); },
          });
          btn.title = item.clipId;
          row.appendChild(btn);
        }
        groupsBox.appendChild(row);
      }
    };

    const refresh = async (): Promise<void> => {
      try {
        const st = await ctx.invoke<ClipsState>('state');
        if (ctx.signal.aborted) return;
        renderGroups(st);
      } catch (err) {
        if (ctx.signal.aborted) return;
        statBar.replaceChildren();
        groupsBox.replaceChildren(ui.placeholder(`动作调参不可用: ${errText(err)}`));
      }
    };

    async function reload(): Promise<void> {
      const off = ui.disable(btnReload, btnReset);
      warnBox.replaceChildren();
      say('重载中…');
      try {
        const out = await ctx.invoke<{ ok: boolean; message: string; warnings: string[] }>('reload');
        say(out.message || 'OK', !out.ok);
        for (const w of out.warnings ?? []) warnBox.appendChild(ui.msgline(`⚠ ${w}`, true));
        await refresh();
      } catch (err) {
        say(`重载失败: ${errText(err)}`, true);
      } finally {
        off.dispose();
      }
    }

    async function reset(): Promise<void> {
      try {
        const out = await ctx.invoke<{ message?: string }>('reset');
        say(out.message ?? 'OK');
      } catch (err) {
        say(`复位失败: ${errText(err)}`, true);
      }
    }

    void refresh();
  },
};
