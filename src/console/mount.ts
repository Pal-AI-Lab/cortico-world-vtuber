/**
 * 挂载面板管理 VTS、TTS server 与演出流的状态和启停，由 mount.state 统一取数。
 * 轮询使用 ctx.interval，修改状态后调用 ctx.refresh 更新页头徽标。provider 各自打包，监听和轮询随面板卸载释放。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from 'cortico/web/shared/client-panel.ts';
import { errText, setMsg, type MountState, type TtsMountState, type VtsState } from './client.ts';

/** 等 TTS 权重加载的轮询:每 2 秒问一次,最多 90 拍(3 分钟) */
const TTS_POLL_MS = 2000;
const TTS_POLL_TICKS = 90;

/** managed 服务的本地进程阶段;external 服务不走这张表。 */
const TTS_TONE: Record<string, RowTone> = {
  running: 'on',
  starting: 'warn',
  error: 'off',
  stopped: 'off',
};
const TTS_WORD: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  error: '异常',
  stopped: '未启动',
};

type RowTone = 'on' | 'warn' | 'off' | 'plain';

interface MountRow {
  /** 这一行右侧放按钮的格子 */
  acts: HTMLElement;
  set(tone: RowTone, word: string, note?: string): void;
}

export const mountPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui } = ctx;
    const card = ui.sheet({
      title: '挂载',
      en: 'bring-up',
      desc: '开播前把这三条链路带起来。首次连 VTS 要在它的弹窗里点允许(之后记住 token)。',
    });

    const msg = ui.msgline('');
    const btnAll = ui.button('⏻ 一键挂载', { variant: 'primary' });
    const btnTest = ui.button('测试动作');
    const btnRefresh = ui.button('刷新', { size: 'sm' });
    const bar = ui.rowbar();
    bar.append(btnAll, btnTest, msg, ui.h('span', 'grow'), btnRefresh);
    card.body.appendChild(bar);

    const vtsRow = mountRow(ctx, card.body, '形象');
    const ttsRow = mountRow(ctx, card.body, '声音');
    const stageRow = mountRow(ctx, card.body, '演出流');

    const btnConn = ui.button('连接', { size: 'sm', variant: 'primary' });
    const btnDisc = ui.button('断开', { size: 'sm', variant: 'danger' });
    vtsRow.acts.append(btnDisc, btnConn);
    const btnStart = ui.button('启动', { size: 'sm', variant: 'primary' });
    const btnStop = ui.button('停止', { size: 'sm', variant: 'danger' });
    ttsRow.acts.append(btnStop, btnStart);

    const say = (text: string, bad = false): void => setMsg(msg, text, bad);

    /**
     * 「我改了自己的状态,请重取 manifest」——VTS / TTS 那两颗徽标画在页头上
     * (host 的地盘),面板够不着,只能说一声。面板已经卸了就别再叫醒 host。
     */
    const bumpBadges = async (): Promise<void> => {
      if (ctx.signal.aborted) return;
      await ctx.refresh();
    };

    const renderVts = (st: VtsState | null): void => {
      if (!st) {
        vtsRow.set('plain', '不可用');
        return;
      }
      vtsRow.set(
        st.connected ? 'on' : 'off',
        st.connected ? '已连接' : '未连接',
        [st.model ? st.model.name : null, st.url, st.tokenSet ? null : '未授权']
          .filter(Boolean)
          .join(' · '),
      );
      btnConn.disabled = st.connected;
      btnDisc.disabled = !st.connected;
      btnTest.disabled = !st.connected;
    };

    /**
     * 声音那行。external 服务没有本地进程可看可启停,`local` 为 null 不是错误:
     * 那一行只报当前服务名与「已应用 / 待应用」,启停按钮藏起来。
     */
    const renderTts = (st: TtsMountState | null): void => {
      if (!st) {
        ttsRow.set('plain', '不可用');
        return;
      }
      const revision = st.pendingApply ? '待应用' : '已应用';
      if (!st.managed || !st.local) {
        ttsRow.set(
          'plain',
          st.pendingApply ? '待应用' : '外部服务',
          [`服务 ${st.serviceName}`, st.protocol, revision, st.url].filter(Boolean).join(' · '),
        );
        btnStart.hidden = true;
        btnStop.hidden = true;
        return;
      }
      btnStart.hidden = false;
      btnStop.hidden = false;
      const res = st.local.resources;
      const missing = res
        ? [
            !res.server.ready ? '运行时' : '',
            !res.baseLm.ready ? 'BaseLM' : '',
            !res.acoustic.ready ? 'Acoustic' : '',
            res.alignerRequired && !res.alignerLm.ready ? 'Aligner LM' : '',
            res.alignerRequired && !res.alignerAudio.ready ? 'Aligner Audio' : '',
          ].filter(Boolean)
        : [];
      ttsRow.set(
        TTS_TONE[st.phase] ?? 'plain',
        TTS_WORD[st.phase] ?? st.phase,
        [
          st.serviceName,
          st.pid ? `pid ${st.pid}` : null,
          st.url,
          revision,
          missing.length ? `缺 ${missing.join(' / ')}` : null,
          st.detail,
        ].filter(Boolean).join(' · '),
      );
      btnStart.disabled = st.phase === 'starting' || st.phase === 'running';
      btnStop.disabled = st.phase === 'stopped' && !st.pid;
    };

    const renderStage = (stream: MountState['stream']): void => {
      if (!stream) {
        stageRow.set('plain', '不可用');
        return;
      }
      stageRow.set(
        stream.up ? 'on' : 'off',
        stream.up ? `已启动 ${portOf(stream.url)}`.trim() : '未启动',
        stream.up ? '订阅端:字幕/动作/弹幕' : '',
      );
    };

    /** 全量刷新。取数失败时三行一起落到"不可用",而不是留着上一屏的旧值。 */
    const refresh = async (): Promise<void> => {
      try {
        const st = await ctx.invoke<MountState>('state');
        if (ctx.signal.aborted) return;
        renderVts(st.vts);
        renderTts(st.tts);
        renderStage(st.stream);
      } catch (err) {
        if (ctx.signal.aborted) return;
        renderVts(null);
        renderTts(null);
        renderStage(null);
        say(`挂载状态拉不到: ${errText(err)}`, true);
      }
    };

    /**
     * 权重加载要一两分钟,轮到不再是 `starting` 为止。
     * 面板卸载时 promise 落在一句"面板已关闭"上,而不是永挂。
     */
    const waitTtsReady = (): Promise<string> =>
      new Promise<string>((resolve) => {
        let ticks = 0;
        let probing = false;
        let timer: { dispose(): void } | null = null;
        const done = (text: string): void => {
          timer?.dispose();
          resolve(text);
        };
        ctx.signal.addEventListener('abort', () => done('面板已关闭'), { once: true });
        timer = ctx.interval(() => {
          if (++ticks > TTS_POLL_TICKS) {
            done('[失败] 声音 启动超时');
            return;
          }
          if (probing) return; // 上一拍还没回来,不叠着发
          probing = true;
          void ctx.invoke<TtsMountState>('ttsState').then(
            (st) => {
              probing = false;
              renderTts(st);
              // 换成 external 服务后没有本地进程可等;那不算失败
              if (st.phase === 'starting') return;
              if (st.managed && st.local) done(st.phase === 'running' ? '声音就绪' : `[失败] 声音 ${st.detail || st.phase}`);
              else done(`声音切到 ${st.serviceName}`);
            },
            () => { probing = false; }, // 还没回来,下一拍再问
          );
        }, TTS_POLL_MS);
      });

    btnConn.addEventListener('click', () => {
      void (async () => {
        say('连接中…(VTS 弹窗时去点允许)');
        btnConn.disabled = true;
        try {
          const out = await ctx.invoke<{ connected: boolean; cleared?: string[] }>('vtsConnect');
          say(`已连接${out.cleared?.length ? `,复位了残留表情 ${out.cleared.length} 个` : ''}`);
        } catch (err) {
          say(`连接失败: ${errText(err)}`, true);
        } finally {
          await refresh();
          await bumpBadges();
        }
      })();
    }, { signal: ctx.signal });

    btnDisc.addEventListener('click', () => {
      void (async () => {
        say('');
        try {
          await ctx.invoke('vtsDisconnect');
          say('已断开');
        } catch (err) {
          say(`断开失败: ${errText(err)}`, true);
        } finally {
          await refresh();
          await bumpBadges();
        }
      })();
    }, { signal: ctx.signal });

    btnStart.addEventListener('click', () => {
      void (async () => {
        say('启动中…(首次要加载权重)');
        try {
          renderTts(await ctx.invoke<TtsMountState>('ttsStart'));
          say(await waitTtsReady());
        } catch (err) {
          say(`启动失败: ${errText(err)}`, true);
        } finally {
          await bumpBadges();
        }
      })();
    }, { signal: ctx.signal });

    btnStop.addEventListener('click', () => {
      void (async () => {
        say('');
        try {
          renderTts(await ctx.invoke<TtsMountState>('ttsStop'));
          say('已停止');
        } catch (err) {
          say(`停止失败: ${errText(err)}`, true);
        } finally {
          await bumpBadges();
        }
      })();
    }, { signal: ctx.signal });

    btnTest.addEventListener('click', () => {
      void (async () => {
        try {
          const out = await ctx.invoke<{ message?: string }>('vtsTest');
          say(out.message || 'OK');
        } catch (err) {
          say(`测试失败: ${errText(err)}`, true);
        }
      })();
    }, { signal: ctx.signal });

    btnRefresh.addEventListener('click', () => {
      say('');
      void refresh();
    }, { signal: ctx.signal });

    // 一键挂载:声音那头要加载权重,先踢起来;形象那头要人去点 VTS 弹窗,同时进行
    btnAll.addEventListener('click', () => {
      void (async () => {
        btnAll.disabled = true;
        say('挂载中…(VTS 弹窗时去点允许)');
        try {
          const st = await ctx.invoke<MountState>('state');
          // 外部服务没有本机进程可拉:那种情况下"挂载"这一半是空动作
          const ttsJob = !st.tts?.managed
            ? Promise.resolve(`声音用外部服务 ${st.tts?.serviceName ?? '(没有服务)'}`)
            : st.tts?.phase === 'running'
              ? Promise.resolve('声音已在运行')
              : ctx.invoke<TtsMountState>('ttsStart').then(waitTtsReady);
          const vtsJob = st.vts?.connected
            ? Promise.resolve('形象已连接')
            : ctx.invoke('vtsConnect').then(() => '形象已连接');
          const notes = await Promise.all([
            vtsJob.catch((err: unknown) => `[失败] 形象 ${errText(err)}`),
            ttsJob.catch((err: unknown) => `[失败] 声音 ${errText(err)}`),
          ]);
          await refresh();
          say(notes.join(' · '), notes.some((n) => n.startsWith('[失败]')));
        } catch (err) {
          say(`挂载失败: ${errText(err)}`, true);
        } finally {
          btnAll.disabled = false;
          await bumpBadges();
        }
      })();
    }, { signal: ctx.signal });

    ctx.root.appendChild(card.el);
    void refresh();
  },
};

/**
 * 一行 = 一条链路:状态灯 + 名字 + 状态词 + 细节 + 它自己的启停按钮。
 *
 * 样式在本 provider 的 `style.css` 里(`vt-` 前缀)。`ctx.ui` 没有对应原语:
 * 这是一张"若干条链路各自的启停"的表,`kv` 放不下按钮列,`table` 又要表头。
 */
function mountRow(ctx: ConsolePanelContext, parent: HTMLElement, name: string): MountRow {
  const { ui } = ctx;
  const el = ui.h('div', 'vt-mountrow');
  const dot = ui.h('span', 'vt-dot');
  const state = ui.h('span', 'vt-mstate', '—');
  const detail = ui.h('span', 'vt-mdetail');
  const acts = ui.h('span', 'vt-macts');
  el.append(dot, ui.h('span', 'vt-mname', name), state, detail, acts);
  parent.appendChild(el);
  return {
    acts,
    set(tone, word, note) {
      dot.className = tone === 'plain' ? 'vt-dot' : `vt-dot ${tone}`;
      state.className = tone === 'plain' ? 'vt-mstate' : `vt-mstate ${tone}`;
      state.textContent = word;
      detail.textContent = note ?? '';
      detail.title = note ?? ''; // 窄屏下这行会被省略号截掉
    },
  };
}

/** `http://127.0.0.1:7792/overlay` → `:7792`;认不出来就不显示端口。 */
function portOf(url: string | null): string {
  if (!url) return '';
  const m = /:(\d+)/.exec(url.replace(/^\w+:\/\//, ''));
  return m ? `:${m[1]}` : '';
}
