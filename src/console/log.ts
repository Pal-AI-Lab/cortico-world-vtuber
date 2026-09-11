/**
 * 演出日志面板展示轮、拍、TTS、音频回执、状态 cue、模式与打断。
 * ctx.ui.log 负责追加、尾部粘滞与容量上限，ctx.interval 负责随面板卸载停止轮询；entries 以 after 游标增量读取。
 */

import type {
  ConsoleLogTone,
  ConsolePanelContext,
  ConsolePanelPlugin,
} from 'cortico/web/shared/client-plugin.ts';
import { errText, type PerfLogEntry } from './client.ts';

const POLL_MS = 2000;
/** 环形上限。模组那侧的事件环也是这个量级,再多留也拿不到。 */
const MAX_LINES = 500;

export const logPanel: ConsolePanelPlugin = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({
      title: '演出日志',
      en: 'perf log',
      desc: '轮 / 拍 / TTS / 音频回执 / 状态 cue / 模式 / 打断。同步打进运行日志与终端;'
        + `这里只留最近 ${MAX_LINES} 条。`,
    });

    const count = ui.chip('0 条');
    const area = ui.chip('—');
    const btnEnd = ui.button('回到底部', {
      size: 'sm',
      onClick: () => view.scrollToEnd(),
    });
    const bar = ui.rowbar();
    const err = ui.msgline('');
    bar.append(count, area, err, ui.h('span', 'grow'), btnEnd);

    const view = ui.log({
      max: MAX_LINES,
      maxHeight: '300px',
      empty: '(等待日志…)',
    });

    card.body.append(bar, view.el);
    ctx.root.appendChild(card.el);

    let lastSeq = 0;
    let polling = false;

    const tick = (): void => {
      if (polling) return; // 上一拍还没回来,不叠着发
      polling = true;
      void ctx.invoke<{ entries: PerfLogEntry[] }>('entries', [lastSeq]).then(
        (out) => {
          polling = false;
          if (ctx.signal.aborted) return;
          err.textContent = '';
          err.classList.remove('bad');
          const entries = out.entries ?? [];
          if (entries.length === 0) return;
          for (const e of entries) {
            lastSeq = Math.max(lastSeq, e.seq);
            view.append(`[${e.ts}] ${e.area} | ${e.msg}`, toneOf(e));
          }
          count.textContent = `${view.count} 条`;
          area.textContent = entries[entries.length - 1].area;
        },
        (e: unknown) => {
          polling = false;
          if (ctx.signal.aborted) return;
          // 一次抖动不该把已经收到的日志洗掉,只标一行,下一拍照常再问
          err.textContent = `拉取失败: ${errText(e)}`;
          err.classList.add('bad');
        },
      );
    };

    ctx.interval(tick, POLL_MS);
    tick();
  },
};

/**
 * 一行的配色。模组自己在出问题的那些行文首打了 `⚠`(注入报错、对齐退化、
 * 重载失败),这里不另作判断,只把那个既有标记翻译成 `warn` 配色。
 */
function toneOf(e: PerfLogEntry): ConsoleLogTone {
  return e.msg.startsWith('⚠') ? 'warn' : 'plain';
}
