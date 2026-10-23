using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("海克斯指南")]
[assembly: AssemblyDescription("海克斯大乱斗本地实时助手")]
[assembly: AssemblyCompany("HexGuide")]
[assembly: AssemblyProduct("海克斯指南桌面版")]
[assembly: AssemblyCopyright("Copyright © 2026 HexGuide")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]
[assembly: AssemblyInformationalVersion("1.2.0")]

namespace HexGuide.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // Off-screen product-view verification: no MainWindow, tray, backend, hotkey or game action.
            if (args.Length == 2 && args[0] == "--sidebar-self-test")
            {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                try { Console.WriteLine(SidebarWindow.RunSelfTest(args[1])); }
                catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
                return;
            }
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e)
            {
                MessageBox.Show("窗口遇到问题，请关闭后重新打开。\r\n" + e.Exception.Message, "海克斯指南", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            string dataDirectory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "appdata");
            bool background = false, preview = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--data-dir" && i + 1 < args.Length) dataDirectory = Path.GetFullPath(args[++i]);
                else if (args[i] == "--background") background = true;
                else if (args[i] == "--sidebar-preview") { preview = true; background = true; }
            }
            try { Application.Run(new MainWindow(dataDirectory, background, preview)); }
            catch (Exception error)
            {
                MessageBox.Show("无法打开海克斯指南。请将压缩包完整解压后再运行。\r\n" + error.Message, "海克斯指南", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal sealed class MainWindow : Form
    {
        private readonly string dataDirectory;
        private readonly Label status;
        private readonly WebView2 browser;
        private readonly ToolStripButton reload;
        private Process backend;
        private ChildJob job;
        private Uri localOrigin;
        private bool closing;
        private bool stoppingBackend;
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem scanMenu;
        private readonly ToolStripLabel shortcutStatus;
        private readonly SidebarWindow sidebar;
        private readonly Timer refreshTimer;
        private readonly bool startHidden;
        private bool sidebarEnabled = true, previewSidebar, explicitActivation, trayHintShown;
        private bool fetching, scanChanging, confirmChanging, hotKeyRegistered;
        private string sessionToken;
        private IntPtr lastGame;
        private DateTime nextFetch = DateTime.MinValue;
        private const int SidebarHotKey = 0x4847;

        internal MainWindow(string dataDirectory, bool background, bool preview)
        {
            this.dataDirectory = dataDirectory;
            startHidden = background || GameWindow.IsGameForeground();
            previewSidebar = preview;
            Text = "海克斯指南 1.2.0 · 实时助手";
            Size = new Size(1320, 900);
            MinimumSize = new Size(860, 620);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(12, 17, 26);
            Font = new Font("Microsoft YaHei UI", 9F);
            // The same embedded brand icon is used by Explorer, the window and the tray.
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            AutoScaleMode = AutoScaleMode.Dpi;
            ShowInTaskbar = true;
            TopMost = false;
            KeyPreview = true;

            var toolbar = new ToolStrip();
            toolbar.GripStyle = ToolStripGripStyle.Hidden;
            toolbar.BackColor = Color.FromArgb(22, 29, 40);
            toolbar.ForeColor = Color.FromArgb(222, 231, 239);
            toolbar.Padding = new Padding(10, 4, 10, 4);
            var title = new ToolStripLabel("海克斯指南  /  本地实时助手");
            var hideButton = new ToolStripButton("收起到后台");
            hideButton.Click += delegate { HideMain(); };
            var sidebarButton = new ToolStripButton("显示 / 收起侧栏");
            sidebarButton.Click += delegate { ToggleSidebar(); };
            var gameButton = new ToolStripButton("返回游戏");
            gameButton.Click += delegate { ReturnToGame(); };
            reload = new ToolStripButton("刷新页面");
            reload.Enabled = false;
            reload.Click += delegate { if (browser.CoreWebView2 != null) browser.Reload(); };
            toolbar.Items.Add(title);
            toolbar.Items.Add(new ToolStripSeparator());
            toolbar.Items.Add(hideButton);
            toolbar.Items.Add(sidebarButton);
            toolbar.Items.Add(gameButton);
            toolbar.Items.Add(reload);
            shortcutStatus = new ToolStripLabel("Alt + Shift + H：切换侧栏");
            shortcutStatus.ForeColor = Color.FromArgb(163, 178, 196);
            toolbar.Items.Add(shortcutStatus);
            browser = new WebView2();
            browser.Dock = DockStyle.Fill;
            browser.DefaultBackgroundColor = BackColor;
            browser.Visible = false;
            status = new Label();
            status.Dock = DockStyle.Fill;
            status.TextAlign = ContentAlignment.MiddleCenter;
            status.ForeColor = ForeColor = Color.FromArgb(222, 231, 239);
            status.Font = new Font("Microsoft YaHei UI", 12F);
            status.Text = "正在启动本地助手…";
            Controls.Add(browser);
            Controls.Add(status);
            Controls.Add(toolbar);
            toolbar.Dock = DockStyle.Top;
            sidebar = new SidebarWindow();
            sidebar.HideRequested += delegate { sidebarEnabled = false; previewSidebar = false; sidebar.Hide(); };
            sidebar.DetailsRequested += delegate { ShowMain(); };
            sidebar.GameRequested += delegate { ReturnToGame(); };
            sidebar.OfferConfirmed += async delegate(string id) { await ConfirmOfferAsync(id); };
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开完整助手", null, delegate { ShowMain(); });
            menu.Items.Add("显示 / 收起游戏侧栏", null, delegate { ToggleSidebar(); });
            menu.Items.Add("预览侧栏（不切换窗口）", null, delegate { sidebarEnabled = true; previewSidebar = true; UpdateSidebarVisibility(); });
            scanMenu = new ToolStripMenuItem("后台识别海克斯");
            scanMenu.Enabled = false;
            scanMenu.ToolTipText = "只在游戏位于前台时识别；结果仍需人工核对。";
            scanMenu.Click += async delegate { await ToggleScanningAsync(); };
            menu.Items.Add(scanMenu);
            menu.Items.Add("返回游戏", null, delegate { ReturnToGame(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("完全退出", null, delegate { closing = true; Close(); });
            tray = new NotifyIcon { Icon = Icon, Text = "海克斯指南 · 后台运行中", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { ShowMain(); };
            refreshTimer = new Timer { Interval = 400 };
            refreshTimer.Tick += async delegate
            {
                UpdateSidebarVisibility();
                if (DateTime.UtcNow >= nextFetch) { nextFetch = DateTime.UtcNow.AddSeconds(2); await FetchSidebarAsync(); }
            };
            refreshTimer.Start();
            Shown += async delegate { if (startHidden) Hide(); await StartAsync(); };
            Resize += delegate { if (!closing && WindowState == FormWindowState.Minimized) HideMain(); };
            KeyDown += delegate(object sender, KeyEventArgs e)
            {
                // Escape is local to this app; no hook, game-key polling, or global Escape registration.
                if (e.KeyCode == Keys.Escape) { sidebarEnabled = false; previewSidebar = false; sidebar.Hide(); }
            };
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!closing && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; HideMain(); return; }
                closing = true;
                refreshTimer.Stop(); refreshTimer.Dispose();
                sidebar.Close();
                tray.Visible = false; tray.Dispose();
                StopBackend();
            };
        }

        protected override bool ShowWithoutActivation { get { return !explicitActivation; } }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            hotKeyRegistered = RegisterHotKey(Handle, SidebarHotKey, 0x0001 | 0x0004 | 0x4000, (uint)Keys.H);
            if (!hotKeyRegistered && shortcutStatus != null) shortcutStatus.Text = "快捷键被占用：请使用托盘或侧栏按钮";
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            if (hotKeyRegistered) { UnregisterHotKey(Handle, SidebarHotKey); hotKeyRegistered = false; }
            base.OnHandleDestroyed(e);
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0312 && message.WParam.ToInt32() == SidebarHotKey) { ToggleSidebar(); return; }
            base.WndProc(ref message);
        }

        private void HideMain()
        {
            if (closing) return;
            Hide();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            if (!trayHintShown)
            {
                trayHintShown = true;
                tray.ShowBalloonTip(2500, "助手继续在后台运行", "右下角托盘可打开助手、返回游戏或完全退出。Alt + Shift + H 切换游戏侧栏。", ToolTipIcon.Info);
            }
        }

        private void ShowMain()
        {
            if (closing) return;
            previewSidebar = false; sidebar.Hide();
            explicitActivation = true;
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show(); Activate();
        }

        private void ToggleSidebar()
        {
            bool visible = sidebar.Visible;
            sidebarEnabled = !visible;
            previewSidebar = !visible && !GameWindow.IsGameForeground();
            UpdateSidebarVisibility();
        }

        private void UpdateSidebarVisibility()
        {
            if (closing || sidebar.IsDisposed) return;
            IntPtr foreground = GameWindow.ForegroundGame();
            if (foreground != IntPtr.Zero) lastGame = foreground;
            if (!sidebarEnabled || (!previewSidebar && foreground == IntPtr.Zero)) { if (sidebar.Visible) sidebar.Hide(); UpdateSidebarHint(false); return; }
            IntPtr target = foreground != IntPtr.Zero ? foreground : lastGame;
            Rectangle area = target != IntPtr.Zero ? Screen.FromHandle(target).WorkingArea : Screen.PrimaryScreen.WorkingArea;
            sidebar.Place(area);
            if (!sidebar.Visible) sidebar.ShowPassive();
            UpdateSidebarHint(sidebar.Visible);
        }

        private void UpdateSidebarHint(bool visible)
        {
            string hint = hotKeyRegistered ? "Alt + Shift + H：侧栏" + (visible ? "已显示" : "已收起") : "快捷键被占用：请使用托盘或侧栏按钮";
            if (shortcutStatus.Text != hint) shortcutStatus.Text = hint;
        }

        private void ReturnToGame()
        {
            IntPtr target = GameWindow.FindGame(lastGame);
            if (target == IntPtr.Zero)
            {
                tray.ShowBalloonTip(2500, "没有找到游戏窗口", "请确认已进入游戏。助手不会尝试激活其他程序。", ToolTipIcon.Info);
                return;
            }
            lastGame = target; previewSidebar = false; HideMain();
            if (!GameWindow.ActivateGame(target)) tray.ShowBalloonTip(2500, "Windows 暂未允许切换", "请使用 Alt + Tab 返回游戏；助手不会模拟按键。", ToolTipIcon.Info);
        }

        private async Task StartAsync()
        {
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string node = Path.Combine(root, "runtime", "node.exe");
                string server = Path.Combine(root, "server", "main.mjs");
                if (!File.Exists(node) || !File.Exists(server))
                    throw new IOException("缺少运行文件。请完整解压软件包，不要只复制主程序。");
                Directory.CreateDirectory(dataDirectory);
                string writableProbe = Path.Combine(dataDirectory, ".write-check");
                File.WriteAllText(writableProbe, "ok");
                File.Delete(writableProbe);
                var start = new ProcessStartInfo(node);
                start.WorkingDirectory = root;
                start.Arguments = Quote(server) + " --port 0 --data-dir " + Quote(dataDirectory);
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8;
                start.StandardErrorEncoding = Encoding.UTF8;
                backend = new Process();
                backend.StartInfo = start;
                backend.EnableRaisingEvents = true;
                backend.Exited += delegate
                {
                    if (!closing && !stoppingBackend && IsHandleCreated)
                        BeginInvoke((Action)delegate { ShowFailure("本地连接已停止。请关闭窗口后重新打开软件。"); });
                };
                if (!backend.Start()) throw new IOException("本地服务未能启动。");
                job = new ChildJob(backend);
                // Drain stderr, but never persist credentials or session tokens in log files.
                backend.ErrorDataReceived += delegate { };
                backend.BeginErrorReadLine();
                Task<string> readyTask = backend.StandardOutput.ReadLineAsync();
                if (await Task.WhenAny(readyTask, Task.Delay(20000)) != readyTask)
                    throw new TimeoutException("本地服务启动超时。请检查文件是否被安全软件隔离，或重新解压软件包。");
                string ready = await readyTask;
                if (closing) return;
                var serializer = new JavaScriptSerializer();
                var handshake = serializer.Deserialize<Dictionary<string, object>>(ready ?? "{}");
                int port = handshake.ContainsKey("port") ? Convert.ToInt32(handshake["port"]) : 0;
                string token = handshake.ContainsKey("token") ? Convert.ToString(handshake["token"]) : "";
                if (port < 1 || port > 65535 || token.Length < 20 || token.Length > 512)
                    throw new IOException("本地服务返回了无效的启动信息，请重新解压软件包。");
                sessionToken = token;
                localOrigin = new Uri("http://127.0.0.1:" + port + "/");
                DrainOutput(backend);
                await FetchSidebarAsync();
                if (closing) return;
                status.Text = "正在打开界面…";
                var options = new CoreWebView2EnvironmentOptions();
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDirectory, "webview"), options);
                if (closing) return;
                await browser.EnsureCoreWebView2Async(environment);
                var settings = browser.CoreWebView2.Settings;
                settings.AreDevToolsEnabled = false;
                settings.AreDefaultContextMenusEnabled = false;
                settings.AreHostObjectsAllowed = false;
                settings.IsWebMessageEnabled = false;
                settings.IsStatusBarEnabled = false;
                settings.IsPasswordAutosaveEnabled = false;
                settings.IsGeneralAutofillEnabled = false;
                browser.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args)
                { args.State = CoreWebView2PermissionState.Deny; };
                browser.CoreWebView2.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args)
                { args.Cancel = true; };
                browser.CoreWebView2.NavigationStarting += OnNavigation;
                browser.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
                { args.Handled = true; OpenExternal(args.Uri); };
                browser.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
                {
                    if (!args.IsSuccess) { ShowFailure("页面未能打开，请点击刷新或重启软件。"); return; }
                    status.Visible = false;
                    browser.Visible = true;
                    reload.Enabled = true;
                };
                // The token stays in this process and the fragment, never an HTTP query or log.
                browser.Source = new Uri(localOrigin, "#session=" + Uri.EscapeDataString(token));
                // The handshake is the only backend stdout line needed by the shell.
            }
            catch (WebView2RuntimeNotFoundException)
            {
                ShowFailure("此电脑缺少 Microsoft Edge WebView2 运行环境。\r\n后台同步与原生侧栏仍可使用。\r\n完整界面请安装微软 Evergreen Runtime 后重试。\r\nhttps://developer.microsoft.com/microsoft-edge/webview2/");
            }
            catch (UnauthorizedAccessException)
            {
                ShowFailure("软件目录无法写入。请将完整文件夹放到可写位置后再打开，\r\n或使用 --data-dir 指定自己的数据文件夹。");
                StopBackend();
            }
            catch (Exception error)
            {
                ShowFailure("启动失败：" + error.Message);
                if (localOrigin == null) StopBackend();
            }
        }

        private void OnNavigation(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            Uri target;
            if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out target)) { args.Cancel = true; return; }
            if (localOrigin != null && target.Scheme == localOrigin.Scheme && target.Host == localOrigin.Host && target.Port == localOrigin.Port) return;
            args.Cancel = true;
            OpenExternal(args.Uri);
        }

        private async Task FetchSidebarAsync()
        {
            if (closing || localOrigin == null || fetching) return;
            fetching = true;
            try
            {
                var model = await RequestModelAsync("api/sidebar", null);
                if (closing || IsDisposed) return;
                sidebar.Model = model;
                scanMenu.Checked = ModelValue.Boolean(ModelValue.Object(model, "ocr"), "enabled");
                scanMenu.Enabled = !scanChanging;
                sidebar.Invalidate();
            }
            catch { if (!closing) { sidebar.Model = ModelValue.Failure("正在等待本地连接…"); sidebar.Invalidate(); } }
            finally { fetching = false; }
        }

        private async Task ToggleScanningAsync()
        {
            if (closing || localOrigin == null || scanChanging) return;
            scanChanging = true; scanMenu.Enabled = false;
            try
            {
                var model = await RequestModelAsync("api/sidebar/ocr", "{\"enabled\":" + (scanMenu.Checked ? "false" : "true") + "}");
                if (closing) return;
                sidebar.Model = model;
                scanMenu.Checked = ModelValue.Boolean(ModelValue.Object(model, "ocr"), "enabled");
                sidebar.Invalidate();
            }
            catch { if (!closing) tray.ShowBalloonTip(2500, "识别设置未保存", "请稍后重试，或打开完整助手手动扫描。", ToolTipIcon.Info); }
            finally { scanChanging = false; if (!closing) scanMenu.Enabled = true; }
        }

        private async Task ConfirmOfferAsync(string id)
        {
            if (closing || localOrigin == null || confirmChanging || string.IsNullOrEmpty(id)) return;
            var owned = new List<string>();
            foreach (object entry in ModelValue.Array(sidebar.Model, "owned"))
            {
                string value = ModelValue.Text(entry as Dictionary<string, object>, "id");
                if (value.Length > 0 && !owned.Contains(value)) owned.Add(value);
            }
            if (!owned.Contains(id)) owned.Add(id);
            string route = ModelValue.Text(sidebar.Model, "route");
            if (route.Length == 0) route = "auto";
            string body = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "owned", owned.ToArray() }, { "route", route } });
            confirmChanging = true;
            try
            {
                await RequestModelAsync("api/session", body);
                if (closing) return;
                sidebar.Notice = "已记录本局选择，推荐正在更新";
                await FetchSidebarAsync();
            }
            catch { if (!closing) sidebar.Notice = "记录未成功，请稍后再点一次"; }
            finally { confirmChanging = false; if (!closing) sidebar.Invalidate(); }
        }

        private Task<Dictionary<string, object>> RequestModelAsync(string path, string body)
        {
            Uri endpoint = new Uri(localOrigin, path);
            string token = sessionToken;
            string origin = localOrigin.GetLeftPart(UriPartial.Authority);
            return Task.Run(delegate
            {
                var request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Proxy = null;
                request.Timeout = 2000;
                request.ReadWriteTimeout = 2000;
                request.Headers["X-Hexguide-Session"] = token;
                request.Headers["Origin"] = origin;
                if (body != null)
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(body);
                    request.Method = "POST";
                    request.ContentType = "application/json";
                    request.ContentLength = bytes.Length;
                    using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
                }
                using (WebResponse response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    if (json.Length > 262144) throw new IOException("本地侧栏数据过长。");
                    return new JavaScriptSerializer { MaxJsonLength = 262144 }.Deserialize<Dictionary<string, object>>(json);
                }
            });
        }

        private static void OpenExternal(string value)
        {
            Uri target;
            if (!Uri.TryCreate(value, UriKind.Absolute, out target) || target.Scheme != Uri.UriSchemeHttps) return;
            try { Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true }); }
            catch { MessageBox.Show("无法打开外部链接，请在浏览器中访问。", "海克斯指南"); }
        }

        private void ShowFailure(string message)
        {
            if (closing || IsDisposed) return;
            browser.Visible = false;
            status.Text = message;
            status.Visible = true;
            sidebar.Model = ModelValue.Failure(message.Split('\r', '\n')[0]);
            sidebar.Invalidate();
        }

        private void StopBackend()
        {
            stoppingBackend = true;
            if (job != null) { job.Dispose(); job = null; }
            if (backend != null)
            {
                try { if (!backend.HasExited) backend.Kill(); }
                catch (InvalidOperationException) { }
                finally { backend.Dispose(); backend = null; }
            }
        }

        private static string Quote(string value)
        {
            // CommandLineToArgvW escaping, including backslashes before quotes and at the end.
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); result.Append(c); slashes = 0;
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }

        private static async void DrainOutput(Process process)
        {
            try { while (await process.StandardOutput.ReadLineAsync() != null) { } }
            catch (ObjectDisposedException) { }
            catch (IOException) { }
            catch (InvalidOperationException) { }
        }

        [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr handle, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr handle, int id);
    }

    // The painted sidebar has no text controls or WebView that can take keyboard focus.
    internal sealed class SidebarWindow : Form
    {
        private readonly Font headingFont = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold);
        private readonly Font normalFont = new Font("Microsoft YaHei UI", 9F);
        private readonly Font smallFont = new Font("Microsoft YaHei UI", 8F);
        private readonly Color muted = Color.FromArgb(154, 171, 192);
        private readonly Color accent = Color.FromArgb(128, 222, 193);
        private Rectangle hideButton, detailsButton, gameButton;
        private readonly Dictionary<Rectangle, string> offerButtons = new Dictionary<Rectangle, string>();
        internal Dictionary<string, object> Model = ModelValue.Failure("正在连接本地助手…");
        internal string Notice = "";
        internal event EventHandler HideRequested, DetailsRequested, GameRequested;
        internal event Action<string> OfferConfirmed;

        internal SidebarWindow()
        {
            Text = "海克斯指南 · 游戏侧栏";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.FromArgb(14, 22, 32);
            ForeColor = Color.FromArgb(229, 236, 245);
            Font = normalFont;
            Size = new Size(324, 720);
            AutoScaleMode = AutoScaleMode.Dpi;
            DoubleBuffered = true;
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get { var value = base.CreateParams; value.ExStyle |= 0x00000080 | 0x08000000; return value; }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
            base.WndProc(ref message);
        }
        internal void Place(Rectangle area)
        {
            int width = Math.Min(324, area.Width);
            int height = Math.Min(750, Math.Max(340, area.Height - 36));
            Rectangle desired = new Rectangle(area.Right - width - 12, area.Top + 18, width, height);
            if (Bounds != desired) Bounds = desired;
        }
        internal void ShowPassive()
        {
            if (!Visible) Show();
            SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, 0x0010 | 0x0040); // NOACTIVATE | SHOWWINDOW
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            using (var border = new Pen(Color.FromArgb(55, 77, 97))) g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            int x = 17, width = Width - 34, y = 16;
            Write(g, "海克斯指南", headingFont, ForeColor, new Rectangle(x, y, width, 29)); y += 34;
            Write(g, "Alt + Shift + H  显示 / 收起", smallFont, muted, new Rectangle(x, y, width, 20)); y += 28;
            var champion = ModelValue.Object(Model, "champion");
            string hero = ModelValue.Text(champion, "name");
            string level = ModelValue.Text(Model, "level");
            if (hero.Length == 0) hero = "等待英雄同步";
            Write(g, hero + (level.Length > 0 && level != "0" ? "  ·  " + level + " 级" : ""), headingFont, accent, new Rectangle(x, y, width, 27)); y += 29;
            string connection = ModelValue.Text(ModelValue.Object(Model, "connection"), "message");
            Write(g, connection.Length > 0 ? connection : "只读本机数据 · 不操作游戏", smallFont, muted, new Rectangle(x, y, width, 34)); y += 39;
            string ocrText = ModelValue.Boolean(ModelValue.Object(Model, "ocr"), "enabled") ? "后台识别已开启 · 结果需核对" : "后台识别未开启 · 可在托盘开启";
            Write(g, ocrText, smallFont, muted, new Rectangle(x, y, width, 20)); y += 28;
            ArrayList owned = ModelValue.Array(Model, "owned");
            Write(g, "本局已选  " + owned.Count, normalFont, accent, new Rectangle(x, y, width, 22)); y += 25;
            var names = new List<string>();
            foreach (object item in owned) { string name = ModelValue.Text(item as Dictionary<string, object>, "name"); if (name.Length > 0) names.Add(name); }
            Write(g, names.Count > 0 ? string.Join(" · ", names.ToArray()) : "尚未记录，选择后请在完整助手确认", smallFont, muted, new Rectangle(x, y, width, 38)); y += 46;
            ArrayList offers = ModelValue.Array(Model, "offers");
            Write(g, "三选一参考", normalFont, accent, new Rectangle(x, y, width, 22)); y += 27;
            Write(g, "先在游戏选好，再点「记为已选」", smallFont, muted, new Rectangle(x, y, width, 18)); y += 22;
            offerButtons.Clear();
            if (offers.Count == 0)
            {
                Write(g, "等待完整卡片出现。\r\n识别结果只作候选，使用前需核对名称。", normalFont, muted, new Rectangle(x, y, width, 52)); y += 59;
            }
            else
            {
                int index = 0;
                foreach (object item in offers)
                {
                    if (index++ >= 3 || y + 68 > Height - 102) break;
                    var offer = item as Dictionary<string, object>;
                    using (var brush = new SolidBrush(Color.FromArgb(23, 36, 48))) g.FillRectangle(brush, new Rectangle(x, y, width, 65));
                    string rank = ModelValue.Text(offer, "rank");
                    Write(g, (rank.Length > 0 ? rank + ". " : "") + ModelValue.Text(offer, "name"), normalFont, ForeColor, new Rectangle(x + 9, y + 6, width - 94, 23));
                    Rectangle confirm = new Rectangle(x + width - 76, y + 5, 68, 23);
                    PaintButton(g, confirm, "记为已选");
                    string offerId = ModelValue.Text(offer, "id");
                    if (offerId.Length > 0) offerButtons[confirm] = offerId;
                    string reason = ModelValue.Text(offer, "reason");
                    Write(g, reason.Length > 0 ? reason : "请核对识别名称", smallFont, muted, new Rectangle(x + 9, y + 30, width - 18, 29));
                    y += 74;
                }
            }
            var plan = ModelValue.Object(Model, "plan");
            string planTitle = ModelValue.Text(plan, "title"), summary = ModelValue.Text(plan, "summary");
            if (y + 85 < Height - 91 && (planTitle.Length > 0 || summary.Length > 0))
            {
                Write(g, planTitle.Length > 0 ? planTitle : "本局玩法参考", normalFont, accent, new Rectangle(x, y, width, 23)); y += 27;
                Write(g, summary, smallFont, muted, new Rectangle(x, y, width, Math.Max(28, Height - y - 100)));
            }
            int buttonY = Height - 67;
            hideButton = new Rectangle(x, buttonY, 65, 31);
            detailsButton = new Rectangle(x + 74, buttonY, 100, 31);
            gameButton = new Rectangle(x + 183, buttonY, width - 183, 31);
            PaintButton(g, hideButton, "收起"); PaintButton(g, detailsButton, "打开详细"); PaintButton(g, gameButton, "返回游戏");
            Write(g, Notice.Length > 0 ? Notice : "只读游戏 · 不替你点击或操作", smallFont, muted, new Rectangle(x, Height - 28, width, 18));
        }
        private static void Write(Graphics graphics, string text, Font font, Color color, Rectangle rectangle)
        {
            TextRenderer.DrawText(graphics, text ?? "", font, rectangle, color, TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }
        private void PaintButton(Graphics graphics, Rectangle rectangle, string title)
        {
            using (var brush = new SolidBrush(Color.FromArgb(35, 56, 69))) graphics.FillRectangle(brush, rectangle);
            TextRenderer.DrawText(graphics, title, smallFont, rectangle, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            foreach (var entry in offerButtons)
                if (entry.Key.Contains(e.Location)) { if (OfferConfirmed != null) OfferConfirmed(entry.Value); return; }
            if (hideButton.Contains(e.Location) && HideRequested != null) HideRequested(this, EventArgs.Empty);
            else if (detailsButton.Contains(e.Location) && DetailsRequested != null) DetailsRequested(this, EventArgs.Empty);
            else if (gameButton.Contains(e.Location) && GameRequested != null) GameRequested(this, EventArgs.Empty);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { headingFont.Dispose(); normalFont.Dispose(); smallFont.Dispose(); }
            base.Dispose(disposing);
        }
        internal static string RunSelfTest(string previewPath)
        {
            previewPath = Path.GetFullPath(previewPath);
            Directory.CreateDirectory(Path.GetDirectoryName(previewPath));
            using (var window = new SidebarWindow())
            {
                int flags = window.CreateParams.ExStyle;
                bool safe = window.ShowWithoutActivation && (flags & 0x08000000) != 0 && (flags & 0x00000080) != 0
                    && !window.ShowInTaskbar && window.TopMost && window.FormBorderStyle == FormBorderStyle.None && !window.Visible;
                if (!safe) throw new InvalidOperationException("Sidebar nonactivation self-test failed.");
                window.Model = new Dictionary<string, object> {
                    { "connection", new Dictionary<string, object> { { "status", "waiting" }, { "message", "离屏布局预览 · 下方均为示例数据" } } },
                    { "champion", new Dictionary<string, object> { { "id", "XinZhao" }, { "name", "示例英雄" } } },
                    { "level", 13 }, { "ocr", new Dictionary<string, object> { { "enabled", true } } },
                    { "owned", new object[] { new Dictionary<string, object> { { "id", "demo-owned" }, { "name", "示例已选海克斯" } } } },
                    { "offers", new object[] {
                        new Dictionary<string, object> { { "id", "demo-a" }, { "name", "示例选项 A" }, { "rank", 1 }, { "reason", "说明会随英雄和本局已选海克斯调整。" } },
                        new Dictionary<string, object> { { "id", "demo-b" }, { "name", "示例选项 B" }, { "rank", 2 }, { "reason", "先在游戏完成选择，再在这里记录。" } },
                        new Dictionary<string, object> { { "id", "demo-c" }, { "name", "示例选项 C" }, { "rank", 3 }, { "reason", "完整解释可在「打开详细」中查看。" } }
                    } },
                    { "plan", new Dictionary<string, object> { { "title", "本局玩法参考" }, { "summary", "建议会根据等级、装备和已确认的海克斯持续更新。" } } }
                };
                using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png); }
                if (window.Visible) throw new InvalidOperationException("Off-screen test unexpectedly displayed a window.");
                return new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "checks", 8 + GameWindow.ValidateFixtures() }, { "width", window.Width }, { "height", window.Height }, { "previewPath", previewPath } });
            }
        }
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    }

    internal static class ModelValue
    {
        internal static Dictionary<string, object> Object(Dictionary<string, object> model, string key)
        {
            object value;
            return model != null && model.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }
        internal static string Text(Dictionary<string, object> model, string key)
        {
            object value;
            return model != null && model.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }
        internal static bool Boolean(Dictionary<string, object> model, string key) { return string.Equals(Text(model, key), "true", StringComparison.OrdinalIgnoreCase); }
        internal static ArrayList Array(Dictionary<string, object> model, string key)
        {
            object value;
            if (model == null || !model.TryGetValue(key, out value) || value == null) return new ArrayList();
            var list = value as ArrayList;
            if (list != null) return list;
            var values = value as object[];
            return values == null ? new ArrayList() : new ArrayList(values);
        }
        internal static Dictionary<string, object> Failure(string message)
        {
            return new Dictionary<string, object> { { "connection", new Dictionary<string, object> { { "status", "waiting" }, { "message", message } } } };
        }
    }

    // Foreground tracking reads window metadata. Only explicit user commands activate a game.
    internal static class GameWindow
    {
        private delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
        internal static IntPtr ForegroundGame() { IntPtr window = GetForegroundWindow(); return IsVerifiedGame(window) ? window : IntPtr.Zero; }
        internal static bool IsGameForeground() { return ForegroundGame() != IntPtr.Zero; }
        internal static bool IsVerifiedGame(IntPtr window)
        {
            if (window == IntPtr.Zero || !IsWindow(window)) return false;
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (pid == 0) return false;
            try
            {
                using (Process process = Process.GetProcessById((int)pid))
                {
                    if (!string.Equals(process.ProcessName, "League of Legends", StringComparison.OrdinalIgnoreCase)) return false;
                    // QUERY_LIMITED_INFORMATION avoids VM_READ, memory access, and privilege escalation.
                    string path = QueryImagePath(pid);
                    var title = new StringBuilder(512);
                    GetWindowText(window, title, title.Capacity);
                    return IsTrustedGameIdentity(process.ProcessName, path, title.ToString());
                }
            }
            catch { return false; }
        }
        private static string QueryImagePath(uint pid)
        {
            IntPtr handle = OpenProcess(0x1000, false, pid);
            if (handle == IntPtr.Zero) return null;
            try
            {
                var path = new StringBuilder(32768);
                uint capacity = (uint)path.Capacity;
                return QueryFullProcessImageName(handle, 0, path, ref capacity) ? path.ToString() : null;
            }
            finally { CloseHandle(handle); }
        }
        private static bool IsTrustedGameIdentity(string processName, string path, string title)
        {
            if (!string.Equals(processName, "League of Legends", StringComparison.OrdinalIgnoreCase)) return false;
            // If Windows withholds even the limited path query, require both the exact
            // process name and known game-window title. A title alone is never accepted.
            if (string.IsNullOrEmpty(path)) return string.Equals(title, "League of Legends (TM) Client", StringComparison.Ordinal);
            try
            {
                return string.Equals(Path.GetFileName(path), "League of Legends.exe", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(new DirectoryInfo(Path.GetDirectoryName(path)).Name, "Game", StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }
        internal static int ValidateFixtures()
        {
            string valid = @"E:\Riot Games\LOL\League of Legends\Game\League of Legends.exe";
            bool passed = IsTrustedGameIdentity("League of Legends", valid, "")
                && !IsTrustedGameIdentity("Other", valid, "League of Legends (TM) Client")
                && !IsTrustedGameIdentity("League of Legends", @"E:\Game\Other.exe", "League of Legends (TM) Client")
                && !IsTrustedGameIdentity("League of Legends", @"E:\Other\League of Legends.exe", "League of Legends (TM) Client")
                && IsTrustedGameIdentity("League of Legends", null, "League of Legends (TM) Client")
                && !IsTrustedGameIdentity("League of Legends", null, "League of Legends")
                && !IsTrustedGameIdentity("Other", null, "League of Legends (TM) Client");
            if (!passed) throw new InvalidOperationException("Game-window identity fixtures failed.");
            return 7;
        }
        internal static IntPtr FindGame(IntPtr previous)
        {
            if (IsVerifiedGame(previous)) return previous;
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr window, IntPtr unused)
            {
                if (IsWindowVisible(window) && IsVerifiedGame(window)) { found = window; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }
        internal static bool ActivateGame(IntPtr window)
        {
            if (!IsVerifiedGame(window)) return false;
            if (IsIconic(window)) ShowWindowAsync(window, 9);
            return SetForegroundWindow(window);
        }
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int maximum);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }

    // A private Windows job ensures the helper exits even if the UI is terminated.
    internal sealed class ChildJob : IDisposable
    {
        private IntPtr handle;
        internal ChildJob(Process child)
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return;
            var info = new JobInformation();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int length = Marshal.SizeOf(typeof(JobInformation));
            IntPtr pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                if (!SetInformationJobObject(handle, 9, pointer, (uint)length) || !AssignProcessToJobObject(handle, child.Handle)) Dispose();
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
        [StructLayout(LayoutKind.Sequential)] private struct BasicInformation
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] private struct JobInformation
        {
            public BasicInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
        [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}
