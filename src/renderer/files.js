'use strict';
/* global $, esc, icon, api, state, panel, toast, qlOpenFile, qlOpenWeb */
// ==========================================================================
// 终端里的文件路径：只给真实存在、能预览的文件加下划线；
// 悬停：图片出缩略图，其他文件出信息卡；点击：在右侧面板按类型预览。
// 支持的扩展名由主进程提供（state.previewExts）。
// ==========================================================================

const KIND_LABEL = { image: '图片', markdown: 'Markdown', code: '代码', pdf: 'PDF' };
const KIND_ICON = { image: 'image', markdown: 'fileText', code: 'fileCode', pdf: 'fileText' };

const fileUrl = p => 'ccsfile://f/?p=' + encodeURIComponent(p);
const imgUrl = fileUrl;
const humanSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const baseNameOf = p => String(p).split(/[\\/]/).pop();
const dirNameOf = p => String(p).replace(/[\\/][^\\/]*$/, '');

let FILE_RE = null;
function fileRegexes() {
  if (FILE_RE) return FILE_RE;
  const exts = state.previewExts || { image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] };
  const kindByExt = {};
  for (const [k, list] of Object.entries(exts)) for (const e of list) kindByExt[e] = k;
  const alt = Object.keys(kindByExt).sort((a, b) => b.length - a.length).join('|');
  FILE_RE = {
    // 绝对路径：盘符开头，段里允许空格，不允许 : * ? " < > |
    abs: new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]+?\.(?:${alt})(?![A-Za-z0-9])`, 'gi'),
    // 相对路径：icon-16.png、src/main.js（不含空格；网址里的不算）
    rel: new RegExp(String.raw`(?<![\w\\/.:\-@一-鿿])(?:[\w.\-一-鿿]+[\\/])*[\w\-一-鿿][\w.\-一-鿿]*\.(?:${alt})(?![A-Za-z0-9])`, 'gi'),
    kindOf: p => kindByExt[((String(p).match(/\.([A-Za-z0-9]+)$/) || [])[1] || '').toLowerCase()] || null,
  };
  return FILE_RE;
}
// 纯文本网址：遇到空白、引号、尖括号、中文标点就截止
const URL_RE = /\bhttps?:\/\/[^\s<>"'`，。；！？、（）【】「」《》]+/gi;
// 去掉末尾的标点；右括号只在网址里没有对应左括号时去掉（比如 markdown 的 (https://...)）
function trimUrl(u) {
  u = u.replace(/[.,;:!?'"*_~]+$/, '');
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (u.endsWith(c) && u.split(o).length < u.split(c).length) u = u.slice(0, -1);
  }
  return u.replace(/[.,;:!?'"]+$/, '');
}
function findUrlMatches(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length > 'https://'.length) out.push({ i: m.index, j: m.index + url.length, url });
  }
  return out;
}
const ABS_DIR_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?:()（）]*/g;

// 一个逻辑行（含自动折行）的文字，以及每个字符对应的单元格坐标（1 起）
function logicalLine(buffer, row) {
  let start = row, end = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  while (buffer.getLine(end + 1)?.isWrapped) end++;
  let text = '';
  const map = [];
  const cell = buffer.getNullCell();
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue;
      const ch = cell.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) map.push({ x: x + 1, y: y + 1, w });
      text += ch;
    }
  }
  return { text, map, start, end };
}

function findFileMatches(text) {
  const re = fileRegexes();
  const out = [], taken = [];
  for (const m of text.matchAll(re.abs)) {
    out.push({ i: m.index, j: m.index + m[0].length, text: m[0], kind: re.kindOf(m[0]) });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(re.rel)) {
    const i = m.index, j = i + m[0].length;
    if (taken.some(([a, b]) => i < b && j > a)) continue;
    out.push({ i, j, text: m[0], kind: re.kindOf(m[0]) });
  }
  return out.sort((a, b) => a.i - b.i);
}

// 相对名字的候选目录：从这一行往上找最近出现的绝对路径，最后加上会话的工作目录
function candidateDirs(tab, row) {
  const b = tab.term.buffer.active;
  const dirs = [], seen = new Set();
  const add = d => { d = d.replace(/[\\/]+$/, ''); const k = d.toLowerCase(); if (d.length > 2 && !seen.has(k)) { seen.add(k); dirs.push(d); } };
  for (let y = row; y >= Math.max(0, row - 600) && dirs.length < 40; y--) {
    const t = b.getLine(y)?.translateToString(true) || '';
    for (const m of t.matchAll(ABS_DIR_RE)) {
      let p = m[0].replace(/[.,;，。；、]+$/, '');
      if (/\.[A-Za-z0-9]{1,6}$/.test(p)) p = dirNameOf(p); // 文件路径 → 所在目录
      add(p);
    }
  }
  if (tab.cwd) add(tab.cwd);
  return dirs;
}

// 解析结果缓存：找到的长期有效；没找到的 8 秒后重试（文件可能刚被创建）
async function resolveFile(tab, text, row) {
  tab.fileCache = tab.fileCache || new Map();
  const abs = /^[A-Za-z]:[\\/]/.test(text);
  const key = text + '@' + (abs ? '' : row);
  const hit = tab.fileCache.get(key);
  if (hit && (hit.r || Date.now() - hit.t < 8000)) return hit.r;
  const r = await api.fileResolve({ name: text, dirs: abs ? [] : candidateDirs(tab, row) });
  tab.fileCache.set(key, { r, t: Date.now() });
  return r;
}

// 整个终端缓冲区里提到的某类文件（图片左右翻页用）
function collectRefs(tab, kind) {
  const b = tab.term.buffer.active;
  const refs = [], seen = new Set();
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    if (!line || line.isWrapped) continue;
    const { text, end } = logicalLine(b, y);
    for (const m of findFileMatches(text)) {
      if (kind && m.kind !== kind) continue;
      const k = m.text.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      refs.push({ text: m.text, row: y });
    }
    y = end;
  }
  return refs;
}

function setupFileLinks(tab) {
  const { term } = tab;
  term.registerLinkProvider({
    provideLinks(lineNo, callback) {
      const b = term.buffer.active;
      const { text, map } = logicalLine(b, lineNo - 1);
      const ms = findFileMatches(text).filter(m => {
        const s = map[m.i], e = map[m.j - 1];
        return s && e && !(e.y < lineNo || s.y > lineNo);
      });
      if (!ms.length) { callback(undefined); return; }
      // 只给真实存在的文件加下划线，避免 "Node.js" 这类词被误标；
      // md / pdf / 图片找不到时不加下划线，但悬停、点击会提示"找不到"
      Promise.all(ms.map(m => resolveFile(tab, m.text, map[m.i].y - 1))).then(rs => {
        const links = [];
        ms.forEach((m, k) => {
          const r = rs[k];
          const s = map[m.i], e = map[m.j - 1];
          if (!r) {
            if (m.kind === 'code') return;
            links.push({
              range: { start: { x: s.x, y: s.y }, end: { x: e.x + e.w - 1, y: e.y } },
              text: m.text,
              decorations: { underline: false, pointerCursor: false },
              activate: () => toast(`找不到 ${m.text}`),
              hover: ev => scheduleMissing(tab, m.text, s.y - 1, ev),
              leave: hideThumb,
            });
            return;
          }
          links.push({
            range: { start: { x: s.x, y: s.y }, end: { x: e.x + e.w - 1, y: e.y } },
            text: m.text,
            decorations: { underline: true, pointerCursor: true },
            activate: () => openFilePreview(tab, r, m.text, s.y - 1),
            hover: ev => scheduleHover(r, ev),
            leave: hideThumb,
          });
        });
        callback(links.length ? links : undefined);
      }, () => callback(undefined));
    },
  });
  term.registerLinkProvider({
    provideLinks(lineNo, callback) {
      const { text, map } = logicalLine(term.buffer.active, lineNo - 1);
      const links = [];
      for (const m of findUrlMatches(text)) {
        const s = map[m.i], e = map[m.j - 1];
        if (!s || !e || e.y < lineNo || s.y > lineNo) continue;
        links.push({
          range: { start: { x: s.x, y: s.y }, end: { x: e.x + e.w - 1, y: e.y } },
          text: m.url,
          decorations: { underline: true, pointerCursor: true },
          activate: () => openWebLink(m.url),
          hover: ev => scheduleUrlHover(m.url, ev),
          leave: hideThumb,
        });
      }
      callback(links.length ? links : undefined);
    },
  });
  // Claude Code 输出的 OSC 8 超链接：网页交给 openWebLink，能预览的本地文件在面板里打开
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: async (_e, uri) => {
      if (/^https?:\/\//i.test(uri)) { openWebLink(uri); return; }
      if (!/^file:/i.test(uri)) return;
      let p = decodeURIComponent(uri.replace(/^file:\/\/\/?/i, ''));
      if (/^[A-Za-z]:/.test(p)) p = p.replace(/\//g, '\\');
      const r = await api.fileResolve({ name: p, dirs: [] });
      if (r) openFilePreview(tab, r, p, term.buffer.active.viewportY);
      else api.showItem(p);
    },
  };
}

// ---------------- 悬停：图片缩略图 / 文件信息卡 ----------------
let thumbTimer = null, thumbToken = 0;
function scheduleHover(r, ev) {
  clearTimeout(thumbTimer);
  const token = ++thumbToken;
  const x = ev.clientX, y = ev.clientY;
  thumbTimer = setTimeout(() => {
    if (token !== thumbToken) return;
    const box = $('#img-hover');
    if (r.kind === 'image') {
      box.innerHTML = `<div class="ih-img checker"><img src="${imgUrl(r.path)}" alt=""></div>
        <div class="ih-meta"><span class="ih-name">${esc(baseNameOf(r.path))}</span><span class="ih-dim">${humanSize(r.size)}</span></div>
        <div class="ih-hint">点击在右侧预览</div>`;
      const img = box.querySelector('img');
      img.onload = () => { const d = box.querySelector('.ih-dim'); if (d) d.textContent = `${img.naturalWidth}×${img.naturalHeight} · ${humanSize(r.size)}`; placeThumb(x, y); };
      img.onerror = () => { box.querySelector('.ih-img').innerHTML = '<div class="ih-miss">无法显示这张图</div>'; };
    } else {
      box.innerHTML = `<div class="ih-file"><span class="ih-icon">${icon(KIND_ICON[r.kind] || 'fileText', 20)}</span>
        <div class="ih-ftext"><div class="ih-name">${esc(baseNameOf(r.path))}</div><div class="ih-dim">${KIND_LABEL[r.kind] || '文件'} · ${humanSize(r.size)}</div></div></div>
        <div class="ih-hint">点击在右侧预览</div>`;
    }
    box.classList.remove('hidden');
    placeThumb(x, y);
  }, 220);
}
// ---------------- 网页链接 ----------------
// 网页链接打开方式：quicklook 速览窗（默认）| ego 独立 ego 窗口 | system 系统浏览器
const linkTarget = () => state.platform !== 'win32' ? 'system' : (state.config.linkTarget || 'quicklook');
async function openWebLink(url) {
  hideThumb();
  const target = linkTarget();
  if (target === 'quicklook') { qlOpenWeb(url); return; }
  let host = url;
  try { host = new URL(url).host; } catch { }
  const r = target === 'ego' ? await api.openInEgo(url) : await api.openExternal(url);
  if (r && r.ok) toast(r.via === 'ego' ? `已在 ego 中打开 ${host}` : `已用浏览器打开 ${host}`);
}
function scheduleUrlHover(url, ev) {
  clearTimeout(thumbTimer);
  const token = ++thumbToken;
  const x = ev.clientX, y = ev.clientY;
  thumbTimer = setTimeout(() => {
    if (token !== thumbToken) return;
    const box = $('#img-hover');
    const shown = url.length > 90 ? url.slice(0, 87) + '…' : url;
    box.innerHTML = `<div class="ih-file"><span class="ih-icon">${icon('globe', 20)}</span>
      <div class="ih-ftext"><div class="ih-name">${{ quicklook: '点击在右侧速览窗打开', ego: '点击在 ego 中打开', system: '点击用浏览器打开' }[linkTarget()]}</div><div class="ih-dim">${esc(shown)}</div></div></div>`;
    box.classList.remove('hidden');
    placeThumb(x, y);
  }, 350);
}

// 找不到的文件：告诉用户在哪些地方找过
function scheduleMissing(tab, text, row, ev) {
  clearTimeout(thumbTimer);
  const token = ++thumbToken;
  const x = ev.clientX, y = ev.clientY;
  thumbTimer = setTimeout(() => {
    if (token !== thumbToken) return;
    const abs = /^[A-Za-z]:[\\/]/.test(text);
    const dirs = abs ? [] : candidateDirs(tab, row);
    const where = abs ? '这个路径下没有这个文件'
      : `找过：${dirs.slice(-1).concat(dirs.slice(0, 2)).filter((d, i, a) => a.indexOf(d) === i).map(d => esc(d)).join('<br>')}${/[\\/]/.test(text) ? '' : '<br>以及会话目录下的子文件夹'}`;
    const box = $('#img-hover');
    box.innerHTML = `<div class="ih-file"><span class="ih-icon miss">${icon('fileText', 20)}</span>
      <div class="ih-ftext"><div class="ih-name">找不到 ${esc(baseNameOf(text))}</div><div class="ih-dim">${where}</div></div></div>`;
    box.classList.remove('hidden');
    placeThumb(x, y);
  }, 450);
}
function placeThumb(x, y) {
  const box = $('#img-hover');
  const r = box.getBoundingClientRect();
  let left = x + 16, top = y + 18;
  if (left + r.width > innerWidth - 8) left = Math.max(8, x - r.width - 16);
  if (top + r.height > innerHeight - 8) top = Math.max(8, y - r.height - 18);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}
function hideThumb() {
  clearTimeout(thumbTimer);
  thumbToken++;
  $('#img-hover').classList.add('hidden');
}

// ---------------- 分发到各个渲染器 ----------------
async function openFilePreview(tab, r, text, row) {
  hideThumb();
  if (!r) { toast(`找不到 ${text}`); return; }
  // 能预览的文件都放进速览窗的标签里
  if (['image', 'markdown', 'code', 'pdf'].includes(r.kind)) qlOpenFile(tab, r, text, row);
  else api.showItem(r.path);
}

// 当前预览的文件变了（比如 claude 刚改完）就让渲染器自己刷新
let previewWatch = null; // { path, reload(info) }
function watchPreview(path, reload) {
  previewWatch = path ? { path, reload } : null;
  api.watchFile(path || null);
}
api.onFileChanged(info => {
  if (!previewWatch || !panel.open) return;
  if (String(info.path).toLowerCase() !== String(previewWatch.path).toLowerCase()) return;
  previewWatch.reload(info);
});
