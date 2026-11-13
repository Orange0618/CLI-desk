const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, protocol, net, screen } = require('electron');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const scanner = require('./scanner');

// ---------- 配置 ----------
// 应用名决定配置目录（%APPDATA%CLI-desk）。从旧名字升级上来时，把旧配置搬过来一次。
const LEGACY_USERDATA = ['Claude 会话台'];
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  for (const name of LEGACY_USERDATA) {
    const old = path.join(app.getPath('appData'), name, 'config.json');
    try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.copyFileSync(old, CONFIG_FILE); break; } catch { }
  }
}
const DEFAULT_CONFIG = {
  pinned: [],          // 置顶项目（normCwd）
  projectOrder: [],    // 项目的固定顺序（normCwd）；新项目插到最前面，之后不再随活跃度变动
  hidden: [],          // 隐藏项目（normCwd）
  extraProjects: [],   // 手动添加、可能还没有会话的目录（原始路径）
  collapsed: {},       // normCwd -> true 表示折叠
  aliases: {},         // sessionId -> 本地自定义名字
  archived: [],        // 已归档的会话 ID（只是本工具里隐藏，不动 Claude 的文件）
  pinnedSessions: [],  // 置顶的会话 ID
  showScripted: false, // 是否显示 claude -p / SDK 脚本会话
  showHidden: false,
  claudeArgs: '--dangerously-skip-permissions', // 每次启动 claude 附加的参数（默认跳过权限确认）
  fontSize: 14,
  sidebarWidth: 288,
  sidebarCollapsed: false,
  appearance: 'system',   // system | light | dark
  palette: 'classic',     // classic(旧版米色) | modern(新版中性灰)
  syncClaudeTheme: true,  // 让 claude 自己的配色跟随应用浅/深色
  showUsage: true,        // 侧边栏显示 5 小时 / 每周额度
  qlRecentFiles: [],      // 速览窗里最近打开过的文件（最多 5 条）
  linkTarget: 'quicklook', // 网页链接打开方式：quicklook 速览窗（嵌入的 ego）| ego 独立 ego 窗口 | system 系统浏览器
  statuslineRefresh: 1,    // 状态栏跟随窗口宽度重排的检查间隔（秒），0 = 关闭；只对 Windows 生效
};
let config = { ...DEFAULT_CONFIG };
try { config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { }
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
if (config.openLinksInEgo === false && !config.linkTargetMigrated) { config.linkTarget = 'system'; config.linkTargetMigrated = true; }
// 一次性迁移：老配置里启动参数为空的，补上默认的跳过权限参数；之后用户手动清空也不会再加回来
if (!config.argsDefaultApplied) {
  if (!String(config.claudeArgs || '').trim()) config.claudeArgs = DEFAULT_CONFIG.claudeArgs;
  config.argsDefaultApplied = true;
  try { saveConfig(); } catch { }
}

// ---------- 找 claude 可执行文件 ----------
function findClaude() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, 'claude' + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { }
    }
  }
  return null;
}
const CLAUDE = findClaude();

// 如果本工具是从某个 Claude Code 会话里启动的，会继承那个会话的标记变量，
// 导致新开的 claude 以为自己是子会话（不保存对话记录等）。这里把它们去掉。
const SESSION_MARKER_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];
function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const k of Object.keys(env)) {
    if (SESSION_MARKER_VARS.includes(k.toUpperCase())) delete env[k];
  }
  return env;
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ---------- 主题 ----------
nativeTheme.themeSource = config.appearance || 'system';
function isDark() { return nativeTheme.shouldUseDarkColors; }
// ---------- 状态栏：跟随窗口宽度重排 ----------
// Claude Code 在终端变窄 / 变宽后不会重跑 statusLine（anthropics/claude-code#76988），
// 按旧宽度生成的一行会被它截成 "…"。官方给的办法是 statusLine.refreshInterval 定时重跑；
// 但完整跑一次状态栏命令（claude-hud）要拉起 bash→cmd→node→git 好几个进程，约 0.5 秒。
// 所以给本工具启动的会话套一层缓存：宽度和会话数据都没变时直接输出上次结果，
// 只有变了才跑用户原来的命令。只读用户的 settings，不改任何全局配置。
const SL_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CLI-desk', 'statusline');
const SL_CACHE = path.join(SL_DIR, 'cache');
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const toBashPath = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function readJsonObj(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // 原子替换，Claude 不会读到写了一半的文件
}
const validStatusLine = sl => (sl && typeof sl === 'object' && !Array.isArray(sl) && sl.type === 'command'
  && typeof sl.command === 'string' && sl.command.trim()) ? sl : null;
// 按 Claude 的优先级找出这个目录实际生效的 statusLine：项目本地 > 项目 > 用户
function effectiveStatusLine(dir) {
  const userDir = process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR.trim()) : path.join(os.homedir(), '.claude');
  const files = dir ? [path.join(dir, '.claude', 'settings.local.json'), path.join(dir, '.claude', 'settings.json')] : [];
  files.push(path.join(userDir, 'settings.json'));
  for (const f of files) {
    const s = readJsonObj(f);
    if (s && 'statusLine' in s) return validStatusLine(s.statusLine);
  }
  return null;
}
// 生成缓存层脚本（Claude 用 Git Bash 的 `bash -c` 执行命令，这里用 `.` 载入，不多开进程）
function statuslineWrapper(inner) {
  const file = path.join(SL_DIR, `wrap-${sha1(inner)}.sh`);
  const cache = toBashPath(SL_CACHE);
  const script = [
    '# CLI-desk 自动生成，请勿手改。',
    '# Claude Code 改变窗口宽度后不会重跑 statusLine，旧的一行会被截成 "…"。CLI-desk 给会话加了',
    '# refreshInterval 定时重跑；这里在宽度（COLUMNS）和会话数据都没变时直接输出上次的结果，',
    '# 变了才运行你原来的状态栏命令（见本文件末尾的 { } 里），避免每秒都完整跑一次。',
    'ccs_in=; IFS= read -r -d \'\' ccs_in',
    // 会话时长每次都变，不参与比较；其余字段在空闲时保持不变
    'ccs_key=$ccs_in',
    'if [[ $ccs_key =~ ^(.*)\\"total_duration_ms\\":[[:space:]]*[0-9.]+(.*)$ ]]; then ccs_key=${BASH_REMATCH[1]}${BASH_REMATCH[2]}; fi',
    'ccs_key="${COLUMNS:-0}|$ccs_key"',
    'ccs_sid=',
    'if [[ $ccs_in =~ \\"session_id\\":[[:space:]]*\\"([A-Za-z0-9._-]+)\\" ]]; then ccs_sid=${BASH_REMATCH[1]}; fi',
    `ccs_kf=${shq(cache)}/$ccs_sid.key; ccs_of=${shq(cache)}/$ccs_sid.out`,
    'if [[ -n $ccs_sid && -f $ccs_kf && -f $ccs_of ]]; then',
    '  ccs_old=; IFS= read -r -d \'\' ccs_old < "$ccs_kf"',
    '  if [[ $ccs_old == "$ccs_key" ]]; then ccs_out=; IFS= read -r -d \'\' ccs_out < "$ccs_of"; printf \'%s\' "$ccs_out"; exit 0; fi',
    'fi',
    // 末尾补一个 x 再去掉，保留命令输出结尾的换行；ccs_rc 是原命令的退出码
    'ccs_out=$(printf \'%s\' "$ccs_in" | {',
    inner,
    '}; ccs_rc=$?; printf x; exit $ccs_rc)',
    'ccs_rc=$?',
    'ccs_out=${ccs_out%x}',
    'printf \'%s\' "$ccs_out"',
    // 先清空 key 再写 out、最后写 key：中途被 Claude 取消也不会出现 key 和 out 对不上
    'if [[ $ccs_rc -eq 0 && -n $ccs_sid && -n $ccs_out ]]; then : > "$ccs_kf" 2>/dev/null && printf \'%s\' "$ccs_out" > "$ccs_of" && printf \'%s\' "$ccs_key" > "$ccs_kf"; fi 2>/dev/null',
    'exit $ccs_rc',
    '',
  ].join('\n');
  fs.mkdirSync(SL_CACHE, { recursive: true });
  writeIfChanged(file, script);
  return '. ' + shq(toBashPath(file));
}
// 给会话用的 statusLine：用户原来的配置 + 定时重跑 + 缓存层。没配状态栏、关掉了、或非 Windows 时不碰。
function sessionStatusLine(dir) {
  const every = Number(config.statuslineRefresh);
  if (process.platform !== 'win32' || !(every >= 1)) return null; // 缓存层是 Git Bash 语法，只在 Windows 上验证过
  const base = process.env.CCS_STATUSLINE_COMMAND
    ? { type: 'command', command: process.env.CCS_STATUSLINE_COMMAND } // 自检用
    : effectiveStatusLine(dir);
  if (!base) return null;
  try {
    const own = Number(base.refreshInterval);
    return { ...base, command: statuslineWrapper(base.command), refreshInterval: own >= 1 ? Math.min(own, every) : every };
  } catch { return null; }
}
// 清掉一周没用过的缓存（会话结束后就没用了）
function pruneStatuslineCache() {
  try {
    const cutoff = Date.now() - 7 * 864e5;
    for (const f of fs.readdirSync(SL_CACHE)) {
      const p = path.join(SL_CACHE, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { }
    }
  } catch { }
}

// 每个会话的 --settings：配色（应用是浅色时 claude 也要用浅色，否则白字在米色背景上看不见）
// + 上面的状态栏。文件名取内容的哈希：不同项目内容不同，同时启动也不会互相覆盖。
// 只传给本工具启动的会话，不修改用户全局的 Claude 设置。Claude 只在启动时读一次这个文件。
function themeArgs(dir) {
  const settings = {};
  if (config.syncClaudeTheme !== false) settings.theme = isDark() ? 'dark' : 'light';
  const sl = sessionStatusLine(dir);
  if (sl) settings.statusLine = sl;
  if (!Object.keys(settings).length) return [];
  try {
    const json = JSON.stringify(settings);
    const file = path.join(app.getPath('userData'), `claude-session-${sha1(json)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeIfChanged(file, json);
    return ['--settings', file];
  } catch { return []; }
}
const BG = {
  classic: { light: '#faf9f5', dark: '#262624' },
  modern: { light: '#fcfcfb', dark: '#151515' },
};
function windowBg() { return (BG[config.palette] || BG.classic)[isDark() ? 'dark' : 'light']; }
nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
  send('theme:updated', isDark());
});

// ---------- 终端进程 ----------
const terms = new Map(); // termId -> { proc, buf, timer }
let win = null;

function send(ch, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
}

function spawnClaude({ termId, cwd, args, cols, rows }) {
  let dir = cwd;
  let warn = null;
  if (!dir || !fs.existsSync(dir)) {
    warn = `\x1b[33m[提示] 原工作目录不存在：${cwd}\r\n已改为在用户目录启动。\x1b[0m\r\n`;
    dir = os.homedir();
  }
  const fullArgs = [...themeArgs(dir), ...splitArgs(config.claudeArgs), ...args];
  let file = CLAUDE, argv = fullArgs;
  if (!CLAUDE) {
    file = process.env.ComSpec || 'cmd.exe';
    argv = ['/c', 'claude', ...fullArgs];
  } else if (/\.(cmd|bat)$/i.test(CLAUDE)) {
    file = process.env.ComSpec || 'cmd.exe';
    argv = ['/c', CLAUDE, ...fullArgs];
  }
  const proc = pty.spawn(file, argv, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd: dir,
    env: childEnv(),
    useConpty: true,
  });
  const t = { proc, buf: '', timer: null };
  terms.set(termId, t);
  if (warn) send('pty:data', termId, warn);
  proc.onData(data => {
    // 合并 16ms 内的输出再发给渲染进程，减少 IPC 次数
    t.buf += data;
    if (!t.timer) {
      t.timer = setTimeout(() => {
        t.timer = null;
        const chunk = t.buf; t.buf = '';
        send('pty:data', termId, chunk);
      }, 16);
    }
  });
  proc.onExit(({ exitCode }) => {
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    if (t.buf) { send('pty:data', termId, t.buf); t.buf = ''; }
    terms.delete(termId);
    send('pty:exit', termId, exitCode);
  });
}

ipcMain.handle('pty:resume', (_e, { termId, sessionId, cwd, cols, rows }) => {
  spawnClaude({ termId, cwd, args: ['--resume', sessionId], cols, rows });
});
ipcMain.handle('pty:new', (_e, { termId, cwd, cols, rows }) => {
  // 预先指定会话 ID，这样新会话写入磁盘后能和这个标签页对上
  const sessionId = crypto.randomUUID();
  spawnClaude({ termId, cwd, args: ['--session-id', sessionId], cols, rows });
  return sessionId;
});
ipcMain.on('pty:write', (_e, termId, data) => { terms.get(termId)?.proc.write(data); });
ipcMain.on('pty:resize', (_e, termId, cols, rows) => {
  const t = terms.get(termId);
  if (t && cols > 0 && rows > 0) { try { t.proc.resize(cols, rows); } catch { } }
});
ipcMain.handle('pty:kill', (_e, termId) => {
  const t = terms.get(termId);
  if (t) { try { t.proc.kill(); } catch { } terms.delete(termId); }
});

// ---------- 会话列表 ----------
function buildState() {
  const sessions = scanner.scan().map(s => ({ ...s, key: scanner.normCwd(s.cwd) }));
  return {
    sessions,
    extraProjects: config.extraProjects.map(p => ({ cwd: p, key: scanner.normCwd(p) })),
    config,
    claudePath: CLAUDE,
    home: os.homedir(),
    userName: (() => { try { return os.userInfo().username; } catch { return ''; } })(),
    dark: isDark(),
    platform: process.platform,
    previewExts: PREVIEW_EXTS,
  };
}
ipcMain.handle('sessions:get', () => buildState());

let watchTimer = null;
function startWatch() {
  try {
    fs.watch(scanner.PROJECTS_DIR, { recursive: true }, (_ev, file) => {
      if (file && !String(file).endsWith('.jsonl')) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => send('sessions:update', buildState()), 1200);
    });
  } catch (e) {
    // 目录不存在等情况：退化为定时刷新
    setInterval(() => send('sessions:update', buildState()), 10000);
  }
}

// ---------- 额度 ----------
// Claude Code 会把 rate_limits（5 小时 / 7 天的已用百分比和重置时间）传给状态栏程序。
// claude-hud 状态栏插件支持把它写成一个 JSON 快照（display.externalUsageWritePath），
// 这里只读那个文件，不碰登录凭据。
const HUD_DIR = path.join(os.homedir(), '.claude', 'plugins', 'claude-hud');
const HUD_CONFIG = path.join(HUD_DIR, 'config.json');
const DEFAULT_USAGE_PATH = '~/.claude/plugins/claude-hud/usage-snapshot.json';
const expandHome = p => p.replace(/^~(?=$|[\\/])/, os.homedir());
function hudUsagePath() {
  if (!fs.existsSync(HUD_DIR)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(HUD_CONFIG, 'utf8'));
    const p = c && c.display && c.display.externalUsageWritePath;
    return p ? path.normalize(expandHome(String(p).trim())) : '';
  } catch { return ''; }
}
function usageWindow(w) {
  if (!w) return null;
  const pct = typeof w.used_percentage === 'number' && isFinite(w.used_percentage) ? Math.max(0, Math.min(100, w.used_percentage)) : null;
  const resetsAt = w.resets_at ? (Date.parse(w.resets_at) || null) : null;
  return pct === null && !resetsAt ? null : { pct, resetsAt };
}
function readUsage() {
  const p = hudUsagePath();
  if (p === null) return { status: 'no-hud' };
  if (!p) return { status: 'not-configured' };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { status: 'ok', updatedAt: Date.parse(j.updated_at) || null, fiveHour: usageWindow(j.five_hour), sevenDay: usageWindow(j.seven_day) };
  } catch { return { status: 'waiting' }; }
}
let usageWatcher = null, usageTimer = null;
function watchUsage() {
  if (usageWatcher) { try { usageWatcher.close(); } catch { } usageWatcher = null; }
  const p = hudUsagePath();
  if (!p) return;
  try {
    usageWatcher = fs.watch(path.dirname(p), (_ev, file) => {
      if (file && path.basename(String(file)) !== path.basename(p)) return;
      clearTimeout(usageTimer);
      usageTimer = setTimeout(() => send('usage:update', readUsage()), 300);
    });
  } catch { }
}
ipcMain.handle('usage:get', () => readUsage());
ipcMain.handle('usage:enable', () => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(HUD_CONFIG, 'utf8')) || {}; } catch { }
  c.display = { ...(c.display || {}), externalUsageWritePath: DEFAULT_USAGE_PATH };
  fs.mkdirSync(HUD_DIR, { recursive: true });
  fs.writeFileSync(HUD_CONFIG, JSON.stringify(c, null, 2) + '\n');
  watchUsage();
  return readUsage();
});

// ---------- 文件预览 ----------
// 终端里提到的文件可以在右侧面板预览：图片 / PDF 走 ccsfile:// 协议，Markdown / 代码读成文本
const PREVIEW_EXTS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown', 'mdx'],
  code: [
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'json', 'jsonc', 'json5', 'css', 'scss', 'sass', 'less',
    'html', 'htm', 'xml', 'vue', 'svelte', 'py', 'pyw', 'pyi', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
    'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cs', 'fs', 'swift', 'm', 'mm', 'lua', 'r', 'dart', 'jl',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'yml', 'yaml', 'toml', 'ini', 'cfg',
    'conf', 'properties', 'cmake', 'mk', 'proto', 'txt', 'log', 'csv', 'tsv', 'diff', 'patch', 'tex', 'bib', 'rst',
    'adoc', 'v', 'sv', 'vhd', 'vhdl', 'asm', 's', 'ino', 'nix', 'tf', 'hcl', 'zig', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj',
  ],
};
const EXT_KIND = {};
for (const [kind, list] of Object.entries(PREVIEW_EXTS)) for (const e of list) EXT_KIND[e] = kind;
const kindOf = p => EXT_KIND[path.extname(String(p)).slice(1).toLowerCase()] || null;

// ccsfile://f/?p=<绝对路径>：只放行图片和 PDF
protocol.registerSchemesAsPrivileged([{ scheme: 'ccsfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
function registerFileProtocol() {
  protocol.handle('ccsfile', req => {
    try {
      const p = new URL(req.url).searchParams.get('p') || '';
      const k = kindOf(p);
      if (!path.isAbsolute(p) || (k !== 'image' && k !== 'pdf')) return new Response('not allowed', { status: 403 });
      return net.fetch(pathToFileURL(p).toString());
    } catch { return new Response('bad request', { status: 400 }); }
  });
}

// 把终端里看到的文件名解析成真实文件：绝对路径直接检查；相对名字按候选目录依次找
ipcMain.handle('file:resolve', (_e, { name, dirs }) => {
  const tryPath = p => {
    try {
      const kind = kindOf(p);
      if (!kind) return null;
      const st = fs.statSync(p);
      return st.isFile() ? { path: p, kind, size: st.size, mtime: st.mtimeMs } : null;
    } catch { return null; }
  };
  if (!name || typeof name !== 'string') return null;
  if (path.isAbsolute(name)) return tryPath(path.normalize(name));
  const valid = (dirs || []).filter(d => typeof d === 'string' && path.isAbsolute(d));
  for (const d of valid) {
    const r = tryPath(path.resolve(d, name));
    if (r) return r;
  }
  // 只有文件名（不带目录）时，在前两个候选目录（会话目录 + 最近提到的目录）的子文件夹里找
  if (!/[\\/]/.test(name) && kindOf(name)) {
    const roots = [valid[valid.length - 1], valid[0]].filter((d, i, a) => d && a.indexOf(d) === i);
    for (const root of roots) {
      const found = findBelow(root, name);
      if (found) return tryPath(found);
    }
  }
  return null;
});

// 广度优先往下找同名文件：最多 4 层、2000 个目录、150ms，跳过依赖和构建产物目录
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'env', 'target', '.idea', '.vscode', 'bower_components', '.gradle', 'obj', 'bin']);
function findBelow(root, name) {
  const want = name.toLowerCase();
  const deadline = Date.now() + 150;
  let queue = [{ dir: root, depth: 0 }], seenDirs = 0;
  while (queue.length && Date.now() < deadline && seenDirs < 2000) {
    const next = [];
    for (const { dir, depth } of queue) {
      if (Date.now() >= deadline || seenDirs >= 2000) break;
      seenDirs++;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase() === want && depth > 0) return path.join(dir, e.name);
        if (e.isDirectory() && depth < 4 && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) next.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
    queue = next;
  }
  return null;
}

// 读文本文件：最多 3MB；含 NUL 字节当作二进制；不是合法 UTF-8 时按 GB18030（兼容 GBK）解码
ipcMain.handle('file:read', (_e, p) => {
  const kind = kindOf(p);
  if (typeof p !== 'string' || !path.isAbsolute(p) || (kind !== 'markdown' && kind !== 'code')) return { ok: false, error: '不支持预览这种文件' };
  const MAX = 3 * 1024 * 1024;
  let fd;
  try {
    const st = fs.statSync(p);
    const len = Math.min(st.size, MAX);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, 0);
    if (buf.subarray(0, 8000).includes(0)) return { ok: false, binary: true, error: '这是二进制文件，没法当文本显示' };
    let text, encoding = 'UTF-8';
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch {
      // 截断处可能切断了一个 UTF-8 字符，先宽松解码看看乱码比例
      const loose = new TextDecoder('utf-8').decode(buf);
      const bad = (loose.match(/\uFFFD/g) || []).length;
      if (bad <= 2) text = loose;
      else { text = new TextDecoder('gb18030').decode(buf); encoding = 'GB18030'; }
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { ok: true, text, size: st.size, mtime: st.mtimeMs, truncated: st.size > MAX, encoding };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { }
  }
});

// 监听当前预览的文件（claude 改了文件就自动刷新）；监听所在目录，兼容"写临时文件再改名"的保存方式
let fileWatcher = null, fileWatchTimer = null;
ipcMain.handle('file:watch', (_e, p) => {
  if (fileWatcher) { try { fileWatcher.close(); } catch { } fileWatcher = null; }
  if (typeof p !== 'string' || !path.isAbsolute(p)) return;
  const base = path.basename(p).toLowerCase();
  try {
    fileWatcher = fs.watch(path.dirname(p), (_ev, file) => {
      if (file && path.basename(String(file)).toLowerCase() !== base) return;
      clearTimeout(fileWatchTimer);
      fileWatchTimer = setTimeout(() => {
        let st = null;
        try { st = fs.statSync(p); } catch { }
        send('file:changed', { path: p, exists: !!st, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 });
      }, 250);
    });
  } catch { }
});
ipcMain.handle('shell:showItem', (_e, p) => { if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p); });
// 打开网页：默认交给 ego lite（Chromium 内核，传网址会在已开的窗口里新开标签页；没开就启动它），
// 没装 ego 或在设置里关掉时用系统默认浏览器
function openUrl(url, target) {
  url = String(url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false };
  target = target || config.linkTarget || 'quicklook';
  // 速览窗由渲染进程负责（比如页面里 window.open 出来的链接）
  if (target === 'quicklook' && process.platform === 'win32' && fs.existsSync(EGO_EXE)) { send('ql:openUrl', url); return { ok: true, via: 'quicklook' }; }
  if (target !== 'system' && process.platform === 'win32' && fs.existsSync(EGO_EXE)) {
    try {
      const p = spawn(EGO_EXE, [url], { detached: true, stdio: 'ignore' });
      p.on('error', () => shell.openExternal(url));
      p.unref();
      return { ok: true, via: 'ego' };
    } catch { }
  }
  shell.openExternal(url);
  return { ok: true, via: 'system' };
}
ipcMain.handle('shell:openExternal', (_e, url, target) => openUrl(url, target || 'system'));
ipcMain.handle('link:openInEgo', (_e, url) => openUrl(url, 'ego'));

// ---------- 速览窗：嵌入专用的 ego 窗口（Windows） ----------
// 每个网页链接用 ego 的 --app 模式开一个专用窗口（没有标签栏 / 工具栏），嵌成本窗口的子窗口。
// 跟随由助手自己完成：它每 4ms 看一次本窗口的客户区，按锚点（离右 / 上 / 下边的距离 + 宽度）摆放。
// 用户自己原来的 ego 窗口一律不碰。
const EGO_EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Citro Labs', 'ego lite', 'Application', 'ego.exe');
const egoHelper = {
  proc: null, seq: 0, wait: new Map(), buf: '',
  start() {
    if (this.proc) return;
    const p = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ego-helper.ps1')], { windowsHide: true });
    this.proc = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const [id, kind, payload = ''] = line.split('\t');
        if (id === '0') { if (kind === 'event') { try { send('ql:event', JSON.parse(payload)); } catch { } } continue; }
        const w = this.wait.get(id);
        if (!w) continue;
        this.wait.delete(id); clearTimeout(w.timer);
        let data = null; if (kind === 'ok') { try { data = JSON.parse(payload); } catch { } }
        w.resolve({ ok: kind === 'ok', data, error: kind === 'err' ? payload : undefined });
      }
    });
    p.stderr.on('data', () => { });
    p.on('exit', () => {
      this.proc = null;
      send('ql:event', { type: 'helper-exit' });
      for (const w of this.wait.values()) { clearTimeout(w.timer); w.resolve({ ok: false, error: '助手进程退出了' }); }
      this.wait.clear();
    });
  },
  call(cmd, args = [], timeout = 10000) {
    this.start();
    const id = String(++this.seq);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wait.delete(id); resolve({ ok: false, error: '超时' }); }, timeout);
      this.wait.set(id, { resolve, timer });
      this.proc.stdin.write([id, cmd, ...args.map(a => String(a).replace(/[\t\r\n]/g, ' '))].join('\t') + '\n');
    });
  },
};
// 网页标题里可能夹着零宽字符（比如飞书的隐形水印）
const cleanTitle = t => String(t || '').replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u202a-\u202e]/g, '').replace(/\s*-\s*ego$/, '').trim();
const hostHwnd = () => win.getNativeWindowHandle().readBigUInt64LE(0).toString();
const physical = n => Math.round(n * screen.getDisplayMatching(win.getBounds()).scaleFactor * win.webContents.getZoomFactor());

ipcMain.handle('ql:status', () => ({ supported: process.platform === 'win32', installed: fs.existsSync(EGO_EXE) }));
ipcMain.handle('ql:openWeb', async (_e, url) => {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
  if (!fs.existsSync(EGO_EXE)) return { ok: false, reason: 'not-installed' };
  url = String(url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'bad-url' };
  const r = await egoHelper.call('open', [EGO_EXE, '--app="' + url.replace(/"/g, '%22') + '"'], 20000);
  if (!r.ok || !r.data) return { ok: false, reason: 'launch-failed', error: r.error };
  const a = await egoHelper.call('attach', [r.data.hwnd, hostHwnd()]);
  if (!a.ok) return { ok: false, reason: 'error', error: a.error };
  return { ok: true, hwnd: r.data.hwnd, title: cleanTitle(r.data.title) };
});
ipcMain.on('ql:anchor', (_e, hwnd, rc) => { egoHelper.call('anchor', [hwnd, physical(rc.right), physical(rc.top), physical(rc.bottom), physical(rc.width)]); });
ipcMain.on('ql:show', (_e, hwnd, visible) => { egoHelper.call('show', [hwnd, visible ? 1 : 0]); });
ipcMain.on('ql:nav', (_e, hwnd, n) => { egoHelper.call('appcmd', [hwnd, n]); });
ipcMain.handle('ql:close', (_e, hwnd) => egoHelper.call('close', [hwnd]));
ipcMain.handle('ql:popout', (_e, hwnd) => egoHelper.call('detach', [hwnd]));
app.on('will-quit', () => { if (egoHelper.proc) try { egoHelper.proc.kill(); } catch { } });

// ---------- 配置 / 杂项 ----------
ipcMain.handle('config:set', (_e, patch) => {
  config = { ...config, ...patch };
  saveConfig();
  if (patch.appearance) nativeTheme.themeSource = patch.appearance;
  if (patch.palette && win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
  return config;
});
// 渲染进程按当前主题算好颜色后，同步给 Windows 右上角的窗口按钮
ipcMain.on('window:overlay', (_e, color, symbolColor) => {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  try { win.setTitleBarOverlay({ color, symbolColor, height: 44 }); } catch { }
});
// 删除会话：把对话记录 (.jsonl) 和同名的附属目录移到回收站
ipcMain.handle('session:delete', async (_e, sessionId) => {
  const s = scanner.scan().find(x => x.id === sessionId);
  if (!s) return { ok: false, error: '找不到这个会话的记录文件' };
  const root = path.resolve(scanner.PROJECTS_DIR) + path.sep;
  const file = path.resolve(s.file);
  if (!file.startsWith(root) || !file.endsWith('.jsonl')) return { ok: false, error: '路径不在 Claude 会话目录里，已拒绝' };
  try {
    await shell.trashItem(file);
    const side = file.slice(0, -'.jsonl'.length);
    if (fs.existsSync(side) && fs.statSync(side).isDirectory()) await shell.trashItem(side);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
  const drop = list => (list || []).filter(id => id !== sessionId);
  const aliases = { ...config.aliases }; delete aliases[sessionId];
  config = { ...config, archived: drop(config.archived), pinnedSessions: drop(config.pinnedSessions), aliases };
  saveConfig();
  return { ok: true, state: buildState() };
});
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择项目目录' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('clipboard:readText', () => clipboard.readText());
ipcMain.handle('clipboard:writeText', (_e, t) => clipboard.writeText(t));
// Electron 45 的 clipboard 接口是异步的，也没有 readImage 了；用 has('image/png') 判断
ipcMain.handle('clipboard:hasImage', async () => {
  try { return !!(await clipboard.has('image/png')); } catch { return false; }
});
ipcMain.handle('util:normCwd', (_e, p) => scanner.normCwd(p));

// ---------- 窗口 ----------
function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 860,
    minHeight: 500,
    title: 'CLI-desk',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: windowBg(),
    // 无边框标题栏，Windows 右上角保留系统按钮（颜色由渲染进程同步）
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32'
      ? { color: windowBg(), symbolColor: isDark() ? '#c2c0b6' : '#3d3d3a', height: 44 }
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      plugins: true, // 内置 PDF 阅读器
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 终端里的网页链接用系统浏览器打开，不在应用里弹新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) openUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) openUrl(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // 有正在运行的会话时，关闭前确认
  let reallyClose = false;
  win.on('close', e => {
    if (reallyClose) return;
    if (terms.size > 0) {
      const r = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['关闭', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '确认关闭',
      message: `还有 ${terms.size} 个会话在运行，关闭窗口会结束它们。`,
        detail: '对话记录已经保存，之后可以在侧边栏里点开接着聊。',
      });
      if (r === 1) { e.preventDefault(); return; }
    }
    // 速览窗里嵌着的专用 ego 窗口：先解开再关掉，别让它们跟着本窗口被硬销毁
    if (egoHelper.proc) {
      e.preventDefault();
      egoHelper.call('closeall', [], 1500).finally(() => { reallyClose = true; win.close(); });
    }
  });
}

app.setName('CLI-desk');
if (process.platform === 'win32') app.setAppUserModelId('cli-desk');
app.whenReady().then(() => {
  registerFileProtocol();
  createWindow();
  startWatch();
  pruneStatuslineCache();
  watchUsage();
  setInterval(() => send('usage:update', readUsage()), 60000);
});
app.on('window-all-closed', () => {
  for (const t of terms.values()) { try { t.proc.kill(); } catch { } }
  terms.clear();
  app.quit();
});

// ---------- 自检（仅在设置 CCS_SELFTEST 环境变量时运行）----------
if (process.env.CCS_SELFTEST) {
  const out = process.env.CCS_SELFTEST;
  // 窗口被遮挡时 Chromium 不重绘：先拍一张触发重绘（丢弃），等一下再拍正式的
  const snap = async (name) => {
    await win.webContents.capturePage(undefined, { stayAwake: true });
    await new Promise(r => setTimeout(r, 250));
    const img = await win.webContents.capturePage(undefined, { stayAwake: true });
    fs.writeFileSync(path.join(out, name), img.toPNG());
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  app.whenReady().then(async () => {
    win.webContents.on('console-message', e => console.log('[renderer]', e.level, e.message, e.sourceId + ':' + e.lineNumber));
    win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err));
    // 测试脚本把页面标题设成 "SNAP:名字" 就截一张图
    win.on('page-title-updated', (e, title) => {
      title = String(title);
      if (title.startsWith('SNAP:')) { e.preventDefault(); snap(title.slice(5) + '.png'); }
      if (title.startsWith('SCREEN:')) { e.preventDefault(); screenShot(title.slice(7) + '.png'); }
      if (title.startsWith('WIN:')) { // 测试指令：WIN:move:dx:dy / WIN:size:dw:dh / WIN:min / WIN:restore
        e.preventDefault();
        const [, op, a, b] = title.split(':');
        const bd = win.getBounds();
        if (op === 'move') win.setBounds({ ...bd, x: bd.x + +a, y: bd.y + +b });
        if (op === 'size') win.setBounds({ ...bd, width: bd.width + +a, height: bd.height + +b });
        if (op === 'min') win.minimize();
        if (op === 'restore') win.restore();
        if (op === 'geom') egoHelper.call('geom', [a]).then(r => win.webContents.executeJavaScript('window.__geom = ' + JSON.stringify(r.data)));
        if (op === 'lag') (async () => {
          const samples = [];
          for (let k = 0; k < 5; k++) {
            const bd2 = win.getBounds();
            const t0 = process.hrtime.bigint();
            win.setBounds({ ...bd2, width: bd2.width + (k % 2 ? +b : -b) });
            let ms = -1;
            for (let n = 0; n < 200; n++) {
              const g = (await egoHelper.call('geom', [a])).data;
              if (g && g.want && g.have.every((v, i) => Math.abs(v - g.want[i]) <= 1)) { ms = Number(process.hrtime.bigint() - t0) / 1e6; break; }
            }
            samples.push(Math.round(ms));
            await new Promise(r => setTimeout(r, 300));
          }
          win.webContents.executeJavaScript('window.__lag = ' + JSON.stringify(samples));
        })();
      }
    });
    // 屏幕截图：临时置顶窗口，直接截屏幕上这块区域（应用内截图拍不到别的程序的子窗口）
    const screenShot = async name => {
      win.setAlwaysOnTop(true); win.focus();
      await wait(500);
      const b = win.getBounds(), sf = screen.getDisplayMatching(b).scaleFactor;
      let [x, y, w, h] = [b.x, b.y, b.width, b.height].map(v => Math.round(v * sf));
      const file = path.join(out, name).replace(/'/g, "''");
      const ps = `Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap ${w}, ${h}; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size); $bmp.Save('${file}')`;
      await new Promise(r => spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }).on('exit', r));
      win.setAlwaysOnTop(false);
    };
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await wait(1500);
    await snap('1-sidebar.png');
    const dir = process.env.CCS_SELFTEST_DIR;
    if (dir) {
      await win.webContents.executeJavaScript(`api.normCwd(${JSON.stringify(dir)}).then(k => newSessionIn(${JSON.stringify(dir)}, k))`);
      await wait(9000);
      win.show(); win.focus(); win.webContents.invalidate(); await wait(800);
      await snap('2-new-session.png');
      const info = await win.webContents.executeJavaScript(`JSON.stringify({ tabs: [...tabs.values()].map(t => ({ sid: t.sessionId, alive: t.alive, cols: t.term.cols, rows: t.term.rows, text: (() => { const b = t.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i)?.translateToString(true); if (l && l.trim()) out.push(l); } return out.slice(0, 40); })() })), tabbar: document.querySelector("#tabbar").children.length, homeHidden: document.querySelector("#home").classList.contains("hidden"), pending: document.querySelectorAll(".sess.pending").length })`);
      fs.writeFileSync(path.join(out, 'tabs.json'), info);
      // 可选：执行一个探测脚本（文件路径），结果写到 probe.json
      if (process.env.CCS_SELFTEST_JS) {
        const js = fs.readFileSync(process.env.CCS_SELFTEST_JS, 'utf8');
        const res = await win.webContents.executeJavaScript(js);
        fs.writeFileSync(path.join(out, 'probe.json'), typeof res === 'string' ? res : JSON.stringify(res, null, 2));
        win.focus(); win.webContents.invalidate(); await wait(600);
        await snap('3-probe.png');
      }
    }
    if (egoHelper.proc) await egoHelper.call('closeall', [], 2000);
    for (const t of terms.values()) { try { t.proc.kill(); } catch { } }
    terms.clear();
    app.exit(0);
  });
}
