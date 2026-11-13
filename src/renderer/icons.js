'use strict';
// 线性图标（24x24 视框，描边风格，参考 lucide 的造型自绘）
const ICON_PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  folderOpen: '<path d="M4 18.5 6.4 11a2 2 0 0 1 1.9-1.4H20a1 1 0 0 1 1 1.3l-2 6.2a2 2 0 0 1-1.9 1.4H5.5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2h3.6l2 2.2H17a2 2 0 0 1 2 2"/>',
  chevron: '<path d="m9.5 6.5 5 5.5-5 5.5"/>',
  chevronDown: '<path d="m6.5 9.5 5.5 5 5.5-5"/>',
  chevronUp: '<path d="m6.5 14.5 5.5-5 5.5 5"/>',
  minus: '<path d="M5.5 12h13"/>',
  layers: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  panelRight: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5s1.2-6.1 3.6-8.5z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-4.5-4.5L6 19.5"/>',
  fileText: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M9 13h6M9 16.5h6"/>',
  fileCode: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M10.5 12.5 8.5 14.5l2 2M13.5 12.5l2 2-2 2"/>',
  expand: '<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6"/>',
  shrink: '<path d="M19.5 10H14V4.5M4.5 14H10v5.5M14 10l5.5-5.5M10 14l-5.5 5.5"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  more: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  refresh: '<path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 12.5a8 8 0 0 0 13.7 5.2L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
  pin: '<path d="M12 17v4.5"/><path d="M8.5 3.5h7l-1 5.5 3 3V14h-11v-2l3-3z"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  pencil: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.5 9.5 0 0 1 12 5.5c5 0 8.5 4.5 9.5 6.5a14 14 0 0 1-2.6 3.4M6.6 6.6C4.5 8 3 10.2 2.5 12c1 2 4.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  eye: '<path d="M2.5 12C3.5 10 7 5.5 12 5.5S20.5 10 21.5 12c-1 2-4.5 6.5-9.5 6.5S3.5 14 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M18 13.5v4a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"/><path d="M10 12.5h4"/>',
  unarchive: '<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"/><path d="M12 17.5v-5.5M9.5 14.5 12 12l2.5 2.5"/>',
  trash: '<path d="M4 6.5h16"/><path d="M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/><path d="M6.2 6.5l.9 12.3a2 2 0 0 0 2 1.7h5.8a2 2 0 0 0 2-1.7l.9-12.3"/><path d="M10 10.5v6M14 10.5v6"/>',
  back: '<path d="M14.5 6.5 9 12l5.5 5.5"/>',
  // 品牌点缀：自绘的 8 芒星（不是 Anthropic 官方标志）
  spark: null,
};

function sparkSvg(size) {
  const rays = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const len = i % 2 === 0 ? 10.5 : 8;
    const x = 12 + Math.cos(a) * len, y = 12 + Math.sin(a) * len;
    rays.push(`<path d="M12 12L${x.toFixed(2)} ${y.toFixed(2)}"/>`);
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">${rays.join('')}</svg>`;
}

function icon(name, size = 16, stroke = 1.75) {
  if (name === 'spark') return sparkSvg(size);
  const p = ICON_PATHS[name];
  if (!p) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

// 把静态 HTML 里的 data-icon 占位替换成 SVG
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const html = icon(el.dataset.icon, +(el.dataset.size || 16), +(el.dataset.stroke || 1.75));
    el.insertAdjacentHTML('afterbegin', html);
    el.removeAttribute('data-icon');
  });
}
