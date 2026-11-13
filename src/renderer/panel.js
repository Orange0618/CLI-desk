'use strict';
/* global $, icon, api, state, tabs, activeId */
// ==========================================================================
// 右侧预览面板（通用容器）：拖动分隔条调宽、加宽 / 还原、关闭。
// 具体内容由各渲染器（目前是图片）填进 head / toolbar / body。
// ==========================================================================

const panel = { open: false, kind: null, max: false, hooks: {} };
const PANEL_MIN = 300;   // 面板最窄
const TERM_MIN = 380;    // 终端区至少留这么宽
const PANEL_DEFAULT = 480;

function panelLimit() {
  const w = $('#workspace').getBoundingClientRect().width;
  return Math.max(PANEL_MIN, w - TERM_MIN - 24);
}
function applyPanelWidth(px) {
  const w = Math.round(Math.max(PANEL_MIN, Math.min(panelLimit(), px)));
  $('#side-panel').style.width = w + 'px';
  return w;
}
function savedPanelWidth() { return state.config.previewWidth || PANEL_DEFAULT; }

// 打开面板，返回各个插槽元素；如果已经被别的渲染器占用，先让它清理
function openPanel(kind, hooks = {}) {
  if (panel.open && panel.kind !== kind && panel.hooks.onClose) panel.hooks.onClose();
  const el = $('#side-panel');
  const fresh = !panel.open || panel.kind !== kind;
  panel.kind = kind;
  panel.hooks = hooks;
  // 顶部一行是速览窗的标签栏（由 quicklook.js 渲染，切换内容时保留），下面是当前内容
  if (!el.querySelector('.pv-tabbar')) {
    el.innerHTML = `
      <div class="pv-tabbar">
        <div class="pv-tabs"></div>
        <button class="pv-btn" data-pv="new" title="新建网页">${icon('plus', 15, 2)}</button>
        <span class="pv-sep"></span>
        <button class="pv-btn" data-pv="max" title="加宽 / 还原">${icon(panel.max ? 'shrink' : 'expand', 15)}</button>
        <button class="pv-btn" data-pv="close" title="收起速览窗 (Esc)">${icon('x', 16, 2)}</button>
      </div>
      <div class="pv-main"></div>`;
  }
  if (fresh) {
    el.querySelector('.pv-main').innerHTML = `
      <div class="pv-head">
        <div class="pv-title"><span class="pv-name"></span><span class="pv-meta"></span></div>
        <div class="pv-actions"></div>
      </div>
      <div class="pv-toolbar"></div>
      <div class="pv-body"></div>`;
  }
  if (panel.onOpened) panel.onOpened();
  if (!panel.open) {
    panel.open = true;
    panel.max = false;
    applyPanelWidth(savedPanelWidth());
    el.classList.remove('hidden');
    $('#panel-resizer').classList.remove('hidden');
    $('#workspace').classList.add('panel-open');
  }
  return {
    name: el.querySelector('.pv-name'),
    meta: el.querySelector('.pv-meta'),
    actions: el.querySelector('.pv-actions'),
    toolbar: el.querySelector('.pv-toolbar'),
    body: el.querySelector('.pv-body'),
    fresh,
  };
}

function closePanel() {
  if (!panel.open) return;
  if (panel.hooks.onClose) panel.hooks.onClose();
  panel.open = false;
  panel.kind = null;
  panel.hooks = {};
  const el = $('#side-panel');
  el.classList.add('hidden');
  el.innerHTML = '';
  $('#panel-resizer').classList.add('hidden');
  $('#workspace').classList.remove('panel-open');
  if (panel.onClosed) panel.onClosed();
  tabs.get(activeId)?.term.focus();
}

function togglePanelMax() {
  panel.max = !panel.max;
  applyPanelWidth(panel.max ? panelLimit() : savedPanelWidth());
  const b = $('#side-panel [data-pv="max"]');
  if (b) b.innerHTML = icon(panel.max ? 'shrink' : 'expand', 15);
}

// ---- 事件 ----
$('#side-panel').addEventListener('click', e => {
  const b = e.target.closest('[data-pv]');
  if (!b) return;
  if (b.dataset.pv === 'close') closePanel();
  else if (b.dataset.pv === 'max') togglePanelMax();
  else if (b.dataset.pv === 'new' && panel.onNew) panel.onNew();
});
// 点进面板时把键盘焦点交给面板，这样方向键 / Esc 不会传进 claude
$('#side-panel').addEventListener('mousedown', e => {
  if (!e.target.closest('input, textarea')) $('#side-panel').focus({ preventScroll: true });
});
$('#side-panel').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
  if (panel.hooks.onKey) panel.hooks.onKey(e);
});
new ResizeObserver(() => { if (panel.open && panel.hooks.onResize) panel.hooks.onResize(); }).observe($('#side-panel'));
window.addEventListener('resize', () => { if (panel.open) applyPanelWidth(panel.max ? panelLimit() : savedPanelWidth()); });

// 拖动分隔条调宽
(() => {
  const rz = $('#panel-resizer');
  let drag = null;
  rz.addEventListener('mousedown', e => {
    drag = { x: e.clientX, w: $('#side-panel').getBoundingClientRect().width };
    rz.classList.add('dragging');
    document.body.classList.add('col-resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    panel.max = false;
    applyPanelWidth(drag.w + (drag.x - e.clientX));
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    rz.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    const w = Math.round($('#side-panel').getBoundingClientRect().width);
    state.config.previewWidth = w;
    api.setConfig({ previewWidth: w });
    const b = $('#side-panel [data-pv="max"]');
    if (b) b.innerHTML = icon('expand', 15);
  });
  // 双击分隔条：恢复默认宽度
  rz.addEventListener('dblclick', () => {
    panel.max = false;
    const w = applyPanelWidth(PANEL_DEFAULT);
    state.config.previewWidth = w;
    api.setConfig({ previewWidth: w });
  });
})();
