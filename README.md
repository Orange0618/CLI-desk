<p align="center">
  <img src="assets/icons/icon-128.png" width="96" height="96" alt="CLI-desk">
</p>

<h1 align="center">CLI-desk</h1>

<p align="center">
  给 Claude Code CLI 套一层轻量的桌面壳。<br>
  CLI 还是那个 CLI，只是多了桌面端的便利。
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#功能">功能</a> ·
  <a href="#快捷键">快捷键</a> ·
  <a href="#它会碰哪些文件">它会碰哪些文件</a> ·
  <a href="#english">English</a>
</p>

---

如果你习惯用终端里的 `claude`，又羡慕桌面端那种侧边栏一点就切会话的体验，CLI-desk 就是给你的。

它不重写 Claude Code，也不调用 API。每个标签页里跑的就是你机器上那个原生的 `claude` CLI：配置、插件、MCP、hooks、状态栏都照常生效。CLI-desk 只在外面加了这些东西：

- 一个**按工作目录分组的会话侧边栏**；
- 一个可以看图片、Markdown、代码、PDF 和网页的**右侧速览窗**；
- 一些终端里不太顺手的地方的修补，比如中文输入法、粘贴截图。

> 非官方项目，与 Anthropic 无关。Claude 和 Claude Code 是 Anthropic 的商标。

## 功能

### 会话管理

- **按工作目录分组**：读取 `~/.claude/projects` 里的对话记录，同一个目录下的会话挂在同一个文件夹下。
- **一级页面保持清爽**：每个目录默认只显示最近 5 个会话，其余的点“显示其余”展开。不常用的可以**归档**到单独的二级页面。
- **目录顺序固定**：不会因为某个会话刚活跃就跳到最上面。可以置顶、上移下移、隐藏，也可以给会话起本地别名。
- **运行状态**：会话在跑时右侧显示转圈；跑完了、你还没看，显示一个橙点；点开就消失。
- **删除**：对话记录移到回收站，不是直接删掉。
- **新建 / 恢复**：新会话带上预先生成的会话 ID 启动，恢复用 `claude --resume`。

### 终端

- 基于 xterm.js + node-pty（Windows 上走 ConPTY）。
- **中文输入法**：候选框跟着 Claude 画出来的光标走，不会跑到窗口外面。
- **粘贴截图**：剪贴板里是图片时，`Ctrl+V` 会替你按下 Claude 的图片粘贴键（Windows 上是 `Alt+V`）。也可以直接把文件拖进终端。
- `Shift+Enter` 换行，选中文字后 `Ctrl+C` 复制，右键复制或粘贴。
- **状态栏跟随窗口宽度重排**：Claude Code 在窗口变窄后不会重跑状态栏命令，旧的一行会被截成 `…`（[anthropics/claude-code#76988](https://github.com/anthropics/claude-code/issues/76988)）。CLI-desk 给会话加了定时重跑，并在中间套了一层缓存：宽度和会话数据都没变时直接复用上次结果，开销很小。可以在设置里调间隔或关掉（目前仅 Windows）。
- **跟随应用的浅色 / 深色**：可选让 Claude 的终端配色同步切换。

### 速览窗

点顶栏右侧的按钮打开，可以拖动调宽、加宽或收起。

- **图片**：滚轮缩放、拖动平移、适合窗口 / 1:1，同一会话里提到的多张图可以左右翻。
- **Markdown**：渲染预览和源码两种视图，表格、任务列表、代码高亮都支持。
- **代码**：带行号和语法高亮，可切换自动换行。
- **PDF**：用内置的 PDF 查看器。
- **终端里的文件名可以直接点**：识别出会话里提到的文件，悬停显示缩略图，点击在速览窗打开。只写了文件名的，会在会话目录的子文件夹里帮你找。
- **开始页**：粘贴一个文件路径就能打开，还会列出最近打开的 5 个文件。
- **网页（可选，仅 Windows）**：装了 ego lite 浏览器的话，会话里的链接可以在速览窗里直接打开（一个嵌进来的 ego 窗口）；没装就用系统浏览器。

### 用量面板（可选）

侧边栏底部显示 5 小时和本周的额度：已用百分比和重置时间。数据来自 [claude-hud](https://github.com/jarrodwatts/claude-hud) 状态栏插件写出的快照文件，CLI-desk 只读这个文件，**不碰你的登录凭据**。装了 claude-hud 但没开快照的话，面板上有一键开启的按钮（会在 claude-hud 的配置里加一项 `display.externalUsageWritePath`）。

## 安装

需要：

- **Windows 10 / 11**。开发和测试都在 Windows 上做；macOS 和 Linux 理论上能跑，但没测过，速览窗里的网页功能也只支持 Windows。
- **Node.js 20+** 和 npm（用来安装依赖）。
- **Claude Code CLI**，能在 `PATH` 或 `~/.local/bin` 里找到 `claude`。

```bash
git clone https://github.com/Orange0618/CLI-desk.git
cd CLI-desk
npm install
npm start
```

想要桌面快捷方式的话，把目标设成：

```
<CLI-desk 目录>\node_modules\electron\dist\electron.exe "<CLI-desk 目录>"
```

图标用 `assets\icon.ico`。

### ⚠️ 默认启动参数

CLI-desk 默认给每个会话带上 `--dangerously-skip-permissions`：Claude 修改文件、执行命令都**不再逐个征求你的确认**。如果你不想要，打开 设置 → “启动 claude 时附加的参数”，把它删掉就行。

## 快捷键

| 按键 | 作用 |
|---|---|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换到下一个 / 上一个打开的会话 |
| `Shift+Enter` | 在 Claude 的输入框里换行 |
| `Ctrl+C`（有选中文字时） | 复制 |
| `Ctrl+V` | 粘贴文字；剪贴板是图片时粘贴截图 |
| `Ctrl+Shift+W` | 关闭当前会话标签 |
| `Esc`（焦点在速览窗时） | 收起速览窗 |
| 双击侧边栏的 logo | 回到首页 |

## 它会碰哪些文件

CLI-desk 尽量不动你的东西：

| 位置 | 做什么 |
|---|---|
| `~/.claude/projects/**/*.jsonl` | **只读**，用来列出会话。删除会话时把对应文件移到回收站。 |
| `~/.claude/settings.json`、项目里的 `.claude/settings*.json` | **只读**，用来找出你配置的状态栏命令。 |
| `%APPDATA%\CLI-desk\` | 自己的配置（`config.json`），以及启动会话时传给 `claude --settings` 的小文件（配色和状态栏）。 |
| `%LOCALAPPDATA%\CLI-desk\statusline\` | 状态栏缓存层的脚本和缓存，一周没用的缓存会自动清掉。 |
| claude-hud 的 `config.json` | **只在你点“开启用量”时**加一项快照路径。 |

不会改你的全局 Claude 设置，也不会把任何数据发到网上。归档、置顶、别名都只存在 CLI-desk 自己的配置里。

## 开发

```
src/
  main.js          主进程：会话扫描、pty、配置、文件预览协议、ego 嵌入
  scanner.js       解析 ~/.claude/projects 下的会话记录
  preload.js       给页面暴露的 API
  ego-helper.ps1   把 ego 窗口嵌进速览窗用的 Win32 助手（PowerShell + C#）
  renderer/        界面：侧边栏、终端、速览窗、各种预览
tools/
  render-icons.js  从 assets/logo.svg 生成各尺寸图标
```

改完代码重启应用即可，没有构建步骤。

## 致谢

- [xterm.js](https://xtermjs.org/)、[node-pty](https://github.com/microsoft/node-pty)、[Electron](https://www.electronjs.org/)
- [marked](https://marked.js.org/)、[DOMPurify](https://github.com/cure53/DOMPurify)、[highlight.js](https://highlightjs.org/)
- 界面配色参考了开源社区整理的旧版 Claude 桌面端设计风格

## 许可

[MIT](LICENSE)

---

## English

**CLI-desk** is a lightweight desktop shell for the Claude Code CLI. Each tab runs your own native `claude` binary, so your settings, plugins, MCP servers, hooks and status line all keep working. On top of that, CLI-desk adds:

- a sidebar that groups sessions by working directory, with archive, pin, reorder, rename and delete (to the recycle bin);
- running / finished indicators for every session;
- a resizable side panel that previews images, Markdown, code and PDFs, and on Windows with ego lite installed, web pages too;
- fixes for terminal pain points: IME candidate placement, pasting screenshots with `Ctrl+V`, and a status line that re-wraps when the window gets narrower instead of being truncated with `…`;
- an optional usage panel (5-hour and weekly limits) read from claude-hud's snapshot file.

It reads your Claude Code data locally and never sends anything anywhere. Developed and tested on Windows 10/11; macOS and Linux are untested.

```bash
git clone https://github.com/Orange0618/CLI-desk.git
cd CLI-desk
npm install
npm start
```

Heads-up: sessions start with `--dangerously-skip-permissions` by default. Remove it under Settings if you want Claude to ask before editing files or running commands.

Not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic. MIT licensed.
