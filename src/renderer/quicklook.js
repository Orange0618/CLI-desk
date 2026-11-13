'use strict';
/* global $, esc, icon, api, state, toast, openPanel, closePanel, panel, baseNameOf, KIND_ICON, KIND_LABEL, tabs, activeId,
          openImagePreview, openMarkdownPreview, openCodePreview, openPdfPreview */
// ==========================================================================
// 速览窗：右侧面板顶部的一排标签，网页和文件都在这里看。
//  - 网页：主进程用 ego 的 --app 模式开一个专用窗口，嵌进面板（只支持 Windows）
//  - 文件：图片 / Markdown / 代码 / PDF，用现有的预览渲染
// 收起速览窗不会关掉标签；单个标签的 × 才是关闭。
// ==========================================================================

const ql = { items: [], activeId: null, seq: 0, covered: false };
const QL_MAX_WEB = 8;
const QL_RECENT_FILES = 5;
const QL_HOME = 'https://www.bing.com/';

const qlActive = () => ql.items.find(i => i.id === ql.activeId) || null;
const hostOf = url => { try { return new URL(url).host; } catch { return url; } };
const isNative = it => it.kind === 'web'; // 由嵌入的原生窗口显示
const qlTitle = it => it.kind === 'web' ? (it.title || hostOf(it.url)) : it.kind === 'start' ? '开始' : baseNameOf(it.r.path);
const qlIcon = it => ({ web: 'globe', start: 'search' }[it.kind] || KIND_ICON[it.r.kind] || 'fileText');
const webSupported = () => state.platform === 'win32';

function qlRenderTabs() {
  const box = document.querySelector('#side-panel .pv-tabs');
  if (!box) return;
  box.innerHTML = ql.items.map(it => {
    const tip = it.kind === 'web' ? `${qlTitle(it)}\n${it.url}` : it.kind === 'file' ? it.r.path : '';
    return `<div class="pv-tab${it.id === ql.activeId ? ' active' : ''}" data-ql="${it.id}" title="${esc(tip)}">
      ${icon(qlIcon(it), 14)}<span class="pv-tab-text">${esc(qlTitle(it))}</span>${it.loading ? '<span class="spin sm"></span>' : ''}
      <button class="pv-tab-x" data-qlx="${it.id}" title="关闭这个标签">${icon('x', 12, 2)}</button>
    </div>`;
  }).join('');
  box.querySelector('.pv-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function qlActivate(it) {
  for (const x of ql.items) if (isNative(x) && x.hwnd && x !== it) api.qlShow(x.hwnd, false);
  ql.activeId = it.id;
  if (isNative(it)) qlShowNative(it);
  else if (it.kind === 'start') qlShowStart(it);
  else if (it.r.kind === 'image') openImagePreview(it.tab, it.r, it.text, it.row);
  else if (it.r.kind === 'markdown') openMarkdownPreview(it.r);
  else if (it.r.kind === 'code') openCodePreview(it.r);
  else if (it.r.kind === 'pdf') openPdfPreview(it.r);
  qlRenderTabs();
}

function qlCloseItem(it) {
  const idx = ql.items.indexOf(it);
  if (idx < 0) return;
  ql.items.splice(idx, 1);
  if (it.kind === 'web' && it.hwnd) api.qlClose(it.hwnd);
  if (ql.activeId === it.id) {
    const next = ql.items[Math.min(idx, ql.items.length - 1)];
    if (next) qlActivate(next);
    else { ql.activeId = null; closePanel(); }
  } else qlRenderTabs();
}

// ---------------- 文件 ----------------
function qlOpenFile(tab, r, text, row) {
  let it = ql.items.find(i => i.kind === 'file' && i.r.path.toLowerCase() === r.path.toLowerCase());
  if (it) Object.assign(it, { r, tab: tab || it.tab, text, row });
  else {
    it = { id: 'q' + (++ql.seq), kind: 'file', r, tab, text, row };
    const act = qlActive();
    if (act && act.kind === 'start' && panel.open) ql.items.splice(ql.items.indexOf(act), 1, it); // 从开始页打开的：替换开始页
    else ql.items.push(it);
  }
  qlRememberFile(r);
  qlActivate(it);
}
// 图片预览里左右翻页后，更新当前标签
function qlFileShown(r) {
  const it = qlActive();
  if (it && it.kind === 'file' && it.r.kind === r.kind) { it.r = r; qlRenderTabs(); }
}
function qlRememberFile(r) {
  const list = [{ path: r.path, kind: r.kind }, ...(state.config.qlRecentFiles || []).filter(x => x.path.toLowerCase() !== r.path.toLowerCase())].slice(0, QL_RECENT_FILES);
  state.config.qlRecentFiles = list;
  api.setConfig({ qlRecentFiles: list });
}
// 打开一个路径（绝对路径；或相对当前会话目录的路径）
async function qlOpenPath(p) {
  p = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!p) return false;
  const t = tabs.get(activeId);
  const r = await api.fileResolve({ name: p, dirs: t && t.cwd ? [t.cwd] : [] });
  if (!r) return false;
  qlOpenFile(t || null, r, p, 0);
  return true;
}
const looksLikePath = v => /^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v) || (/[\\/]/.test(v) && /\.[A-Za-z0-9]{1,6}$/.test(v) && !/\s/.test(v) && !/^https?:/i.test(v));

// ---------------- 网页 ----------------
async function qlOpenWeb(url) {
  if (!webSupported()) { api.openExternal(url); return; }
  const same = ql.items.find(i => i.kind === 'web' && i.url === url && (i.hwnd || i.loading));
  if (same) { qlActivate(same); return; }
  const it = { id: 'q' + (++ql.seq), kind: 'web', url, title: hostOf(url), hwnd: null, loading: true };
  const act = qlActive();
  if (act && act.kind === 'start' && panel.open) ql.items.splice(ql.items.indexOf(act), 1, it); // 开始页直接变成这个网页
  else ql.items.push(it);
  const webs = ql.items.filter(i => i.kind === 'web');
  if (webs.length > QL_MAX_WEB) qlCloseItem(webs[0]);
  qlRememberUrl(url);
  qlActivate(it);
  const r = await api.qlOpenWeb(url);
  if (!ql.items.includes(it)) { if (r.ok) api.qlClose(r.hwnd); return; } // 等待期间标签被关了
  it.loading = false;
  if (r.ok) { it.hwnd = r.hwnd; if (r.title) it.title = r.title; }
  else it.error = { 'not-installed': '没找到 ego lite（Program Files\\Citro Labs\\ego lite）', 'launch-failed': '等了 15 秒没看到 ego 的新窗口', 'bad-url': '这不是网页地址' }[r.reason] || ('打开失败：' + (r.error || ''));
  if (ql.activeId === it.id && panel.open) qlShowNative(it);
  else if (it.hwnd) api.qlShow(it.hwnd, false);
  qlRenderTabs();
}
function qlRememberUrl(url) {
  const list = [url, ...(state.config.qlRecent || []).filter(u => u !== url)].slice(0, 5);
  state.config.qlRecent = list;
  api.setConfig({ qlRecent: list });
}

// ---------------- 网页的面板 ----------------
function qlShowNative(it) {
  const ui = openPanel(it.kind, {
    onResize: qlPlace,
    onClose: () => { if (it.hwnd) api.qlShow(it.hwnd, false); },
  });
  ui.name.textContent = qlTitle(it);
  ui.name.title = it.url;
  ui.meta.textContent = hostOf(it.url);
  {
    ui.actions.innerHTML = `
      <button class="pv-btn" data-w="back" title="后退">${icon('back', 16, 2)}</button>
      <button class="pv-btn" data-w="forward" title="前进">${icon('chevron', 16, 2)}</button>
      <button class="pv-btn" data-w="reload" title="刷新">${icon('refresh', 15)}</button>
      <span class="pv-sep"></span>
      <button class="pv-btn" data-w="copy" title="复制链接">${icon('copy', 15)}</button>
      <button class="pv-btn" data-w="ego" title="在完整的 ego 窗口里打开这个链接">${icon('external', 15)}</button>
      <button class="pv-btn" data-w="popout" title="把这个页面弹出成独立窗口">${icon('expand', 15)}</button>`;
  }
  ui.actions.onclick = e => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    const act = b.dataset.w;
    if (act === 'copy') { api.writeClipboard(it.url); toast('已复制链接'); return; }
    if (act === 'ego') { api.openInEgo(it.url); toast('已在 ego 中打开'); return; }
    if (!it.hwnd) return;
    if (act === 'back') api.qlNav(it.hwnd, 1);
    else if (act === 'forward') api.qlNav(it.hwnd, 2);
    else if (act === 'reload') api.qlNav(it.hwnd, 3);
    else if (act === 'popout') {
      api.qlPopout(it.hwnd);
      it.hwnd = null; // 已经不归我们管了，关标签时不要关掉它
      qlCloseItem(it);
      toast('已弹出成独立窗口');
    }
  };
  ui.toolbar.innerHTML = '';
  const msg = it.loading ? `<div class="pv-miss"><span class="spin"></span>&nbsp; 正在用 ego 打开…</div>`
    : it.error ? `<div class="pv-miss">${esc(it.error)}</div>` : '';
  ui.body.innerHTML = `<div class="web-slot">${msg}</div>`;
  if (it.hwnd && !ql.covered) { qlPlace(); api.qlShow(it.hwnd, true); }
}

// 把当前原生窗口摆到面板内容区：告诉助手离窗口右 / 上 / 下边的距离和宽度，之后窗口变化由助手自己跟
function qlPlace() {
  const it = qlActive();
  if (!it || !isNative(it) || !it.hwnd || !panel.open) return;
  const slot = document.querySelector('#side-panel .web-slot');
  if (!slot) return;
  const r = slot.getBoundingClientRect();
  api.qlAnchor(it.hwnd, { right: innerWidth - r.right, top: r.top, bottom: innerHeight - r.bottom, width: r.width });
}

// ---------------- 开始页：浏览器 / 最近文件 / 粘贴路径 / 工作空间 ----------------
function qlNewStart() {
  let it = ql.items.find(i => i.kind === 'start');
  if (!it) { it = { id: 'q' + (++ql.seq), kind: 'start' }; ql.items.push(it); }
  qlActivate(it);
}
async function qlShowStart(it) {
  const ui = openPanel('start', {});
  ui.name.textContent = '速览窗';
  ui.meta.textContent = '看网页、看文件';
  ui.actions.innerHTML = '';
  ui.toolbar.innerHTML = '';
  const files = state.config.qlRecentFiles || [];
  const urls = state.config.qlRecent || [];
  const item = (attr, val, ic, label, sub) => `<button class="ql-recent-item" ${attr}="${esc(val)}" title="${esc(val)}">${icon(ic, 14)}<span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ''}</button>`;
  ui.body.innerHTML = `<div class="ql-start">
    <div class="ql-start-title">${icon('panelRight', 22)}<span>速览窗</span></div>
    <input class="text-input ql-input" placeholder="输入网址、搜索内容，或粘贴文件路径" spellcheck="false">
    <div class="ql-actions">
      ${webSupported() ? `<button class="btn btn-secondary" data-start="browser">${icon('globe', 15)}打开浏览器</button>` : ''}
    </div>
    <div class="ql-section"><div class="ql-recent-head">最近打开的文件</div>
      <div class="ql-recent">${files.length ? files.map(f => item('data-file', f.path, KIND_ICON[f.kind] || 'fileText', baseNameOf(f.path), KIND_LABEL[f.kind] || '')).join('') : '<div class="ql-empty">还没有。在会话里点文件名，或者把文件路径粘贴到上面的输入框</div>'}</div></div>
    ${urls.length ? `<div class="ql-section"><div class="ql-recent-head">最近打开的网页</div><div class="ql-recent">${urls.map(u => item('data-url', u, 'globe', u.replace(/^https?:\/\//, ''), '')).join('')}</div></div>` : ''}
  </div>`;
  const inp = ui.body.querySelector('.ql-input');
  setTimeout(() => inp.focus(), 50);
  const go = async v => {
    v = v.trim();
    if (!v) return;
    if (looksLikePath(v.replace(/^["']|["']$/g, ''))) {
      if (await qlOpenPath(v)) return;
      toast('打不开这个路径：文件不存在，或者不是能预览的类型');
      return;
    }
    const url = /^https?:\/\//i.test(v) ? v : (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(v) ? 'https://' + v : 'https://www.bing.com/search?q=' + encodeURIComponent(v));
    qlOpenWeb(url);
  };
  inp.onkeydown = e => { if (e.key === 'Enter') go(inp.value); };
  // 粘贴的是现成的文件路径：直接打开
  inp.addEventListener('paste', e => {
    const text = (e.clipboardData && e.clipboardData.getData('text') || '').trim();
    if (text && !text.includes('\n') && looksLikePath(text.replace(/^["']|["']$/g, ''))) {
      e.preventDefault();
      inp.value = text;
      qlOpenPath(text).then(ok => { if (!ok) toast('打不开这个路径：文件不存在，或者不是能预览的类型'); });
    }
  });
  ui.body.querySelector('[data-start="browser"]')?.addEventListener('click', () => qlOpenWeb(QL_HOME));
  ui.body.querySelectorAll('[data-file]').forEach(b => {
    b.onclick = async () => { if (!(await qlOpenPath(b.dataset.file))) toast('这个文件已经不在了'); };
  });
  ui.body.querySelectorAll('[data-url]').forEach(b => { b.onclick = () => qlOpenWeb(b.dataset.url); });
}

// ---------------- 事件 ----------------
document.querySelector('#side-panel').addEventListener('click', e => {
  const x = e.target.closest('[data-qlx]');
  if (x) { e.stopPropagation(); const it = ql.items.find(i => i.id === x.dataset.qlx); if (it) qlCloseItem(it); return; }
  const t = e.target.closest('[data-ql]');
  if (t) { const it = ql.items.find(i => i.id === t.dataset.ql); if (it && it.id !== ql.activeId) qlActivate(it); }
});
document.querySelector('#side-panel').addEventListener('auxclick', e => {
  const t = e.target.closest('[data-ql]');
  if (t && e.button === 1) { const it = ql.items.find(i => i.id === t.dataset.ql); if (it) qlCloseItem(it); }
});
const syncToggle = () => $('#btn-ego').classList.toggle('on', panel.open);
panel.onOpened = () => { qlRenderTabs(); requestAnimationFrame(syncToggle); };
panel.onNew = qlNewStart;
panel.onClosed = () => { for (const x of ql.items) if (isNative(x) && x.hwnd) api.qlShow(x.hwnd, false); syncToggle(); };

api.onQlEvent(ev => {
  if (ev.type === 'title') {
    const it = ql.items.find(i => i.hwnd === ev.hwnd);
    if (it && ev.title) {
      it.title = String(ev.title).replace(/\s*-\s*ego$/, '');
      qlRenderTabs();
      if (it.id === ql.activeId && isNative(it)) { const n = document.querySelector('#side-panel .pv-name'); if (n) n.textContent = qlTitle(it); }
    }
  } else if (ev.type === 'gone') {
    const it = ql.items.find(i => i.hwnd === ev.hwnd);
    if (it) {
      it.hwnd = null;
      qlCloseItem(it);
    }
  } else if (ev.type === 'helper-exit') {
    for (const it of ql.items.filter(isNative)) { it.hwnd = null; it.loading = false; it.error = '助手进程退出了，关掉这个标签再重新打开'; }
    if (qlActive() && isNative(qlActive()) && panel.open) qlShowNative(qlActive());
    qlRenderTabs();
  }
});
// 网页里 window.open 出来的链接（主进程转过来的）
api.onQlOpenUrl(url => qlOpenWeb(url));

// 原生窗口会盖住菜单和弹窗：它们出现时先把网页藏起来
for (const sel of ['#ctx-menu', '#modal-mask']) {
  new MutationObserver(() => {
    const covered = ['#ctx-menu', '#modal-mask'].some(s => !$(s).classList.contains('hidden'));
    if (covered === ql.covered) return;
    ql.covered = covered;
    const it = qlActive();
    if (it && isNative(it) && it.hwnd && panel.open) { if (!covered) qlPlace(); api.qlShow(it.hwnd, !covered); }
  }).observe($(sel), { attributes: true, attributeFilter: ['class'] });
}

// 顶栏按钮：打开 / 收起速览窗
$('#btn-ego').onclick = () => {
  if (panel.open) { closePanel(); return; }
  const it = qlActive() || ql.items[ql.items.length - 1];
  if (it) qlActivate(it); else qlNewStart();
};
