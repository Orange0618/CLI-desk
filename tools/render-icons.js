// 用 Electron 把 assets/logo.svg 渲染成各尺寸 PNG + Windows 用的 .ico，并生成预览图。
// 用法：electron tools/render-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'assets', 'logo.svg'), 'utf8');
const OUT = path.join(ROOT, 'assets', 'icons');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// ICO 容器：每个尺寸直接存 PNG（Windows Vista 起支持）
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p => p.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const svgUrl = 'data:image/svg+xml;base64,' + Buffer.from(SVG).toString('base64');
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const img = new Image();
      img.src = ${JSON.stringify(svgUrl)};
      await img.decode();
      const draw = (size, bg) => {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const g = c.getContext('2d');
        if (bg) { g.fillStyle = bg; g.fillRect(0, 0, size, size); }
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, size, size);
        return c;
      };
      const out = {};
      for (const s of ${JSON.stringify(SIZES)}) out[s] = draw(s).toDataURL('image/png');
      // 预览：浅色 / 深色背景上各尺寸（小尺寸放大 4 倍看像素）
      const W = 1100, H = 520;
      const sheet = document.createElement('canvas'); sheet.width = W; sheet.height = H;
      const sg = sheet.getContext('2d');
      const rows = [['#faf9f5', 20], ['#202020', 270]];
      for (const [bg, y] of rows) {
        sg.fillStyle = bg; sg.fillRect(0, y - 20, W, 250);
        sg.drawImage(draw(200), 20, y);
        let x = 250;
        for (const s of [64, 48, 32, 24, 16]) {
          const c = draw(s);
          sg.imageSmoothingEnabled = false;
          sg.drawImage(c, x, y + 100 - s * 2, s * 4 > 200 ? 200 : s * 4, s * 4 > 200 ? 200 : s * 4);
          sg.imageSmoothingEnabled = true;
          sg.drawImage(c, x, y + 210 - s);
          x += Math.min(s * 4, 200) + 30;
        }
      }
      out.sheet = sheet.toDataURL('image/png');
      return out;
    })()
  `);
  fs.mkdirSync(OUT, { recursive: true });
  const toBuf = d => Buffer.from(d.split(',')[1], 'base64');
  for (const s of SIZES) fs.writeFileSync(path.join(OUT, `icon-${s}.png`), toBuf(result[s]));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), toBuf(result[256]));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), buildIco(ICO_SIZES.map(size => ({ size, buf: toBuf(result[size]) }))));
  fs.writeFileSync(path.join(OUT, 'preview.png'), toBuf(result.sheet));
  console.log('icons written to', OUT);
  app.quit();
});
