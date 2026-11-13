// ==UserScript==
// @name         B站稍后再看 · 播放量筛选
// @namespace    wlvf.mellie.local
// @version      0.2.1
// @description  在 B 站稍后再看列表按播放量阈值筛选卡片（隐藏/淡化双模式），仅在列表页运行、播放页不启动。判定恒为 ≥，默认阈值 10000、默认不启用，数据来自列表接口精确值。
// @author       结衣 & 梅莉
// @match        https://www.bilibili.com/watchlater/list*
// @match        https://www.bilibili.com/list/watchlater*
// @exclude      https://www.bilibili.com/watchlater/list*bvid*
// @exclude      https://www.bilibili.com/list/watchlater*bvid*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/ShirasawaYui/bilibili-watchlater-view-filter
// @supportURL   https://github.com/ShirasawaYui/bilibili-watchlater-view-filter/issues
// @downloadURL  https://github.com/ShirasawaYui/bilibili-watchlater-view-filter/raw/main/bilibili-watchlater-view-filter.user.js
// @updateURL    https://github.com/ShirasawaYui/bilibili-watchlater-view-filter/raw/main/bilibili-watchlater-view-filter.user.js
// ==/UserScript==
/*
 * 思路致谢（MIT，未复制其代码）：
 * - GF 541838「B站稍后观看时长统计助手」（特比欧炸）https://greasyfork.org/zh-CN/scripts/541838
 *   → @match 作用域与深色适配思路
 * - GF 438093「B站视频按播放数量过滤」（cakiihana）https://greasyfork.org/zh-CN/scripts/438093
 *   → 阈值输入 / localStorage 持久化 / 隐藏-淡化交互模式
 * 设计与验收：工作区《稍后再看播放量筛选_实施计划.md》
 *
 * 说明：
 * - @grant none 是刻意选择：脚本运行在页面上下文，fetch 才能带 B 站 cookie 完成跨域。
 * - 隐藏/淡化只增删自有 class（wlvf-hidden / wlvf-dim），绝不写内联 display，
 *   避免恢复时把 B 站自己用 v-show 隐藏的卡片一起放出来。
 * - v0.1.2：卡片选择器改为纯 class 匹配（不限标签），兼容「链接转换」类插件
 *   将 div.video-card--grid 改写为 <a> 的场景；bvidOf 优先读卡片自身 href。
 * - v0.2.0：面板新增亮色/深色切换按钮；双主题取自 B 站界面实色（页面底色
 *   微调一档作面板底 + 描边 + 投影，三层边界清晰），偏好持久化到 localStorage。
 * - v0.2.1：只在「稍后再看列表页」运行。B 站把连播播放页也放在 /list/watchlater
 *   下（?watchlater_cfg=…&oid=…&bvid=BV…），通配 @match 会把它一并匹配，导致面板
 *   挂到播放页右上、列表容器轮询与接口 fetch 全部空转。修复 = 元数据 @exclude
 *   在注入阶段挡掉 + 运行时 isWatchlaterListUrl 守卫 + SPA 路由监听进出时装卸。
 */

(function () {
  'use strict';

  // ========== 选择器常量（B 站改版时只改这里） ==========
  const SELECTORS = {
    section: 'section.watchlater-list-container',
    // 只按 class 匹配、不限标签：兼容链接转换插件把 div 改成 a 的情况
    card: '.video-card--grid',
    coverLink: 'a.bili-cover-card',
    // 降级路径：第一个 stat 块（播放量）；F6 实测其文本即播放量缩写
    firstStat: '.bili-cover-card__stats .bili-cover-card__stat',
  };

  const API_URL = 'https://api.bilibili.com/x/v2/history/toview';
  const LS_KEY = { threshold: 'wlvf.threshold', enabled: 'wlvf.enabled', mode: 'wlvf.mode', theme: 'wlvf.theme' };
  const DEFAULT_THRESHOLD = 10000;
  const CLS = { hide: 'wlvf-hidden', dim: 'wlvf-dim' };
  const INPUT_DEBOUNCE = 200;
  const APPLY_DEBOUNCE = 120;

  // ========== 状态 ==========
  const state = {
    viewMap: new Map(),   // bvid -> 精确播放量
    total: 0,             // 全量条数（接口）
    degraded: false,      // true = 接口不可用，走 DOM 缩写解析
    degradeReason: '',
    enabled: false,       // 默认不启用（Q2）
    mode: 'hide',         // 'hide' | 'dim'，默认隐藏（Q2）
    theme: 'light',       // 'light' | 'dark'，面板主题（v0.2.0，持久化）
    threshold: DEFAULT_THRESHOLD, // null = 不筛（清空输入时）
    peek: false,          // 临时显示全部（不改阈值）
    unmatched: 0,
    skipped: 0,           // BV 提取失败而跳过的卡片数
  };

  // ========== 生命周期句柄 ==========
  let active = false;        // 当前是否处于列表页（播放页为 false，不做任何工作）
  let sectionWaitTimer = 0;  // waitForSection 轮询句柄
  let inputTimer = 0;        // 阈值输入防抖句柄

  // ========== 纯函数（单测对象） ==========
  /** 严格全匹配解析播放量缩写："2.1万"→21000，"763"→763，"1.2亿"→1.2e8，拼接串/非法→NaN */
  function parseCount(s) {
    const m = String(s == null ? '' : s).trim().match(/^([\d.]+)\s*([万亿])?$/);
    if (!m) return NaN;
    const n = Number(m[1]);
    return m[2] === '亿' ? n * 1e8 : m[2] === '万' ? n * 1e4 : n;
  }
  /** 阈值输入："10000"/"1.5万"/"2亿" → 数值；空串 → null（不筛）；非法 → null */
  function parseThreshold(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return null;
    const v = parseCount(t);
    return Number.isFinite(v) ? v : null;
  }
  /** 判定恒为 ≥（Q1）：不达标 → false。NaN 交给调用方按「宁可漏筛」处理 */
  function passes(view, threshold) {
    return view >= threshold;
  }
  /** 是否为「稍后再看列表页」。播放页复用 /list/watchlater 路径但带 bvid/oid，必须排除 */
  function isWatchlaterListUrl(href) {
    const u = new URL(String(href || ''), 'https://www.bilibili.com/');
    const p = u.pathname.replace(/\/+$/, '');
    if (p !== '/watchlater/list' && p !== '/list/watchlater') return false;
    const q = u.searchParams;
    return !(q.has('bvid') || q.has('oid') || /bvid=/.test(u.hash));
  }

  // ========== 持久化 ==========
  function loadConfig() {
    try {
      const t = localStorage.getItem(LS_KEY.threshold);
      state.threshold = t === null ? DEFAULT_THRESHOLD : parseThreshold(t);
      state.enabled = localStorage.getItem(LS_KEY.enabled) === '1';
      state.mode = localStorage.getItem(LS_KEY.mode) === 'dim' ? 'dim' : 'hide';
      const themeSaved = localStorage.getItem(LS_KEY.theme);
      // 显式偏好优先；未设置时跟随系统主题
      state.theme = (themeSaved === 'dark' || themeSaved === 'light') ? themeSaved
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch (e) { /* localStorage 不可用则全走默认值 */ }
  }
  function saveConfig() {
    try {
      localStorage.setItem(LS_KEY.threshold, state.threshold == null ? '' : String(state.threshold));
      localStorage.setItem(LS_KEY.enabled, state.enabled ? '1' : '0');
      localStorage.setItem(LS_KEY.mode, state.mode);
      localStorage.setItem(LS_KEY.theme, state.theme);
    } catch (e) { /* 忽略 */ }
  }

  // ========== 数据层 ==========
  async function loadViewMap() {
    if (!active) return;
    setStatus('数据源：加载中 …');
    try {
      // 必须绝对地址：相对路径会打到 www 拿回 HTML（S0 实测教训）
      const r = await fetch(API_URL, { credentials: 'include' });
      const d = await r.json();
      if (d.code !== 0 || !d.data || !Array.isArray(d.data.list)) {
        throw new Error('toview 响应异常 code=' + (d && d.code));
      }
      const map = new Map();
      for (const it of d.data.list) {
        if (it.bvid && it.stat && typeof it.stat.view === 'number') {
          map.set(it.bvid, it.stat.view);
        }
      }
      state.viewMap = map;
      state.total = d.data.list.length;
      state.degraded = false;
      state.degradeReason = '';
    } catch (e) {
      state.degraded = true;
      state.degradeReason = String((e && e.message) || e);
      state.viewMap = new Map();
      // Q7 已定：面板黄色提示 + 控制台一行，不弹窗
      console.warn('[播放量筛选] 列表接口不可用，降级为卡片缩写解析（误差约 ±5%）：', state.degradeReason);
    }
    // fetch 期间可能已 SPA 切到播放页：此时不写状态、不重算
    if (!active) return;
    applyAll();
  }

  // ========== 卡片识别与过滤 ==========
  /** 从 href 提取 BV：兼容 ?bvid=BV… 和 /video/BV… 两种格式（Edge 与 Chrome 渲染路径不同） */
  function extractBv(href) {
    if (!href) return null;
    const m = href.match(/bvid=(BV[0-9A-Za-z]+)/) || href.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  }
  function bvidOf(card) {
    // 0. 卡片本身就是 <a>（链接转换插件把 div 改成 a 时）：直接取自身 href
    if (card.getAttribute) {
      const bv = extractBv(card.getAttribute('href'));
      if (bv) return bv;
    }
    // 1. 优先从 a.bili-cover-card 取；兼容它 href 格式差异
    const a = card.querySelector(SELECTORS.coverLink);
    if (a) {
      const bv = extractBv(a.getAttribute('href'));
      if (bv) return bv;
    }
    // 2. 兜底：扫卡片内所有 <a>，找第一个含 BV 的 href
    const links = card.querySelectorAll('a[href]');
    for (const link of links) {
      const bv = extractBv(link.getAttribute('href'));
      if (bv) return bv;
    }
    return null;
  }
  function viewOf(card, bvid) {
    if (state.degraded) {
      const st = card.querySelector(SELECTORS.firstStat);
      return st ? parseCount(st.textContent) : NaN;
    }
    return state.viewMap.has(bvid) ? state.viewMap.get(bvid) : NaN;
  }
  function clearCard(card) {
    card.classList.remove(CLS.hide, CLS.dim);
  }
  function markFiltered(card) {
    if (state.mode === 'dim') {
      card.classList.remove(CLS.hide);
      card.classList.add(CLS.dim);
    } else {
      card.classList.remove(CLS.dim);
      card.classList.add(CLS.hide);
    }
  }

  let applyTimer = 0;
  function scheduleApply() {
    // 节流：已有待执行的 applyAll 就不重置计时器，防止连续 class 变动把执行饿死
    if (applyTimer) return;
    applyTimer = setTimeout(() => { applyTimer = 0; applyAll(); }, APPLY_DEBOUNCE);
  }

  function applyAll() {
    if (!active) return;
    const section = document.querySelector(SELECTORS.section);
    if (!section) return;
    const cards = section.querySelectorAll(SELECTORS.card);
    const filtering = state.enabled && !state.peek && state.threshold != null;
    let hidden = 0;
    let unmatched = 0;
    let skipped = 0;
    for (const card of cards) {
      if (!filtering) { clearCard(card); continue; }
      const bv = bvidOf(card);
      if (!bv) {
        // BV 提不到（占位卡 / DOM 未就绪）：清掉残留 class，宁可漏筛不可误藏
        clearCard(card);
        skipped++;
        continue;
      }
      const v = viewOf(card, bv);
      if (!Number.isFinite(v)) {
        unmatched++;
        clearCard(card); // 宁可漏筛，不可误杀
        continue;
      }
      if (passes(v, state.threshold)) clearCard(card);
      else { markFiltered(card); hidden++; }
    }
    state.unmatched = unmatched;
    state.skipped = skipped;
    updateStatus({ rendered: cards.length, hidden });
  }

  // ========== 状态栏 ==========
  function updateStatus({ rendered, hidden }) {
    const st = document.getElementById('wlvf-status');
    const ds = document.getElementById('wlvf-source');
    if (!st || !ds) return;
    if (state.peek && state.enabled) {
      st.textContent = '临时显示全部 · 阈值未变';
    } else if (!state.enabled) {
      st.textContent = '已停用 · 全部还原';
    } else if (state.threshold == null) {
      st.textContent = '阈值为空 · 未筛选';
    } else {
      const verb = state.mode === 'dim' ? '已淡化' : '已隐藏';
      st.textContent = verb + ' ' + hidden + ' / 可见 ' + (rendered - hidden) + ' · 全量 ' + state.total;
    }
    if (state.degraded) {
      ds.textContent = '数据源：卡片缩写（精度受限）⚠ ' + state.degradeReason;
      ds.className = 'wlvf-warn';
    } else {
      ds.textContent = '数据源：接口精确值 ✓  未匹配 ' + state.unmatched +
        (state.skipped ? ' · 跳过 ' + state.skipped : '');
      ds.className = '';
    }
  }
  function setStatus(text) {
    const st = document.getElementById('wlvf-status');
    if (st) st.textContent = text;
  }

  // ========== UI ==========
  const CSS = [
    '.wlvf-hidden{display:none !important;}',
    '.wlvf-dim{opacity:.22 !important;transition:opacity .15s;}',
    '.wlvf-panel{position:fixed;top:76px;right:18px;z-index:99999;width:256px;',
    '  padding:12px 14px;border-radius:12px;',
    '  font:12px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    '  background:var(--wlvf-bg);color:var(--wlvf-fg);border:1px solid var(--wlvf-border);',
    '  box-shadow:var(--wlvf-shadow);transition:background .2s,color .2s,border-color .2s;}',
    // —— 亮色：取自 B 站亮色界面实色。面板底用 --bg2 灰一档浮在纯白页面上，
    //    输入框回白色、描边 + 投影收边，三层边界互不粘连 ——
    '.wlvf-theme-light{',
    '  --wlvf-bg:#F6F7F8F2;--wlvf-fg:#18191C;--wlvf-border:#D5D9DE;',
    '  --wlvf-muted:#61666D;--wlvf-accent:#00AEEC;--wlvf-warn-bg:#FAEEDA;--wlvf-warn-fg:#854F0B;',
    '  --wlvf-input-bg:#FFFFFF;--wlvf-btn-bg:#FFFFFF;--wlvf-shadow:0 4px 16px rgba(0,0,0,.08);}',
    // —— 深色：取自 B 站深色界面实色。面板底比页面 #17181A 提亮一档 #212226，
    //    沉稳不突兀；输入框再提一档，描边 #3A3C42 把面板从页面上"抬"出来 ——
    '.wlvf-theme-dark{',
    '  --wlvf-bg:#212226F2;--wlvf-fg:#E7E9EB;--wlvf-border:#3A3C42;',
    '  --wlvf-muted:#A2A7AE;--wlvf-accent:#0087BD;--wlvf-warn-bg:#412402;--wlvf-warn-fg:#FAC775;',
    '  --wlvf-input-bg:#2A2B30;--wlvf-btn-bg:#2A2B30;--wlvf-shadow:0 4px 16px rgba(0,0,0,.45);}',
    '.wlvf-panel input[type=text]{width:86px;padding:2px 8px;border-radius:8px;',
    '  border:1px solid var(--wlvf-border);background:var(--wlvf-input-bg);color:var(--wlvf-fg);',
    '  font-size:12px;outline:none;}',
    '.wlvf-panel input[type=text]:focus{border-color:var(--wlvf-accent);}',
    '.wlvf-panel button{padding:3px 10px;border-radius:8px;cursor:pointer;font-size:12px;',
    '  border:1px solid var(--wlvf-border);background:var(--wlvf-btn-bg);color:var(--wlvf-fg);}',
    '.wlvf-panel button:hover{border-color:var(--wlvf-accent);}',
    '.wlvf-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;}',
    '.wlvf-panel label{display:inline-flex;align-items:center;gap:3px;cursor:pointer;user-select:none;}',
    '.wlvf-muted{color:var(--wlvf-muted);}',
    '.wlvf-warn{color:var(--wlvf-warn-fg);background:var(--wlvf-warn-bg);',
    '  border-radius:6px;padding:1px 6px;}',
    '.wlvf-div{height:1px;background:var(--wlvf-border);margin:8px 0;}',
    '.wlvf-title{display:flex;justify-content:space-between;align-items:center;',
    '  font-weight:500;margin:0 0 6px;}',
    '.wlvf-theme-btn{padding:1px 8px;font-size:11px;border-radius:7px;}',
  ].join('\n');

  /** 应用面板主题（亮/深），并同步按钮文案 */
  function applyTheme() {
    const p = document.getElementById('wlvf-panel');
    if (!p) return;
    p.classList.remove('wlvf-theme-light', 'wlvf-theme-dark');
    p.classList.add(state.theme === 'dark' ? 'wlvf-theme-dark' : 'wlvf-theme-light');
    const btn = document.getElementById('wlvf-theme');
    if (btn) {
      btn.textContent = state.theme === 'dark' ? '亮色' : '暗色';
      btn.title = state.theme === 'dark' ? '切换到亮色模式' : '切换到深色模式';
    }
  }

  function buildPanel() {
    if (document.getElementById('wlvf-panel')) return;
    const style = document.createElement('style');
    style.id = 'wlvf-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wlvf-panel';
    panel.className = 'wlvf-panel';
    panel.innerHTML = [
      '<div class="wlvf-title"><span>播放量筛选</span>',
      '  <button id="wlvf-theme" class="wlvf-theme-btn" type="button">暗色</button>',
      '</div>',
      '<div class="wlvf-row">',
      '  <span>播放量 ≥</span>',
      '  <input id="wlvf-threshold" type="text" placeholder="如 1.5万" title="支持纯数字 / 1.5万 / 2亿；清空 = 不筛">',
      '</div>',
      '<div class="wlvf-row">',
      '  <label><input id="wlvf-enabled" type="checkbox">启用</label>',
      '  <label><input name="wlvf-mode" type="radio" value="hide">隐藏</label>',
      '  <label><input name="wlvf-mode" type="radio" value="dim">淡化</label>',
      '  <button id="wlvf-peek" type="button">临时显示全部</button>',
      '</div>',
      '<div class="wlvf-div"></div>',
      '<div id="wlvf-status" class="wlvf-muted"></div>',
      '<div id="wlvf-source" class="wlvf-muted"></div>',
      '<div class="wlvf-row" style="margin-top:8px">',
      '  <button id="wlvf-refresh" type="button">刷新数据</button>',
      '  <button id="wlvf-recalc" type="button">立即重算</button>',
      '</div>',
    ].join('');
    document.body.appendChild(panel);

    // —— 控件初值（默认：阈值 10000、不启用、隐藏模式）——
    const thInput = panel.querySelector('#wlvf-threshold');
    thInput.value = state.threshold == null ? '' : String(state.threshold);
    panel.querySelector('#wlvf-enabled').checked = state.enabled;
    const modeRadio = panel.querySelector('input[name="wlvf-mode"][value="' + state.mode + '"]');
    if (modeRadio) modeRadio.checked = true;

    // —— 事件绑定（change + click 双保险，解决部分环境下 change 不稳定） ——
    thInput.addEventListener('input', () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        state.threshold = parseThreshold(thInput.value);
        saveConfig();
        applyAll();
      }, INPUT_DEBOUNCE);
    });
    const enInput = panel.querySelector('#wlvf-enabled');
    function onEnableToggle() {
      state.enabled = enInput.checked;
      saveConfig();
      applyAll();
    }
    enInput.addEventListener('change', onEnableToggle);
    enInput.addEventListener('click', () => setTimeout(onEnableToggle, 0));
    panel.querySelectorAll('input[name="wlvf-mode"]').forEach((r) => {
      function onModeToggle() {
        if (!r.checked) return;
        state.mode = r.value === 'dim' ? 'dim' : 'hide';
        saveConfig();
        applyAll();
      }
      r.addEventListener('change', onModeToggle);
      r.addEventListener('click', () => setTimeout(onModeToggle, 0));
    });
    panel.querySelector('#wlvf-peek').addEventListener('click', (e) => {
      state.peek = !state.peek;
      e.target.textContent = state.peek ? '恢复筛选' : '临时显示全部';
      applyAll();
    });
    panel.querySelector('#wlvf-refresh').addEventListener('click', () => loadViewMap());
    panel.querySelector('#wlvf-recalc').addEventListener('click', () => applyAll());
    // 亮/深切换：一按即换，偏好立即持久化
    panel.querySelector('#wlvf-theme').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      saveConfig();
      applyTheme();
    });
    applyTheme();
  }

  // ========== 动态套用 ==========
  let observer = null;
  let observedSection = null;
  function attachObserver() {
    if (!active) return;
    const section = document.querySelector(SELECTORS.section);
    if (!section) return;
    if (observer && observedSection === section) return;
    if (observer) observer.disconnect();
    observedSection = section;
    observer = new MutationObserver(scheduleApply);
    // childList+subtree: 无限滚动新增卡片、插件包一层 wrapper 也能捕获
    // attributes+class: Vue 重渲染 / 插件改写 class 后自动补过滤
    observer.observe(section, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    scheduleApply();
  }
  function waitForSection(tries) {
    if (!active) return;
    if (document.querySelector(SELECTORS.section)) { attachObserver(); return; }
    if ((tries || 0) > 100) return;
    sectionWaitTimer = setTimeout(() => waitForSection((tries || 0) + 1), 200);
  }

  // ========== 按页面装卸 ==========
  /** 进入播放页：撤掉面板/样式/观察者/定时器，并还原卡片 class（SPA 会复用 DOM） */
  function teardown() {
    if (!active) return;
    active = false;
    if (observer) { observer.disconnect(); observer = null; observedSection = null; }
    clearTimeout(applyTimer); applyTimer = 0;
    clearTimeout(sectionWaitTimer); sectionWaitTimer = 0;
    clearTimeout(inputTimer); inputTimer = 0;
    document.querySelectorAll('.' + CLS.hide + ',.' + CLS.dim).forEach(clearCard);
    const p = document.getElementById('wlvf-panel');
    if (p) p.remove();
    const s = document.getElementById('wlvf-style');
    if (s) s.remove();
  }
  function boot() {
    if (active) return;
    active = true;
    loadConfig();
    buildPanel();
    waitForSection(0);
    loadViewMap();
  }
  /** URL 变化后同步生命周期：列表页 → 启动；播放页 → 完全卸载 */
  function syncActive() {
    if (isWatchlaterListUrl(location.href)) {
      if (!active) boot();
      else attachObserver(); // hash 视图切换后 section 可能被替换，重挂观察者
    } else {
      teardown();
    }
  }
  /** SPA 路由：pushState/replaceState 不触发 popstate，需一并挂钩 */
  function installRouteWatch() {
    const fire = () => setTimeout(syncActive, 0);
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    const push = history.pushState;
    const replace = history.replaceState;
    history.pushState = function () {
      const r = push.apply(this, arguments);
      fire();
      return r;
    };
    history.replaceState = function () {
      const r = replace.apply(this, arguments);
      fire();
      return r;
    };
  }

  // ========== 启动 ==========
  // 直接打开播放页时守卫直接 return：不建面板、不轮询、不 fetch、不挂 observer。
  // 从列表页 SPA 进出播放态时，由路由监听自动装卸。
  installRouteWatch();
  syncActive();
})();

// 供 node 单测提取（不影响运行）
// __PURE_EXPORT__ parseCount parseThreshold passes isWatchlaterListUrl
