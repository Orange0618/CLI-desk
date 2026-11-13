'use strict';
/* global $, esc, icon, api, toast, openPanel, resolveFile, collectRefs, imgUrl, humanSize, baseNameOf, watchPreview */
// ==========================================================================
// 右侧面板：图片预览（缩放 / 拖动 / 翻页）。文件识别和分发在 files.js。
// ==========================================================================

// ---------------- 右侧面板里的图片预览 ----------------
const pv = { tab: null, refs: [], index: 0, cur: null, scale: 1, tx: 0, ty: 0, fit: true, nw: 0, nh: 0, token: 0, ui: null };

// 点击终端里的图片：在右侧面板打开（已打开就换图）
function openImagePreview(tab, r, text, row) {
  pv.tab = tab;
  pv.refs = tab ? collectRefs(tab, 'image') : [];
  pv.index = pv.refs.findIndex(x => x.text.toLowerCase() === text.toLowerCase());
  if (pv.index < 0) { pv.refs.unshift({ text, row }); pv.index = 0; }
  ensureImagePanel();
  showPanelImage(r);
}

function ensureImagePanel() {
  const ui = openPanel('image', {
    onResize: () => { if (pv.fit && pv.nw) fitImage(); },
    onKey: imageKey,
    onClose: () => { pv.ui = null; pv.cur = null; watchPreview(null); },
  });
  pv.ui = ui;
  if (!ui.fresh) return;
  ui.actions.innerHTML = `
    <button class="pv-btn" data-act="copy" title="复制路径">${icon('copy', 15)}</button>
    <button class="pv-btn" data-act="folder" title="在文件夹中显示">${icon('folderOpen', 15)}</button>
    <button class="pv-btn" data-act="external" title="用系统查看器打开">${icon('external', 15)}</button>`;
  ui.toolbar.innerHTML = `
    <button class="pv-btn" data-act="fit" title="适合面板 (0)">适合</button>
    <button class="pv-btn" data-act="actual" title="原始大小 (1)">1:1</button>
    <span class="pv-sep"></span>
    <button class="pv-btn" data-act="out" title="缩小 (-)">${icon('minus', 15, 2)}</button>
    <span class="pv-zoom">100%</span>
    <button class="pv-btn" data-act="in" title="放大 (+)">${icon('plus', 15, 2)}</button>
    <span class="pv-spacer"></span>
    <button class="pv-btn pv-nav" data-act="prev" title="上一张 (←)">${icon('back', 16, 2)}</button>
    <span class="pv-count"></span>
    <button class="pv-btn pv-nav" data-act="next" title="下一张 (→)">${icon('chevron', 16, 2)}</button>`;
  ui.body.innerHTML = '<div class="pv-stage"><img class="pv-img" alt="" draggable="false"><div class="pv-miss hidden"></div></div>';
  const root = $('#side-panel');
  root.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => imageAction(b.dataset.act); });
  const stage = ui.body.querySelector('.pv-stage');
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(pv.scale * Math.pow(1.0015, -e.deltaY), e.clientX, e.clientY);
  }, { passive: false });
  let drag = null;
  stage.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx: pv.tx, ty: pv.ty };
    stage.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    pv.tx = drag.tx + e.clientX - drag.x;
    pv.ty = drag.ty + e.clientY - drag.y;
    pv.fit = false;
    applyTransform();
  });
  window.addEventListener('mouseup', () => { if (drag) { drag = null; stage.classList.remove('dragging'); } });
  stage.addEventListener('dblclick', e => {
    if (pv.fit && pv.scale < 1) zoomAt(1, e.clientX, e.clientY); else fitImage();
  });
}

function showPanelImage(r) {
  const ui = pv.ui;
  if (!ui) return;
  const token = ++pv.token;
  pv.cur = r;
  if (typeof qlFileShown === 'function') qlFileShown(r);
  watchPreview(r.path, info => { if (info.exists && pv.cur && pv.cur.path === r.path) showPanelImage({ ...pv.cur, size: info.size, mtime: info.mtime }); });
  const img = ui.body.querySelector('.pv-img');
  const miss = ui.body.querySelector('.pv-miss');
  img.style.opacity = '0';
  miss.classList.add('hidden');
  ui.name.textContent = baseNameOf(r.path);
  ui.name.title = r.path;
  ui.meta.textContent = humanSize(r.size);
  const n = pv.refs.length;
  const root = $('#side-panel');
  root.querySelector('.pv-count').textContent = n > 1 ? `${pv.index + 1} / ${n}` : '';
  root.querySelectorAll('.pv-nav').forEach(b => b.classList.toggle('hidden', n < 2));
  img.onload = () => {
    if (token !== pv.token) return;
    pv.nw = img.naturalWidth || 512;
    pv.nh = img.naturalHeight || 512;
    ui.meta.textContent = `${img.naturalWidth}×${img.naturalHeight} · ${humanSize(r.size)}`;
    fitImage();
    img.style.opacity = '1';
  };
  img.onerror = () => {
    if (token !== pv.token) return;
    miss.textContent = '无法显示这张图';
    miss.classList.remove('hidden');
  };
  img.src = imgUrl(r.path) + '&t=' + Math.round(r.mtime || 0);
}

function stageRect() { return pv.ui.body.querySelector('.pv-stage').getBoundingClientRect(); }
function fitImage() {
  if (!pv.ui || !pv.nw) return;
  const r = stageRect();
  const pad = 24;
  const s = Math.min((r.width - pad * 2) / pv.nw, (r.height - pad * 2) / pv.nh);
  // 小图（比如 16px 图标）放大显示更容易看清，最多放大到 8 倍
  pv.scale = Math.max(0.02, Math.min(s, pv.nw < 128 ? 8 : 1));
  pv.tx = (r.width - pv.nw * pv.scale) / 2;
  pv.ty = (r.height - pv.nh * pv.scale) / 2;
  pv.fit = true;
  applyTransform();
}
function zoomAt(scale, cx, cy) {
  if (!pv.ui) return;
  const r = stageRect();
  scale = Math.max(0.02, Math.min(32, scale));
  const px = cx - r.left, py = cy - r.top;
  pv.tx = px - (px - pv.tx) * (scale / pv.scale);
  pv.ty = py - (py - pv.ty) * (scale / pv.scale);
  pv.scale = scale;
  pv.fit = false;
  applyTransform();
}
function zoomCenter(scale) { const r = stageRect(); zoomAt(scale, r.left + r.width / 2, r.top + r.height / 2); }
function applyTransform() {
  if (!pv.ui) return;
  const img = pv.ui.body.querySelector('.pv-img');
  img.style.width = pv.nw + 'px';
  img.style.height = pv.nh + 'px';
  img.style.transform = `translate(${pv.tx}px, ${pv.ty}px) scale(${pv.scale})`;
  img.style.imageRendering = pv.scale >= 2 ? 'pixelated' : 'auto'; // 放大小图时保持像素清晰
  const z = $('#side-panel .pv-zoom');
  if (z) z.textContent = Math.round(pv.scale * 100) + '%';
}

async function stepImage(dir) {
  const n = pv.refs.length;
  if (n < 2 || !pv.tab) return;
  for (let k = 1; k <= n; k++) {
    const i = ((pv.index + dir * k) % n + n) % n;
    const ref = pv.refs[i];
    const r = await resolveFile(pv.tab, ref.text, ref.row);
    if (r) { pv.index = i; showPanelImage(r); return; }
  }
}

function imageAction(act) {
  const r = pv.cur;
  if (act === 'fit') fitImage();
  else if (act === 'actual') zoomCenter(1);
  else if (act === 'in') zoomCenter(pv.scale * 1.25);
  else if (act === 'out') zoomCenter(pv.scale / 1.25);
  else if (act === 'prev') stepImage(-1);
  else if (act === 'next') stepImage(1);
  else if (act === 'copy' && r) { api.writeClipboard(r.path); toast('已复制路径'); }
  else if (act === 'folder' && r) api.showItem(r.path);
  else if (act === 'external' && r) api.openPath(r.path);
}

function imageKey(e) {
  const map = { ArrowLeft: 'prev', ArrowRight: 'next', '0': 'fit', '1': 'actual', '+': 'in', '=': 'in', '-': 'out' };
  const act = map[e.key];
  if (act) { e.preventDefault(); imageAction(act); }
}
