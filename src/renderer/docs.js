'use strict';
/* global $, esc, icon, api, toast, state, openPanel, panel, fileUrl, humanSize, baseNameOf, dirNameOf, openFilePreview,
          watchPreview, marked, DOMPurify, hljs */
// ==========================================================================
// 右侧面板：Markdown / 代码 / PDF 预览
// ==========================================================================

// 头部通用按钮：复制路径、在文件夹中显示、用系统程序打开
function docActions(ui, r) {
  ui.actions.innerHTML = `
    <button class="pv-btn" data-doc="copy-path" title="复制路径">${icon('copy', 15)}</button>
    <button class="pv-btn" data-doc="folder" title="在文件夹中显示">${icon('folderOpen', 15)}</button>
    <button class="pv-btn" data-doc="external" title="用系统默认程序打开">${icon('external', 15)}</button>`;
  ui.actions.querySelector('[data-doc="copy-path"]').onclick = () => { api.writeClipboard(r.path); toast('已复制路径'); };
  ui.actions.querySelector('[data-doc="folder"]').onclick = () => api.showItem(r.path);
  ui.actions.querySelector('[data-doc="external"]').onclick = () => api.openPath(r.path);
  ui.name.textContent = baseNameOf(r.path);
  ui.name.title = r.path;
}
function docMeta(ui, parts) { ui.meta.textContent = parts.filter(Boolean).join(' · '); }
function docMessage(ui, text) { ui.body.innerHTML = `<div class="pv-miss">${esc(text)}</div>`; }

// ---------------- 代码高亮 ----------------
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml', py: 'python', pyw: 'python', pyi: 'python', rb: 'ruby', php: 'php',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'gradle', go: 'go', rs: 'rust',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp', cs: 'csharp', fs: 'fsharp',
  swift: 'swift', m: 'objectivec', mm: 'objectivec', lua: 'lua', r: 'r', dart: 'dart', jl: 'julia',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', psm1: 'powershell', bat: 'dos', cmd: 'dos',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  properties: 'properties', cmake: 'cmake', mk: 'makefile', proto: 'protobuf', diff: 'diff', patch: 'diff', tex: 'latex',
  v: 'verilog', sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl', asm: 'x86asm', s: 'x86asm', nix: 'nix', tf: 'ini', hcl: 'ini',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', clj: 'clojure', md: 'markdown', markdown: 'markdown',
};
function langOf(p) {
  const ext = ((String(p).match(/\.([A-Za-z0-9]+)$/) || [])[1] || '').toLowerCase();
  const lang = LANG_BY_EXT[ext];
  return lang && hljs.getLanguage(lang) ? lang : null;
}
// 把高亮后的 HTML 按行切开；跨行的 <span> 在行尾关掉、下一行重新打开
function splitHighlighted(html) {
  const lines = [], stack = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)|(<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { stack.push(m[1]); cur += m[1]; }
    else if (m[2]) { stack.pop(); cur += m[2]; }
    else if (m[3]) { cur += '</span>'.repeat(stack.length); lines.push(cur); cur = stack.join(''); }
    else cur += m[4] || m[5];
  }
  lines.push(cur + '</span>'.repeat(stack.length));
  return lines;
}
function highlightToLines(text, lang) {
  if (lang && text.length < 800 * 1024) {
    try { return splitHighlighted(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value); } catch { }
  }
  return text.split('\n').map(esc);
}

// ---------------- 代码 / 文本 ----------------
const codeState = { wrap: false };
async function openCodePreview(r) {
  const ui = openPanel('code', { onClose: () => watchPreview(null) });
  docActions(ui, r);
  const lang = langOf(r.path);
  ui.toolbar.innerHTML = `
    <span class="pv-tag">${esc(lang || '纯文本')}</span>
    <span class="pv-note" data-c="lines"></span>
    <span class="pv-spacer"></span>
    <button class="pv-btn${codeState.wrap ? ' on' : ''}" data-c="wrap" title="自动换行">换行</button>
    <button class="pv-btn" data-c="copy" title="复制全部内容">${icon('copy', 15)}<span>复制</span></button>`;
  const render = async (keepScroll) => {
    const prev = ui.body.querySelector('.pv-scroll');
    const top = keepScroll && prev ? prev.scrollTop : 0;
    const res = await api.readFile(r.path);
    if (!res.ok) { docMessage(ui, res.error || '读取失败'); docMeta(ui, [humanSize(r.size)]); return; }
    const text = res.text.replace(/\r\n?/g, '\n');
    const lines = text.split('\n').length;
    docMeta(ui, [humanSize(res.size), res.encoding !== 'UTF-8' ? res.encoding : '', res.truncated ? '只显示前 3MB' : '']);
    ui.toolbar.querySelector('[data-c="lines"]').textContent = `${lines} 行`;
    ui.body._text = text;
    let inner;
    if (lines > 50000) {
      inner = `<pre class="code-plain">${esc(text)}</pre>`; // 太大：不分行不高亮
    } else {
      const html = highlightToLines(text, lines > 20000 ? null : lang);
      const w = String(html.length).length;
      inner = `<div class="code-view hljs${codeState.wrap ? ' wrap' : ''}" style="--gutter:${w + 1}ch">${html.map((l, i) => `<div class="cl"><span class="cn">${i + 1}</span><span class="ct">${l || ' '}</span></div>`).join('')}</div>`;
    }
    ui.body.innerHTML = `<div class="pv-scroll">${inner}</div>`;
    ui.body.querySelector('.pv-scroll').scrollTop = top;
  };
  ui.toolbar.querySelector('[data-c="wrap"]').onclick = e => {
    codeState.wrap = !codeState.wrap;
    e.currentTarget.classList.toggle('on', codeState.wrap);
    ui.body.querySelector('.code-view')?.classList.toggle('wrap', codeState.wrap);
  };
  ui.toolbar.querySelector('[data-c="copy"]').onclick = () => { if (ui.body._text != null) { api.writeClipboard(ui.body._text); toast('已复制全部内容'); } };
  docMessage(ui, '读取中…');
  await render(false);
  watchPreview(r.path, info => { if (info.exists) { r.size = info.size; render(true); } });
}

// ---------------- Markdown ----------------
const mdState = { source: false };
async function openMarkdownPreview(r) {
  const ui = openPanel('markdown', { onClose: () => watchPreview(null) });
  docActions(ui, r);
  ui.toolbar.innerHTML = `
    <div class="segmented sm" data-m="mode"><button data-v="preview" class="${mdState.source ? '' : 'on'}">预览</button><button data-v="source" class="${mdState.source ? 'on' : ''}">源码</button></div>
    <span class="pv-spacer"></span>
    <button class="pv-btn" data-m="copy" title="复制 Markdown 原文">${icon('copy', 15)}<span>复制</span></button>`;
  const dir = dirNameOf(r.path);
  let text = '';
  const render = (keepScroll) => {
    const prev = ui.body.querySelector('.pv-scroll');
    const top = keepScroll && prev ? prev.scrollTop : 0;
    if (mdState.source) {
      const lines = highlightToLines(text, 'markdown');
      ui.body.innerHTML = `<div class="pv-scroll"><div class="code-view hljs wrap" style="--gutter:${String(lines.length).length + 1}ch">${lines.map((l, i) => `<div class="cl"><span class="cn">${i + 1}</span><span class="ct">${l || ' '}</span></div>`).join('')}</div></div>`;
    } else {
      ui.body.innerHTML = `<div class="pv-scroll"><article class="md-body">${renderMarkdown(text)}</article></div>`;
      fixMarkdownDom(ui.body.querySelector('.md-body'), dir);
    }
    ui.body.querySelector('.pv-scroll').scrollTop = top;
  };
  const load = async (keepScroll) => {
    const res = await api.readFile(r.path);
    if (!res.ok) { docMessage(ui, res.error || '读取失败'); return; }
    text = res.text.replace(/\r\n?/g, '\n');
    docMeta(ui, [humanSize(res.size), res.encoding !== 'UTF-8' ? res.encoding : '', res.truncated ? '只显示前 3MB' : '']);
    render(keepScroll);
  };
  ui.toolbar.querySelector('[data-m="mode"]').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    mdState.source = b.dataset.v === 'source';
    ui.toolbar.querySelectorAll('[data-m="mode"] button').forEach(x => x.classList.toggle('on', x === b));
    render(false);
  };
  ui.toolbar.querySelector('[data-m="copy"]').onclick = () => { api.writeClipboard(text); toast('已复制 Markdown 原文'); };
  docMessage(ui, '读取中…');
  await load(false);
  watchPreview(r.path, info => { if (info.exists) load(true); });
}

function renderMarkdown(text) {
  // YAML front matter 显示成代码块
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) text = '```yaml\n' + fm[1] + '\n```\n' + text.slice(fm[0].length);
  const html = marked.parse(text, { gfm: true, breaks: false });
  // 过滤掉脚本、事件属性、javascript: 链接等，防止 md 文件里夹带的代码被执行
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'textarea', 'select'] });
}

const LOCAL_IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)(?:[?#].*)?$/i;
function fixMarkdownDom(root, dir) {
  // 只保留任务清单的勾选框（只读），其他输入框去掉
  root.querySelectorAll('input').forEach(i => { if (i.type === 'checkbox') i.disabled = true; else i.remove(); });
  // 代码块高亮
  root.querySelectorAll('pre code').forEach(el => {
    const m = (el.className || '').match(/language-([\w+#-]+)/);
    const lang = m && hljs.getLanguage(m[1]) ? m[1] : null;
    try {
      if (lang) el.innerHTML = hljs.highlight(el.textContent, { language: lang, ignoreIllegals: true }).value;
      el.classList.add('hljs');
    } catch { }
  });
  // 本地图片：相对路径按 md 文件所在目录解析，再走 ccsfile:// 显示
  root.querySelectorAll('img').forEach(async img => {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:)/i.test(src)) return;
    img.removeAttribute('src');
    if (!LOCAL_IMG_RE.test(src)) return;
    const name = decodeURIComponent(src.replace(/^file:\/\/\/?/i, '').replace(/[?#].*$/, ''));
    const r = await api.fileResolve({ name, dirs: [dir] });
    if (r && r.kind === 'image') img.src = fileUrl(r.path);
    else img.alt = img.alt || `找不到图片 ${name}`;
  });
  // 链接：网页用浏览器；锚点在文档内跳；本地文件能预览就在面板里打开
  root.addEventListener('click', async e => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href)) { openWebLink(href); return; }
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      const t = root.querySelector(`[id="${CSS.escape(id)}"]`) || [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => slug(h.textContent) === slug(id));
      t?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^mailto:/i.test(href)) return;
    const name = decodeURIComponent(href.replace(/^file:\/\/\/?/i, '').replace(/#.*$/, ''));
    const r = await api.fileResolve({ name, dirs: [dir] });
    if (r) openFilePreview(null, r, name, 0);
    else toast(`找不到 ${name}`);
  });
}
const slug = s => String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-一-鿿]/g, '');

// ---------------- PDF ----------------
function openPdfPreview(r) {
  const ui = openPanel('pdf', { onClose: () => watchPreview(null) });
  docActions(ui, r);
  docMeta(ui, [humanSize(r.size)]);
  ui.toolbar.innerHTML = '';
  const show = mtime => {
    ui.body.innerHTML = `<iframe class="pdf-frame" src="${fileUrl(r.path)}&t=${Math.round(mtime || 0)}#view=FitH" title="${esc(baseNameOf(r.path))}"></iframe>`;
  };
  show(r.mtime);
  watchPreview(r.path, info => { if (info.exists) { docMeta(ui, [humanSize(info.size)]); show(info.mtime); } });
}
