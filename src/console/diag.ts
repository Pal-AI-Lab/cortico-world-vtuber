/**
 * 面板 `diag` —— 演出诊断:选个台本走真实演出链路(TTS 出声在声卡,动作打进 VTS),
 * 加上分层归因与逐帧录制导出。
 *
 * 给的是可复算的数字:每参数的动态范围、每层峰值贡献、最大跳变排行及归因、真实
 * 注入帧率与丢帧率。报表每 5 秒自动覆盖写进 `data/vtuber-diag/latest.json`。
 *
 * 完整 JSON 报表从 `<details>` 改成 `ui.drawer`(点一下摊开一层浮层):
 * 那本来就是"看一眼大的"这个需求,而抽屉的关闭语义与生命周期已经在原语里做对了
 * (Esc / 点遮罩 / 面板卸载都收)。顺手给它配一颗 `copyButton`——报表最常见的
 * 去处是粘进别处对比。
 */

import type {
  ConsolePanelContext,
  ConsolePanelPlugin,
} from '../../web/shared/client-plugin.ts';
import {
  delay,
  errText,
  numField,
  setMsg,
  type DiagJump,
  type DiagReport,
  type DiagState,
} from './client.ts';

/** 录制提前这么久启动,好把演出的起势也框进去 */
const RECORD_LEAD_MS = 300;

interface Preset {
  label: string;
  script: string;
}

export const diagPanel: ConsolePanelPlugin = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({
      title: '演出诊断',
      en: 'diagnostics',
      desc: '选个台本走真实演出链路:TTS 出声在声卡,动作打进 VTS。查跳变从「录制并演出」开始,'
        + '它把整段演出连同 VTS 对拍读回录进同一份文件。',
    });

    let presets: Preset[] = [];
    let report: DiagReport | null = null;

    // ---- 台本演出 ----
    const sel = ui.select({
      onInput: (v) => {
        const p = presets[Number(v)];
        if (p) script.value = p.script;
      },
    });
    const script = ui.textarea({ rows: 3 });
    const performMsg = ui.msgline('');
    const sayPerform = (text: string, bad = false): void => setMsg(performMsg, text, bad);
    const btnPerform = ui.button('演出', { onClick: () => { void doPerform(); } });
    const btnRecPerform = ui.button('⏺ 录制并演出', {
      variant: 'primary',
      onClick: () => { void doRecordAndPerform(); },
    });
    const performBar = ui.actions();
    performBar.append(performMsg, ui.h('span', 'grow'), btnPerform, btnRecPerform);

    // ---- 报表 ----
    const statBox = ui.h('div');
    const msg = ui.msgline('');
    const say = (text: string, bad = false): void => setMsg(msg, text, bad);
    const secs = numField(ctx, { value: 25, min: 1, max: 30, cls: 'vt-num sm' });
    const btnRefresh = ui.button('刷新', { onClick: () => { void load(); } });
    const btnRec = ui.button('仅录制', { onClick: () => { void doRecord(); } });
    const btnRaw = ui.button('完整报表 JSON', {
      size: 'sm',
      onClick: () => {
        const body = ui.h('div');
        const tools = ui.rowbar();
        tools.append(ui.h('span', 'grow'), ui.copyButton(() => reportJson()));
        const pre = ui.h('pre', 'mono', reportJson());
        body.append(tools, pre);
        ui.drawer('完整报表 JSON', body);
      },
    });
    const bar = ui.actions();
    bar.append(ui.field('录制秒数', secs), msg, ui.h('span', 'grow'), btnRaw, btnRefresh, btnRec);

    card.body.append(
      ui.section('台本演出'),
      sel,
      script,
      performBar,
      ui.section('诊断报表'),
      statBox,
      bar,
    );
    ctx.root.appendChild(card.el);

    const reportJson = (): string => JSON.stringify(report ?? {}, null, 1);
    const recordSpanMs = (): number =>
      Math.max(1, Math.min(30, Number(secs.value) || 25)) * 1000;

    // ---- 取数 ----

    void (async () => {
      try {
        const out = await ctx.invoke<{ presets: Preset[] }>('presets');
        if (ctx.signal.aborted) return;
        presets = out.presets ?? [];
        sel.replaceChildren();
        presets.forEach((p, i) => {
          const opt = ui.h('option', null, p.label);
          opt.value = String(i);
          sel.appendChild(opt);
        });
        if (presets.length > 0) script.value = presets[0].script;
      } catch (err) {
        if (ctx.signal.aborted) return;
        sayPerform(`演出不可用: ${errText(err)}`, true);
      }
    })();

    async function load(): Promise<void> {
      try {
        const out = await ctx.invoke<DiagState>('state');
        if (ctx.signal.aborted) return;
        report = out.report ?? {};
        renderSummary(report);
        const dir = out.state?.dir;
        say(dir
          ? `自动写盘:${dir}/latest.json(每 ${out.state.autoDumpSec} 秒)`
          : '未配置落盘目录');
      } catch (err) {
        if (ctx.signal.aborted) return;
        say(errText(err), true);
      }
    }

    function renderSummary(rep: DiagReport): void {
      const w = rep.window ?? {};
      const inj = rep.inject ?? {};
      const rows: Array<{ k: string; v: string }> = [
        { k: '求值 / 注入', v: `${w.evalHz ?? '-'} Hz  /  ${inj.sentHz ?? '-'} Hz` },
        { k: '丢帧', v: `${inj.dropPct ?? 0}%  (${inj.droppedBusy ?? 0} 帧)` },
      ];
      if (inj.rejectedParams?.length) {
        rows.push({ k: '实机没有的参数', v: inj.rejectedParams.join('、') });
      }
      const p = rep.state?.performer;
      if (p?.mode) {
        rows.push({ k: '模式 / 排队 / 说话', v: `${p.mode} / ${p.queuedBeats ?? 0} 拍 / ${p.playing ? '是' : '否'}` });
      }
      const ss = p?.states ?? {};
      if (ss.pose !== undefined) {
        rows.push({
          k: 'pose / emotion / gaze',
          v: [ss.pose, ss.emotion, ss.gaze].map((v) => v ?? '-').join(' , ')
            + '   剩余 '
            + [ss.poseLeftMs, ss.emotionLeftMs, ss.gazeLeftMs]
              .map((v) => (v == null ? '-' : `${v}ms`))
              .join(' , '),
        });
      }
      // 跳变最大的几个参数,直接把元凶层摆出来
      const jumps: Array<{ name: string; j: DiagJump }> = [];
      for (const [name, d] of Object.entries(rep.params ?? {})) {
        for (const j of d.jumps ?? []) jumps.push({ name, j });
      }
      jumps.sort((a, b) => Math.abs(b.j.delta) - Math.abs(a.j.delta));
      for (const { name, j } of jumps.slice(0, 4)) {
        const blame = Object.entries(j.dBy ?? {})
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
        rows.push({
          k: `跳变 ${name}`,
          v: `${j.from} → ${j.to}  (Δ${j.delta} / ${j.dtMs}ms)`
            + (blame ? `  元凶层 ${blame[0]} ${blame[1] > 0 ? '+' : ''}${blame[1]}` : '')
            + (j.duck ? `  duck ${j.duck[0]}→${j.duck[1]}` : ''),
        });
      }

      statBox.replaceChildren(
        ui.statgrid([
          { k: '注入', v: String(inj.sentHz ?? '-'), unit: 'Hz' },
          { k: '丢帧', v: `${inj.dropPct ?? 0}%`, accent: (inj.dropPct ?? 0) > 10 },
        ]),
        ui.kv(rows),
      );
    }

    // ---- 动作 ----

    async function perform(): Promise<string> {
      const out = await ctx.invoke<{ message?: string }>('perform', [script.value]);
      return out.message || 'OK';
    }

    async function doPerform(): Promise<void> {
      sayPerform('');
      try {
        sayPerform(await perform());
      } catch (err) {
        sayPerform(`演出失败: ${errText(err)}`, true);
      }
    }

    async function doRecordAndPerform(): Promise<void> {
      const ms = recordSpanMs();
      const off = ui.disable(btnPerform, btnRecPerform, btnRec);
      sayPerform(`录制 ${ms / 1000}s + 演出中…`);
      try {
        // 录制先起 300ms 以覆盖演出起势;两项并行,等录制回来再读报表
        const recording = ctx.invoke<{ result?: { message?: string } }>('record', [ms]);
        await delay(ctx, RECORD_LEAD_MS);
        const note = await perform();
        const out = await recording;
        sayPerform(`${out.result?.message ?? '已导出'}  |  ${note}`);
        await load();
      } catch (err) {
        sayPerform(`录制演出失败: ${errText(err)}`, true);
      } finally {
        off.dispose();
      }
    }

    async function doRecord(): Promise<void> {
      const ms = recordSpanMs();
      const off = ui.disable(btnPerform, btnRecPerform, btnRec);
      say('录制中…');
      try {
        const out = await ctx.invoke<{ result?: { message?: string } }>('record', [ms]);
        say(out.result?.message ?? '已导出');
        await load();
      } catch (err) {
        say(errText(err), true);
      } finally {
        off.dispose();
      }
    }

    void load();
  },
};
