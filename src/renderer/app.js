'use strict';
/* global Terminal, FitAddon, Unicode11Addon, WebglAddon, icon, hydrateIcons */

const $ = s => document.querySelector(s);

let state = { sessions: [], extraProjects: [], config: {}, claudePath: null, home: '', userName: '', dark: false };
let search = '';
const expandedMore = new Set(); // 展开了"更多"的项目
const SESSIONS_PREVIEW = 5; // 一级页面每个目录默认只显示最近的几个（置顶的另算）
let sideView = 'main';      // main 项目列表 | archive 已归档

// termId -> tab
const tabs = new Map();
let tabOrder = [];
let activeId = null;
let termSeq = 0;

// ================= 工具 =================
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function baseName(p) {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
function relTime(ms) {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const dt = new Date(ms);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return sameYear ? `${dt.getMonth() + 1}月${dt.getDate()}日` : `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}
function sessionTitle(s) {
  const alias = state.config.aliases?.[s.id];
  if (alias) return alias;
  if (s.title) return s.title;
  if (s.firstPrompt) return s.firstPrompt.split('\n')[0].slice(0, 80);
  return '(无标题会话)';
}
function projectLabel(cwd) {
  if (!cwd) return '?';
  if (state.home && cwd.toLowerCase() === state.home.toLowerCase()) return '用户目录';
  return baseName(cwd);
}
function tabForSession(id) {
  for (const t of tabs.values()) if (t.sessionId === id) return t;
  return null;
}
// 会话状态：running 正在运行（转圈）/ done 跑完了、等你看（橙点）/ '' 无
// 判断依据是 Claude Code 设置的终端标题：工作时是 "◐ …" / "◑ …" 交替，空闲时是 "✳ …"
function tabStatus(t) {
  if (!t || !t.alive) return '';
  if (t.busy) return 'running';
  if (t.done) return 'done';
  return '';
}
const BUSY_TITLE = /^[\u25D0-\u25D3\u25F4-\u25F7\u2800-\u28FF]/;
function setBusy(tab, busy) {
  if (tab.busy === busy) return;
  // 一轮跑完：用户正看着这个会话（窗口也在前台）就不用提醒
  if (tab.busy && !busy) tab.done = !(tab.termId === activeId && document.hasFocus());
  if (busy) tab.done = false;
  tab.busy = busy;
  updateStatusDom();
}
// 只更新状态属性，不重建侧边栏
function updateStatusDom() {
  const byKey = new Map();
  for (const t of tabs.values()) {
    const st = tabStatus(t);
    if (t.sessionId) document.querySelectorAll(`.sess[data-sid="${CSS.escape(t.sessionId)}"]`).forEach(el => { el.dataset.st = st; });
    const prev = byKey.get(t.key) || '';
    byKey.set(t.key, prev === 'running' || st === 'running' ? 'running' : (prev || st));
  }
  document.querySelectorAll('.proj-row[data-key]').forEach(el => { el.dataset.st = byKey.get(el.dataset.key) || ''; });
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

// ================= 主题 =================
const ANSI = {
  light: {
    black: '#141413', red: '#b5372b', green: '#3b7a3a', yellow: '#9a6a00', blue: '#2c62a8', magenta: '#8a3f9e', cyan: '#1d7487', white: '#8a887f',
    brightBlack: '#73726c', brightRed: '#c9473a', brightGreen: '#4a8f48', brightYellow: '#b27c00', brightBlue: '#3b78c4', brightMagenta: '#a04fb5', brightCyan: '#26879c', brightWhite: '#3d3d3a',
  },
  dark: {
    black: '#4a4945', red: '#e5766b', green: '#8fbf7f', yellow: '#e0b25e', blue: '#7aa8e6', magenta: '#c79be0', cyan: '#6cc3cf', white: '#c2c0b6',
    brightBlack: '#75736c', brightRed: '#f08a80', brightGreen: '#a5d394', brightYellow: '#edc679', brightBlue: '#93bbf0', brightMagenta: '#d6b0ec', brightCyan: '#86d3de', brightWhite: '#faf9f5',
  },
};
function termTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = cssVar('--surface-2');
  return {
    ...ANSI[dark ? 'dark' : 'light'],
    background: bg,
    foreground: cssVar('--text-1'),
    cursor: cssVar('--clay'),
    cursorAccent: bg,
    selectionBackground: dark ? 'rgba(217,119,87,0.35)' : 'rgba(217,119,87,0.25)',
    scrollbarSliderBackground: cssVar('--scroll-thumb'),
    scrollbarSliderHoverBackground: cssVar('--border-strong'),
    scrollbarSliderActiveBackground: cssVar('--border-strong'),
  };
}
function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = state.dark ? 'dark' : 'light';
  root.dataset.palette = state.config.palette || 'classic';
  const theme = termTheme();
  for (const t of tabs.values()) t.term.options.theme = theme;
  api.setOverlay(cssVar('--surface-1'), cssVar('--text-2'));
}
api.onThemeUpdated(dark => { state.dark = dark; applyTheme(); });

// ================= 项目分组 =================
function isArchived(id) { return (state.config.archived || []).includes(id); }
function isPinnedSession(id) { return (state.config.pinnedSessions || []).includes(id); }

function buildProjects({ ignoreSearch = false, archived = false } = {}) {
  const cfg = state.config;
  const archivedSet = new Set(cfg.archived || []);
  const groups = new Map();
  const ensure = (key, cwd) => {
    let g = groups.get(key);
    if (!g) { g = { key, cwd, sessions: [], updatedAt: 0, extra: false }; groups.set(key, g); }
    return g;
  };
  for (const s of state.sessions) {
    if (s.scripted && !cfg.showScripted) continue;
    if (archived !== archivedSet.has(s.id)) continue;
    const g = ensure(s.key, s.cwd);
    g.sessions.push(s);
    if (s.updatedAt > g.updatedAt) { g.updatedAt = s.updatedAt; g.cwd = s.cwd; }
  }
  if (!archived) for (const p of state.extraProjects) ensure(p.key, p.cwd).extra = true;
  // 已打开但还没写入磁盘的新会话
  const known = new Set(state.sessions.map(s => s.id));
  if (!archived) for (const t of tabs.values()) {
    if (t.sessionId && !known.has(t.sessionId)) {
      const g = ensure(t.key, t.cwd);
      g.sessions.push({ id: t.sessionId, cwd: t.cwd, key: t.key, pending: true, updatedAt: t.createdAt });
      g.updatedAt = Math.max(g.updatedAt, t.createdAt);
    }
  }

  let list = [...groups.values()];
  const hidden = new Set(cfg.hidden || []);
  if (!cfg.showHidden && !archived) list = list.filter(g => !hidden.has(g.key));

  const q = ignoreSearch ? '' : search.trim().toLowerCase();
  if (q) {
    list = list.map(g => {
      if (g.cwd.toLowerCase().includes(q)) return g;
      const ss = g.sessions.filter(s => {
        const t = (sessionTitle(s) + ' ' + (s.firstPrompt || '') + ' ' + (s.lastPrompt || '') + ' ' + s.id).toLowerCase();
        return t.includes(q);
      });
      return ss.length ? { ...g, sessions: ss } : null;
    }).filter(Boolean);
  }

  const pinned = cfg.pinned || [];
  const pinnedS = new Set(cfg.pinnedSessions || []);
  for (const g of list) g.sessions.sort((a, b) => (pinnedS.has(b.id) - pinnedS.has(a.id)) || (b.updatedAt - a.updatedAt));
  const order = cfg.projectOrder || [];
  list.sort((a, b) => {
    const pa = pinned.indexOf(a.key), pb = pinned.indexOf(b.key);
    if (pa !== pb) { if (pa === -1) return 1; if (pb === -1) return -1; return pa - pb; }
    const oa = order.indexOf(a.key), ob = order.indexOf(b.key);
    if (oa === -1 && ob === -1) return b.updatedAt - a.updatedAt; // 都是新项目：新的在前
    if (oa === -1) return -1;
    if (ob === -1) return 1;
    return oa - ob;
  });
  return list;
}

function rememberProjectOrder(projects) {
  const order = state.config.projectOrder || [];
  const known = new Set(order);
  const fresh = projects.filter(g => !known.has(g.key)).sort((a, b) => b.updatedAt - a.updatedAt).map(g => g.key);
  if (!fresh.length) return;
  state.config.projectOrder = [...fresh, ...order];
  api.setConfig({ projectOrder: state.config.projectOrder });
}

// 上移 / 下移：和显示列表里相邻的项目交换位置（置顶的在置顶组内移动）
async function moveProject(key, dir) {
  const cfg = state.config;
  const visible = buildProjects({ ignoreSearch: true });
  const pinned = cfg.pinned || [];
  const isPinned = pinned.includes(key);
  const group = visible.filter(g => pinned.includes(g.key) === isPinned).map(g => g.key);
  const i = group.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= group.length) return;
  const other = group[j];
  if (isPinned) {
    const p = [...pinned];
    const a = p.indexOf(key), b = p.indexOf(other);
    [p[a], p[b]] = [p[b], p[a]];
    await setCfg({ pinned: p });
  } else {
    const o = [...(cfg.projectOrder || [])];
    const a = o.indexOf(key), b = o.indexOf(other);
    if (a < 0 || b < 0) return;
    [o[a], o[b]] = [o[b], o[a]];
    await setCfg({ projectOrder: o });
  }
}

function findProject(key) {
  return buildProjects({ ignoreSearch: true }).find(g => g.key === key) ||
    (() => { const s = state.sessions.find(x => x.key === key); return s ? { key, cwd: s.cwd, sessions: [] } : null; })();
}

// ================= 侧边栏 =================
function archivedCount() {
  const ids = new Set(state.sessions.map(s => s.id));
  return (state.config.archived || []).filter(id => ids.has(id)).length;
}

function renderSectionHead() {
  const head = $('#section-head');
  const n = archivedCount();
  $('#archive-count').textContent = n ? String(n) : '';
  $('#btn-archive').classList.toggle('hidden', sideView === 'archive');
  if (sideView === 'archive') {
    head.className = 'section-head archive-head';
    head.innerHTML = `<div class="head-title"><button class="back-btn" id="btn-back" title="返回项目列表">${icon('back', 16, 2)}已归档</button><span class="nav-count">${n || ''}</span></div>`;
    $('#btn-back').onclick = () => setSideView('main');
  } else {
    head.className = 'section-head';
    head.innerHTML = `<span>项目</span><button class="icon-btn sm" id="btn-refresh" title="刷新">${icon('refresh', 14)}</button>`;
    $('#btn-refresh').onclick = () => refresh();
  }
  $('#search').placeholder = sideView === 'archive' ? '搜索已归档的会话' : '搜索项目或会话';
}

function setSideView(v) {
  sideView = v;
  search = ''; $('#search').value = '';
  $('#tree').scrollTop = 0;
  renderTree();
}

function sessRow(s, g, { archivedView = false } = {}) {
  const activeTab = tabs.get(activeId);
  const st = tabStatus(tabForSession(s.id));
  const active = activeTab && activeTab.sessionId === s.id;
  const statusEl = `<span class="run-status" title="${st === 'running' ? '正在运行' : st === 'done' ? '已完成' : ''}"><span class="spin"></span><span class="done-dot"></span></span>`;
  const title = s.pending ? '新会话' : sessionTitle(s);
  const tip = s.pending ? '还没开始聊' : [sessionTitle(s), s.firstPrompt && s.firstPrompt !== s.title ? '首条：' + s.firstPrompt.slice(0, 200) : '', s.branch ? '分支：' + s.branch : ''].filter(Boolean).join('\n');
  const pinned = !archivedView && isPinnedSession(s.id);
  const tools = s.pending ? '' : archivedView
    ? `<span class="sess-tools">
        <button class="icon-btn" data-unarch="${esc(s.id)}" title="取消归档">${icon('unarchive', 15)}</button>
        <button class="icon-btn danger" data-del="${esc(s.id)}" title="删除（移到回收站）">${icon('trash', 15)}</button>
      </span>`
    : `<span class="sess-tools">
        <button class="icon-btn" data-arch="${esc(s.id)}" title="归档">${icon('archive', 15)}</button>
        <button class="icon-btn" data-smore="${esc(s.id)}" data-key="${esc(g.key)}" title="更多">${icon('more', 16)}</button>
      </span>`;
  return `<div class="sess${active ? ' active' : ''}${s.pending ? ' pending' : ''}" data-sid="${esc(s.id)}" data-key="${esc(g.key)}" data-st="${st}" title="${esc(tip)}">
    ${pinned ? `<span class="sess-pin" title="已置顶">${icon('pin', 12)}</span>` : ''}
    <span class="sess-title">${esc(title)}</span>
    <span class="sess-time">${s.pending ? '' : relTime(s.updatedAt)}</span>
    ${statusEl}
    ${tools}
  </div>`;
}

function renderArchive() {
  const tree = $('#tree');
  const groups = buildProjects({ archived: true });
  if (!groups.length) {
    tree.innerHTML = `<div class="tree-empty">${search.trim() ? '没有匹配的已归档会话' : '还没有归档的会话<br>鼠标移到会话上，点归档按钮就能收到这里'}</div>`;
    return;
  }
  tree.innerHTML = `<div class="archive-list">${groups.map(g => `
    <div class="group-label" title="${esc(g.cwd)}">${icon('folder', 13)}<span>${esc(projectLabel(g.cwd))}</span><span class="nav-count">${g.sessions.length}</span></div>
    ${g.sessions.map(s => sessRow(s, g, { archivedView: true })).join('')}`).join('')}</div>`;
}

function renderTree() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  renderSectionHead();
  if (sideView === 'archive') { renderArchive(); tree.scrollTop = scroll; renderFoot(); return; }
  const projects = buildProjects();
  if (!search.trim()) rememberProjectOrder(projects);
  const cfg = state.config;
  const pinned = new Set(cfg.pinned || []);
  const hidden = new Set(cfg.hidden || []);
  const activeTab = tabs.get(activeId);
  const searching = !!search.trim();

  if (!projects.length) {
    tree.innerHTML = `<div class="tree-empty">${searching ? '没有匹配的会话' : '还没有会话<br>点上面的「新建会话」选一个文件夹开始'}</div>`;
  } else {
    tree.innerHTML = projects.map((g, idx) => {
      // 默认：前 4 个项目展开，其余折叠；用户手动操作过的以用户为准；搜索时全展开
      const userSet = cfg.collapsed && Object.prototype.hasOwnProperty.call(cfg.collapsed, g.key);
      const collapsed = searching ? false : (userSet ? cfg.collapsed[g.key] : idx >= 4);
      const sts = g.sessions.map(s => tabStatus(tabForSession(s.id)));
      const pst = sts.includes('running') ? 'running' : sts.includes('done') ? 'done' : '';
      const showAll = searching || expandedMore.has(g.key);
      // 置顶的、已经打开的会话总是显示；其余只显示最近的几个
      const keep = s => isPinnedSession(s.id) || s.pending || !!tabForSession(s.id);
      const shown = showAll ? g.sessions : g.sessions.filter((s, i) => i < SESSIONS_PREVIEW || keep(s));
      const rest = g.sessions.length - shown.length;
      const sess = shown.map(s => sessRow(s, g)).join('');
      return `<div class="project${collapsed ? ' collapsed' : ''}${hidden.has(g.key) ? ' is-hidden' : ''}" data-key="${esc(g.key)}">
        <div class="proj-row" data-key="${esc(g.key)}" data-st="${pst}" title="${esc(g.cwd)}">
          <span class="chev">${icon('chevron', 14, 2)}</span>
          <span class="proj-icon">${icon('folder', 16)}</span>
          <span class="proj-name">${esc(projectLabel(g.cwd))}</span>
          <span class="proj-meta">
            ${pinned.has(g.key) ? `<span class="proj-pin" title="已置顶">${icon('pin', 13)}</span>` : ''}
            <span class="run-status"><span class="spin"></span><span class="done-dot"></span></span>
            <span class="proj-count">${g.sessions.length || ''}</span>
            <span class="proj-tools">
              <button class="icon-btn sm" data-pmore="${esc(g.key)}" title="更多">${icon('more', 16)}</button>
              <button class="icon-btn sm" data-add="${esc(g.key)}" title="在这个目录新开会话">${icon('plus', 15, 2)}</button>
            </span>
          </span>
        </div>
        <div class="sessions"><div class="inner">
          ${sess || '<div class="sess-empty">还没有会话，点 ＋ 新建</div>'}
          ${rest > 0 ? `<button class="more-btn" data-more="${esc(g.key)}">显示其余 ${rest} 个</button>` : ''}
          ${showAll && !searching && g.sessions.length > SESSIONS_PREVIEW ? `<button class="more-btn" data-less="${esc(g.key)}">收起</button>` : ''}
        </div></div>
      </div>`;
    }).join('');
  }
  tree.scrollTop = scroll;
  renderFoot(projects);
}

function renderFoot(projects) {
  const cfg = state.config;
  const total = state.sessions.filter(s => (!s.scripted || cfg.showScripted) && !isArchived(s.id)).length;
  const running = [...tabs.values()].filter(t => t.alive).length;
  const name = state.userName || '我';
  $('#side-foot').innerHTML = `
    <div class="user-chip" title="${esc(state.home)}">
      <div class="avatar">${esc(name.slice(0, 1).toUpperCase())}</div>
      <div class="user-text">
        <div class="user-name">${esc(name)}</div>
        <div class="user-sub">${running ? `${running} 个运行中 · ` : ''}${(projects || buildProjects({ ignoreSearch: true })).length} 个项目 · ${total} 个会话</div>
      </div>
    </div>
    <button class="icon-btn" id="btn-settings" title="设置">${icon('settings', 18)}</button>`;
  $('#btn-settings').onclick = settingsModal;
}

// ================= 用量 =================
let usage = { status: 'loading' };
function resetText(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return '已重置';
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins} 分钟后重置`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return `${h} 小时${m ? ` ${m} 分` : ''}后重置`;
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  const wk = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${wk} ${pad(d.getHours())}:${pad(d.getMinutes())} 重置`;
}
// 紧凑的重置时间：15分后 / 1时15分后 / 周三 17:00
function resetShort(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return '已重置';
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}分后`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return `${h}时${m ? m + '分' : ''}后`;
  const d = new Date(ms);
  return `周${'日一二三四五六'[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function usageRow(label, w) {
  if (!w) return '';
  const reset = w.resetsAt && w.resetsAt <= Date.now();
  const pct = reset ? 0 : (w.pct ?? 0);
  const level = pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '';
  const tip = `${label}额度：${reset ? '已重置' : '已用 ' + Math.round(pct) + '%'}${w.resetsAt && !reset ? '，' + resetText(w.resetsAt) : ''}`;
  return `<div class="usage-row${level}" title="${esc(tip)}">
    <span class="usage-label">${label}</span>
    <span class="usage-bar"><i style="width:${pct}%"></i></span>
    <span class="usage-pct">${reset ? '—' : Math.round(pct) + '%'}</span>
    <span class="usage-reset">${w.resetsAt ? resetShort(w.resetsAt) : ''}</span>
  </div>`;
}
function renderUsage() {
  const box = $('#usage');
  if (state.config.showUsage === false || usage.status === 'loading') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.classList.remove('stale');
  box.title = '';
  if (usage.status === 'no-hud') {
    box.innerHTML = '<div class="usage-hint">用量：需要 claude-hud 状态栏插件</div>';
  } else if (usage.status === 'not-configured') {
    box.innerHTML = '<div class="usage-hint">用量：<button class="link-btn" id="usage-enable">点这里开启</button></div>';
    $('#usage-enable').onclick = async () => { usage = await api.enableUsage(); renderUsage(); };
  } else if (usage.status === 'waiting') {
    box.innerHTML = '<div class="usage-hint">用量：等 Claude 会话刷新一次状态栏</div>';
  } else {
    const rows = usageRow('5 小时', usage.fiveHour) + usageRow('本周', usage.sevenDay);
    box.innerHTML = rows || '<div class="usage-hint">用量：当前账号没有额度信息</div>';
    // 超过 15 分钟没更新：整体变淡，悬停可看更新时间
    if (usage.updatedAt && Date.now() - usage.updatedAt > 15 * 60000) box.classList.add('stale');
    if (usage.updatedAt) box.title = '更新于 ' + relTime(usage.updatedAt);
  }
}
api.onUsageUpdate(u => { usage = u; renderUsage(); });

// ================= 首页 =================
let homeVisible = false;
function renderHome() {
  const home = $('#home');
  if (activeId) { home.classList.add('hidden'); homeVisible = false; return; }
  const enter = !homeVisible;
  homeVisible = true;
  const scroll = home.scrollTop;
  home.classList.remove('hidden');
  const projects = buildProjects({ ignoreSearch: true }).slice(0, 8);
  const recent = state.sessions
    .filter(s => !s.scripted || state.config.showScripted)
    .filter(s => !(state.config.hidden || []).includes(s.key) && !isArchived(s.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6);
  const name = state.userName ? `，${state.userName}` : '';
  home.innerHTML = `<div class="home-inner${enter ? ' enter' : ''}">
    <div class="greeting"><span class="spark">${icon('spark', 34)}</span><h1>${greeting()}${esc(name)}</h1></div>
    <div class="composer">
      <div class="composer-prompt">在哪个项目里开始新会话？</div>
      <div class="proj-chips">
        ${projects.map(g => `<button class="proj-chip" data-hnew="${esc(g.key)}" title="${esc(g.cwd)}">${icon('folder', 15)}<span>${esc(projectLabel(g.cwd))}</span></button>`).join('') || '<span class="composer-hint">还没有项目</span>'}
      </div>
      <div class="composer-foot">
        <span class="composer-hint">点项目直接开始，或者从左边接着聊以前的会话</span>
        <button class="btn btn-secondary" id="home-pick">${icon('folderPlus', 15)}选择文件夹…</button>
      </div>
    </div>
    ${recent.length ? `<div class="recent-head"><h2>${icon('clock', 15)}最近的会话</h2></div>
    <div class="recent-grid">
      ${recent.map(s => `<button class="recent-card" data-hopen="${esc(s.id)}" data-key="${esc(s.key)}" title="${esc(s.cwd)}">
        <div class="rc-top">${icon('chat', 15)}</div>
        <div class="rc-title">${esc(sessionTitle(s))}</div>
        <div class="rc-meta"><span>${esc(projectLabel(s.cwd))}</span><span>·</span><span>${relTime(s.updatedAt)}</span></div>
      </button>`).join('')}
    </div>` : ''}
    <div class="home-keys">
      <span><kbd>Ctrl</kbd> <kbd>Tab</kbd> 切换会话</span>
      <span><kbd>Shift</kbd> <kbd>Enter</kbd> 换行</span>
      <span>选中后 <kbd>Ctrl</kbd> <kbd>C</kbd> 复制</span>
      <span><kbd>Ctrl</kbd> <kbd>V</kbd> 粘贴文字或截图，也可以把图片拖进来</span>
      <span>终端里右键：复制 / 粘贴</span>
    </div>
  </div>`;
  home.scrollTop = scroll;
}

$('#home').addEventListener('click', e => {
  const n = e.target.closest('[data-hnew]');
  if (n) { const g = findProject(n.dataset.hnew); if (g) newSessionIn(g.cwd, g.key); return; }
  const o = e.target.closest('[data-hopen]');
  if (o) { openSession(o.dataset.hopen, o.dataset.key); return; }
  if (e.target.closest('#home-pick')) pickFolderAndStart();
});

// ================= 顶栏标签 =================
function tabTitle(t) {
  const s = state.sessions.find(x => x.id === t.sessionId);
  if (s) return sessionTitle(s);
  return t.title || '新会话';
}

function renderTabs() {
  const t = tabs.get(activeId);
  $('#tabbar').innerHTML = t ? `<div class="crumb" title="${esc(t.cwd)}">
      <span class="crumb-proj">${esc(projectLabel(t.cwd))}</span><span class="crumb-sep">/</span><span class="crumb-title">${esc(tabTitle(t))}</span>
    </div>` : '';
  $('#top-actions').innerHTML = t ? `
    <button class="icon-btn" id="ta-folder" title="在资源管理器中打开">${icon('folderOpen', 17)}</button>
    <button class="icon-btn" id="ta-more" title="更多">${icon('more', 18)}</button>` : '';
  if (t) {
    $('#ta-folder').onclick = () => api.openPath(t.cwd);
    $('#ta-more').onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      if (t.sessionId && state.sessions.some(s => s.id === t.sessionId)) sessionMenu({ clientX: r.right - 210, clientY: r.bottom + 6 }, t.sessionId, t.key);
      else showMenu(r.right - 210, r.bottom + 6, [{ label: '关闭会话', icon: 'x', run: () => closeTab(t.termId) }]);
    };
  }
}

function renderAll() { renderTree(); renderTabs(); renderHome(); renderUsage(); }

// ================= 终端 =================
function createTab({ sessionId, cwd, key, title, isNew }) {
  const termId = 't' + (++termSeq);
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap';
  $('#terms').appendChild(wrap);
  $('#terms').classList.remove('hidden');

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace',
    fontSize: state.config.fontSize || 14,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: termTheme(),
    windowsPty: { backend: 'conpty' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch { }
  term.open(wrap);
  try {
    // WebGL 在高分屏/窗口被遮挡时可能按错误缩放建字形缓存，默认用 DOM 渲染
    if (state.config.renderer !== 'webgl') throw 0;
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* 回退到 DOM 渲染 */ }

  const tab = { termId, sessionId, cwd, key, title, term, fit, wrap, alive: false, busy: false, done: false, createdAt: Date.now(), isNew };
  tabs.set(termId, tab);
  tabOrder.push(termId);

  term.attachCustomKeyEventHandler(e => handleKey(tab, e));
  term.onData(d => {
    if (!tab.alive) {
      if (d === '\r') relaunch(tab);
      return;
    }
    // 用户开始输入（不是终端自动回复的控制序列），说明已经看过结果了
    if (tab.done && (d === '\r' || d[0] !== '\x1b')) { tab.done = false; updateStatusDom(); }
    api.write(termId, d);
  });
  term.onTitleChange(title => setBusy(tab, BUSY_TITLE.test(title || '')));
  term.onResize(({ cols, rows }) => { if (tab.alive) api.resize(termId, cols, rows); });
  term._core.onRender(() => { if (tab.placeIme) tab.placeIme(); });
  setupImeAnchor(tab);
  setupFileLinks(tab);
  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    if (term.hasSelection()) { api.writeClipboard(term.getSelection()); term.clearSelection(); }
    else pasteInto(tab);
  });
  wrap.addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('#terms').classList.add('drop-target');
  });
  wrap.addEventListener('dragleave', e => { if (!wrap.contains(e.relatedTarget)) $('#terms').classList.remove('drop-target'); });
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    $('#terms').classList.remove('drop-target');
    dropFilesInto(tab, e.dataTransfer.files);
  });

  activate(termId);
  return tab;
}

// ---------- 输入法候选框定位 ----------
// 输入法候选框跟着 xterm 隐藏的 textarea 走，textarea 默认跟着"真实光标"。
// Claude Code 会隐藏真实光标、用反色方块画自己的光标，输出后真实光标常停在屏幕底部，
// 候选框就会跑到窗口右下角外面。这里把 textarea 挪到 Claude 画的那个光标上。
function findImeCell(term) {
  const b = term.buffer.active;
  const core = term._core;
  const curRow = b.baseY + b.cursorY - b.viewportY;
  const clamp = (x, y) => ({ x: Math.max(0, Math.min(term.cols - 1, x)), y: Math.max(0, Math.min(term.rows - 1, y)) });
  const hidden = core && core.coreService && core.coreService.isCursorHidden;
  if (!hidden) return curRow >= 0 && curRow < term.rows ? null : clamp(b.cursorX, term.rows - 1);

  let best = null, bestD = Infinity;
  const cell = b.getNullCell();
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < term.cols; x++) {
      if (!line.getCell(x, cell) || !cell.isInverse()) continue;
      const d = Math.abs(y - curRow) * 1000 + Math.abs(x - b.cursorX);
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best || clamp(b.cursorX, curRow);
}

function setupImeAnchor(tab) {
  const { term, wrap } = tab;
  let pending = false;
  const place = () => {
    pending = false;
    if (tab.termId !== activeId) return;
    const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
    const cw = dims && dims.css && dims.css.cell && dims.css.cell.width;
    const ch = dims && dims.css && dims.css.cell && dims.css.cell.height;
    if (!cw || !ch) return;
    const pos = findImeCell(term);
    if (!pos) return; // 真实光标可见且在视口内，用 xterm 默认位置
    const left = pos.x * cw + 'px', top = pos.y * ch + 'px';
    const ta = term.textarea;
    const cv = wrap.querySelector('.composition-view');
    const placeCv = () => {
      if (!cv || !cv.classList.contains('active')) return;
      const maxLeft = Math.max(0, term.cols * cw - cv.offsetWidth);
      const left2 = Math.min(pos.x * cw, maxLeft) + 'px';
      cv.style.left = left2;
      cv.style.top = top;
      if (ta) { ta.style.left = left2; ta.style.top = top; }
    };
    if (ta) { ta.style.left = left; ta.style.top = top; }
    placeCv();
    // xterm 在 compositionupdate 的末尾还会排一次零延时覆盖；等它之后再夹一次，
    // 否则长拼音组字会把辅助输入框推到画布右侧并触发祖先横向滚动。
    if (cv && cv.classList.contains('active')) setTimeout(placeCv, 0);
  };
  // 放到 xterm 自己的定位逻辑之后执行
  const schedule = () => { if (!pending) { pending = true; setTimeout(place, 0); } };
  term.onRender(schedule);
  term.onCursorMove(schedule);
  const ta = term.textarea;
  if (ta) {
    for (const ev of ['focus', 'compositionstart', 'compositionupdate', 'keydown']) {
      ta.addEventListener(ev, () => { setTimeout(place, 0); requestAnimationFrame(place); });
    }
  }
  tab.placeIme = place;
}

async function launch(tab) {
  const { cols, rows } = tab.term;
  tab.alive = true;
  tab.busy = false;
  tab.done = false;
  if (tab.isNew) {
    tab.sessionId = await api.newSession({ termId: tab.termId, cwd: tab.cwd, cols, rows });
    tab.isNew = false;
  } else {
    await api.resume({ termId: tab.termId, sessionId: tab.sessionId, cwd: tab.cwd, cols, rows });
  }
  renderTabs(); renderTree();
}

function relaunch(tab) {
  tab.term.reset();
  // 新会话如果一句话都没说就退出了，磁盘上没有记录，只能重新开一个
  const exists = state.sessions.some(s => s.id === tab.sessionId);
  if (!exists) tab.isNew = true;
  launch(tab);
}

function handleKey(tab, e) {
  const k = e.key;
  if (e.type !== 'keydown') {
    // 被我们处理的组合键，keyup/keypress 也要拦住
    if ((e.ctrlKey && (k === 'v' || k === 'V' || k === 'Tab')) || (e.shiftKey && k === 'Enter')) return false;
    return true;
  }
  if (e.ctrlKey && k === 'Tab') {
    cycleTab(e.shiftKey ? -1 : 1);
    return false;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (k === 'c' || k === 'C') && tab.term.hasSelection()) {
    api.writeClipboard(tab.term.getSelection());
    tab.term.clearSelection();
    return false;
  }
  if (e.ctrlKey && !e.altKey && (k === 'v' || k === 'V')) {
    pasteInto(tab);
    return false;
  }
  if (e.shiftKey && !e.ctrlKey && !e.altKey && k === 'Enter') {
    if (tab.alive) api.write(tab.termId, '\x1b\r'); // Claude Code 把 ESC+回车 当作换行
    return false;
  }
  if (e.ctrlKey && e.shiftKey && (k === 'W' || k === 'w')) {
    closeTab(tab.termId);
    return false;
  }
  return true;
}

// Claude Code 的"从剪贴板粘贴图片"快捷键：Windows / WSL 是 Alt+V，其他平台是 Ctrl+V
function imagePasteKey() { return state.platform === 'win32' ? '\x1bv' : '\x16'; }

async function pasteInto(tab) {
  if (!tab.alive) return;
  // 剪贴板里是图片时，替用户按下 Claude 的图片粘贴键，Claude 会自己去读剪贴板里的图
  if (await api.clipboardHasImage()) { api.write(tab.termId, imagePasteKey()); return; }
  const text = await api.readClipboard();
  if (text) tab.term.paste(text);
}

// 把文件路径交给 Claude：图片路径会被它识别成 [Image #N]，其他文件就是普通路径
function quotePath(p) { return /[\s"'&()]/.test(p) ? `"${p}"` : p; }
function dropFilesInto(tab, files) {
  if (!tab || !tab.alive) return;
  const paths = [...files].map(f => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  tab.term.paste(paths.map(quotePath).join(' ') + ' ');
  tab.term.focus();
}

function activate(termId) {
  activeId = termId;
  for (const t of tabs.values()) t.wrap.classList.toggle('hidden-term', t.termId !== termId);
  const t = tabs.get(termId);
  $('#terms').classList.toggle('hidden', !t);
  if (t) {
    t.done = false; // 点开就算看过了
    requestAnimationFrame(() => {
      try { fitTab(t); } catch { }
      t.term.focus();
      if (t.placeIme) t.placeIme();
    });
  }
  renderAll();
}

function goHome() {
  activeId = null;
  for (const t of tabs.values()) t.wrap.classList.add('hidden-term');
  $('#terms').classList.add('hidden');
  renderAll();
}

function cycleTab(dir) {
  if (tabOrder.length < 2) return;
  const i = tabOrder.indexOf(activeId);
  activate(tabOrder[(i + dir + tabOrder.length) % tabOrder.length]);
}

async function closeTab(termId, { force = false } = {}) {
  const t = tabs.get(termId);
  if (!t) return;
  if (!force && t.alive && tabStatus(t) === 'running') {
    const ok = await confirmModal('这个会话正在工作', 'Claude 还在输出，关闭会中断它。对话记录会保留，之后可以从侧边栏接着聊。', '仍然关闭', true);
    if (!ok) return;
  }
  if (t.alive) await api.kill(termId);
  t.term.dispose();
  t.wrap.remove();
  tabs.delete(termId);
  const i = tabOrder.indexOf(termId);
  tabOrder.splice(i, 1);
  if (activeId === termId) {
    const next = tabOrder[Math.min(i, tabOrder.length - 1)];
    if (next) activate(next); else goHome();
  } else renderAll();
}

function openSession(sid, key) {
  const existing = tabForSession(sid);
  if (existing) { activate(existing.termId); return; }
  const s = state.sessions.find(x => x.id === sid);
  if (!s) return;
  const tab = createTab({ sessionId: sid, cwd: s.cwd, key: s.key || key, title: sessionTitle(s), isNew: false });
  requestAnimationFrame(() => { try { fitTab(tab); } catch { } launch(tab); });
}

function newSessionIn(cwd, key) {
  const tab = createTab({ sessionId: null, cwd, key, title: '新会话', isNew: true });
  requestAnimationFrame(() => { try { fitTab(tab); } catch { } launch(tab); });
}

async function pickFolderAndStart() {
  const dir = await api.pickFolder();
  if (!dir) return;
  const key = await api.normCwd(dir);
  const cfg = state.config;
  const patch = {};
  if (!state.sessions.some(s => s.key === key) && !state.extraProjects.some(p => p.key === key)) {
    patch.extraProjects = [...(cfg.extraProjects || []), dir];
  }
  if ((cfg.hidden || []).includes(key)) patch.hidden = cfg.hidden.filter(k => k !== key);
  if (Object.keys(patch).length) { await setCfg(patch); await refresh(); }
  newSessionIn(dir, key);
}

api.onData((id, data) => {
  const t = tabs.get(id);
  if (t) t.term.write(data);
});
api.onExit((id, code) => {
  const t = tabs.get(id);
  if (!t) return;
  t.alive = false;
  t.busy = false;
  t.done = false;
  t.term.write(`\r\n\x1b[90m────────────\r\n[会话已结束${code ? '，退出码 ' + code : ''}] 按 Enter 重新打开，或关掉这个标签。\x1b[0m\r\n`);
  renderTabs(); renderTree();
});

// 终端区域尺寸变化时重新适配。
// xterm DOM renderer 会把 css.cell.width 重算成 round(真实字符宽*cols)/cols（先取整再分摊），
// 比原始字符宽略大；fit.proposeDimensions 用这个被放大的宽度去 floor 除容器宽，
// 画布就会比容器宽出最多 ~1px*cols 的取整差，右侧被裁。这里用原始未取整的字符宽重算列数。
function fitTab(t) {
  if (!t || t.wrap.classList.contains('hidden-term')) return false;
  const core = t.term._core;
  const rs = core && core._renderService;
  const dpr = (core._coreBrowserService && core._coreBrowserService.dpr) || window.devicePixelRatio || 1;
  const dim = rs && rs.dimensions;
  const deviceCharW = dim && dim.device && dim.device.char && dim.device.char.width;
  const rawCellW = deviceCharW ? deviceCharW / dpr : (dim && dim.css && dim.css.cell && dim.css.cell.width);
  const cellH = dim && dim.css && dim.css.cell && dim.css.cell.height;
  if (!rawCellW || !cellH) return false;
  const cs = getComputedStyle(t.wrap);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const scrollbar = t.term.options.scrollback === 0 ? 0 : (t.term.options.overviewRuler?.width || 14);
  const availW = Math.max(0, t.wrap.clientWidth - padX - scrollbar);
  const availH = Math.max(0, t.wrap.clientHeight - padY);
  const cols = Math.max(2, Math.floor(availW / rawCellW));
  const rows = Math.max(1, Math.floor(availH / cellH));
  if (cols !== t.term.cols || rows !== t.term.rows) { t.term.resize(cols, rows); return true; }
  return false;
}
new ResizeObserver(() => {
  const t = tabs.get(activeId);
  fitTab(t);
}).observe($('#stage'));

// ================= 浮层菜单 =================
// items: { label, icon, sub, danger, run } | '-' | { header }
function showMenu(x, y, items) {
  const m = $('#ctx-menu');
  m.innerHTML = items.map((it, i) => {
    if (it === '-') return '<div class="ctx-sep"></div>';
    if (it.header) return `<div class="ctx-label">${esc(it.header)}</div>`;
    return `<div class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}" title="${esc(it.title || '')}">
      ${it.icon ? icon(it.icon, 16) : ''}<span class="ctx-text">${esc(it.label)}</span>${it.sub ? `<span class="ctx-sub">${esc(it.sub)}</span>` : ''}
    </div>`;
  }).join('');
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  m.onclick = e => {
    const el = e.target.closest('.ctx-item');
    if (!el) return;
    hideMenu();
    items[+el.dataset.i].run();
  };
}
function hideMenu() { $('#ctx-menu').classList.add('hidden'); }
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx-menu')) hideMenu(); });
window.addEventListener('blur', hideMenu);

async function setCfg(patch) {
  state.config = await api.setConfig(patch);
  renderAll();
}
function toggleIn(list, v) {
  const s = new Set(list || []);
  s.has(v) ? s.delete(v) : s.add(v);
  return [...s];
}

function projectMenu(x, y, key) {
  const g = findProject(key);
  if (!g) return;
  const cfg = state.config;
  const isPinned = (cfg.pinned || []).includes(key);
  const isHidden = (cfg.hidden || []).includes(key);
  showMenu(x, y, [
    { label: '在这里新开会话', icon: 'plus', run: () => newSessionIn(g.cwd, key) },
    '-',
    { label: isPinned ? '取消置顶' : '置顶', icon: 'pin', run: () => setCfg({ pinned: toggleIn(cfg.pinned, key) }) },
    { label: '上移', icon: 'chevronUp', run: () => moveProject(key, -1) },
    { label: '下移', icon: 'chevronDown', run: () => moveProject(key, 1) },
    { label: '在资源管理器中打开', icon: 'folderOpen', run: () => api.openPath(g.cwd) },
    { label: '复制路径', icon: 'copy', run: () => api.writeClipboard(g.cwd) },
    { label: `归档较早的会话（保留最近 ${SESSIONS_PREVIEW} 个）`, icon: 'archive', run: () => archiveOlder(key) },
    '-',
    {
      label: isHidden ? '取消隐藏' : '隐藏这个项目', icon: isHidden ? 'eye' : 'eyeOff', danger: !isHidden, run: () => {
        const patch = { hidden: toggleIn(cfg.hidden, key) };
        if (!isHidden) patch.extraProjects = (cfg.extraProjects || []).filter(p => !state.extraProjects.find(x => x.cwd === p && x.key === key));
        setCfg(patch).then(refresh);
      },
    },
  ]);
}

function sessionMenu(e, sid, key) {
  const s = state.sessions.find(x => x.id === sid);
  const t = tabForSession(sid);
  const items = [];
  if (s && !(t && t.termId === activeId)) items.push({ label: t ? '切换到这个会话' : '打开并继续', icon: 'chat', run: () => openSession(sid, key) });
  if (s) items.push({
    label: '重命名…', icon: 'pencil', run: async () => {
      const v = await inputModal('重命名会话', '只在本工具里显示，不会改动 Claude 的记录。留空恢复原名。', state.config.aliases?.[sid] || sessionTitle(s));
      if (v === null) return;
      const aliases = { ...(state.config.aliases || {}) };
      if (v.trim() && v.trim() !== (s.title || '')) aliases[sid] = v.trim(); else delete aliases[sid];
      await setCfg({ aliases });
    },
  });
  if (s) {
    const arch = isArchived(sid);
    if (!arch) items.push({ label: isPinnedSession(sid) ? '取消置顶' : '置顶', icon: 'pin', run: () => togglePinSession(sid) });
    items.push(arch
      ? { label: '取消归档', icon: 'unarchive', run: () => unarchiveSessions([sid]) }
      : { label: '归档', icon: 'archive', run: () => archiveSessions([sid]) });
    items.push('-');
  }
  items.push({ label: '复制会话 ID', icon: 'copy', run: () => api.writeClipboard(sid) });
  if (s) items.push({ label: '复制继续命令', icon: 'terminal', run: () => api.writeClipboard(`cd "${s.cwd}"; claude --resume ${sid}`) });
  if (t || s) items.push('-');
  if (t) items.push({ label: '关闭会话', icon: 'x', run: () => closeTab(t.termId) });
  if (s) items.push({ label: '删除…', icon: 'trash', danger: true, run: () => deleteSessionFlow(sid) });
  showMenu(e.clientX, e.clientY, items);
}

function newChatMenu() {
  const r = $('#btn-new').getBoundingClientRect();
  const projects = buildProjects({ ignoreSearch: true }).slice(0, 7);
  showMenu(r.left, r.bottom + 4, [
    { header: '在哪个项目里新开会话' },
    ...projects.map(g => ({ label: projectLabel(g.cwd), sub: g.sessions.length ? String(g.sessions.length) : '', icon: 'folder', title: g.cwd, run: () => newSessionIn(g.cwd, g.key) })),
    ...(projects.length ? ['-'] : []),
    { label: '选择文件夹…', icon: 'folderPlus', run: pickFolderAndStart },
  ]);
}

// ================= 归档 / 置顶 / 删除 =================
let toastTimer = null;
function toast(msg, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button id="toast-act">${esc(actionLabel)}</button>` : ''}`;
  el.classList.remove('hidden');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  if (actionLabel) $('#toast-act').onclick = () => { hideToast(); action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() { $('#toast').classList.add('hidden'); }

async function archiveSessions(ids, { silent = false } = {}) {
  ids = ids.filter(Boolean);
  if (!ids.length) return;
  const set = new Set(state.config.archived || []);
  ids.forEach(id => set.add(id));
  const pinnedSessions = (state.config.pinnedSessions || []).filter(id => !ids.includes(id));
  await setCfg({ archived: [...set], pinnedSessions });
  if (!silent) toast(ids.length === 1 ? '已归档' : `已归档 ${ids.length} 个会话`, '撤销', () => unarchiveSessions(ids, { silent: true }));
}

async function unarchiveSessions(ids, { silent = false } = {}) {
  const drop = new Set(ids);
  await setCfg({ archived: (state.config.archived || []).filter(id => !drop.has(id)) });
  if (!silent) toast(ids.length === 1 ? '已取消归档，回到项目列表里了' : `已取消归档 ${ids.length} 个会话`, '撤销', () => archiveSessions(ids, { silent: true }));
}

function togglePinSession(id) {
  return setCfg({ pinnedSessions: toggleIn(state.config.pinnedSessions, id) });
}

async function archiveOlder(key) {
  const g = findProject(key);
  if (!g) return;
  const real = g.sessions.filter(x => !x.pending).sort((a, b) => b.updatedAt - a.updatedAt);
  const keepIds = new Set(real.filter(x => !isPinnedSession(x.id)).slice(0, SESSIONS_PREVIEW).map(x => x.id));
  const ids = real.filter(x => !keepIds.has(x.id) && !isPinnedSession(x.id) && !tabForSession(x.id)).map(x => x.id);
  if (!ids.length) { toast(`这个项目没有需要整理的会话`); return; }
  const ok = await confirmModal('归档较早的会话',
    `保留「${projectLabel(g.cwd)}」里最近的 ${SESSIONS_PREVIEW} 个、置顶的和已经打开的会话，其余 ${ids.length} 个移到「已归档」。随时可以取消归档。`,
    `归档 ${ids.length} 个`);
  if (ok) archiveSessions(ids);
}

async function deleteSessionFlow(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  const ok = await confirmModal('删除这个会话？',
    `「${sessionTitle(s)}」的对话记录会移到回收站，之后在 Claude 里也找不到它了。需要的话可以从回收站还原。`,
    '删除', true);
  if (!ok) return;
  const t = tabForSession(id);
  if (t) {
    await closeTab(t.termId, { force: true });
    await new Promise(r => setTimeout(r, 400)); // 等 claude 进程释放文件
  }
  const r = await api.deleteSession(id);
  if (!r.ok) { toast('删除失败：' + r.error); return; }
  applyState(r.state);
  toast('已移到回收站');
}

// ================= 弹窗 =================
function modal(html) {
  $('#modal').innerHTML = html;
  $('#modal-mask').classList.remove('hidden');
}
function closeModal() { $('#modal-mask').classList.add('hidden'); $('#modal').innerHTML = ''; tabs.get(activeId)?.term.focus(); }

function inputModal(title, hint, value) {
  return new Promise(resolve => {
    modal(`<h3>${esc(title)}</h3>
      <div class="field"><input type="text" class="text-input" id="m-input" value="${esc(value)}" spellcheck="false">
      <div class="field-hint">${esc(hint)}</div></div>
      <div class="modal-btns"><button class="btn btn-ghost" id="m-cancel">取消</button><button class="btn btn-primary" id="m-ok">保存</button></div>`);
    const inp = $('#m-input');
    inp.focus(); inp.select();
    const done = v => { closeModal(); resolve(v); };
    $('#m-ok').onclick = () => done(inp.value);
    $('#m-cancel').onclick = () => done(null);
    inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
  });
}

function confirmModal(title, text, okText, danger) {
  return new Promise(resolve => {
    modal(`<h3>${esc(title)}</h3><div class="modal-text">${esc(text)}</div>
      <div class="modal-btns"><button class="btn btn-ghost" id="m-cancel">取消</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok">${esc(okText || '确定')}</button></div>`);
    const done = v => { closeModal(); resolve(v); };
    $('#m-ok').onclick = () => done(true);
    $('#m-cancel').onclick = () => done(false);
    $('#m-ok').focus();
  });
}

function segmented(id, options, value) {
  return `<div class="segmented" id="${id}">${options.map(([v, label]) =>
    `<button data-v="${v}" class="${v === value ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
}
function bindSegmented(id) {
  const el = $('#' + id);
  el.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  };
  return () => el.querySelector('button.on')?.dataset.v;
}

function settingsModal() {
  const c = state.config;
  modal(`<h3>设置</h3>
    <div class="field">
      <div class="field-label">外观</div>
      ${segmented('s-appearance', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']], c.appearance || 'system')}
    </div>
    <div class="field">
      <div class="field-label">配色</div>
      ${segmented('s-palette', [['classic', '经典米色'], ['modern', '新版中性灰']], c.palette || 'classic')}
    </div>
    <label class="check-row"><input type="checkbox" id="s-sync" ${c.syncClaudeTheme !== false ? 'checked' : ''}>
      <span>让 Claude 的配色跟着浅色 / 深色走<div class="field-hint">关掉后 Claude 用你自己在 /config 里设的主题。已经打开的会话要重新打开才会换。</div></span></label>
    <label class="check-row"><input type="checkbox" id="s-scripted" ${c.showScripted ? 'checked' : ''}><span>显示脚本会话（claude -p / SDK 调用产生的）</span></label>
    <label class="check-row"><input type="checkbox" id="s-hidden" ${c.showHidden ? 'checked' : ''}><span>显示已隐藏的项目</span></label>
    <label class="check-row"><input type="checkbox" id="s-usage" ${c.showUsage !== false ? 'checked' : ''}><span>在侧边栏显示用量（5 小时 / 本周额度）</span></label>
    ${state.platform === 'win32' ? `<div class="field">
      <div class="field-label">状态栏跟随窗口宽度重排</div>
      ${segmented('s-slr', [['1', '每秒'], ['2', '2 秒'], ['5', '5 秒'], ['0', '关闭']], String(c.statuslineRefresh ?? 1))}
      <div class="field-hint">窗口变窄后，Claude 不会重新生成状态栏，只会把它截成"…"。开启后按这个间隔检查一次宽度；宽度和内容都没变时直接复用上次的结果，开销很小。对之后打开的会话生效。</div>
    </div>` : ''}
    <div class="field">
      <div class="field-label">网页链接打开方式</div>
      ${segmented('s-link', [['quicklook', '右侧速览窗'], ['ego', 'ego 独立窗口'], ['system', '系统浏览器']], c.linkTarget || 'quicklook')}
      <div class="field-hint">速览窗和 ego 独立窗口都需要装 ego lite（只支持 Windows）；没装时自动用系统浏览器。</div>
    </div>
    <div class="field">
      <div class="field-label">启动 claude 时附加的参数</div>
      <input type="text" class="text-input" id="s-args" value="${esc(c.claudeArgs || '')}" placeholder="例如 --dangerously-skip-permissions --model opus" spellcheck="false">
      <div class="field-hint">默认带 --dangerously-skip-permissions：Claude 改文件、执行命令都不再逐个确认。不想要就删掉它。对之后打开的会话生效。</div>
    </div>
    <div class="field">
      <div class="field-label">终端字号</div>
      <input type="number" class="text-input" id="s-font" min="10" max="24" value="${c.fontSize || 14}" style="width:110px">
      <div class="field-hint">Claude 路径：${esc(state.claudePath || '没找到 claude，将通过 cmd 调用')}</div>
    </div>
    <div class="modal-btns"><button class="btn btn-ghost" id="m-cancel">取消</button><button class="btn btn-primary" id="m-ok">保存</button></div>`);
  const getAppearance = bindSegmented('s-appearance');
  const getPalette = bindSegmented('s-palette');
  const getLink = bindSegmented('s-link');
  const getSlr = state.platform === 'win32' ? bindSegmented('s-slr') : () => String(c.statuslineRefresh ?? 1);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const fontSize = Math.max(10, Math.min(24, parseInt($('#s-font').value, 10) || 14));
    await setCfg({
      appearance: getAppearance(),
      palette: getPalette(),
      syncClaudeTheme: $('#s-sync').checked,
      showScripted: $('#s-scripted').checked,
      showHidden: $('#s-hidden').checked,
      showUsage: $('#s-usage').checked,
      linkTarget: getLink(),
      statuslineRefresh: Number(getSlr()) || 0,
      claudeArgs: $('#s-args').value.trim(),
      fontSize,
    });
    for (const t of tabs.values()) t.term.options.fontSize = fontSize;
    closeModal();
    // 外观切换后主进程会推送 theme:updated；配色切换在这里直接应用
    requestAnimationFrame(applyTheme);
    fitTab(tabs.get(activeId));
  };
}

// ================= 事件绑定 =================
$('#tree').addEventListener('click', e => {
  const ar = e.target.closest('[data-arch]');
  if (ar) { e.stopPropagation(); archiveSessions([ar.dataset.arch]); return; }
  const ua = e.target.closest('[data-unarch]');
  if (ua) { e.stopPropagation(); unarchiveSessions([ua.dataset.unarch]); return; }
  const dl = e.target.closest('[data-del]');
  if (dl) { e.stopPropagation(); deleteSessionFlow(dl.dataset.del); return; }
  const sm = e.target.closest('[data-smore]');
  if (sm) { e.stopPropagation(); const r = sm.getBoundingClientRect(); sessionMenu({ clientX: r.left, clientY: r.bottom + 4 }, sm.dataset.smore, sm.dataset.key); return; }
  const less = e.target.closest('[data-less]');
  if (less) { expandedMore.delete(less.dataset.less); renderTree(); return; }
  const add = e.target.closest('[data-add]');
  if (add) { e.stopPropagation(); const g = findProject(add.dataset.add); if (g) newSessionIn(g.cwd, g.key); return; }
  const pm = e.target.closest('[data-pmore]');
  if (pm) { e.stopPropagation(); const r = pm.getBoundingClientRect(); projectMenu(r.left, r.bottom + 4, pm.dataset.pmore); return; }
  const more = e.target.closest('[data-more]');
  if (more) { expandedMore.add(more.dataset.more); renderTree(); return; }
  const sess = e.target.closest('.sess');
  if (sess) {
    const t = tabForSession(sess.dataset.sid);
    if (t) activate(t.termId); else openSession(sess.dataset.sid, sess.dataset.key);
    return;
  }
  const row = e.target.closest('.proj-row');
  if (row) {
    const key = row.dataset.key;
    const el = row.parentElement;
    const collapsed = !el.classList.contains('collapsed');
    el.classList.toggle('collapsed', collapsed);
    state.config.collapsed = { ...(state.config.collapsed || {}), [key]: collapsed };
    api.setConfig({ collapsed: state.config.collapsed });
  }
});
$('#tree').addEventListener('contextmenu', e => {
  e.preventDefault();
  const sess = e.target.closest('.sess');
  if (sess) { if (!sess.classList.contains('pending')) sessionMenu(e, sess.dataset.sid, sess.dataset.key); return; }
  const row = e.target.closest('.proj-row');
  if (row) projectMenu(e.clientX, e.clientY, row.dataset.key);
});


$('#search').addEventListener('input', e => { search = e.target.value; renderTree(); });
$('#search').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; search = ''; renderTree(); } });
$('#btn-new').onclick = newChatMenu;
$('#btn-archive').onclick = () => setSideView('archive');
$('.wordmark').addEventListener('dblclick', goHome);
function setCollapsed(v) {
  $('#app').classList.toggle('side-collapsed', v);
  $('#btn-expand').classList.toggle('hidden', !v);
  api.setConfig({ sidebarCollapsed: v });
  state.config.sidebarCollapsed = v;
  requestAnimationFrame(() => { fitTab(tabs.get(activeId)); });
}
$('#btn-collapse').onclick = () => setCollapsed(true);
$('#btn-expand').onclick = () => setCollapsed(false);

$('#modal-mask').addEventListener('mousedown', e => { if (e.target.id === 'modal-mask') closeModal(); });
window.addEventListener('focus', () => {
  const t = tabs.get(activeId);
  if (t && t.done) { t.done = false; updateStatusDom(); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal-mask').classList.contains('hidden')) closeModal();
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
});

// 侧边栏拖动调整宽度
(() => {
  const rz = $('#resizer'), side = $('#sidebar');
  let dragging = false;
  rz.addEventListener('mousedown', e => { dragging = true; rz.classList.add('dragging'); e.preventDefault(); });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    side.style.width = Math.max(220, Math.min(520, e.clientX)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; rz.classList.remove('dragging');
    api.setConfig({ sidebarWidth: parseInt(side.style.width, 10) });
    fitTab(tabs.get(activeId));
  });
})();

// ================= 数据 =================
function applyState(s) {
  const paletteChanged = s.config.palette !== state.config.palette || s.dark !== state.dark;
  state = s;
  if (paletteChanged) applyTheme();
  renderAll();
}
async function refresh() { applyState(await api.getSessions()); }
api.onSessionsUpdate(applyState);

(async () => {
  hydrateIcons();
  const s = await api.getSessions();
  if (s.config.sidebarWidth) $('#sidebar').style.width = s.config.sidebarWidth + 'px';
  if (s.config.sidebarCollapsed) { $('#app').classList.add('side-collapsed'); $('#btn-expand').classList.remove('hidden'); }
  state = s;
  if (s.platform === 'win32') $('#btn-ego').classList.remove('hidden');
  applyTheme();
  usage = await api.getUsage();
  renderAll();
  // 重置倒计时每 30 秒刷新一次
  setInterval(renderUsage, 30000);
  // 每分钟刷新一次"x 分钟前"和问候语
  setInterval(() => { renderTree(); if (!activeId) renderHome(); }, 60000);
})();
