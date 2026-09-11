/**
 * 演出 overlay:订阅同源 /stream(SSE),渲染字幕(按 cue 时间轴)、动作标签
 * 气泡与弹幕。透明底;OBS browser source 指向的就是这一页。
 *
 * 样式与图层开关来自服务端配置(snapshot / overlay.config 事件),控制台改动
 * 实时生效。URL 参数可按订阅方覆盖图层:?subtitles=0&cues=0&danmaku=0;
 * ?bg=dim 给预览加暗背景(正式合成不带,保持透明)。
 */
(() => {
  const stageEl = document.getElementById('stage');
  const bubblesEl = document.getElementById('bubbles');
  const tagToastsEl = document.getElementById('tag-toasts');
  const danmakuLayer = document.getElementById('danmaku-layer');

  const params = new URLSearchParams(location.search);
  if (params.get('bg') === 'dim') document.body.classList.add('bg-dim');
  /** URL 覆盖:'0'/'false' 关,'1'/'true' 开,缺省 null = 跟服务端配置 */
  function paramFlag(name) {
    const v = params.get(name);
    if (v === null) return null;
    return !(v === '0' || v === 'false');
  }
  const layerOverride = {
    subtitles: paramFlag('subtitles'),
    cues: paramFlag('cues'),
    danmaku: paramFlag('danmaku'),
  };

  let cfg = {
    subtitles: true,
    cues: true,
    danmaku: true,
    subtitle: { scale: 1, weight: 400, maxLines: 2, color: '#fffef8', strokeColor: '#000000', strokeW: 1, plate: 0, fontFamily: '' },
  };

  function layerOn(name) {
    const o = layerOverride[name];
    return o === null ? !!cfg[name] : o;
  }

  function applyConfig(next) {
    if (!next || typeof next !== 'object') return;
    cfg = { ...cfg, ...next, subtitle: { ...cfg.subtitle, ...(next.subtitle || {}) } };
    const s = stageEl.style;
    const sub = cfg.subtitle;
    s.setProperty('--sub-scale', String(sub.scale));
    s.setProperty('--sub-weight', String(sub.weight));
    s.setProperty('--sub-color', sub.color);
    s.setProperty('--sub-stroke-color', sub.strokeColor);
    s.setProperty('--sub-stroke-w', String(sub.strokeW));
    s.setProperty('--sub-plate', String(sub.plate));
    if (sub.fontFamily) s.setProperty('--sub-font', sub.fontFamily + ", 'ZCOOL XiaoWei', 'Microsoft YaHei', sans-serif");
    else s.removeProperty('--sub-font');
    if (!layerOn('subtitles')) clearSubtitles();
    refitCurrent();
  }

  let cueTimers = [];
  let bubbleTimers = [];
  let revealTimers = [];

  function stopReveal() {
    for (const t of revealTimers) clearTimeout(t);
    revealTimers = [];
  }

  function clearSubtitles() {
    for (const t of cueTimers) clearTimeout(t);
    for (const t of bubbleTimers) clearTimeout(t);
    stopReveal();
    cueTimers = [];
    bubbleTimers = [];
    bubblesEl.replaceChildren();
  }

  /** 超过最大行数先二分缩字号(下限 55%),仍放不下才允许多行向上生长,不截断 */
  function fitSubtitle(body) {
    body.style.fontSize = '';
    const base = parseFloat(getComputedStyle(body).fontSize);
    body.style.maxWidth = Math.min(bubblesEl.clientWidth, base * 22) + 'px';
    const range = document.createRange();
    range.selectNodeContents(body);
    const lines = () => range.getClientRects().length;
    const maxLines = cfg.subtitle.maxLines || 2;
    if (lines() <= maxLines) return;
    let lo = base * 0.55;
    let hi = base;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      body.style.fontSize = mid + 'px';
      if (lines() <= maxLines) lo = mid;
      else hi = mid;
    }
    body.style.fontSize = lo + 'px';
  }

  function refitCurrent() {
    const body = bubblesEl.querySelector('.bubble .body');
    if (body) fitSubtitle(body);
  }

  /**
   * 上屏一条 cue。elapsedMs 是这条已经念到哪(重发的时间轴把正在念的那条带回来时
   * 不为 0):同一句已在屏上就原地续,不重建气泡;增量进度只前进不倒退。
   */
  function showBubble(text, holdMs, speakMs, elapsedMs) {
    for (const t of bubbleTimers) clearTimeout(t);
    bubbleTimers = [];
    stopReveal();
    const current = bubblesEl.querySelector('.bubble');
    let el = current && !current.classList.contains('out') && current.dataset.text === text ? current : null;
    let body;
    if (el) {
      body = el.querySelector('.body');
    } else {
      el = document.createElement('div');
      el.className = 'bubble';
      el.dataset.text = text;
      el.innerHTML = '<span class="body"></span>';
      body = el.querySelector('.body');
      // 先整句排版把字号定下来(避免增量过程中字号跳动),再清空按发声进度放字
      body.textContent = text;
      bubblesEl.replaceChildren(el);
      fitSubtitle(body);
    }
    // 增量跟播:字幕跟着嘴走,没念出来的字不上屏;被切断时 stopReveal 冻在当前前缀
    const cps = Array.from(text);
    const revealMs = Math.max(0, Number(speakMs) || 0);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    if (revealMs > 120 && cps.length > 1 && elapsed < revealMs) {
      const t0 = performance.now() - elapsed;
      let shown = el === current ? Array.from(body.textContent).length : 0;
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / revealMs);
        shown = Math.max(shown, Math.max(1, Math.round(cps.length * k)));
        body.textContent = cps.slice(0, shown).join('');
        if (k < 1) revealTimers.push(setTimeout(tick, 50));
      };
      tick();
    } else {
      body.textContent = text;
    }
    const hold = Math.max(400, holdMs);
    bubbleTimers.push(setTimeout(() => el.classList.add('out'), hold));
    bubbleTimers.push(setTimeout(() => { if (el.parentNode === bubblesEl) el.remove(); }, hold + 400));
  }

  /**
   * 收到一片的字幕时间轴:cue 的 atMs 相对本事件接收时刻,负值 = 这条已经念到 |atMs| 处,
   * 立即上屏并从那里续增量。同一片会多次收到(开播、播放中拿到更准的时间源时重发),
   * 每次都是仍在显示区间内的全部 cue:未触发的定时器全部清掉按新批重排。
   */
  function onSubtitle(msg) {
    if (!layerOn('subtitles')) return;
    for (const t of cueTimers) clearTimeout(t);
    cueTimers = [];
    const cues = Array.isArray(msg.cues) ? msg.cues : [];
    for (const cue of cues) {
      if (!cue || typeof cue.text !== 'string' || !cue.text) continue;
      const at = Number(cue.atMs) || 0;
      const dur = Math.max(400, Number(cue.durMs) || 1000);
      const speak = Number(cue.speakMs) || 0;
      if (at < 0) showBubble(cue.text, dur + at, speak, -at);
      else cueTimers.push(setTimeout(() => showBubble(cue.text, dur, speak, 0), at));
    }
  }

  /** 她被打断/音频被切:还没上屏的 cue 作废,增量冻在当前前缀,字幕提前淡出 */
  function onSubtitleCut() {
    for (const t of cueTimers) clearTimeout(t);
    cueTimers = [];
    stopReveal();
    const el = bubblesEl.querySelector('.bubble');
    if (!el) return;
    for (const t of bubbleTimers) clearTimeout(t);
    bubbleTimers = [];
    el.classList.add('out');
    setTimeout(() => { if (el.parentNode === bubblesEl) el.remove(); }, 400);
  }

  const TAG_TOAST_MAX = 6;
  const TAG_TOAST_HOLD_MS = 2600;
  const TAG_CHANNELS = ['gesture', 'pose', 'emotion', 'gaze', 'fx', 'reset'];

  function spawnTagToast(word, channel) {
    const el = document.createElement('div');
    el.className = 'tag-toast ch-' + (TAG_CHANNELS.includes(channel) ? channel : 'reset');
    el.innerHTML = '<span class="dot"></span><span class="word"></span>';
    el.querySelector('.word').textContent = word;
    tagToastsEl.appendChild(el);
    while (tagToastsEl.children.length > TAG_TOAST_MAX) tagToastsEl.firstChild.remove();
    setTimeout(() => el.classList.add('out'), TAG_TOAST_HOLD_MS);
    setTimeout(() => el.remove(), TAG_TOAST_HOLD_MS + 350);
  }

  function onCues(cues) {
    if (!layerOn('cues')) return;
    cues
      .filter((c) => c && typeof c.word === 'string' && c.word)
      .forEach((c, i) => setTimeout(() => spawnTagToast(c.word, c.channel), i * 120));
  }

  function spawnDanmaku(text, self) {
    if (!layerOn('danmaku')) return;
    const el = document.createElement('div');
    el.className = 'danmaku' + (self ? ' self' : '');
    el.textContent = text;
    el.style.top = 8 + Math.random() * 62 + '%';
    el.style.left = '100%';
    const dur = 7 + Math.random() * 5;
    el.style.animationDuration = dur + 's';
    danmakuLayer.appendChild(el);
    setTimeout(() => el.remove(), (dur + 0.2) * 1000);
  }

  const es = new EventSource(new URL('/stream', location.href).href);
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') { applyConfig(msg.overlay); return; }
    if (msg.type === 'overlay.config') { applyConfig(msg.config); return; }
    if (msg.type === 'subtitle') { onSubtitle(msg); return; }
    if (msg.type === 'subtitle.cut') { onSubtitleCut(); return; }
    if (msg.type === 'cue' && Array.isArray(msg.cues)) { onCues(msg.cues); return; }
    if (msg.type === 'danmaku') { spawnDanmaku(msg.text || '', !!msg.self); }
    // 不认识的事件类型一律忽略(演出流的前向兼容约定)
  };

  window.addEventListener('resize', refitCurrent);
})();
