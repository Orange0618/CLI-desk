# ego lite quick-look helper (Windows only).
# Opens dedicated ego windows, embeds them as child windows of the host, and keeps them glued to an
# anchored area of the host's client rect. All work happens in C#: PowerShell only loads the code.
#
# Protocol (one line per message, fields separated by TAB):
#   stdin : <id> <cmd> <args...>
#   stdout: <id> ok <json>   |   <id> err <message>   |   0 event <json>
# Commands:
#   find                                   list ego top-level windows
#   open   <exe> <args>                     start ego with args, return the hwnd of the new window
#   attach <child> <parent>                 make <child> a borderless child of <parent>
#   anchor <child> <right> <top> <bottom> <width>   physical px from the parent's client edges
#   show   <child> <0|1>
#   close  <child>                          WM_CLOSE (only our own dedicated windows)
#   detach <child>                          turn back into a normal top-level window
#   appcmd <child> <1|2|3>                  browser back / forward / refresh (like mouse side buttons)
#   closeall
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class EgoHost {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
  [DllImport("user32.dll")] static extern int MapWindowPoints(IntPtr from, IntPtr to, ref RECT r, int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);

  const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
  const long WS_CHILD = 0x40000000L, WS_POPUP = 0x80000000L, WS_CAPTION = 0x00C00000L, WS_THICKFRAME = 0x00040000L,
             WS_SYSMENU = 0x00080000L, WS_MINIMIZEBOX = 0x00020000L, WS_MAXIMIZEBOX = 0x00010000L, WS_VISIBLE = 0x10000000L,
             WS_CLIPSIBLINGS = 0x04000000L;
  const long WS_EX_APPWINDOW = 0x00040000L, WS_EX_WINDOWEDGE = 0x100L, WS_EX_DLGMODALFRAME = 0x1L, WS_EX_CLIENTEDGE = 0x200L, WS_EX_STATICEDGE = 0x20000L;
  const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20,
             SWP_SHOWWINDOW = 0x40, SWP_NOCOPYBITS = 0x100, SWP_NOOWNERZORDER = 0x200, SWP_ASYNCWINDOWPOS = 0x4000;
  const uint WM_CLOSE = 0x10;

  class Managed {
    public IntPtr hwnd, parent;
    public long style, ex;
    public bool anchored, visible = true;
    public int right, top, bottom, width;
    public RECT last; public bool haveLast;
    public int crop = -1;            // ego 自己画在网页区域顶部的标题栏高度（-1 = 还没测）
    public int placedAt;             // 第一次摆好的时间，等布局稳定后再测标题栏
    public int rgnW, rgnH;           // 上次设置裁剪区域时的窗口大小
    public string title = "";
  }
  static readonly Dictionary<long, Managed> managed = new Dictionary<long, Managed>();
  static readonly object gate = new object();
  static readonly object outLock = new object();
  static TextWriter stdout;

  static void Write(string line) { lock (outLock) { stdout.WriteLine(line); stdout.Flush(); } }
  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') { b.Append('\\').Append(c); }
      else if (c < 0x20) { b.Append("\\u").Append(((int)c).ToString("x4")); }
      else if (c >= 0x200b && c <= 0x200f || c >= 0x2060 && c <= 0x2064 || c == 0xfeff) { } // 零宽字符（网页水印）丢掉
      else b.Append(c);
    }
    return b.ToString();
  }
  static string Title(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }

  // ---- 找 ego 的顶层浏览器窗口 ----
  static List<IntPtr> Find() {
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcessesByName("ego")) pids.Add((uint)p.Id);
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h) || GetParent(h) != IntPtr.Zero) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      if (Title(h).Length == 0) return true;
      list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  static string WinJson(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return "{\"hwnd\":\"" + h.ToInt64() + "\",\"title\":\"" + Esc(Title(h)) + "\",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}";
  }

  // ---- 打开专用窗口：记下已有窗口，启动后找新出现的那个 ----
  static IntPtr Open(string exe, string args) {
    var before = new HashSet<long>();
    foreach (var h in Find()) before.Add(h.ToInt64());
    var psi = new ProcessStartInfo(exe, args); psi.UseShellExecute = false;
    Process.Start(psi);
    var deadline = DateTime.Now.AddSeconds(15);
    while (DateTime.Now < deadline) {
      Thread.Sleep(80);
      foreach (var h in Find()) if (!before.Contains(h.ToInt64())) return h;
    }
    return IntPtr.Zero;
  }

  static void Attach(IntPtr c, IntPtr parent) {
    lock (gate) {
      Managed m;
      if (!managed.TryGetValue(c.ToInt64(), out m)) {
        m = new Managed { hwnd = c };
        if (IsZoomed(c) || IsIconic(c)) ShowWindow(c, 9);
        m.style = GetLong(c, GWL_STYLE).ToInt64();
        m.ex = GetLong(c, GWL_EXSTYLE).ToInt64();
        managed[c.ToInt64()] = m;
      }
      m.parent = parent;
      long style = (m.style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) | WS_CHILD | WS_CLIPSIBLINGS;
      long ex = m.ex & ~(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE);
      SetLong(c, GWL_STYLE, new IntPtr(style));
      SetLong(c, GWL_EXSTYLE, new IntPtr(ex));
      SetParent(c, parent);
      SetWindowPos(c, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      m.haveLast = false;
    }
  }
  static void Detach(IntPtr c) {
    lock (gate) {
      Managed m;
      if (!managed.TryGetValue(c.ToInt64(), out m)) return;
      managed.Remove(c.ToInt64());
      if (!IsWindow(c)) return;
      RECT r; GetWindowRect(c, out r);
      SetWindowRgn(c, IntPtr.Zero, true);
      SetParent(c, IntPtr.Zero);
      SetLong(c, GWL_STYLE, new IntPtr(m.style));
      SetLong(c, GWL_EXSTYLE, new IntPtr(m.ex));
      SetWindowPos(c, IntPtr.Zero, r.L, r.T, r.R - r.L, r.B - r.T, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    }
  }

  // ---- 跟随：每 4ms 看一次父窗口客户区，子窗口按锚点贴过去（异步移动，不等 ego） ----
  static int MeasureCaption(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    int x = r.L + (r.R - r.L) * 2 / 5;
    int max = Math.Min(160, (r.B - r.T) / 3);
    for (int dy = 0; dy < max; dy++) {
      int y = r.T + dy;
      IntPtr lp = new IntPtr(((y & 0xFFFF) << 16) | (x & 0xFFFF));
      IntPtr res;
      if (SendMessageTimeout(h, 0x84, IntPtr.Zero, lp, 2, 200, out res) == IntPtr.Zero) return 0; // WM_NCHITTEST, SMTO_ABORTIFHUNG
      if (res.ToInt64() == 1) return dy; // HTCLIENT
    }
    return 0;
  }

  static void Place(Managed m, bool force) {
    if (!m.anchored || !m.visible) return;
    RECT cr; GetClientRect(m.parent, out cr);
    RECT want; want.L = cr.R - m.right - m.width; want.T = m.top; want.R = cr.R - m.right; want.B = cr.B - m.bottom;
    if (want.R - want.L < 50 || want.B - want.T < 50) return;
    if (!force && m.haveLast && want.L == m.last.L && want.T == m.last.T && want.R == m.last.R && want.B == m.last.B) return;
    int crop = Math.Max(0, m.crop);
    int w = want.R - want.L, hh = want.B - want.T + crop;
    SetWindowPos(m.hwnd, IntPtr.Zero, want.L, want.T - crop, w, hh,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS | SWP_SHOWWINDOW);
    if (crop > 0 && (w != m.rgnW || hh != m.rgnH)) { SetWindowRgn(m.hwnd, CreateRectRgn(0, crop, w, hh), true); m.rgnW = w; m.rgnH = hh; }
    if (!m.haveLast) m.placedAt = Environment.TickCount;
    m.last = want; m.haveLast = true;
  }
  static void Follow() {
    int tick = 0;
    while (true) {
      Thread.Sleep(4);
      tick++;
      var gone = new List<long>();
      var titles = new List<Managed>();
      lock (gate) {
        foreach (var kv in managed) {
          var m = kv.Value;
          if (!IsWindow(m.hwnd)) { gone.Add(kv.Key); continue; }
          try {
            if (m.crop < 0 && m.anchored && m.visible && m.haveLast && Environment.TickCount - m.placedAt > 250) {
              m.crop = MeasureCaption(m.hwnd);
              Place(m, true);
            } else Place(m, false);
          } catch { }
          if (tick % 100 == 0) { var t = Title(m.hwnd); if (t != m.title) { m.title = t; titles.Add(m); } }
        }
        foreach (var k in gone) managed.Remove(k);
      }
      foreach (var k in gone) Write("0\tevent\t{\"type\":\"gone\",\"hwnd\":\"" + k + "\"}");
    }
  }

  static string Handle(string[] a) {
    switch (a[1]) {
      case "find": {
        var parts = new List<string>(); foreach (var h in Find()) parts.Add(WinJson(h));
        return "[" + string.Join(",", parts) + "]";
      }
      case "open": {
        var h = Open(a[2], a.Length > 3 ? a[3] : "");
        return h == IntPtr.Zero ? "null" : WinJson(h);
      }
      case "attach": {
        Attach(new IntPtr(long.Parse(a[2])), new IntPtr(long.Parse(a[3])));
        return "true";
      }
      case "anchor": {
        lock (gate) {
          Managed m;
          if (managed.TryGetValue(long.Parse(a[2]), out m)) {
            m.right = int.Parse(a[3]); m.top = int.Parse(a[4]); m.bottom = int.Parse(a[5]); m.width = int.Parse(a[6]);
            m.anchored = true; Place(m, true);
          }
        }
        return "true";
      }
      case "show": {
        lock (gate) {
          Managed m;
          if (managed.TryGetValue(long.Parse(a[2]), out m)) {
            m.visible = a[3] == "1";
            if (m.visible) { ShowWindow(m.hwnd, 8); Place(m, true); } else ShowWindow(m.hwnd, 0); // SW_SHOWNA / SW_HIDE
          }
        }
        return "true";
      }
      case "close": { PostMessage(new IntPtr(long.Parse(a[2])), WM_CLOSE, IntPtr.Zero, IntPtr.Zero); return "true"; }
      // 浏览器命令（和鼠标侧键一样）：1 后退 2 前进 3 刷新
      case "appcmd": { PostMessage(new IntPtr(long.Parse(a[2])), 0x0319, new IntPtr(long.Parse(a[2])), new IntPtr(int.Parse(a[3]) << 16)); return "true"; }
      case "detach": Detach(new IntPtr(long.Parse(a[2]))); return "true";
      case "geom": {
        var c = new IntPtr(long.Parse(a[2]));
        if (!IsWindow(c)) return "{\"exists\":false}";
        lock (gate) {
          Managed m; managed.TryGetValue(c.ToInt64(), out m);
          RECT have; GetWindowRect(c, out have);
          IntPtr parent = m != null ? m.parent : GetParent(c);
          MapWindowPoints(IntPtr.Zero, parent, ref have, 2);
          if (m != null && m.crop > 0) have.T += m.crop;
          RECT cr; GetClientRect(parent, out cr);
          string want = m != null ? "[" + (cr.R - m.right - m.width) + "," + m.top + "," + (cr.R - m.right) + "," + (cr.B - m.bottom) + "]" : "null";
          return "{\"exists\":true,\"crop\":" + (m != null ? m.crop : -1) + ",\"visible\":" + (IsWindowVisible(c) ? "true" : "false") + ",\"have\":[" + have.L + "," + have.T + "," + have.R + "," + have.B + "],\"want\":" + want + "}";
        }
      }
      case "closeall": {
        var webs = new List<IntPtr>();
        lock (gate) { foreach (var kv in managed) webs.Add(kv.Value.hwnd); managed.Clear(); }
        foreach (var h in webs) { ShowWindow(h, 0); SetParent(h, IntPtr.Zero); PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
        return "true";
      }
    }
    throw new Exception("unknown command " + a[1]);
  }

  public static void Run() {
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
    timeBeginPeriod(1); // 让 4ms 的睡眠更准
    stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var worker = new Thread(Follow); worker.IsBackground = true; worker.Start();
    Write("0\tready\t{}");
    string line;
    while ((line = stdin.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      var a = line.Split('\t');
      string id = a[0];
      // open 会等新窗口出现，放到后台线程，不挡住其他指令（比如拖动时的 anchor）
      if (a.Length > 1 && a[1] == "open") {
        var args = a;
        new Thread(() => { try { Write(id + "\tok\t" + Handle(args)); } catch (Exception e) { Write(id + "\terr\t" + Esc(e.Message)); } }) { IsBackground = true }.Start();
        continue;
      }
      try { Write(id + "\tok\t" + Handle(a)); }
      catch (Exception e) { Write(id + "\terr\t" + Esc(e.Message)); }
    }
  }
}
'@
[EgoHost]::Run()
