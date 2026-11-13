// 扫描 ~/.claude/projects，把会话按真实工作目录(cwd)归组。
// 目录名会把非 ASCII 字符替换成 '-'，不可逆，所以 cwd 必须从 jsonl 记录里读。
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;

// file path -> { mtimeMs, size, info }
const cache = new Map();

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString('utf8');
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { out.push(JSON.parse(line)); } catch { /* 截断的行 */ }
  }
  return out;
}

// 从 user 消息里取出用户真正输入的文字（跳过 system-reminder、斜杠命令输出等）
function userText(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message && rec.message.content;
  let texts = [];
  if (typeof c === 'string') texts = [c];
  else if (Array.isArray(c)) texts = c.filter(b => b && b.type === 'text').map(b => b.text || '');
  for (let t of texts) {
    t = t.trim();
    if (!t) continue;
    // 斜杠命令：<command-name>/foo</command-name> → 显示 "/foo"
    const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
    if (cmd) {
      const args = t.match(/<command-args>([^<]*)<\/command-args>/);
      return (cmd[1] + ' ' + (args ? args[1] : '')).trim();
    }
    if (t.startsWith('<')) {
      // 去掉开头的 <system-reminder>…</system-reminder> 等包裹块，看后面有没有真内容
      const stripped = t.replace(/<([a-zA-Z-]+)[^>]*>[\s\S]*?<\/\1>/g, '').trim();
      if (stripped && !stripped.startsWith('<')) return stripped;
      continue;
    }
    return t;
  }
  return null;
}

function parseSession(file, stat) {
  const fd = fs.openSync(file, 'r');
  let head, tail = '';
  try {
    head = readRange(fd, 0, Math.min(HEAD_BYTES, stat.size));
    if (stat.size > HEAD_BYTES) {
      const start = Math.max(HEAD_BYTES, stat.size - TAIL_BYTES);
      tail = readRange(fd, start, stat.size - start);
    }
  } finally {
    fs.closeSync(fd);
  }

  const headRecs = parseLines(head);
  const tailRecs = parseLines(tail);
  const all = headRecs.concat(tailRecs);

  let cwd = null, firstPrompt = null, firstCommand = null, title = null, lastPrompt = null;
  let sessionId = null, branch = null, entrypoint = null;
  let hasConversation = false;

  for (const r of headRecs) {
    if (!sessionId && r.sessionId) sessionId = r.sessionId;
    if (!cwd && r.cwd) cwd = r.cwd;
    if (!entrypoint && r.entrypoint) entrypoint = r.entrypoint;
    if (r.type === 'assistant') hasConversation = true;
    if (!firstPrompt) {
      const t = userText(r);
      if (t && t.startsWith('/')) { if (!firstCommand) firstCommand = t; }
      else if (t) firstPrompt = t;
    }
  }
  if (!firstPrompt) firstPrompt = firstCommand;
  for (const r of all) {
    if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
    if (r.type === 'relocated' && r.relocatedCwd) cwd = r.relocatedCwd;
    if (r.type === 'last-prompt' && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.gitBranch) branch = r.gitBranch;
    if (r.type === 'assistant') hasConversation = true;
  }
  if (!cwd) {
    for (const r of tailRecs) { if (r.cwd) { cwd = r.cwd; break; } }
  }

  return {
    // 文件名才是真正的会话 ID（claude --resume 按文件名找）。分叉 / 续聊出来的会话
    // 开头几条记录会带着原会话的 sessionId，不能用。
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    title,
    firstPrompt,
    lastPrompt: typeof lastPrompt === 'string' ? lastPrompt : null,
    branch,
    entrypoint,
    // sdk-cli / sdk-ts = claude -p 或 SDK 脚本调用，不是交互会话
    scripted: !!entrypoint && entrypoint.startsWith('sdk'),
    hasConversation,
    updatedAt: stat.mtimeMs,
    size: stat.size,
  };
}

function normCwd(p) {
  if (!p) return p;
  let n = path.normalize(p).replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/.test(n)) n += '\\';
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function scan() {
  const sessions = [];
  const seen = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return sessions; }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      seen.add(file);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const hit = cache.get(file);
      let info;
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        info = hit.info;
      } else {
        try { info = parseSession(file, stat); } catch { continue; }
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
      }
      if (info.hasConversation && info.cwd) sessions.push(info);
    }
  }
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return sessions;
}

module.exports = { scan, normCwd, PROJECTS_DIR };
