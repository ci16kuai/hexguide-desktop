using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
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
[assembly: AssemblyDescription("海克斯大乱斗本局助手与资料查询")]
[assembly: AssemblyCompany("HexGuide")]
[assembly: AssemblyProduct("海克斯指南桌面版")]
[assembly: AssemblyCopyright("Copyright © 2026 HexGuide")]
[assembly: AssemblyVersion("1.10.2.0")]
[assembly: AssemblyFileVersion("1.10.2.0")]
[assembly: AssemblyInformationalVersion("1.10.2")]

namespace HexGuide.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // Pure fixtures only: no form, message loop, backend, game capture,
            // hotkey registration, or reads of the user's installed settings.
            if (args.Length == 1 && args[0] == "--selection-self-test")
            {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                try
                {
                    int checks = ScreenSelectionWatcher.ValidateFixtures() + MainWindow.ValidateSelectionDiagnosticFixtures();
                    Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                        { "version", "1.10.2" }, { "checks", checks },
                        { "nativeDiagnosticMaxBytes", ScreenSelectionWatcher.LargestDiagnosticFixtureBytes },
                        { "mode", "offline-no-ui" }, { "liveGameVerified", false }
                    }));
                }
                catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
                return;
            }
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

    // Other apps hide the panel only while the game is fully covered/minimized.
    // Occlusion never changes the user's open/closed intent.
    internal sealed class SidebarVisibilityState
    {
        internal bool Enabled { get; private set; }
        internal bool Pinned { get; private set; }
        private bool automaticOpened;
        internal SidebarVisibilityState(bool initiallyPinned)
        {
            Enabled = true; Pinned = initiallyPinned;
        }
        internal bool ShouldShow(bool gameForeground, bool mainForeground)
        {
            return ShouldShow(gameForeground, mainForeground, false);
        }
        internal bool ShouldShow(bool gameForeground, bool mainForeground, bool backgroundGameExposed)
        {
            if (Enabled && (gameForeground || backgroundGameExposed)) automaticOpened = true;
            return Enabled && (gameForeground || mainForeground || backgroundGameExposed) && (Pinned || automaticOpened);
        }
        internal bool HideForMainWindow { get { return !(Pinned || automaticOpened); } }
        internal void OpenPinned() { Enabled = true; Pinned = true; }
        internal void Close() { Enabled = false; Pinned = false; automaticOpened = false; }
        internal void Toggle(bool currentlyVisible)
        {
            if (Pinned || automaticOpened || currentlyVisible) Close();
            else OpenPinned();
        }
        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { if (!condition) throw new InvalidOperationException(message); checks++; };
            var automatic = new SidebarVisibilityState(false);
            check(automatic.Enabled && !automatic.Pinned, "Default sidebar intent must remain automatic.");
            check(!automatic.ShouldShow(false, true) && automatic.HideForMainWindow, "An unopened sidebar appeared on the initial main page.");
            check(!automatic.ShouldShow(false, false), "Automatic sidebar appeared over an unrelated foreground app.");
            check(automatic.ShouldShow(true, false), "The first foreground game did not automatically open the sidebar.");
            check(!automatic.ShouldShow(false, false) && automatic.Enabled, "Leaving the game did not temporarily hide the sidebar while retaining intent.");
            check(automatic.ShouldShow(false, true) && !automatic.HideForMainWindow, "Returning to the main page did not restore the automatically opened sidebar.");
            // Exercise only policy transitions. Actual message dispatch, hotkey
            // registration and main-window visibility require separate UI verification.
            var requested = new SidebarVisibilityState(false);
            requested.Toggle(false);
            check(requested.Enabled && requested.Pinned, "Explicit opening was not pinned.");
            check(requested.ShouldShow(true, false), "An explicitly opened sidebar was not visible in the game.");
            check(!requested.ShouldShow(false, false) && requested.Pinned && requested.Enabled, "Other apps did not suspend a pinned sidebar without clearing intent.");
            check(requested.ShouldShow(false, true), "Returning to the main window did not restore the pinned sidebar.");
            check(!requested.ShouldShow(false, false) && requested.ShouldShow(true, false), "Repeated away/return cycles lost the open state.");
            check(!requested.HideForMainWindow && requested.Pinned, "The main-window hiding policy would hide a pinned sidebar.");
            requested.Toggle(true);
            check(!requested.Enabled && !requested.Pinned, "Explicit toggling did not close and unpin the sidebar.");
            check(!requested.ShouldShow(true, false) && !requested.ShouldShow(false, true) && !requested.ShouldShow(false, false), "A manually closed sidebar reopened on a foreground change.");
            requested.OpenPinned();
            check(requested.ShouldShow(false, true) && !requested.ShouldShow(false, false), "Explicit preview escaped the allowed foreground scope.");
            requested.Close();
            check(!requested.ShouldShow(true, false), "Closing the visibility policy did not keep the sidebar closed.");
            var launchPreview = new SidebarVisibilityState(true);
            check(launchPreview.Pinned && !launchPreview.ShouldShow(false, false) && launchPreview.ShouldShow(false, true), "Sidebar-preview startup did not preserve intent while outside the allowed scope.");
            launchPreview.Toggle(false);
            check(!launchPreview.Enabled && !launchPreview.Pinned, "A temporarily hidden pinned window could not be closed by the next toggle.");
            automatic.Toggle(true);
            check(!automatic.ShouldShow(true, false) && !automatic.ShouldShow(false, true), "Toggling an automatically visible sidebar did not close it.");
            automatic.Toggle(false);
            check(automatic.Pinned && automatic.ShouldShow(false, true) && !automatic.ShouldShow(false, false), "Reopening after a manual close did not preserve a scoped open state.");
            var hiddenAutomatic = new SidebarVisibilityState(false);
            hiddenAutomatic.ShouldShow(true, false); hiddenAutomatic.ShouldShow(false, false);
            hiddenAutomatic.Toggle(false);
            check(!hiddenAutomatic.ShouldShow(true, false) && !hiddenAutomatic.ShouldShow(false, true), "Explicitly toggling a temporarily hidden automatic panel did not close its open intent.");
            var background = new SidebarVisibilityState(false);
            check(background.ShouldShow(false, false, true), "A visible background game did not preserve automatic sidebar display.");
            check(!background.ShouldShow(false, false, false) && background.Enabled, "A fully covered game did not temporarily hide the sidebar.");
            check(background.ShouldShow(false, false, true), "Exposing the background game did not restore the open sidebar.");
            background.Close();
            check(!background.ShouldShow(false, false, true) && !background.ShouldShow(true, false, false), "Background exposure reopened a manually closed sidebar.");
            return checks;
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
        private readonly SidebarVisibilityState sidebarVisibility;
        private readonly SidebarShortcut shortcut;
        private readonly ScreenSelectionWatcher selectionWatcher;
        private bool desiredSidebarVisible;
        private bool explicitActivation, trayHintShown;
        private bool fetching, scanChanging, confirmChanging, appearanceRequested, appearanceOpening, layoutRequested, layoutOpening;
        private long sidebarRequestGeneration;
        private string sessionToken;
        private IntPtr lastGame;
        private DateTime nextFetch = DateTime.MinValue;
        private DateTime nextBackgroundGameLookup = DateTime.MinValue;
        private DateTime nextSelectionDiagnostics = DateTime.MinValue;
        private int selectionDiagnosticsWriting;

        internal MainWindow(string dataDirectory, bool background, bool preview)
        {
            this.dataDirectory = dataDirectory;
            startHidden = background || GameWindow.IsGameForeground();
            sidebarVisibility = new SidebarVisibilityState(preview);
            Text = "海克斯指南 1.10.2 · 我的这一局";
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
            var title = new ToolStripLabel("海克斯指南  /  我的这一局");
            var gameTools = new ToolStripDropDownButton("游戏工具");
            var hideButton = new ToolStripMenuItem("收起到后台");
            hideButton.Click += delegate { HideMain(); };
            var sidebarButton = new ToolStripMenuItem("显示 / 收起侧栏");
            sidebarButton.Click += delegate { ToggleSidebar(); };
            var gameButton = new ToolStripMenuItem("返回游戏");
            gameButton.Click += delegate { ReturnToGame(); };
            var appearanceButton = new ToolStripButton("界面设置");
            appearanceButton.Click += async delegate { await OpenAppearanceAsync(); };
            var layoutButton = new ToolStripButton("编辑界面");
            layoutButton.Click += async delegate { await OpenLayoutAsync(); };
            reload = new ToolStripButton("刷新页面");
            reload.Enabled = false;
            reload.Click += delegate { if (browser.CoreWebView2 != null) browser.Reload(); };
            toolbar.Items.Add(title);
            toolbar.Items.Add(new ToolStripSeparator());
            gameTools.DropDownItems.Add(hideButton);
            gameTools.DropDownItems.Add(sidebarButton);
            gameTools.DropDownItems.Add(gameButton);
            toolbar.Items.Add(gameTools);
            toolbar.Items.Add(appearanceButton);
            toolbar.Items.Add(layoutButton);
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
            status.Text = "正在载入本局助手…";
            Controls.Add(browser);
            Controls.Add(status);
            Controls.Add(toolbar);
            toolbar.Dock = DockStyle.Top;
            sidebar = new SidebarWindow();
            sidebar.HideRequested += delegate { sidebarVisibility.Close(); sidebar.Hide(); };
            sidebar.DetailsRequested += delegate { ShowMain(); };
            sidebar.GameRequested += delegate { ReturnToGame(); };
            sidebar.OfferConfirmed += async delegate(string id) { await ConfirmOfferAsync(id); };
            selectionWatcher = new ScreenSelectionWatcher();
            selectionWatcher.StatusChanged += delegate(string message)
            {
                if (!closing && !confirmChanging) { sidebar.Notice = message; sidebar.Invalidate(); }
            };
            selectionWatcher.SelectionObserved += async delegate(Dictionary<string, object> evidence) { await ConfirmScreenSelectionAsync(evidence); };
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开海克斯指南", null, delegate { ShowMain(); });
            menu.Items.Add("界面设置", null, async delegate { await OpenAppearanceAsync(); });
            menu.Items.Add("编辑整个界面", null, async delegate { await OpenLayoutAsync(); });
            menu.Items.Add("显示 / 收起游戏侧栏", null, delegate { ToggleSidebar(); });
            menu.Items.Add("预览侧栏（不切换窗口）", null, delegate { sidebarVisibility.OpenPinned(); UpdateSidebarVisibility(); });
            scanMenu = new ToolStripMenuItem("后台识别海克斯");
            scanMenu.Enabled = false;
            scanMenu.ToolTipText = "只识别前台游戏；屏幕自动确认属于实验功能，证据不足时仍可手动确认。";
            scanMenu.Click += async delegate { await ToggleScanningAsync(); };
            menu.Items.Add(scanMenu);
            menu.Items.Add("返回游戏", null, delegate { ReturnToGame(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("完全退出", null, delegate { closing = true; Close(); });
            tray = new NotifyIcon { Icon = Icon, Text = "海克斯指南 · 后台运行中", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { ShowMain(); };
            shortcut = new SidebarShortcut(delegate { if (!closing) ToggleSidebar(); },
                delegate { return !closing && GameWindow.IsShortcutForeground(IsHandleCreated ? Handle : IntPtr.Zero); });
            shortcut.ContextChanged += delegate(bool allowed) { if (!closing) UpdateSidebarVisibility(); };
            refreshTimer = new Timer { Interval = 400 };
            refreshTimer.Tick += async delegate
            {
                UpdateSidebarVisibility();
                shortcut.Pulse(dataDirectory, sidebarVisibility.Enabled, sidebarVisibility.Pinned, desiredSidebarVisible, sidebar.Visible);
                PulseSelectionDiagnostics();
                if (DateTime.UtcNow >= nextFetch) { nextFetch = DateTime.UtcNow.AddSeconds(2); await FetchSidebarAsync(); }
                if (appearanceRequested) await OpenRequestedAppearanceAsync();
                if (layoutRequested) await OpenRequestedLayoutAsync();
            };
            refreshTimer.Start();
            Shown += async delegate { if (startHidden) Hide(); await StartAsync(); };
            Resize += delegate { if (!closing && WindowState == FormWindowState.Minimized) HideMain(); };
            KeyDown += delegate(object sender, KeyEventArgs e)
            {
                // Escape is local to this app; no hook, game-key polling, or global Escape registration.
                if (e.KeyCode == Keys.Escape) { sidebarVisibility.Close(); sidebar.Hide(); }
            };
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!closing && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; HideMain(); return; }
                closing = true;
                refreshTimer.Stop(); refreshTimer.Dispose();
                selectionWatcher.Dispose();
                shortcut.Dispose();
                sidebar.Close();
                tray.Visible = false; tray.Dispose();
                StopBackend();
            };
        }

        protected override bool ShowWithoutActivation { get { return !explicitActivation; } }

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
            if (sidebarVisibility.HideForMainWindow) sidebar.Hide();
            explicitActivation = true;
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show(); Activate();
        }

        private void ToggleSidebar()
        {
            sidebarVisibility.Toggle(sidebar.Visible);
            UpdateSidebarVisibility();
        }

        private async Task OpenAppearanceAsync()
        {
            if (closing) return;
            appearanceRequested = true;
            ShowMain();
            await OpenRequestedAppearanceAsync();
        }

        private async Task OpenRequestedAppearanceAsync()
        {
            if (!appearanceRequested || appearanceOpening || closing || browser.CoreWebView2 == null || !browser.Visible) return;
            appearanceOpening = true;
            try
            {
                // The fixed script is the only bridge; user-controlled settings are never evaluated.
                string result = await browser.CoreWebView2.ExecuteScriptAsync("Boolean(window.hexguideAppearance && (window.hexguideAppearance.open(), true))");
                if (string.Equals(result, "true", StringComparison.Ordinal)) appearanceRequested = false;
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
            catch (COMException) { }
            finally { appearanceOpening = false; }
        }

        private async Task OpenLayoutAsync()
        {
            if (closing) return;
            layoutRequested = true;
            ShowMain();
            await OpenRequestedLayoutAsync();
        }

        private async Task OpenRequestedLayoutAsync()
        {
            if (!layoutRequested || layoutOpening || closing || browser.CoreWebView2 == null || !browser.Visible) return;
            layoutOpening = true;
            try
            {
                string result = await browser.CoreWebView2.ExecuteScriptAsync("Boolean(window.hexguideLayout && (window.hexguideLayout.open(), true))");
                if (string.Equals(result, "true", StringComparison.Ordinal)) layoutRequested = false;
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
            catch (COMException) { }
            finally { layoutOpening = false; }
        }

        private void UpdateSidebarVisibility()
        {
            if (closing || sidebar.IsDisposed) return;
            IntPtr foreground = GameWindow.CurrentForeground();
            bool gameForeground = GameWindow.IsVerifiedGame(foreground);
            bool mainForeground = foreground != IntPtr.Zero && IsHandleCreated && foreground == Handle;
            if (gameForeground) lastGame = foreground;
            bool backgroundGameExposed = false;
            if (!gameForeground && !mainForeground && sidebarVisibility.Enabled)
            {
                if (!GameWindow.IsVerifiedGame(lastGame) && DateTime.UtcNow >= nextBackgroundGameLookup)
                {
                    lastGame = GameWindow.FindGame(IntPtr.Zero);
                    nextBackgroundGameLookup = DateTime.UtcNow.AddSeconds(2);
                }
                if (lastGame != IntPtr.Zero) backgroundGameExposed = GameWindow.HasExposedGameArea(lastGame, sidebar.IsHandleCreated ? sidebar.Handle : IntPtr.Zero);
            }
            desiredSidebarVisible = sidebarVisibility.ShouldShow(gameForeground, mainForeground, backgroundGameExposed);
            if (!desiredSidebarVisible) { if (sidebar.Visible) sidebar.Hide(); UpdateSidebarHint(false); return; }
            IntPtr target = gameForeground ? foreground : lastGame;
            Rectangle area = GameWindow.PlacementArea(target);
            sidebar.Place(area);
            if (!sidebar.Visible) sidebar.ShowPassive();
            UpdateSidebarHint(sidebar.Visible);
        }

        private void UpdateSidebarHint(bool visible)
        {
            string hint = "Alt + Shift + H：侧栏" + (visible ? "已显示" : "已收起");
            if (!shortcut.ContextAllowed) hint += " · 仅游戏 / 助手前台";
            else if (!shortcut.Registered) hint += " · 备用检测（" + shortcut.RegistrationError + "）";
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
            lastGame = target; HideMain();
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
                browser.CoreWebView2.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
                {
                    if (!args.IsSuccess) { ShowFailure("页面未能打开，请点击刷新或重启软件。"); return; }
                    status.Visible = false;
                    browser.Visible = true;
                    reload.Enabled = true;
                    await OpenRequestedAppearanceAsync();
                    await OpenRequestedLayoutAsync();
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
            if (closing || localOrigin == null || fetching || confirmChanging || scanChanging) return;
            fetching = true;
            long generation = sidebarRequestGeneration;
            try
            {
                var model = await RequestModelAsync("api/sidebar", null);
                if (closing || IsDisposed || generation != sidebarRequestGeneration || confirmChanging || scanChanging) return;
                sidebar.Model = model;
                selectionWatcher.UpdateModel(model);
                scanMenu.Checked = ModelValue.Boolean(ModelValue.Object(model, "ocr"), "enabled");
                scanMenu.Enabled = !scanChanging;
                sidebar.Invalidate();
            }
            catch { if (!closing && generation == sidebarRequestGeneration && !confirmChanging && !scanChanging) { selectionWatcher.CancelForLocalAction(); sidebar.Model = ModelValue.Failure("正在等待本地连接…"); sidebar.Invalidate(); } }
            finally { fetching = false; }
        }

        private void PulseSelectionDiagnostics()
        {
            DateTime now = DateTime.UtcNow;
            if (closing || now < nextSelectionDiagnostics || System.Threading.Interlocked.CompareExchange(ref selectionDiagnosticsWriting, 1, 0) != 0) return;
            nextSelectionDiagnostics = now.AddSeconds(2);
            string json;
            try
            {
                json = SelectionDiagnosticsJson(selectionWatcher, sidebar.Model, now);
            }
            catch { System.Threading.Interlocked.Exchange(ref selectionDiagnosticsWriting, 0); return; }
            string path = Path.Combine(dataDirectory, "diagnostics", "screen-selection-status.json");
            Task.Run(delegate
            {
                string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    File.WriteAllText(temporary, json, new UTF8Encoding(false));
                    if (File.Exists(path)) File.Replace(temporary, path, null);
                    else File.Move(temporary, path);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                finally
                {
                    try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
                    System.Threading.Interlocked.Exchange(ref selectionDiagnosticsWriting, 0);
                }
            });
        }

        internal static string SelectionDiagnosticsJson(ScreenSelectionWatcher watcher, Dictionary<string, object> model, DateTime now)
        {
            var snapshot = new Dictionary<string, object> {
                { "version", "1.10.2" }, { "schemaVersion", 2 },
                { "updatedAtUtc", now.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture) },
                { "native", watcher.Diagnostics() },
                { "backend", ScreenSelectionWatcher.BackendDiagnostics(ModelValue.Object(model, "selectionDiagnostics")) }
            };
            string json = new JavaScriptSerializer().Serialize(snapshot);
            if (Encoding.UTF8.GetByteCount(json) > 4096) throw new InvalidOperationException("Selection diagnostic snapshot exceeds its fixed bound.");
            return json;
        }

        internal static int ValidateSelectionDiagnosticFixtures()
        {
            using (var watcher = new ScreenSelectionWatcher())
            {
                watcher.RecordCaptureResult(false, "card-occluded", 1);
                var privateBackend = new Dictionary<string, object> {
                    { "selectionDiagnostics", new Dictionary<string, object> {
                        { "metadataStatus", "PRIVATE-MARKER" }, { "captureAgeMs", long.MaxValue },
                        { "lastScanAgeMs", 1 }, { "backendArmed", true }, { "ids", new[] { "PRIVATE-MARKER" } },
                        { "scanCode", "PRIVATE-MARKER" },
                        { "capture", new Dictionary<string, object> { { "windowHandle", "PRIVATE-MARKER" } } }
                    } }, { "name", "PRIVATE-MARKER" }
                };
                string json = SelectionDiagnosticsJson(watcher, privateBackend, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
                var snapshot = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                if (snapshot.Count != 5 || Encoding.UTF8.GetByteCount(json) > 4096
                    || ModelValue.Text(snapshot, "version") != "1.10.2" || ModelValue.Text(snapshot, "schemaVersion") != "2")
                    throw new InvalidOperationException("The persisted selection diagnostic snapshot exceeded its schema or byte bound.");
                if (json.Contains("PRIVATE-MARKER") || json.Contains("\"ids\"") || json.Contains("windowHandle")
                    || json.Contains("\"signature\"") || json.Contains("\"signatures\"") || json.Contains("\"delta\""))
                    throw new InvalidOperationException("Untrusted or private metadata entered the selection diagnostic snapshot.");
                return 2;
            }
        }

        private async Task ToggleScanningAsync()
        {
            if (closing || localOrigin == null || scanChanging) return;
            selectionWatcher.CancelForLocalAction();
            sidebarRequestGeneration++;
            scanChanging = true; scanMenu.Enabled = false;
            try
            {
                var model = await RequestModelAsync("api/sidebar/ocr", "{\"enabled\":" + (scanMenu.Checked ? "false" : "true") + "}");
                if (closing) return;
                sidebar.Model = model;
                selectionWatcher.UpdateModel(model);
                scanMenu.Checked = ModelValue.Boolean(ModelValue.Object(model, "ocr"), "enabled");
                sidebar.Invalidate();
            }
            catch { if (!closing) tray.ShowBalloonTip(2500, "识别设置未保存", "请稍后重试，或打开完整助手手动扫描。", ToolTipIcon.Info); }
            finally { scanChanging = false; if (!closing) scanMenu.Enabled = true; }
        }

        private async Task ConfirmOfferAsync(string id)
        {
            if (closing || localOrigin == null || confirmChanging || string.IsNullOrEmpty(id)) return;
            selectionWatcher.CancelForLocalAction();
            sidebarRequestGeneration++;
            confirmChanging = true;
            shortcut.ConfirmRequests++;
            try
            {
                var current = await RequestModelAsync("api/sidebar", null);
                if (closing) return;
                bool offered = false;
                foreach (object entry in ModelValue.Array(current, "offers"))
                    if (ModelValue.Text(entry as Dictionary<string, object>, "id") == id) offered = true;
                long revision;
                object currentGameId;
                if (!offered || !ModelValue.Integer(current, "sessionRevision", out revision) || !ModelValue.GameId(current, out currentGameId))
                {
                    sidebar.Model = current;
                    sidebar.Notice = "这轮选项已更新，请核对当前卡片";
                    return;
                }
                // The server checks the game, revision and current offer in one operation.
                // Never fall back to replacing an entire session from an older GET.
                string body = new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                    { "id", id }, { "gameId", currentGameId }, { "revision", revision }
                });
                var confirmed = await RequestModelAsync("api/session/confirm", body);
                if (closing) return;
                if (!ModelValue.ConfirmsOffer(confirmed, id, currentGameId))
                {
                    sidebar.Notice = "本局状态已变化，请核对当前选择";
                    nextFetch = DateTime.MinValue;
                    return;
                }
                sidebar.Model = confirmed;
                selectionWatcher.UpdateModel(confirmed);
                sidebar.ExpandBuild();
                shortcut.ConfirmSuccesses++;
                sidebar.Notice = "已记录本局选择，推荐已更新";
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                bool changed = response != null && response.StatusCode == HttpStatusCode.Conflict;
                if (response != null) response.Close();
                if (!closing) sidebar.Notice = changed ? "本轮选项已变化，请核对当前卡片" : "记录未成功，请稍后再点一次";
                if (changed && !closing) nextFetch = DateTime.MinValue;
            }
            catch { if (!closing) sidebar.Notice = "记录未成功，请稍后再点一次"; }
            finally { confirmChanging = false; if (!closing) sidebar.Invalidate(); }
        }

        private async Task ConfirmScreenSelectionAsync(Dictionary<string, object> evidence)
        {
            if (closing || localOrigin == null || confirmChanging || scanChanging) return;
            long selectedIndex;
            var ids = ModelValue.Array(evidence, "ids");
            if (!ModelValue.Integer(evidence, "selectedIndex", out selectedIndex) || selectedIndex > 2 || ids.Count != 3) return;
            string selectedId = ids[(int)selectedIndex] as string;
            object requestedGameId;
            if (string.IsNullOrEmpty(selectedId) || !ModelValue.GameId(evidence, out requestedGameId)) return;
            sidebarRequestGeneration++;
            confirmChanging = true;
            try
            {
                // The authoritative server checks the exact offer token, ordered
                // IDs, capture time, game epoch and revision before mutation.
                string body = new JavaScriptSerializer().Serialize(evidence);
                var confirmed = await RequestModelAsync("api/sidebar/selection", body);
                if (closing) return;
                if (!ModelValue.ConfirmsOffer(confirmed, selectedId, requestedGameId))
                {
                    sidebar.Notice = "屏幕自动确认（实验）：状态已变化，请手动核对";
                    nextFetch = DateTime.MinValue;
                    return;
                }
                sidebar.Model = confirmed;
                selectionWatcher.UpdateModel(confirmed);
                sidebar.ExpandBuild();
                sidebar.Notice = "屏幕自动确认（实验）：已记录选择，推荐已更新";
                nextFetch = DateTime.MinValue;
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                if (response != null) response.Close();
                if (!closing) sidebar.Notice = "屏幕自动确认（实验）：未记录本次选择，可手动确认";
                nextFetch = DateTime.MinValue;
            }
            catch { if (!closing) sidebar.Notice = "屏幕自动确认（实验）：记录未完成，可手动确认"; }
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

    }

    internal sealed class SidebarAppearance
    {
        internal string FontFamily = "system", Side = "left";
        internal int Scale = 100, Width = 324, Opacity = 100;
        internal string[] Sections = new[] { "hero", "owned", "offers", "plan" };
        internal string FontName
        {
            get { return FontFamily == "dengxian" ? "等线" : FontFamily == "simsun" ? "宋体" : FontFamily == "yahei" ? "Microsoft YaHei" : "Microsoft YaHei UI"; }
        }
        internal static SidebarAppearance FromModel(Dictionary<string, object> model)
        {
            var result = new SidebarAppearance();
            var settings = ModelValue.Object(ModelValue.Object(model, "appearance"), "sidebar");
            string family = ModelValue.Text(settings, "fontFamily"), side = ModelValue.Text(settings, "side");
            if (family == "system" || family == "yahei" || family == "dengxian" || family == "simsun") result.FontFamily = family;
            if (side == "left" || side == "right") result.Side = side;
            result.Scale = BoundedInteger(settings, "scale", 100, 85, 130);
            result.Width = BoundedInteger(settings, "width", 324, 280, 460);
            result.Opacity = BoundedInteger(settings, "opacity", 100, 75, 100);
            ArrayList sections = ModelValue.Array(settings, "sections");
            if (sections.Count == 4)
            {
                var selected = new List<string>();
                foreach (object section in sections)
                {
                    string value = section as string;
                    if ((value == "hero" || value == "owned" || value == "offers" || value == "plan") && !selected.Contains(value)) selected.Add(value);
                }
                if (selected.Count == 4) result.Sections = selected.ToArray();
            }
            return result;
        }
        private static int BoundedInteger(Dictionary<string, object> model, string key, int fallback, int minimum, int maximum)
        {
            double value;
            if (!double.TryParse(ModelValue.Text(model, key), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value)
                || double.IsNaN(value) || double.IsInfinity(value)) return fallback;
            return (int)Math.Round(Math.Max(minimum, Math.Min(maximum, value)));
        }
    }

    // The painted sidebar has no text controls or WebView that can take keyboard focus.
    internal sealed class SidebarWindow : Form
    {
        // Keep WinForms' managed TopMost state false. Framework Form.Show()
        // otherwise calls FocusActiveControlInternal even with
        // ShowWithoutActivation=true, and CreateHandle reapplies TopMost using
        // SetWindowPos without SWP_NOACTIVATE. Native styles provide the same
        // stacking policy without entering either managed activation path.
        private const int PassiveWindowStyles = 0x00000008 | 0x00000080 | 0x08000000; // TOPMOST | TOOLWINDOW | NOACTIVATE
        private const uint PassiveShowFlags = 0x0010 | 0x0200 | 0x0040; // NOACTIVATE | NOOWNERZORDER | SHOWWINDOW
        private Font headingFont, normalFont, smallFont;
        private SidebarAppearance appearance = new SidebarAppearance();
        private Dictionary<string, object> model = ModelValue.Failure("正在连接本地助手…");
        private readonly Color muted = Color.FromArgb(154, 171, 192);
        private readonly Color accent = Color.FromArgb(128, 222, 193);
        private Rectangle hideButton, detailsButton, gameButton, viewport, scrollTrack, scrollThumb;
        private int scrollOffset, contentHeight;
        private readonly List<string> paintedSections = new List<string>();
        private readonly Dictionary<Rectangle, string> offerButtons = new Dictionary<Rectangle, string>();
        private readonly Dictionary<Rectangle, Dictionary<string, object>> augmentTargets = new Dictionary<Rectangle, Dictionary<string, object>>();
        private readonly ToolTip augmentHint = new ToolTip { ShowAlways = true, InitialDelay = 450, ReshowDelay = 100, AutoPopDelay = 5000 };
        private string activeAugmentHint = "";
        private readonly Dictionary<string, Image> buildIcons = new Dictionary<string, Image>();
        private readonly Dictionary<string, Image> augmentIcons = new Dictionary<string, Image>();
        private readonly HashSet<string> requestedIcons = new HashSet<string>();
        private Rectangle buildToggle;
        private bool buildExpanded, remoteIcons = true;
        private bool initialPlanHandled;
        private string initialPlanGame = "";
        private long sessionRevision = -1;
        private Rectangle placementArea;
        private Point dragStartPointer, dragStartLocation;
        private bool dragging, consumeDragClick, customPosition, appearanceLoaded;
        private double horizontalPosition, verticalPosition = 0.5;
        internal Dictionary<string, object> Model
        {
            get { return model; }
            set
            {
                long revision;
                if (ModelValue.Integer(value, "sessionRevision", out revision))
                {
                    if (revision < sessionRevision) return;
                    sessionRevision = revision;
                }
                int previousOwned = ModelValue.Array(model, "owned").Count;
                bool previousModel = ModelValue.Object(model, "champion") != null;
                string previousPhase = ModelValue.Text(model, "phase");
                model = value;
                int currentOwned = ModelValue.Array(value, "owned").Count;
                string phase = ModelValue.Text(value, "phase"), game = ModelValue.Text(value, "gameId");
                bool boundary = phase == "ChampSelect" || phase == "EndOfGame" || phase == "WaitingForStats";
                bool newGame = game.Length > 0 && initialPlanGame.Length > 0 && game != initialPlanGame;
                if (boundary && phase != previousPhase || newGame) { initialPlanHandled = false; initialPlanGame = ""; }
                if (game.Length > 0) initialPlanGame = game;
                // A connection-only failure does not describe the current selection.
                // Keep an expanded build open until a real session explicitly clears it.
                if (IsLoadingPreview || HasEarlyLivePlan(value))
                {
                    if (!initialPlanHandled) { initialPlanHandled = true; ExpandBuild(); }
                }
                else if (value != null && value.ContainsKey("owned") && currentOwned == 0 && (previousOwned > 0 || boundary || newGame)) buildExpanded = false;
                else if (previousModel && currentOwned > previousOwned) ExpandBuild();
                double observedTime;
                if (currentOwned > 0 || ModelValue.Text(value, "championSource") == "live-client" && TryGameTime(value, out observedTime) && observedTime > 30) initialPlanHandled = true;
                offerButtons.Clear();
                ClearAugmentHint();
                // A transient connection error must not reset the user's last saved layout.
                if (ModelValue.Object(value, "appearance") != null) ApplyAppearance(SidebarAppearance.FromModel(value));
                else Invalidate();
            }
        }
        internal string Notice = "";
        internal bool IsLoadingPreview { get { return ModelValue.Text(ModelValue.Object(model, "plan"), "stage") == "loading-preview"; } }
        private static bool TryGameTime(Dictionary<string, object> value, out double time)
        {
            return double.TryParse(ModelValue.Text(value, "gameTime"), NumberStyles.Float, CultureInfo.InvariantCulture, out time)
                && !double.IsNaN(time) && !double.IsInfinity(time) && time >= 0;
        }
        private static bool HasEarlyLivePlan(Dictionary<string, object> value)
        {
            double time;
            var plan = ModelValue.Object(value, "plan");
            var enemy = ModelValue.Object(plan, "enemyContext");
            var mode = ModelValue.Object(value, "mode");
            return ModelValue.Boolean(mode, "known") && ModelValue.Boolean(mode, "isMayhem")
                && ModelValue.Text(ModelValue.Object(value, "connection"), "status") == "connected"
                && ModelValue.Text(value, "phase") == "InProgress" && ModelValue.Text(value, "championSource") == "live-client"
                && ModelValue.Text(ModelValue.Object(value, "champion"), "id").Length > 0 && TryGameTime(value, out time) && time <= 30
                && ModelValue.Array(value, "owned").Count == 0 && ModelValue.Text(plan, "stage") == "live"
                && ModelValue.Text(enemy, "status") == "detected" && ModelValue.Text(enemy, "source") == "live-client"
                && ModelValue.Array(enemy, "champions").Count > 0 && ModelValue.Array(plan, "buildItems").Count > 0
                && ModelValue.Array(plan, "nextAugments").Count > 0;
        }
        internal event EventHandler HideRequested, DetailsRequested, GameRequested;
        internal event Action<string> OfferConfirmed;

        internal void ExpandBuild()
        {
            buildExpanded = true;
            scrollOffset = 0;
            Invalidate();
        }
        private List<string> DisplaySections()
        {
            var result = new List<string>(appearance.Sections);
            if (buildExpanded) { result.Remove("plan"); result.Insert(0, "plan"); }
            return result;
        }

        internal SidebarWindow()
        {
            Text = "海克斯指南 · 游戏侧栏";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            BackColor = Color.FromArgb(14, 22, 32);
            ForeColor = Color.FromArgb(229, 236, 245);
            UpdateFonts();
            Size = new Size(324, 720);
            AutoScaleMode = AutoScaleMode.Dpi;
            DoubleBuffered = true;
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get { var value = base.CreateParams; value.ExStyle |= PassiveWindowStyles; return value; }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
            base.WndProc(ref message);
        }
        internal void Place(Rectangle area)
        {
            placementArea = area;
            if (dragging) return;
            int top = Math.Min(18, Math.Max(0, (area.Height - 1) / 2));
            int width = Math.Min(appearance.Width, Math.Max(1, area.Width));
            int height = Math.Min(750, Math.Max(1, area.Height - top * 2));
            int remainingX = Math.Max(0, area.Width - width), remainingY = Math.Max(0, area.Height - height);
            double x = customPosition ? horizontalPosition : appearance.Side == "left" ? 0 : 1;
            double y = customPosition ? verticalPosition : 0.5;
            Rectangle desired = new Rectangle(area.Left + (int)Math.Round(x * remainingX), area.Top + (int)Math.Round(y * remainingY), width, height);
            if (Bounds != desired) Bounds = desired;
        }
        private void BeginManualMove(Point pointer)
        {
            if (placementArea.Width < 1 || placementArea.Height < 1) return;
            dragging = true; consumeDragClick = true;
            dragStartPointer = pointer; dragStartLocation = Location;
        }
        private void MoveManually(Point pointer)
        {
            if (!dragging) return;
            int maxX = Math.Max(0, placementArea.Width - Width), maxY = Math.Max(0, placementArea.Height - Height);
            int x = Math.Max(0, Math.Min(maxX, dragStartLocation.X + pointer.X - dragStartPointer.X - placementArea.Left));
            int y = Math.Max(0, Math.Min(maxY, dragStartLocation.Y + pointer.Y - dragStartPointer.Y - placementArea.Top));
            horizontalPosition = maxX == 0 ? 0 : (double)x / maxX;
            verticalPosition = maxY == 0 ? 0.5 : (double)y / maxY;
            customPosition = true;
            Location = new Point(placementArea.Left + x, placementArea.Top + y);
        }
        private void EndManualMove()
        {
            if (!dragging) return;
            dragging = false;
            if (Capture) Capture = false;
            Cursor = Cursors.Default;
            if (placementArea.Width > 0 && placementArea.Height > 0) Place(placementArea);
            Invalidate();
        }
        private void ApplyAppearance(SidebarAppearance next)
        {
            bool fontsChanged = appearance.FontFamily != next.FontFamily || appearance.Scale != next.Scale;
            bool sectionsChanged = string.Join(",", appearance.Sections) != string.Join(",", next.Sections);
            bool sideChanged = appearanceLoaded && appearance.Side != next.Side;
            appearance = next;
            appearanceLoaded = true;
            if (sideChanged)
            {
                EndManualMove();
                customPosition = false;
                if (placementArea.Width > 0 && placementArea.Height > 0) Place(placementArea);
            }
            if (fontsChanged) UpdateFonts();
            if (sectionsChanged) scrollOffset = 0;
            double opacity = next.Opacity / 100.0;
            if (Math.Abs(Opacity - opacity) > 0.001) Opacity = opacity;
            Invalidate();
        }
        private void UpdateFonts()
        {
            Font oldHeading = headingFont, oldNormal = normalFont, oldSmall = smallFont;
            float scale = appearance.Scale / 100F;
            headingFont = new Font(appearance.FontName, 14F * scale, FontStyle.Bold);
            normalFont = new Font(appearance.FontName, 9F * scale);
            smallFont = new Font(appearance.FontName, 8F * scale);
            Font = normalFont;
            if (oldHeading != null) oldHeading.Dispose();
            if (oldNormal != null) oldNormal.Dispose();
            if (oldSmall != null) oldSmall.Dispose();
        }
        private int S(int value) { return Math.Max(1, (int)Math.Round(value * appearance.Scale / 100.0)); }
        internal void ShowPassive()
        {
            if (!Visible) Show();
            SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, PassiveShowFlags);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            using (var border = new Pen(Color.FromArgb(55, 77, 97))) g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            int x = 17, width = Math.Max(1, Width - 34), y = 16;
            Write(g, "海克斯指南", headingFont, ForeColor, new Rectangle(x, y, width, S(29))); y += S(34);
            Write(g, "Ctrl + 左键拖动 · Alt+Shift+H 收放", smallFont, muted, new Rectangle(x, y, width, S(20))); y += S(28);
            viewport = new Rectangle(x, y, width, Math.Max(1, Height - S(82) - y));
            contentHeight = 0;
            foreach (string section in DisplaySections()) contentHeight += SectionHeight(section);
            scrollOffset = Math.Max(0, Math.Min(scrollOffset, Math.Max(0, contentHeight - viewport.Height)));
            offerButtons.Clear(); augmentTargets.Clear(); paintedSections.Clear();
            var previousClip = g.Save();
            g.SetClip(viewport);
            y -= scrollOffset;
            buildToggle = Rectangle.Empty;
            foreach (string section in DisplaySections())
            {
                paintedSections.Add(section);
                DrawSection(g, section, x, y, width);
                y += SectionHeight(section);
            }
            g.Restore(previousClip);
            scrollTrack = scrollThumb = Rectangle.Empty;
            if (contentHeight > viewport.Height)
            {
                scrollTrack = new Rectangle(Width - 9, viewport.Top, 4, viewport.Height);
                using (var trackBrush = new SolidBrush(Color.FromArgb(35, 56, 69))) g.FillRectangle(trackBrush, scrollTrack);
                int thumbHeight = Math.Max(24, viewport.Height * viewport.Height / contentHeight);
                int thumbY = viewport.Top + scrollOffset * (viewport.Height - thumbHeight) / Math.Max(1, contentHeight - viewport.Height);
                scrollThumb = new Rectangle(scrollTrack.Left, thumbY, scrollTrack.Width, thumbHeight);
                using (var thumbBrush = new SolidBrush(muted)) g.FillRectangle(thumbBrush, scrollThumb);
            }
            int buttonY = Height - S(67), gap = 6, buttonWidth = Math.Max(1, (width - gap * 2) / 3);
            hideButton = new Rectangle(x, buttonY, buttonWidth, S(31));
            detailsButton = new Rectangle(x + buttonWidth + gap, buttonY, buttonWidth, S(31));
            gameButton = new Rectangle(x + (buttonWidth + gap) * 2, buttonY, buttonWidth, S(31));
            PaintButton(g, hideButton, "收起"); PaintButton(g, detailsButton, "打开详细"); PaintButton(g, gameButton, "返回游戏");
            string footer = Notice.Length > 0 ? Notice : contentHeight > viewport.Height ? "滚轮或右侧滚动条可查看全部内容" : "只读游戏 · 不替你点击或操作";
            Write(g, footer, smallFont, muted, new Rectangle(x, Height - S(28), width, S(18)));
        }
        private int SectionHeight(string section)
        {
            if (section == "hero") return S(29) + S(39) + S(28);
            if (section == "owned")
            {
                int count = Math.Min(12, ModelValue.Array(Model, "owned").Count);
                int columns = OwnedIconColumns(Math.Max(1, Width - 34));
                return S(25) + (count == 0 ? S(38) : ((count + columns - 1) / columns) * (S(39) + S(7)) + S(5));
            }
            if (section == "offers")
            {
                int count = Math.Min(3, ModelValue.Array(Model, "offers").Count);
                return S(27) + S(34) + (count == 0 ? S(59) : S(123) + count * S(35) + S(8));
            }
            if (!buildExpanded) return S(126);
            var plan = ModelValue.Object(Model, "plan");
            if (IsLoadingPreview) return S(197) + ((Math.Min(6, ModelValue.Array(plan, "buildItems").Count) + 1) / 2) * S(77)
                + S(46) + Math.Min(6, ModelValue.Array(plan, "nextAugments").Count) * S(56) + S(22);
            return S(ModelValue.Array(Model, "owned").Count > 0 ? 163 : 151) + Math.Min(6, ModelValue.Array(plan, "buildItems").Count) * S(96)
                + S(46) + Math.Min(6, ModelValue.Array(plan, "nextAugments").Count) * S(56) + S(22);
        }
        private void DrawSection(Graphics g, string section, int x, int y, int width)
        {
            if (section == "hero") { DrawHero(g, x, y, width); return; }
            if (section == "owned") { DrawOwned(g, x, y, width); return; }
            if (section == "offers") { DrawOffers(g, x, y, width); return; }
            DrawBuild(g, x, y, width);
        }
        private void DrawBuild(Graphics g, int x, int y, int width)
        {
            var plan = ModelValue.Object(Model, "plan");
            string title = ModelValue.Text(plan, "title"), summary = ModelValue.Text(plan, "summary");
            bool loading = IsLoadingPreview;
            Write(g, loading ? "开局前预览" : buildExpanded ? "本局构筑" : (title.Length > 0 ? title : "本局玩法参考"), normalFont, accent, new Rectangle(x, y, Math.Max(1, width - S(75)), S(23)));
            Rectangle toggle = new Rectangle(x + width - S(72), y, S(72), S(24));
            if (viewport.Contains(toggle)) { buildToggle = toggle; PaintButton(g, toggle, buildExpanded ? "收起构筑" : "展开构筑"); }
            y += S(29);
            if (!buildExpanded)
            {
                Write(g, summary.Length > 0 ? summary : "等待英雄与本局选择，推荐将自动更新。", smallFont, muted, new Rectangle(x, y, width, S(78)));
                return;
            }
            ArrayList owned = ModelValue.Array(Model, "owned");
            var selected = owned.Count > 0 ? owned[owned.Count - 1] as Dictionary<string, object> : null;
            if (!loading && selected != null)
            {
                DrawAugmentIcon(g, selected, new Rectangle(x, y + S(2), S(30), S(30)));
                Write(g, "最近确认", normalFont, ForeColor, new Rectangle(x + S(40), y + S(5), Math.Max(1, width - S(40)), S(23)));
                y += S(39);
            }
            else { Write(g, loading ? "对方阵容 · 加载中" : "等待确认本局海克斯", normalFont, ForeColor, new Rectangle(x, y, width, S(23))); y += S(27); }
            var enemy = ModelValue.Object(plan, "enemyContext");
            if (loading)
            {
                int enemyIndex = 0, cellWidth = Math.Max(1, width / 5);
                foreach (object entry in ModelValue.Array(enemy, "champions"))
                {
                    if (enemyIndex >= 5) break;
                    var champion = entry as Dictionary<string, object>;
                    int cellX = x + enemyIndex++ * cellWidth;
                    DrawBuildIcon(g, ModelValue.Text(champion, "icon"), new Rectangle(cellX, y, S(34), S(34)));
                    Write(g, ModelValue.Text(champion, "name"), smallFont, ForeColor, new Rectangle(cellX, y + S(38), Math.Max(1, cellWidth - S(3)), S(30)));
                }
                y += S(73);
            }
            string enemySummary = ModelValue.Text(enemy, "summary");
            Write(g, loading ? "根据英雄与对方阵容准备，入场后自动更新。" : enemySummary.Length > 0 ? enemySummary : "等待读取敌方阵容与装备，暂按自身构筑提供选项。", smallFont, muted, new Rectangle(x, y, width, S(loading ? 30 : 57))); y += S(loading ? 35 : 62);
            Write(g, loading ? "开局出装预设" : "本局装备选择", normalFont, accent, new Rectangle(x, y, width, S(23))); y += S(33);
            ArrayList equipment = ModelValue.Array(plan, "buildItems");
            int index = 0;
            foreach (object entry in equipment)
            {
                if (index++ >= 6) break;
                var item = entry as Dictionary<string, object>;
                if (loading)
                {
                    int column = (index - 1) % 2, cellWidth = Math.Max(1, width / 2), cellX = x + column * cellWidth;
                    DrawBuildIcon(g, ModelValue.Text(item, "icon"), new Rectangle(cellX, y + S(2), S(26), S(26)));
                    Write(g, ModelValue.Text(item, "name"), smallFont, ForeColor, new Rectangle(cellX + S(31), y, Math.Max(1, cellWidth - S(35)), S(24)));
                    Write(g, ModelValue.Text(item, "effect"), smallFont, muted, new Rectangle(cellX, y + S(30), Math.Max(1, cellWidth - S(5)), S(40)));
                    if (column == 1 || index == Math.Min(6, equipment.Count)) y += S(77);
                    continue;
                }
                DrawBuildIcon(g, ModelValue.Text(item, "icon"), new Rectangle(x, y + S(2), S(29), S(29)));
                Write(g, ModelValue.Text(item, "name"), normalFont, ForeColor, new Rectangle(x + S(38), y, Math.Max(1, width - S(38)), S(23)));
                Write(g, ModelValue.Text(item, "effect"), smallFont, muted, new Rectangle(x + S(38), y + S(25), Math.Max(1, width - S(38)), S(31)));
                Write(g, ModelValue.Text(item, "reason"), smallFont, accent, new Rectangle(x, y + S(60), width, S(29)));
                y += S(96);
            }
            Write(g, loading ? "开局关注的海克斯" : "后续遇到可考虑", normalFont, accent, new Rectangle(x, y, width, S(23))); y += S(25);
            Write(g, "机制方向，以游戏实际选项为准", smallFont, muted, new Rectangle(x, y, width, S(18))); y += S(21);
            index = 0;
            foreach (object entry in ModelValue.Array(plan, "nextAugments"))
            {
                if (index++ >= 6) break;
                var augment = entry as Dictionary<string, object>;
                DrawAugmentIcon(g, augment, new Rectangle(x, y + S(2), S(32), S(32)));
                Write(g, ModelValue.Text(augment, "reason"), smallFont, muted, new Rectangle(x + S(43), y + S(2), Math.Max(1, width - S(43)), S(43)));
                y += S(56);
            }
        }
        private int OwnedIconColumns(int width) { return Math.Max(1, (width + S(7)) / (S(39) + S(7))); }
        private void DrawAugmentIcon(Graphics g, Dictionary<string, object> augment, Rectangle rectangle)
        {
            string url = ModelValue.Text(augment, "icon");
            Image icon = GetAugmentIcon(url, ModelValue.Text(augment, "rarity"));
            if (icon != null) g.DrawImage(icon, rectangle);
            else DrawBuildIcon(g, url, rectangle);
            Rectangle visible = Rectangle.Intersect(viewport, rectangle);
            if (visible.Width > 0 && visible.Height > 0) augmentTargets[visible] = augment;
        }
        private Image GetAugmentIcon(string url, string rarity)
        {
            Image original;
            if (!buildIcons.TryGetValue(url, out original)) return null;
            if (rarity != "silver" && rarity != "gold" && rarity != "prismatic") return original;
            string key = url + "\n" + rarity;
            Image colored;
            if (!augmentIcons.TryGetValue(key, out colored))
            {
                colored = CreateRarityIcon(original, rarity);
                augmentIcons[key] = colored;
            }
            return colored;
        }
        private static Bitmap CreateRarityIcon(Image original, string rarity)
        {
            var rectangle = new Rectangle(0, 0, original.Width, original.Height);
            var colored = new Bitmap(rectangle.Width, rectangle.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var source = new Bitmap(rectangle.Width, rectangle.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(source))
                {
                    graphics.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                    graphics.DrawImageUnscaled(original, 0, 0);
                }
                Color light = rarity == "gold" ? Color.FromArgb(255, 233, 171) : Color.FromArgb(242, 247, 255);
                Color dark = rarity == "gold" ? Color.FromArgb(188, 139, 62) : Color.FromArgb(155, 175, 197);
                using (var graphics = Graphics.FromImage(colored))
                using (var brush = new System.Drawing.Drawing2D.LinearGradientBrush(rectangle, light, dark, 45F))
                {
                    if (rarity == "prismatic") brush.InterpolationColors = new System.Drawing.Drawing2D.ColorBlend {
                        Colors = new Color[] { Color.FromArgb(205, 177, 255), Color.FromArgb(143, 235, 243), Color.FromArgb(247, 181, 224), Color.FromArgb(178, 203, 255) },
                        Positions = new float[] { 0F, 0.35F, 0.7F, 1F }
                    };
                    graphics.FillRectangle(brush, rectangle);
                }
                var mask = source.LockBits(rectangle, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                var pixels = colored.LockBits(rectangle, System.Drawing.Imaging.ImageLockMode.ReadWrite, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                try
                {
                    var maskRow = new byte[rectangle.Width * 4]; var colorRow = new byte[maskRow.Length];
                    for (int y = 0; y < rectangle.Height; y++)
                    {
                        Marshal.Copy(IntPtr.Add(mask.Scan0, y * mask.Stride), maskRow, 0, maskRow.Length);
                        IntPtr destination = IntPtr.Add(pixels.Scan0, y * pixels.Stride);
                        Marshal.Copy(destination, colorRow, 0, colorRow.Length);
                        for (int x = 0; x < colorRow.Length; x += 4)
                        {
                            // Remove any source gold tone while retaining its shading and exact alpha.
                            int brightness = (77 * maskRow[x + 2] + 150 * maskRow[x + 1] + 29 * maskRow[x] + 128) >> 8;
                            for (int channel = 0; channel < 3; channel++) colorRow[x + channel] = maskRow[x + 3] == 0 ? (byte)0 : (byte)((colorRow[x + channel] * brightness + 127) / 255);
                            colorRow[x + 3] = maskRow[x + 3];
                        }
                        Marshal.Copy(colorRow, 0, destination, colorRow.Length);
                    }
                }
                finally { source.UnlockBits(mask); colored.UnlockBits(pixels); }
            }
            return colored;
        }
        private void DrawOfferFrame(Graphics g, Rectangle rectangle, string rank)
        {
            Color color = rank == "1" ? Color.FromArgb(216, 181, 101) : Color.FromArgb(55, 77, 97);
            using (var pen = new Pen(color, Math.Max(1, S(1))))
                g.DrawRectangle(pen, rectangle.Left, rectangle.Top, Math.Max(1, rectangle.Width - 1), Math.Max(1, rectangle.Height - 1));
        }
        private Font FitOfferNameFont(Graphics g, string name, Rectangle area)
        {
            float minimum = Math.Min(smallFont.SizeInPoints, 6.5F * appearance.Scale / 100F);
            for (float size = smallFont.SizeInPoints; ; size = Math.Max(minimum, size - 0.25F))
            {
                var font = new Font(smallFont.FontFamily, size, smallFont.Style, GraphicsUnit.Point);
                if (OfferNameFits(g, name, font, area) || size <= minimum) return font;
                font.Dispose();
            }
        }
        private static bool OfferNameFits(Graphics g, string name, Font font, Rectangle area)
        {
            var flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
            Size measured = TextRenderer.MeasureText(g, name, font, new Size(Math.Max(1, area.Width), int.MaxValue), flags);
            int lineHeight = TextRenderer.MeasureText(g, "中", font, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix).Height;
            return measured.Height <= Math.Min(area.Height, lineHeight * 2);
        }
        private void DrawOfferName(Graphics g, string name, Rectangle area)
        {
            using (var font = FitOfferNameFont(g, name, area))
            {
                int lineHeight = TextRenderer.MeasureText(g, "中", font, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix).Height;
                area.Height = Math.Min(area.Height, lineHeight * 2);
                TextRenderer.DrawText(g, name, font, area, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.Top | TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.PreserveGraphicsClipping);
            }
        }
        private void ClearAugmentHint()
        {
            augmentTargets.Clear();
            if (activeAugmentHint.Length == 0) return;
            activeAugmentHint = ""; augmentHint.Hide(this); augmentHint.SetToolTip(this, "");
        }
        private void DrawBuildIcon(Graphics g, string url, Rectangle rectangle)
        {
            Image icon;
            if (buildIcons.TryGetValue(url, out icon)) g.DrawImage(icon, rectangle);
            else
            {
                using (var pen = new Pen(Color.FromArgb(55, 77, 97))) g.DrawRectangle(pen, rectangle);
                QueueBuildIcon(url);
            }
        }
        private async void QueueBuildIcon(string url)
        {
            Uri uri;
            if (!remoteIcons || string.IsNullOrEmpty(url) || !Uri.TryCreate(url, UriKind.Absolute, out uri)
                || uri.Scheme != "https" || (uri.Host != "ddragon.leagueoflegends.com" && uri.Host != "raw.communitydragon.org")
                || requestedIcons.Count >= 96 || !requestedIcons.Add(url)) return;
            try
            {
                byte[] bytes = await Task.Run(delegate
                {
                    var request = (HttpWebRequest)WebRequest.Create(uri);
                    request.Timeout = 2500; request.ReadWriteTimeout = 2500; request.AllowAutoRedirect = false;
                    using (var response = request.GetResponse())
                    using (var stream = response.GetResponseStream())
                    using (var buffer = new MemoryStream())
                    {
                        byte[] chunk = new byte[8192]; int count;
                        while ((count = stream.Read(chunk, 0, chunk.Length)) > 0)
                        { if (buffer.Length + count > 262144) throw new IOException("Icon is too large."); buffer.Write(chunk, 0, count); }
                        return buffer.ToArray();
                    }
                });
                if (IsDisposed || Disposing) return;
                using (var stream = new MemoryStream(bytes))
                using (var image = Image.FromStream(stream)) buildIcons[url] = new Bitmap(image);
                Invalidate();
            }
            catch { /* Missing icons do not affect selection or live recommendations. */ }
        }
        private void DrawHero(Graphics g, int x, int y, int width)
        {
            var champion = ModelValue.Object(Model, "champion");
            string hero = ModelValue.Text(champion, "name");
            string level = ModelValue.Text(Model, "level");
            if (hero.Length == 0) hero = "等待英雄同步";
            Write(g, hero + (level.Length > 0 && level != "0" ? "  ·  " + level + " 级" : ""), headingFont, accent, new Rectangle(x, y, width, S(27))); y += S(29);
            string connection = ModelValue.Text(ModelValue.Object(Model, "connection"), "message");
            Write(g, connection.Length > 0 ? connection : "只读本机数据 · 不操作游戏", smallFont, muted, new Rectangle(x, y, width, S(34))); y += S(39);
            string ocrText = ModelValue.Boolean(ModelValue.Object(Model, "ocr"), "enabled") ? "后台识别已开启 · 结果需核对" : "后台识别未开启 · 可在托盘开启";
            Write(g, ocrText, smallFont, muted, new Rectangle(x, y, width, S(20)));
        }
        private void DrawOwned(Graphics g, int x, int y, int width)
        {
            ArrayList owned = ModelValue.Array(Model, "owned");
            Write(g, "本局已选  " + owned.Count, normalFont, accent, new Rectangle(x, y, width, S(22))); y += S(25);
            if (owned.Count == 0) { Write(g, "尚未记录；自动未确认时可点击图标确认", smallFont, muted, new Rectangle(x, y, width, S(38))); return; }
            int columns = OwnedIconColumns(width), index = 0, cell = S(39) + S(7);
            foreach (object item in owned)
            {
                if (index >= 12) break;
                DrawAugmentIcon(g, item as Dictionary<string, object>, new Rectangle(x + (index % columns) * cell, y + (index / columns) * cell, S(39), S(39)));
                index++;
            }
        }
        private void DrawOffers(Graphics g, int x, int y, int width)
        {
            ArrayList offers = ModelValue.Array(Model, "offers");
            Write(g, "三选一参考", normalFont, accent, new Rectangle(x, y, width, S(22))); y += S(27);
            Write(g, "先在游戏内选择，未记录时再确认\n金框为优先推荐，角标为推荐顺序", smallFont, muted, new Rectangle(x, y, width, S(32))); y += S(34);
            if (offers.Count == 0)
            {
                Write(g, RecognitionSummary(ModelValue.Object(Model, "ocr")), normalFont, muted, new Rectangle(x, y, width, S(30)));
                Write(g, RecognitionTime(ModelValue.Object(Model, "ocr")), smallFont, muted, new Rectangle(x, y + S(33), width, S(19)));
            }
            else
            {
                int index = 0, gap = S(6), cellWidth = Math.Max(1, (width - gap * 2) / 3), cardHeight = S(117);
                foreach (object item in offers)
                {
                    if (index >= 3) break;
                    var offer = item as Dictionary<string, object>;
                    int cardX = x + index * (cellWidth + gap);
                    Rectangle card = new Rectangle(cardX, y, cellWidth, cardHeight);
                    using (var brush = new SolidBrush(Color.FromArgb(23, 36, 48))) g.FillRectangle(brush, card);
                    string rank = ModelValue.Text(offer, "rank");
                    DrawOfferFrame(g, card, rank);
                    int iconSize = Math.Min(S(44), Math.Max(1, cellWidth - S(12)));
                    Rectangle icon = new Rectangle(cardX + (cellWidth - iconSize) / 2, y + S(6), iconSize, iconSize);
                    DrawAugmentIcon(g, offer, icon);
                    Write(g, rank, smallFont, accent, new Rectangle(cardX + S(5), y + S(3), S(15), S(18)));
                    DrawOfferName(g, ModelValue.Text(offer, "name"), new Rectangle(cardX + S(3), y + S(54), Math.Max(1, cellWidth - S(6)), S(33)));
                    PaintButton(g, new Rectangle(cardX + S(3), y + S(91), Math.Max(1, cellWidth - S(6)), S(21)), "确认");
                    string offerId = ModelValue.Text(offer, "id");
                    Rectangle visibleCard = Rectangle.Intersect(viewport, card);
                    if (visibleCard.Width > 0 && visibleCard.Height > 0 && offerId.Length > 0) offerButtons[visibleCard] = offerId;
                    index++;
                }
                y += S(123); index = 0;
                string[] slots = { "左", "中", "右" };
                foreach (object item in offers)
                {
                    if (index >= 3) break;
                    string reason = ModelValue.Text(item as Dictionary<string, object>, "reason");
                    Write(g, slots[index], smallFont, accent, new Rectangle(x, y, S(22), S(30)));
                    Write(g, reason.Length > 0 ? reason : "核对游戏内图标后确认", smallFont, muted, new Rectangle(x + S(23), y, Math.Max(1, width - S(23)), S(31)));
                    y += S(35); index++;
                }
            }
        }
        private static string RecognitionSummary(Dictionary<string, object> ocr)
        {
            if (ocr == null) return "正在等待本局识别状态…";
            if (!ModelValue.Boolean(ocr, "enabled")) return "自动识别已暂停，可从托盘恢复";
            string code = ModelValue.Text(ocr, "code"), status = ModelValue.Text(ocr, "status");
            string message = ModelValue.Text(ocr, "message");
            // Only fixed product text is displayed. Native diagnostics, raw OCR,
            // exception messages and local paths never become sidebar copy.
            if (code == "game-not-foreground" || code == "foreground-changed" || message.StartsWith("请先将英雄联盟游戏窗口切到前台", StringComparison.Ordinal) || message.StartsWith("前台窗口已切换", StringComparison.Ordinal)) return "等待游戏回到前台后自动识别";
            if (code == "ocr-language-missing" || code == "ocr-engine-unavailable" || message.StartsWith("Windows", StringComparison.Ordinal)) return "本机文字识别暂不可用，请检查中文识别";
            if (code == "window-bounds-unavailable" || code == "window-size-unsupported" || code == "ocr-capture-failed" || message.StartsWith("无法读取", StringComparison.Ordinal) || message.StartsWith("游戏窗口尺寸", StringComparison.Ordinal)) return "暂未读到游戏画面，将自动重试";
            if (status == "scanning") return "正在识别本轮三张卡片…";
            if (status == "recognized") return "本轮候选已处理，等待下一轮卡片";
            if (status == "unavailable")
                return message.StartsWith("未确认到同一排", StringComparison.Ordinal) ? "未识别到完整的三张卡片，将自动重试" : "本次识别未完成，将自动重试";
            return "等待游戏中的三选一卡片出现";
        }
        private static string RecognitionTime(Dictionary<string, object> ocr)
        {
            DateTimeOffset observed;
            return DateTimeOffset.TryParse(ModelValue.Text(ocr, "observedAt"), CultureInfo.InvariantCulture, DateTimeStyles.None, out observed)
                ? "最近检查 · " + observed.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                : "出现卡片后会自动检查";
        }
        private static void Write(Graphics graphics, string text, Font font, Color color, Rectangle rectangle)
        {
            TextRenderer.DrawText(graphics, text ?? "", font, rectangle, color, TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.PreserveGraphicsClipping);
        }
        private void PaintButton(Graphics graphics, Rectangle rectangle, string title)
        {
            using (var brush = new SolidBrush(Color.FromArgb(35, 56, 69))) graphics.FillRectangle(brush, rectangle);
            TextRenderer.DrawText(graphics, title, smallFont, rectangle, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && (GetAsyncKeyState(0x11) & 0x8000) != 0)
            {
                BeginManualMove(Cursor.Position);
                if (dragging) { Capture = true; Cursor = Cursors.SizeAll; }
                return;
            }
            consumeDragClick = false;
            base.OnMouseDown(e);
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (dragging)
            {
                if ((GetAsyncKeyState(0x11) & 0x8000) == 0 || (Control.MouseButtons & MouseButtons.Left) == 0) EndManualMove();
                else MoveManually(Cursor.Position);
                return;
            }
            string hint = "";
            foreach (var target in augmentTargets)
            {
                if (!target.Key.Contains(e.Location)) continue;
                string name = ModelValue.Text(target.Value, "name"), reason = ModelValue.Text(target.Value, "reason");
                if (reason.Length == 0) reason = ModelValue.Text(target.Value, "summary");
                string rarity = ModelValue.Text(target.Value, "rarity");
                string quality = rarity == "silver" ? "白银" : rarity == "gold" ? "黄金" : rarity == "prismatic" ? "棱彩" : "品质待核实";
                hint = name + " · " + quality + (reason.Length > 0 ? "\n" + reason : "");
                break;
            }
            if (hint != activeAugmentHint) { activeAugmentHint = hint; augmentHint.SetToolTip(this, hint); }
            Cursor = (GetAsyncKeyState(0x11) & 0x8000) != 0 ? Cursors.SizeAll : Cursors.Default;
            base.OnMouseMove(e);
        }
        protected override void OnMouseLeave(EventArgs e)
        {
            activeAugmentHint = ""; augmentHint.Hide(this); augmentHint.SetToolTip(this, "");
            base.OnMouseLeave(e);
        }
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (dragging && !Capture) EndManualMove();
            base.OnMouseCaptureChanged(e);
        }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && (dragging || consumeDragClick))
            {
                EndManualMove(); consumeDragClick = false; Cursor = Cursors.Default;
                return;
            }
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            if (buildToggle.Contains(e.Location)) { buildExpanded = !buildExpanded; scrollOffset = 0; Invalidate(); return; }
            if (scrollTrack.Contains(e.Location))
            {
                if (!scrollThumb.Contains(e.Location)) ScrollTo(scrollOffset + (e.Y < scrollThumb.Top ? -1 : 1) * Math.Max(S(40), viewport.Height / 2));
                return;
            }
            foreach (var entry in offerButtons)
                if (entry.Key.Contains(e.Location)) { if (OfferConfirmed != null) OfferConfirmed(entry.Value); return; }
            if (hideButton.Contains(e.Location) && HideRequested != null) HideRequested(this, EventArgs.Empty);
            else if (detailsButton.Contains(e.Location) && DetailsRequested != null) DetailsRequested(this, EventArgs.Empty);
            else if (gameButton.Contains(e.Location) && GameRequested != null) GameRequested(this, EventArgs.Empty);
        }
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            if (dragging) return;
            base.OnMouseWheel(e);
            ScrollTo(scrollOffset - Math.Sign(e.Delta) * S(52));
        }
        private void ScrollTo(int value)
        {
            scrollOffset = Math.Max(0, Math.Min(value, Math.Max(0, contentHeight - viewport.Height)));
            offerButtons.Clear();
            ClearAugmentHint();
            Invalidate();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { augmentHint.Dispose(); headingFont.Dispose(); normalFont.Dispose(); smallFont.Dispose(); foreach (Image image in augmentIcons.Values) image.Dispose(); augmentIcons.Clear(); foreach (Image image in buildIcons.Values) image.Dispose(); }
            base.Dispose(disposing);
        }
        internal static string RunSelfTest(string previewPath)
        {
            previewPath = Path.GetFullPath(previewPath);
            Directory.CreateDirectory(Path.GetDirectoryName(previewPath));
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                int flags = window.CreateParams.ExStyle;
                bool safe = window.ShowWithoutActivation && (flags & PassiveWindowStyles) == PassiveWindowStyles
                    && !window.ShowInTaskbar && !window.TopMost && window.FormBorderStyle == FormBorderStyle.None && !window.Visible;
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
                    { "plan", new Dictionary<string, object> {
                        { "title", "本局玩法参考" }, { "summary", "建议会根据等级、装备和已确认的海克斯持续更新。" },
                        { "enemyContext", new Dictionary<string, object> { { "summary", "示例阵容：已读取英雄与装备；此预览未连接真实对局。" } } },
                        { "buildItems", new object[] {
                            new Dictionary<string, object> { { "id", "demo-item-a" }, { "name", "示例装备 A" }, { "effect", "简短介绍装备属性与效果。" }, { "reason", "示例：针对已读取的敌方防御装备提供选项。" } },
                            new Dictionary<string, object> { { "id", "demo-item-b" }, { "name", "示例装备 B" }, { "effect", "装备图标、名字与效果一起显示。" }, { "reason", "示例：延续已确认海克斯的触发方式。" } }
                        } },
                        { "nextAugments", new object[] {
                            new Dictionary<string, object> { { "name", "示例后续海克斯 A" }, { "reason", "结合英雄机制、已有选择与可见阵容解释。" } },
                            new Dictionary<string, object> { { "name", "示例后续海克斯 B" }, { "reason", "这是关注方向，并非预测下一轮必定出现。" } }
                        } }
                    } }
                };
                using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png); }
                if (window.Visible) throw new InvalidOperationException("Off-screen test unexpectedly displayed a window.");
                int passiveActivationChecks = ValidatePassiveActivationFixtures(window);
                window.ExpandBuild();
                string buildPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-build.png");
                using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(buildPreviewPath, System.Drawing.Imaging.ImageFormat.Png); }
                Rectangle buildViewport = window.viewport;
                Require(window.paintedSections[0] == "plan" && window.contentHeight > buildViewport.Height, "Selected build must expand first and remain scrollable.");
                Require(!window.Visible && window.ShowWithoutActivation, "Expanded build unexpectedly activated a window.");
                window.buildExpanded = false; window.scrollOffset = 0;
                string statusPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-recognition-status.png");
                int liveStateChecks = ValidateLiveStateFixtures(window, statusPreviewPath);
                string loadingPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-loading.png");
                int loadingPreviewChecks = ValidateLoadingPreviewFixtures(window, loadingPreviewPath);
                string earlyLivePreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-early-live.png");
                int initialPlanChecks = ValidateInitialPlanFixtures(window, earlyLivePreviewPath);
                int visibilityChecks = SidebarVisibilityState.ValidateFixtures();
                int shortcutChecks = SidebarShortcut.ValidateFixtures();
                int selectionChecks = ScreenSelectionWatcher.ValidateFixtures();
                selectionChecks += MainWindow.ValidateSelectionDiagnosticFixtures();
                string iconPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-augment-icons.png");
                int augmentIconChecks = ValidateAugmentIconFixtures(iconPreviewPath);
                int defaultWidth = window.Width, defaultHeight = window.Height;
                int appearanceChecks = ValidateAppearanceFixtures(window);
                string placementPreviewPath;
                int positionChecks = ValidatePositionFixtures(Path.GetDirectoryName(previewPath), out placementPreviewPath);
                string customPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-custom.png");
                using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(customPreviewPath, System.Drawing.Imaging.ImageFormat.Png); }
                return new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "checks", 10 + GameWindow.ValidateFixtures() + appearanceChecks + positionChecks + liveStateChecks + loadingPreviewChecks + visibilityChecks + initialPlanChecks + shortcutChecks + augmentIconChecks + passiveActivationChecks + selectionChecks }, { "selectionChecks", selectionChecks }, { "passiveActivationChecks", passiveActivationChecks }, { "augmentIconChecks", augmentIconChecks }, { "shortcutChecks", shortcutChecks }, { "appearanceChecks", appearanceChecks }, { "positionChecks", positionChecks }, { "liveStateChecks", liveStateChecks }, { "loadingPreviewChecks", loadingPreviewChecks }, { "initialPlanChecks", initialPlanChecks }, { "visibilityChecks", visibilityChecks }, { "width", defaultWidth }, { "height", defaultHeight }, { "previewPath", previewPath }, { "customPreviewPath", customPreviewPath }, { "buildPreviewPath", buildPreviewPath }, { "placementPreviewPath", placementPreviewPath }, { "statusPreviewPath", statusPreviewPath }, { "loadingPreviewPath", loadingPreviewPath }, { "earlyLivePreviewPath", earlyLivePreviewPath }, { "iconPreviewPath", iconPreviewPath } });
            }
        }
        private static int ValidatePassiveActivationFixtures(SidebarWindow window)
        {
            // This fixture never calls Show/ShowPassive or sends real input.
            // Its hidden HWND was created solely for off-screen rendering.
            Require(!window.TopMost && window.WindowState == FormWindowState.Normal,
                "Sidebar entered a managed TopMost/maximized focus path.");
            Require((window.CreateParams.ExStyle & PassiveWindowStyles) == PassiveWindowStyles,
                "Sidebar creation styles omitted its passive topmost policy.");
            Require(window.IsHandleCreated && (GetWindowLongPtr(window.Handle, -20).ToInt64() & PassiveWindowStyles) == PassiveWindowStyles,
                "The hidden sidebar HWND did not carry native TOPMOST/TOOLWINDOW/NOACTIVATE styles.");
            Require((PassiveShowFlags & (0x0010 | 0x0200 | 0x0040)) == (0x0010 | 0x0200 | 0x0040),
                "Passive showing could activate a window or reorder its owner.");
            Message activation = Message.Create(window.Handle, 0x0021, IntPtr.Zero, IntPtr.Zero);
            window.WndProc(ref activation);
            Require(activation.Result == new IntPtr(3) && !window.Visible,
                "The synthetic mouse-activation message did not remain passive.");
            window.RecreateHandle();
            Require(!window.Visible && !window.TopMost && window.ShowWithoutActivation
                && (GetWindowLongPtr(window.Handle, -20).ToInt64() & PassiveWindowStyles) == PassiveWindowStyles,
                "Recreating the hidden sidebar lost its passive native policy.");
            return 6;
        }
        private static int ValidateAugmentIconFixtures(string previewPath)
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message) { Require(condition, message); checks++; };
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                var owned = new ArrayList(); var offers = new ArrayList(); var next = new ArrayList();
                for (int index = 0; index < 21; index++)
                {
                    string id = "icon-fixture-" + index, icon = "fixture://" + id;
                    Color color = Color.FromArgb(45 + index * 7, 200 - index * 5, 92 + index * 6);
                    var bitmap = new Bitmap(48, 48);
                    using (var graphics = Graphics.FromImage(bitmap)) graphics.Clear(color);
                    window.buildIcons[icon] = bitmap;
                    var augment = new Dictionary<string, object> { { "id", id }, { "icon", icon }, { "name", "示例海克斯名称 " + index }, { "reason", "保留该海克斯的机制与推荐解释。" }, { "rarity", new string[] { "silver", "gold", "prismatic", "" }[index % 4] } };
                    if (index < 12) owned.Add(augment);
                    else if (index < 15)
                    {
                        augment["rank"] = index == 12 ? 2 : index == 13 ? 1 : 3;
                        augment["rarity"] = index == 12 ? "prismatic" : "gold";
                        augment["name"] = new string[] { "大腕", "升级：贪欲九头蛇", "鼓声暴起 低音轰鸣" }[index - 12];
                        offers.Add(augment);
                    }
                    else next.Add(augment);
                }
                var fixture = new Dictionary<string, object> {
                    { "champion", new Dictionary<string, object> { { "id", "Ahri" }, { "name", "隔离示例英雄" } } },
                    { "owned", owned }, { "offers", offers }, { "plan", new Dictionary<string, object> {
                        { "title", "隔离图标布局示例" }, { "summary", "以下为示例图标，没有连接真实对局。" },
                        { "buildItems", new object[0] }, { "nextAugments", next }
                    } }
                };
                window.ApplyAppearance(new SidebarAppearance { Scale = 130, Width = 280, Sections = new string[] { "offers", "owned", "plan", "hero" } });
                window.Place(new Rectangle(0, 0, 1000, 900));
                window.Model = fixture; window.Notice = "离屏示例图标 · 未连接真实对局";
                using (var before = RenderFixture(window))
                {
                    before.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png);
                    check(window.Width == 280 && window.appearance.Scale == 130, "Icon fixture did not exercise narrow width with enlarged text.");
                    check(window.offerButtons.Count == 3, "Three icon cards did not expose three confirmation targets.");
                    var targets = new List<KeyValuePair<Rectangle, string>>(window.offerButtons);
                    targets.Sort(delegate(KeyValuePair<Rectangle, string> first, KeyValuePair<Rectangle, string> second) { return first.Key.Left.CompareTo(second.Key.Left); });
                    var frameColors = new List<int[]>();
                    for (int index = 0; index < targets.Count; index++)
                    {
                        Rectangle card = targets[index].Key;
                        int[] samples = OfferFramePixels(before, card); frameColors.Add(samples);
                        Color expectedFrame = index == 1 ? Color.FromArgb(216, 181, 101) : Color.FromArgb(55, 77, 97);
                        check(samples[0] == expectedFrame.ToArgb() && samples[1] == expectedFrame.ToArgb(), "Candidate recommendation borders followed rarity rather than rank.");
                        Rectangle nameArea = new Rectangle(card.Left + window.S(3), card.Top + window.S(54), Math.Max(1, card.Width - window.S(6)), window.S(33));
                        string name = ModelValue.Text(offers[index] as Dictionary<string, object>, "name");
                        using (var graphics = Graphics.FromImage(before)) using (var font = window.FitOfferNameFont(graphics, name, nameArea))
                            check(OfferNameFits(graphics, name, font, nameArea), "A common Chinese augment name could not fit two lines at narrow width and 130% scale.");
                    }
                    string selected = "";
                    Action<string> confirm = delegate(string id) { selected = id; };
                    window.OfferConfirmed += confirm;
                    try
                    {
                        for (int index = 0; index < targets.Count; index++)
                        {
                            check(targets[index].Value == "icon-fixture-" + (12 + index), "Recommendation rank reordered the game's icon positions.");
                            Rectangle target = targets[index].Key;
                            window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, target.Left + target.Width / 2, target.Top + target.Height / 2, 0));
                            check(selected == targets[index].Value, "An icon confirmation selected a different augment ID.");
                        }
                    }
                    finally { window.OfferConfirmed -= confirm; }
                    Rectangle fixtureViewport = window.viewport;
                    foreach (var target in window.augmentTargets)
                    {
                        Rectangle area = target.Key;
                        check(area.Left >= fixtureViewport.Left && area.Right <= fixtureViewport.Right, "An augment icon overflowed the narrow viewport.");
                        if (area.Width == area.Height)
                        {
                            var expected = (Bitmap)window.GetAugmentIcon(ModelValue.Text(target.Value, "icon"), ModelValue.Text(target.Value, "rarity"));
                            Color actual = before.GetPixel(area.Left + area.Width / 2, area.Top + area.Height / 2), pixel = expected.GetPixel(expected.Width / 2, expected.Height / 2);
                            check(Math.Abs(actual.R - pixel.R) <= 3 && Math.Abs(actual.G - pixel.G) <= 3 && Math.Abs(actual.B - pixel.B) <= 3, "Augment icon art or color did not match its identity.");
                        }
                    }
                    (offers[0] as Dictionary<string, object>)["rank"] = 1;
                    (offers[1] as Dictionary<string, object>)["rank"] = 2;
                    window.Model = fixture;
                    using (var ranked = RenderFixture(window))
                    {
                        for (int index = 0; index < targets.Count; index++)
                        {
                            Rectangle card = targets[index].Key;
                            int[] afterRank = OfferFramePixels(ranked, card);
                            Color expectedFrame = index == 0 ? Color.FromArgb(216, 181, 101) : Color.FromArgb(55, 77, 97);
                            check(afterRank[0] == expectedFrame.ToArgb() && afterRank[1] == expectedFrame.ToArgb(), "Changing recommendation rank did not move the gold recommendation border.");
                            Point iconCenter = new Point(card.Left + card.Width / 2, card.Top + window.S(28));
                            check(ranked.GetPixel(iconCenter.X, iconCenter.Y) == before.GetPixel(iconCenter.X, iconCenter.Y), "Changing recommendation rank recolored the augment icon.");
                        }
                    }
                    (offers[0] as Dictionary<string, object>)["rank"] = 2;
                    (offers[1] as Dictionary<string, object>)["rank"] = 1;
                    (offers[0] as Dictionary<string, object>)["rarity"] = "silver";
                    window.Model = fixture;
                    using (var recolored = RenderFixture(window))
                    {
                        Rectangle card = targets[0].Key;
                        int[] samples = OfferFramePixels(recolored, card);
                        check(samples[0] == frameColors[0][0] && samples[1] == frameColors[0][1], "Changing rarity changed the recommendation border.");
                        Point center = new Point(card.Left + card.Width / 2, card.Top + window.S(28));
                        check(recolored.GetPixel(center.X, center.Y) != before.GetPixel(center.X, center.Y), "Changing rarity did not recolor the augment's own art.");
                    }
                    (offers[0] as Dictionary<string, object>)["rarity"] = "prismatic";
                    RenameFixtureAugments(owned, next);
                    window.Model = fixture;
                    using (var after = RenderFixture(window)) check(EqualFixturePixels(before, after), "Owned or future augment names were still drawn by default.");
                    foreach (object offer in offers) (offer as Dictionary<string, object>)["name"] = "候选名称已改变";
                    window.Model = fixture;
                    using (var renamed = RenderFixture(window)) check(!EqualFixturePixels(before, renamed), "Candidate augment names were not visible beneath their icons.");
                }
                window.ExpandBuild();
                using (var before = RenderFixture(window))
                {
                    string expanded = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-expanded.png");
                    before.Save(expanded, System.Drawing.Imaging.ImageFormat.Png);
                    RenameFixtureAugments(owned, next); window.Model = fixture;
                    using (var after = RenderFixture(window)) check(EqualFixturePixels(before, after), "Recently selected or future augment names were still drawn by default.");
                }
                window.ScrollTo(window.contentHeight);
                check(window.offerButtons.Count == 0 && window.augmentTargets.Count == 0, "Scrolling kept stale icon hit targets before repaint.");
                using (var before = RenderFixture(window))
                {
                    RenameFixtureAugments(owned, next); window.Model = fixture;
                    using (var after = RenderFixture(window)) check(EqualFixturePixels(before, after), "Scrolled augment labels became visible.");
                    Rectangle scrolledViewport = window.viewport;
                    foreach (var target in window.offerButtons) check(scrolledViewport.Contains(target.Key), "Scrolled confirmation targets escaped the visible viewport.");
                }
                check(!window.Visible && window.ShowWithoutActivation && window.activeAugmentHint.Length == 0, "Icon fixtures displayed or activated a real window or tooltip.");
                // One source URL may legitimately serve different qualities. Test
                // opaque detail, partial alpha, and a transparent hole in its art.
                string sharedUrl = "fixture://shared-rarity";
                var shared = new Bitmap(64, 64, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                using (var graphics = Graphics.FromImage(shared)) graphics.Clear(Color.FromArgb(245, 190, 90));
                shared.SetPixel(8, 8, Color.FromArgb(0, 0, 0, 0));
                shared.SetPixel(9, 8, Color.FromArgb(96, 230, 180, 80));
                shared.SetPixel(20, 20, Color.FromArgb(96, 96, 96));
                shared.SetPixel(21, 20, Color.White);
                window.buildIcons[sharedUrl] = shared;
                var silver = (Bitmap)window.GetAugmentIcon(sharedUrl, "silver");
                var gold = (Bitmap)window.GetAugmentIcon(sharedUrl, "gold");
                var prismatic = (Bitmap)window.GetAugmentIcon(sharedUrl, "prismatic");
                check(!object.ReferenceEquals(silver, gold) && !object.ReferenceEquals(gold, prismatic), "A shared URL reused another rarity's cached icon.");
                check(object.ReferenceEquals(silver, window.GetAugmentIcon(sharedUrl, "silver")), "Repainting recreated an already cached rarity icon.");
                check(object.ReferenceEquals(shared, window.GetAugmentIcon(sharedUrl, "unknown")), "Unknown rarity altered the source art.");
                check(shared.GetPixel(32, 32) == Color.FromArgb(245, 190, 90), "Coloring a rarity mutated the source used by hero or equipment drawing.");
                foreach (var colored in new Bitmap[] { silver, gold, prismatic })
                {
                    bool alphaMatches = true;
                    for (int y = 0; y < shared.Height; y++) for (int x = 0; x < shared.Width; x++)
                        if (shared.GetPixel(x, y).A != colored.GetPixel(x, y).A) alphaMatches = false;
                    check(alphaMatches && colored.GetPixel(8, 8).A == 0 && colored.GetPixel(9, 8).A == 96, "Rarity coloring filled a transparent hole or changed edge alpha.");
                    Color detail = colored.GetPixel(20, 20), light = colored.GetPixel(21, 20);
                    check(detail.R < light.R / 2 && detail.G < light.G / 2 && detail.B < light.B / 2, "Rarity coloring discarded the source's gray detail.");
                }
                Color silverCenter = silver.GetPixel(32, 32), goldCenter = gold.GetPixel(32, 32);
                check(silverCenter.B >= silverCenter.R && goldCenter.R > goldCenter.G && goldCenter.G > goldCenter.B, "Shared gold source did not become distinct silver and gold art.");
                check(prismatic.GetPixel(20, 20).ToArgb() != silver.GetPixel(20, 20).ToArgb() && prismatic.GetPixel(45, 45).ToArgb() != gold.GetPixel(45, 45).ToArgb(), "Prismatic art did not receive its own gradient palette.");
            }
            return checks;
        }
        private static int[] OfferFramePixels(Bitmap bitmap, Rectangle frame)
        {
            return new int[] { bitmap.GetPixel(frame.Left + frame.Width / 4, frame.Top).ToArgb(), bitmap.GetPixel(frame.Left + frame.Width * 3 / 4, frame.Top).ToArgb() };
        }
        private static Bitmap RenderFixture(SidebarWindow window)
        {
            var bitmap = new Bitmap(window.Width, window.Height);
            window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            return bitmap;
        }
        private static bool EqualFixturePixels(Bitmap first, Bitmap second)
        {
            using (var left = new MemoryStream()) using (var right = new MemoryStream())
            {
                first.Save(left, System.Drawing.Imaging.ImageFormat.Png); second.Save(right, System.Drawing.Imaging.ImageFormat.Png);
                byte[] a = left.ToArray(), b = right.ToArray();
                if (a.Length != b.Length) return false;
                for (int index = 0; index < a.Length; index++) if (a[index] != b[index]) return false;
                return true;
            }
        }
        private static void RenameFixtureAugments(params ArrayList[] groups)
        {
            foreach (ArrayList group in groups) foreach (object entry in group)
            {
                var augment = entry as Dictionary<string, object>;
                augment["name"] = ModelValue.Text(augment, "name") + " 名称变更不应改变默认图像";
            }
        }
        private static int ValidateInitialPlanFixtures(SidebarWindow window, string earlyLivePreviewPath)
        {
            var original = window.Model;
            var enemy = new Dictionary<string, object> { { "status", "detected" }, { "source", "live-client" }, { "champions", new object[] { new Dictionary<string, object> { { "id", "Soraka" }, { "name", "索拉卡" } } } } };
            var plan = new Dictionary<string, object>(ModelValue.Object(original, "plan"));
            plan["stage"] = "live"; plan["enemyContext"] = enemy;
            var early = new Dictionary<string, object>(original);
            early["connection"] = new Dictionary<string, object> { { "status", "connected" } };
            early["mode"] = new Dictionary<string, object> { { "known", true }, { "isMayhem", true }, { "queueId", 2400 } };
            early["phase"] = "InProgress"; early["stage"] = "live"; early["championSource"] = "live-client";
            early["gameId"] = "early-fixture-one"; early["gameTime"] = 0; early["owned"] = new object[0]; early["offers"] = new object[0]; early["plan"] = plan;
            window.initialPlanHandled = false; window.initialPlanGame = ""; window.buildExpanded = false;
            window.Model = early;
            Require(window.buildExpanded && !window.IsLoadingPreview, "A missed loading sample did not open the first valid live plan with its live identity.");
            window.Notice = "离屏早期实战示例 · 未连接真实对局";
            using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(earlyLivePreviewPath, System.Drawing.Imaging.ImageFormat.Png); }
            window.Notice = "";
            window.buildExpanded = false;
            var repeated = new Dictionary<string, object>(early); repeated["gameTime"] = 3;
            window.Model = repeated;
            Require(!window.buildExpanded, "An early live refresh overrode a user's collapsed recommendation.");
            var transient = ModelValue.Failure("隔离测试中的临时连接中断");
            window.Model = transient; window.Model = repeated;
            Require(!window.buildExpanded, "An early live reconnect reopened an already handled initial plan.");
            var next = new Dictionary<string, object>(early); next["gameId"] = "early-fixture-two";
            window.Model = next;
            Require(window.buildExpanded, "A new game did not receive its own early recommendation opportunity.");
            var loadingPlan = new Dictionary<string, object>(plan); loadingPlan["stage"] = "loading-preview";
            var loading = new Dictionary<string, object>(early); loading["gameId"] = "early-fixture-three"; loading["plan"] = loadingPlan; loading["stage"] = "loading";
            window.Model = loading;
            Require(window.buildExpanded && window.IsLoadingPreview, "A true loading preview did not open.");
            window.buildExpanded = false;
            var afterLoading = new Dictionary<string, object>(early); afterLoading["gameId"] = "early-fixture-three"; afterLoading["gameTime"] = 2;
            window.Model = afterLoading;
            Require(!window.buildExpanded && !window.IsLoadingPreview, "Loading and live did not share one initial expansion opportunity.");
            var late = new Dictionary<string, object>(early); late["gameId"] = "late-fixture"; late["gameTime"] = 120;
            window.Model = late;
            Require(!window.buildExpanded, "A mid-game launch or reconnect automatically expanded recommendations.");
            var zero = new Dictionary<string, object>(late); zero["gameTime"] = 0;
            window.Model = zero;
            Require(!window.buildExpanded, "A zero clock retransmission reopened a mid-game plan.");
            var invalidEnemy = new Dictionary<string, object>(enemy); invalidEnemy["status"] = "stale";
            var invalidPlan = new Dictionary<string, object>(plan); invalidPlan["enemyContext"] = invalidEnemy;
            var invalid = new Dictionary<string, object>(early); invalid["gameId"] = "invalid-fixture"; invalid["plan"] = invalidPlan;
            window.Model = invalid;
            Require(!window.buildExpanded, "A stale opponent plan opened early recommendations.");
            var valid = new Dictionary<string, object>(invalid); valid["plan"] = plan;
            window.Model = valid;
            Require(window.buildExpanded, "A valid plan arriving later in the opening window did not expand.");
            var selected = new Dictionary<string, object>(early); selected["gameId"] = "selected-fixture"; selected["owned"] = ModelValue.Array(original, "owned");
            Require(!HasEarlyLivePlan(selected), "A selected augment was accepted as an empty opening plan.");
            var incomplete = new Dictionary<string, object>(plan); incomplete["nextAugments"] = new object[0];
            var noDirections = new Dictionary<string, object>(early); noDirections["plan"] = incomplete;
            Require(!HasEarlyLivePlan(noDirections), "A plan without future augment directions was treated as ready.");
            var untrusted = new Dictionary<string, object>(early); untrusted["championSource"] = "champ-select";
            Require(!HasEarlyLivePlan(untrusted), "A non-live champion source qualified for live fallback.");
            var unknownMode = new Dictionary<string, object>(early); unknownMode["mode"] = new Dictionary<string, object> { { "known", false }, { "isMayhem", false } };
            Require(!HasEarlyLivePlan(unknownMode), "An unverified game mode qualified for early live fallback.");
            var ordinaryMode = new Dictionary<string, object>(early); ordinaryMode["mode"] = new Dictionary<string, object> { { "known", true }, { "isMayhem", false }, { "queueId", 450 } };
            Require(!HasEarlyLivePlan(ordinaryMode), "An ordinary game mode qualified for early live fallback.");
            Require(!window.Visible && window.ShowWithoutActivation, "Initial-plan fixtures displayed or activated a real window.");
            window.Model = original; window.buildExpanded = false; window.scrollOffset = 0;
            window.initialPlanHandled = false; window.initialPlanGame = "";
            return 16;
        }
        private static int ValidateLoadingPreviewFixtures(SidebarWindow window, string previewPath)
        {
            var original = window.Model;
            var roster = new ArrayList();
            string[] names = { "索拉卡", "盖伦", "墨菲特", "金克丝", "拉克丝" };
            for (int index = 0; index < names.Length; index++)
            {
                string icon = "fixture-loading-hero-" + index;
                var bitmap = new Bitmap(34, 34);
                using (var graphics = Graphics.FromImage(bitmap)) graphics.Clear(Color.FromArgb(46 + index * 15, 92 + index * 10, 111 + index * 8));
                window.buildIcons[icon] = bitmap;
                roster.Add(new Dictionary<string, object> { { "name", names[index] }, { "icon", icon }, { "level", null }, { "items", new object[0] } });
            }
            var plan = new Dictionary<string, object>(ModelValue.Object(original, "plan"));
            plan["stage"] = "loading-preview"; plan["label"] = "开局前预览";
            plan["enemyContext"] = new Dictionary<string, object> { { "status", "detected" }, { "source", "loading-roster" }, { "champions", roster } };
            // Static catalogue names and concise effects; this is an isolated layout fixture,
            // not a claim that these six items or augments were observed in a real match.
            string[] equipmentNames = { "莫雷洛秘典", "兰德里的折磨", "瑞莱的冰晶节杖", "灭世者的死亡之帽", "中娅沙漏", "虚空之杖" };
            string[] equipmentEffects = { "魔法伤害施加3秒40%重伤。", "技能灼烧敌人，按最大生命值造成魔法伤害。", "技能伤害使敌人减速30%，持续1秒。", "总法术强度提升30%。", "进入凝滞状态2.5秒。", "95法术强度，40%法术穿透。" };
            string[] augmentNames = { "循环往复", "炼狱导管", "珠光护手", "歌利亚巨人", "火上浇油", "面包和黄油" };
            var equipment = new ArrayList(); var augments = new ArrayList();
            for (int index = 0; index < equipmentNames.Length; index++)
            {
                string icon = "fixture-loading-hero-" + (index % names.Length);
                equipment.Add(new Dictionary<string, object> { { "name", equipmentNames[index] }, { "effect", equipmentEffects[index] }, { "icon", icon } });
                augments.Add(new Dictionary<string, object> { { "name", augmentNames[index] }, { "reason", "示例机制方向；实际以出现的三个选项为准。" }, { "icon", icon } });
            }
            plan["buildItems"] = equipment; plan["nextAugments"] = augments;
            var loading = new Dictionary<string, object>(original);
            loading["phase"] = "GameStart"; loading["stage"] = "loading"; loading["gameId"] = "loading-fixture-one";
            loading["level"] = null;
            loading["gameTime"] = null;
            loading["owned"] = new object[0]; loading["offers"] = new object[0]; loading["plan"] = plan;
            var select = new Dictionary<string, object>(original); select["phase"] = "ChampSelect"; select["owned"] = new object[0];
            window.Model = select;
            window.buildExpanded = false; window.Model = loading;
            Require(window.IsLoadingPreview && window.buildExpanded, "Loading preview did not expand before any augment selection.");
            window.Notice = "离屏示例 · 未连接真实对局";
            using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png); }
            window.Notice = "";
            Require(window.paintedSections[0] == "plan" && window.buildToggle != Rectangle.Empty, "Loading plan did not move to the first visible section.");
            Rectangle toggle = window.buildToggle;
            window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, toggle.Left + 2, toggle.Top + 2, 0));
            Require(!window.buildExpanded, "Loading preview could not be collapsed by the user.");
            window.Model = loading;
            Require(!window.buildExpanded, "Repeated loading poll overrode the user's collapse.");
            var recovered = new Dictionary<string, object>(loading); recovered["gameId"] = "loading-fixture-two";
            window.Model = recovered;
            Require(window.buildExpanded, "A different loading game did not expand its own preview.");
            var live = new Dictionary<string, object>(recovered);
            live["phase"] = "InProgress"; live["stage"] = "live";
            live["plan"] = new Dictionary<string, object> { { "stage", "live" }, { "summary", "入场后的本局推荐" } };
            window.Model = live;
            Require(!window.IsLoadingPreview && window.buildExpanded, "Entering live play did not preserve the expanded recommendation view.");
            Require(!window.Visible && window.ShowWithoutActivation, "Loading fixtures displayed or activated a real window.");
            var ended = new Dictionary<string, object>(live); ended["phase"] = "EndOfGame";
            window.Model = ended;
            Require(!window.buildExpanded, "The ended game kept its previous preview expanded.");
            window.Model = original; window.buildExpanded = false; window.scrollOffset = 0;
            window.initialPlanHandled = false; window.initialPlanGame = "";
            return 8;
        }
        private static int ValidateLiveStateFixtures(SidebarWindow window, string statusPreviewPath)
        {
            var original = window.Model;
            var recognition = new Dictionary<string, object> { { "enabled", true }, { "status", "waiting" }, { "code", "game-not-foreground" }, { "observedAt", "2026-10-24T01:02:03Z" } };
            Require(RecognitionSummary(recognition) == "等待游戏回到前台后自动识别", "Foreground waiting was hidden behind generic card copy.");
            Require(RecognitionTime(recognition).StartsWith("最近检查 · ", StringComparison.Ordinal), "Last scan time was not displayed.");
            recognition["status"] = "unavailable"; recognition["code"] = "titles-incomplete";
            recognition["message"] = "未确认到同一排的三个海克斯卡片标题。";
            Require(RecognitionSummary(recognition) == "未识别到完整的三张卡片，将自动重试", "Unmatched titles were shown as a never-scanned state.");
            var statusModel = new Dictionary<string, object>(original);
            statusModel["owned"] = new object[0]; statusModel["offers"] = new object[0]; statusModel["ocr"] = recognition;
            window.Model = statusModel;
            using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(statusPreviewPath, System.Drawing.Imaging.ImageFormat.Png); }
            recognition["message"] = "sensitive-path C:\\private\\raw-text";
            Require(!RecognitionSummary(recognition).Contains("private") && !RecognitionSummary(recognition).Contains("raw-text"), "Raw diagnostic text leaked into recognition copy.");
            recognition["enabled"] = false;
            Require(RecognitionSummary(recognition) == "自动识别已暂停，可从托盘恢复", "Paused recognition was not visible.");
            recognition["observedAt"] = "not-a-date";
            Require(RecognitionTime(recognition) == "出现卡片后会自动检查", "Malformed scan timestamp reached the product UI.");
            object parsedGameId;
            var nullGame = new Dictionary<string, object> { { "gameId", null } };
            Require(ModelValue.GameId(nullGame, out parsedGameId) && parsedGameId == null && new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "gameId", parsedGameId } }) == "{\"gameId\":null}", "An explicit null game ID was rejected or serialized as an empty string.");
            Require(!ModelValue.GameId(new Dictionary<string, object>(), out parsedGameId), "A missing game ID was accepted as an explicit null.");
            Require(!ModelValue.GameId(new Dictionary<string, object> { { "gameId", "" } }, out parsedGameId), "An empty game ID was accepted.");
            var confirmation = new Dictionary<string, object> { { "phase", "InProgress" }, { "gameId", null }, { "owned", new object[] { new Dictionary<string, object> { { "id", "demo-confirm" } } } } };
            Require(ModelValue.ConfirmsOffer(confirmation, "demo-confirm", null), "A confirmed selection without LCU metadata was rejected.");
            confirmation["gameId"] = "fixture-game";
            Require(ModelValue.ConfirmsOffer(confirmation, "demo-confirm", null), "LCU metadata recovery incorrectly invalidated the current selection.");
            Require(!ModelValue.ConfirmsOffer(confirmation, "demo-confirm", "other-game"), "A different non-null game was reported as a successful confirmation.");
            confirmation["phase"] = "EndOfGame";
            Require(!ModelValue.ConfirmsOffer(confirmation, "demo-confirm", "fixture-game"), "An ended game was reported as a successful confirmation.");
            confirmation["phase"] = "InProgress";
            Require(!ModelValue.ConfirmsOffer(confirmation, "demo-missing", "fixture-game"), "An absent selected augment was reported as confirmed.");
            confirmation.Remove("gameId");
            Require(!ModelValue.ConfirmsOffer(confirmation, "demo-confirm", null), "An incomplete confirmation response was accepted.");
            var offered = new Dictionary<string, object>(original);
            offered["sessionRevision"] = 20;
            offered["owned"] = new object[0];
            window.Model = offered;
            using (var bitmap = new Bitmap(window.Width, window.Height)) window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            string selected = "";
            Action<string> capture = delegate(string value) { selected = value; };
            window.OfferConfirmed += capture;
            try
            {
                Require(window.offerButtons.Count > 0, "Visible offer did not expose a confirmation target.");
                foreach (var button in window.offerButtons)
                {
                    window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, button.Key.Left + 2, button.Key.Top + 2, 0));
                    Require(selected == button.Value, "Confirmation target did not preserve the displayed offer ID.");
                    break;
                }
            }
            finally { window.OfferConfirmed -= capture; }
            var confirmed = new Dictionary<string, object>(original);
            confirmed["sessionRevision"] = 21;
            confirmed["offers"] = new object[0];
            window.Model = confirmed;
            Require(window.buildExpanded, "Confirmed selection did not expand its build.");
            using (var bitmap = new Bitmap(window.Width, window.Height)) window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            Require(window.paintedSections[0] == "plan", "Confirmed build was not the first expanded section.");
            window.Model = ModelValue.Failure("测试中的短暂本地连接中断");
            Require(window.buildExpanded, "A temporary connection failure collapsed the selected build.");
            var refreshed = new Dictionary<string, object>(confirmed);
            refreshed["plan"] = new Dictionary<string, object> { { "summary", "示例敌方装备更新后的构筑" } };
            window.Model = refreshed;
            Require(window.buildExpanded && ModelValue.Text(ModelValue.Object(window.Model, "plan"), "summary") == "示例敌方装备更新后的构筑", "An equal-revision observation failed to refresh the build after reconnecting.");
            window.Model = offered;
            Require(ModelValue.Array(window.Model, "owned").Count == 1 && window.buildExpanded, "A late old model reverted the confirmed choice.");
            var nextGame = new Dictionary<string, object>(offered);
            nextGame["sessionRevision"] = 22;
            window.Model = nextGame;
            Require(!window.buildExpanded, "A real session reset left the previous build expanded.");
            Require(!window.Visible && window.ShowWithoutActivation, "Confirmation fixtures displayed or activated a window.");
            window.Model = original; window.buildExpanded = false; window.scrollOffset = 0;
            return 24;
        }
        private static int ValidateAppearanceFixtures(SidebarWindow window)
        {
            var defaults = SidebarAppearance.FromModel(new Dictionary<string, object>());
            Require(defaults.Scale == 100 && defaults.Width == 324 && defaults.Opacity == 100 && defaults.Side == "left", "Default sidebar appearance changed.");
            var invalid = new Dictionary<string, object> { { "appearance", new Dictionary<string, object> { { "sidebar", new Dictionary<string, object> {
                { "fontFamily", "untrusted-font-name" }, { "scale", 10000 }, { "width", 99999 }, { "opacity", -50 }, { "side", "anywhere" },
                { "sections", new object[] { "offers", "offers", "hero", "unknown" } }
            } } } } };
            var clamped = SidebarAppearance.FromModel(invalid);
            Require(clamped.Scale == 130 && clamped.Width == 460 && clamped.Opacity == 75, "Native appearance bounds were not enforced.");
            Require(clamped.FontFamily == "system" && clamped.Side == "left", "Unknown appearance enum was accepted.");
            Require(string.Join(",", clamped.Sections) == "hero,owned,offers,plan", "Invalid section order was accepted.");
            invalid["appearance"] = new Dictionary<string, object> { { "sidebar", new Dictionary<string, object> { { "scale", "NaN" }, { "opacity", "Infinity" }, { "width", -100 } } } };
            clamped = SidebarAppearance.FromModel(invalid);
            Require(clamped.Scale == 100 && clamped.Opacity == 100 && clamped.Width == 280, "Invalid numeric settings were not safely normalized.");
            var custom = new Dictionary<string, object>(window.Model);
            custom["appearance"] = new Dictionary<string, object> { { "sidebar", new Dictionary<string, object> {
                { "fontFamily", "simsun" }, { "scale", 130 }, { "width", 280 }, { "opacity", 75 }, { "side", "left" },
                { "sections", new object[] { "plan", "offers", "owned", "hero" } }
            } } };
            window.Model = custom;
            Rectangle monitor = new Rectangle(-1920, -100, 1920, 1080);
            window.Place(monitor);
            Require(window.Width == 280 && window.Left == monitor.Left && window.Top == monitor.Top + (monitor.Height - window.Height) / 2 && monitor.Contains(window.Bounds), "Left/center multi-monitor placement failed.");
            Require(Math.Abs(window.Opacity - 0.75) < 0.001 && Math.Abs(window.headingFont.Size - 18.2F) < 0.01, "Sidebar font or opacity did not update.");
            using (var bitmap = new Bitmap(window.Width, window.Height)) window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            Require(string.Join(",", window.paintedSections.ToArray()) == "plan,offers,owned,hero", "Saved section order was not painted.");
            Rectangle testViewport = window.viewport, testScrollTrack = window.scrollTrack;
            Require(window.contentHeight > testViewport.Height && !testScrollTrack.IsEmpty, "Large-font layout did not provide scrolling.");
            window.ScrollTo(int.MaxValue);
            using (var bitmap = new Bitmap(window.Width, window.Height)) window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            testViewport = window.viewport;
            Require(window.scrollOffset == window.contentHeight - testViewport.Height && window.scrollOffset > 0, "Bottom sections are unreachable by scrolling.");
            foreach (var entry in window.offerButtons) Require(testViewport.Contains(entry.Key), "Clipped offer button remained clickable.");
            Rectangle testHide = window.hideButton, testGame = window.gameButton;
            Require(testHide.Bottom < window.Height && testGame.Right <= window.Width, "Footer buttons overflow at maximum font scale.");
            window.Model = ModelValue.Failure("测试连接中断");
            Require(window.appearance.Scale == 130 && window.appearance.Side == "left", "Connection error reset the saved appearance.");
            window.Model = custom;
            Rectangle smallMonitor = new Rectangle(100, 100, 240, 300);
            window.Place(smallMonitor);
            Require(smallMonitor.Contains(window.Bounds), "Sidebar exceeded a small monitor work area.");
            custom["appearance"] = new Dictionary<string, object> { { "sidebar", new Dictionary<string, object> { { "width", 460 }, { "side", "right" } } } };
            window.Model = custom; window.Place(monitor);
            Require(window.Width == 460 && window.Right == monitor.Right && monitor.Contains(window.Bounds), "Right/sidebar placement did not follow settings.");
            custom["appearance"] = new Dictionary<string, object> { { "sidebar", new Dictionary<string, object> {
                { "fontFamily", "simsun" }, { "scale", 130 }, { "width", 280 }, { "opacity", 75 }, { "side", "left" },
                { "sections", new object[] { "plan", "offers", "owned", "hero" } }
            } } };
            window.Model = custom; window.Place(monitor); window.ScrollTo(0);
            Require(!window.Visible && !window.TopMost && window.ShowWithoutActivation
                && (window.CreateParams.ExStyle & PassiveWindowStyles) == PassiveWindowStyles
                && (GetWindowLongPtr(window.Handle, -20).ToInt64() & PassiveWindowStyles) == PassiveWindowStyles,
                "Appearance changes affected passive sidebar behavior.");
            return 15;
        }
        private static int ValidatePositionFixtures(string directory, out string placementPreviewPath)
        {
            Rectangle area = new Rectangle(100, 50, 1280, 900);
            Point savedLocation;
            placementPreviewPath = Path.Combine(directory, "sidebar-left-center.png");
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                window.Place(area);
                Require(window.Left == area.Left && window.Top == area.Top + 75, "Default sidebar must touch the left edge and be vertically centered.");
                Require(area.Contains(window.Bounds), "Default sidebar is outside the visible area.");
                window.Model = new Dictionary<string, object> { { "connection", new Dictionary<string, object> { { "message", "布局预览 · 未连接真实游戏" } } } };
                using (var panel = new Bitmap(window.Width, window.Height))
                using (var scene = new Bitmap(area.Width, area.Height))
                using (Graphics canvas = Graphics.FromImage(scene))
                {
                    window.DrawToBitmap(panel, new Rectangle(Point.Empty, panel.Size));
                    Require(window.Left == area.Left && window.Top == area.Top + 75, "Creating the native window changed the left-center placement.");
                    canvas.Clear(Color.FromArgb(22, 35, 45));
                    using (var font = new Font("Microsoft YaHei UI", 18F))
                    using (var brush = new SolidBrush(Color.FromArgb(154, 171, 192)))
                        canvas.DrawString("模拟游戏区域 · 默认左侧居中\nCtrl + 鼠标左键可拖动侧栏", font, brush, new PointF(410, 370));
                    canvas.DrawImageUnscaled(panel, window.Left - area.Left, window.Top - area.Top);
                    scene.Save(placementPreviewPath, System.Drawing.Imaging.ImageFormat.Png);
                }
                int hidden = 0;
                window.HideRequested += delegate { hidden++; };
                Point initial = window.Location;
                window.BeginManualMove(new Point(125, 150));
                window.MoveManually(new Point(425, 190));
                savedLocation = window.Location;
                Require(savedLocation == new Point(initial.X + 300, initial.Y + 40), "Drag must follow pointer delta without jumping.");
                window.Place(area);
                Require(window.Location == savedLocation && window.dragging, "Background placement interrupted a drag.");
                Rectangle hide = window.hideButton;
                window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, hide.Left + 2, hide.Top + 2, 0));
                Require(!window.dragging && hidden == 0, "Ctrl-drag release activated a sidebar button.");
                window.Place(area);
                Require(window.Location == savedLocation, "Background refresh snapped a dragged sidebar back.");
                window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, hide.Left + 2, hide.Top + 2, 0));
                Require(hidden == 1, "Normal sidebar buttons stopped working after dragging.");
                Require(!window.Visible && window.ShowWithoutActivation, "Dragging activated or displayed the test window.");
            }
            using (var restored = new SidebarWindow())
            {
                restored.Place(area);
                Require(!restored.customPosition && restored.Location != savedLocation && restored.Left == area.Left && restored.Top == area.Top + 75, "A new launch must reset a dragged position to left-center.");
                Rectangle negative = new Rectangle(-1600, -100, 800, 600);
                restored.Place(negative);
                Require(negative.Contains(restored.Bounds), "Restored sidebar exceeded a smaller secondary monitor.");
                restored.BeginManualMove(Point.Empty);
                restored.MoveManually(new Point(-100000, -100000));
                Require(restored.Left == negative.Left && restored.Top == negative.Top, "Drag did not clamp at the upper-left boundary.");
                restored.MoveManually(new Point(100000, 100000));
                Require(restored.Right == negative.Right && restored.Bottom == negative.Bottom, "Drag did not clamp at the lower-right boundary.");
                restored.OnMouseCaptureChanged(EventArgs.Empty);
                Require(!restored.dragging, "Lost mouse capture left the sidebar stuck in drag mode.");
                restored.Place(new Rectangle(20, 40, 160, 140));
                Require(new Rectangle(20, 40, 160, 140).Contains(restored.Bounds), "Manual placement exceeded a tiny resized game area.");
            }
            return 15;
        }
        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
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
        internal static bool Integer(Dictionary<string, object> model, string key, out long value)
        {
            return long.TryParse(Text(model, key), NumberStyles.Integer, CultureInfo.InvariantCulture, out value) && value >= 0;
        }
        internal static bool GameId(Dictionary<string, object> model, out object value)
        {
            value = null;
            if (model == null || !model.TryGetValue("gameId", out value)) return false;
            if (value == null) return true;
            string id = value as string;
            return id != null && id.Length > 0 && id.Length <= 40;
        }
        internal static bool ConfirmsOffer(Dictionary<string, object> model, string id, object requestedGameId)
        {
            object confirmedGameId;
            if (Text(model, "phase") != "InProgress" || !GameId(model, out confirmedGameId)) return false;
            if (requestedGameId != null && confirmedGameId != null && !string.Equals(requestedGameId as string, confirmedGameId as string, StringComparison.Ordinal)) return false;
            foreach (object entry in Array(model, "owned"))
                if (Text(entry as Dictionary<string, object>, "id") == id) return true;
            return false;
        }
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
        private delegate bool EnumMonitorCallback(IntPtr monitor, IntPtr dc, IntPtr rectangle, IntPtr parameter);
        [StructLayout(LayoutKind.Sequential)] private struct ClientRectangle { internal int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct ClientPoint { internal int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct MonitorMetadata
        {
            internal int Size;
            internal ClientRectangle Monitor, Work;
            internal uint Flags;
        }
        private const int RegionError = 0, EmptyRegion = 1, ComplexRegion = 3, RegionAnd = 1, RegionOr = 2, RegionDifference = 4;
        private const int MaximumCoveringWindows = 256, MaximumRegionBytes = 65536;
        private const long LayeredStyle = 0x00080000L, RightToLeftStyle = 0x00400000L;

        // Metadata geometry only: no capture, game-memory access, input, window
        // activation or window movement. Unknown coverage is treated as hidden.
        // Tiny border/corner remnants do not count as a usable view of the game.
        internal static bool HasExposedGameArea(IntPtr verifiedGame, IntPtr ignoredSidebar)
        {
            IntPtr previousDpi = IntPtr.Zero, remaining = IntPtr.Zero, monitors = IntPtr.Zero;
            try
            {
                if (!IsVerifiedGame(verifiedGame) || !IsWindowVisible(verifiedGame) || IsIconic(verifiedGame)) return false;
                bool cloaked;
                if (!TryIsCloaked(verifiedGame, out cloaked) || cloaked) return false;
                // The application is DPI-unaware. DWM frame bounds are physical
                // pixels, so use one temporary coordinate context for every API.
                previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
                if (previousDpi == IntPtr.Zero) previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-3));
                if (previousDpi == IntPtr.Zero) return false;
                ClientRectangle client, windowBounds;
                var origin = new ClientPoint();
                if (!GetClientRect(verifiedGame, out client) || !ClientToScreen(verifiedGame, ref origin)
                    || !GetWindowRect(verifiedGame, out windowBounds)) return false;
                if ((GetWindowLongPtr(verifiedGame, -20).ToInt64() & RightToLeftStyle) != 0) return false;
                long right = (long)origin.X + client.Right - client.Left, bottom = (long)origin.Y + client.Bottom - client.Top;
                if (right > int.MaxValue || bottom > int.MaxValue || right <= origin.X || bottom <= origin.Y) return false;
                remaining = CreateRectRgn(origin.X, origin.Y, (int)right, (int)bottom);
                if (remaining == IntPtr.Zero) return false;
                IntPtr gameShape = WindowCoverageRegion(verifiedGame, windowBounds);
                if (gameShape == IntPtr.Zero) return false;
                try { if (CombineRgn(remaining, remaining, gameShape, RegionAnd) <= EmptyRegion) return false; }
                finally { DeleteObject(gameShape); }
                monitors = CreateRectRgn(0, 0, 0, 0);
                if (monitors == IntPtr.Zero) return false;
                bool monitorFailure = false; int monitorCount = 0;
                bool enumerated = EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, IntPtr rectangle, IntPtr unused)
                {
                    if (++monitorCount > 32) { monitorFailure = true; return false; }
                    var metadata = new MonitorMetadata { Size = Marshal.SizeOf(typeof(MonitorMetadata)) };
                    if (!GetMonitorInfo(monitor, ref metadata)) { monitorFailure = true; return false; }
                    IntPtr work = CreateRectRgn(metadata.Work.Left, metadata.Work.Top, metadata.Work.Right, metadata.Work.Bottom);
                    if (work == IntPtr.Zero) { monitorFailure = true; return false; }
                    try { if (CombineRgn(monitors, monitors, work, RegionOr) == RegionError) { monitorFailure = true; return false; } }
                    finally { DeleteObject(work); }
                    return true;
                }, IntPtr.Zero);
                if (!enumerated || monitorFailure || CombineRgn(remaining, remaining, monitors, RegionAnd) <= EmptyRegion) return false;
                var visited = new HashSet<IntPtr>();
                IntPtr above = GetWindow(verifiedGame, 3); // GW_HWNDPREV: nearer the top of Z order.
                int count = 0;
                while (above != IntPtr.Zero)
                {
                    if (++count > MaximumCoveringWindows || !visited.Add(above) || above == verifiedGame) return false;
                    IntPtr current = above;
                    above = GetWindow(current, 3);
                    if (!IsWindow(current)) return false;
                    if (current == ignoredSidebar || !IsWindowVisible(current) || IsIconic(current)) continue;
                    if (!TryIsCloaked(current, out cloaked)) return false;
                    if (cloaked || IsKnownTranslucent(current)) continue;
                    ClientRectangle bounds;
                    if (!GetWindowRect(current, out bounds)) return false;
                    if (bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top || !RectInRegion(remaining, ref bounds)) continue;
                    IntPtr coverage = WindowCoverageRegion(current, bounds);
                    if (coverage == IntPtr.Zero) return false;
                    int result;
                    try { result = CombineRgn(remaining, remaining, coverage, RegionDifference); }
                    finally { DeleteObject(coverage); }
                    if (result <= EmptyRegion) return false;
                    if (result == ComplexRegion && !RegionWithinBudget(remaining)) return false;
                }
                ClientRectangle finalBounds;
                if (!IsWindow(verifiedGame) || !IsWindowVisible(verifiedGame) || IsIconic(verifiedGame)
                    || !TryIsCloaked(verifiedGame, out cloaked) || cloaked || !GetWindowRect(verifiedGame, out finalBounds)
                    || finalBounds.Left != windowBounds.Left || finalBounds.Top != windowBounds.Top
                    || finalBounds.Right != windowBounds.Right || finalBounds.Bottom != windowBounds.Bottom) return false;
                return HasMeaningfulExposure(remaining);
            }
            catch { return false; }
            finally
            {
                if (remaining != IntPtr.Zero) DeleteObject(remaining);
                if (monitors != IntPtr.Zero) DeleteObject(monitors);
                if (previousDpi != IntPtr.Zero) { try { SetThreadDpiAwarenessContext(previousDpi); } catch { } }
            }
        }
        private static bool TryIsCloaked(IntPtr window, out bool cloaked)
        {
            int value;
            bool success = DwmGetWindowAttribute(window, 14, out value, sizeof(int)) == 0; // DWMWA_CLOAKED
            cloaked = value != 0; return success;
        }
        private static bool IsKnownTranslucent(IntPtr window)
        {
            if ((GetWindowLongPtr(window, -20).ToInt64() & LayeredStyle) == 0) return false;
            uint color, flags; byte alpha;
            // WS_EX_TRANSPARENT is a painting-order flag, not proof that pixels
            // are transparent. Per-pixel layered opacity cannot be read here;
            // an unknown layered window conservatively contributes its bounds.
            return GetLayeredWindowAttributes(window, out color, out alpha, out flags) && (flags & 2) != 0 && alpha < 255;
        }
        private static IntPtr WindowCoverageRegion(IntPtr window, ClientRectangle windowBounds)
        {
            ClientRectangle frame;
            if (DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(ClientRectangle))) != 0
                || frame.Right <= frame.Left || frame.Bottom <= frame.Top) frame = windowBounds;
            // Clip to both extents, avoiding invisible resize borders without
            // letting a transient/inconsistent DWM frame extend past the HWND.
            frame.Left = Math.Max(frame.Left, windowBounds.Left); frame.Top = Math.Max(frame.Top, windowBounds.Top);
            frame.Right = Math.Min(frame.Right, windowBounds.Right); frame.Bottom = Math.Min(frame.Bottom, windowBounds.Bottom);
            if (frame.Right <= frame.Left || frame.Bottom <= frame.Top) return IntPtr.Zero;
            IntPtr coverage = CreateRectRgn(frame.Left, frame.Top, frame.Right, frame.Bottom), shape = IntPtr.Zero;
            if (coverage == IntPtr.Zero) return IntPtr.Zero;
            try
            {
                if ((GetWindowLongPtr(window, -20).ToInt64() & RightToLeftStyle) == 0)
                {
                    shape = CreateRectRgn(0, 0, 0, 0);
                    if (shape == IntPtr.Zero) { DeleteObject(coverage); return IntPtr.Zero; }
                    int kind = GetWindowRgn(window, shape);
                    if (kind == ComplexRegion && !RegionWithinBudget(shape)) { DeleteObject(coverage); return IntPtr.Zero; }
                    // ERROR also means a normal rectangular window has no
                    // explicit region. Its conservative frame remains usable.
                    if (kind != RegionError)
                    {
                        if (OffsetRgn(shape, windowBounds.Left, windowBounds.Top) == RegionError
                            || CombineRgn(coverage, coverage, shape, RegionAnd) == RegionError)
                        { DeleteObject(coverage); return IntPtr.Zero; }
                    }
                }
                return coverage;
            }
            catch { DeleteObject(coverage); return IntPtr.Zero; }
            finally { if (shape != IntPtr.Zero) DeleteObject(shape); }
        }
        private static bool RegionWithinBudget(IntPtr region)
        {
            uint size = GetRegionData(region, 0, null);
            return size >= 32 && size <= MaximumRegionBytes;
        }
        private static bool HasMeaningfulExposure(IntPtr region)
        {
            uint size = GetRegionData(region, 0, null);
            if (size < 32 || size > MaximumRegionBytes) return false;
            byte[] data = new byte[(int)size];
            if (GetRegionData(region, size, data) != size) return false;
            uint rectangles = BitConverter.ToUInt32(data, 8);
            if (BitConverter.ToUInt32(data, 0) != 32 || BitConverter.ToUInt32(data, 4) != 1 || rectangles > (size - 32) / 16) return false;
            long area = 0; bool usefulRectangle = false;
            for (int index = 0; index < rectangles; index++)
            {
                int offset = 32 + index * 16;
                long width = (long)BitConverter.ToInt32(data, offset + 8) - BitConverter.ToInt32(data, offset);
                long height = (long)BitConverter.ToInt32(data, offset + 12) - BitConverter.ToInt32(data, offset + 4);
                if (width <= 0 || height <= 0 || width > 100000 || height > 100000) return false;
                area += width * height;
                if (width >= 16 && height >= 16) usefulRectangle = true;
            }
            return usefulRectangle && area >= 1024;
        }
        private sealed class CoverageFixture
        {
            internal int Id;
            internal Rectangle[] Areas;
            internal bool Visible = true, Minimized, Cloaked, Translucent;
        }
        // The fixture runner performs only region arithmetic on supplied data;
        // it never enumerates, samples, captures or changes any real window.
        private static bool ExposureFixture(Rectangle game, Rectangle[] monitors, CoverageFixture[] covering, int ignored, bool visible, bool minimized, bool cloaked)
        {
            if (!visible || minimized || cloaked || game.Width <= 0 || game.Height <= 0) return false;
            IntPtr remaining = CreateRectRgn(game.Left, game.Top, game.Right, game.Bottom), clipped = CreateRectRgn(0, 0, 0, 0);
            if (remaining == IntPtr.Zero || clipped == IntPtr.Zero)
            { if (remaining != IntPtr.Zero) DeleteObject(remaining); if (clipped != IntPtr.Zero) DeleteObject(clipped); return false; }
            try
            {
                foreach (Rectangle monitor in monitors)
                {
                    IntPtr part = CreateRectRgn(monitor.Left, monitor.Top, monitor.Right, monitor.Bottom);
                    try { if (part == IntPtr.Zero || CombineRgn(clipped, clipped, part, RegionOr) == RegionError) return false; }
                    finally { if (part != IntPtr.Zero) DeleteObject(part); }
                }
                if (CombineRgn(remaining, remaining, clipped, RegionAnd) <= EmptyRegion) return false;
                foreach (CoverageFixture window in covering)
                {
                    if (window.Id == ignored || !window.Visible || window.Minimized || window.Cloaked || window.Translucent) continue;
                    foreach (Rectangle bounds in window.Areas)
                    {
                        IntPtr part = CreateRectRgn(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
                        try { if (part == IntPtr.Zero || CombineRgn(remaining, remaining, part, RegionDifference) <= EmptyRegion) return false; }
                        finally { if (part != IntPtr.Zero) DeleteObject(part); }
                    }
                }
                return HasMeaningfulExposure(remaining);
            }
            finally { DeleteObject(remaining); DeleteObject(clipped); }
        }
        private static int ValidateExposureFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { if (!condition) throw new InvalidOperationException(message); checks++; };
            Rectangle game = new Rectangle(0, 0, 200, 160);
            Rectangle[] screens = { new Rectangle(-600, -400, 1400, 1000) };
            var none = new CoverageFixture[0];
            Func<CoverageFixture[], bool> exposed = delegate(CoverageFixture[] covers)
            { return ExposureFixture(game, screens, covers, 99, true, false, false); };
            check(exposed(none), "An uncovered synthetic game area was hidden.");
            check(!exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] { game } } }), "A single opaque covering region left a synthetic game exposed.");
            check(!exposed(new[] {
                new CoverageFixture { Id = 1, Areas = new[] { new Rectangle(0, 0, 100, 160) } },
                new CoverageFixture { Id = 2, Areas = new[] { new Rectangle(100, 0, 100, 160) } }
            }), "The union of two windows did not cover the synthetic game.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] { new Rectangle(0, 0, 140, 160) } } }), "A substantial exposed part was discarded.");
            check(ExposureFixture(new Rectangle(-500, -200, 200, 160), screens,
                new[] { new CoverageFixture { Id = 1, Areas = new[] { new Rectangle(-500, -200, 100, 160) } } }, 99, true, false, false), "Negative monitor coordinates broke region subtraction.");
            check(exposed(new[] { new CoverageFixture { Id = 99, Areas = new[] { game } } }), "The ignored sidebar covered its own synthetic game.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] { game }, Translucent = true } }), "A known translucent overlay counted as opaque coverage.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] { game }, Visible = false } }), "An invisible window counted as coverage.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] { game }, Minimized = true } }), "A minimized covering window counted as coverage.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] { game }, Cloaked = true } }), "A cloaked covering window counted as coverage.");
            check(!ExposureFixture(game, screens, none, 99, true, true, false), "A minimized game was classified as exposed.");
            check(!ExposureFixture(game, screens, none, 99, false, false, false), "An invisible game was classified as exposed.");
            check(!ExposureFixture(game, screens, none, 99, true, false, true), "A cloaked game was classified as exposed.");
            check(!ExposureFixture(game, new[] { new Rectangle(400, 0, 100, 100) }, none, 99, true, false, false), "A game outside monitor working areas was classified as exposed.");
            check(!ExposureFixture(new Rectangle(100, 0, 50, 100), new[] { new Rectangle(0, 0, 100, 100), new Rectangle(150, 0, 100, 100) }, none, 99, true, false, false), "A multi-monitor gap counted as visible screen area.");
            check(!exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] { new Rectangle(0, 0, 199, 160) } } }), "A one-pixel resize-border remnant counted as an exposed game.");
            check(!exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] {
                new Rectangle(6, 0, 188, 160), new Rectangle(0, 6, 200, 148)
            } } }), "Separated tiny corners with a large bounding box counted as exposure.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Areas = new[] {
                new Rectangle(0, 0, 70, 160), new Rectangle(130, 0, 70, 160)
            } } }), "A complex covering region's substantial central opening was lost.");
            check(!ExposureFixture(new Rectangle(0, 0, 20, 20), screens, none, 99, true, false, false), "A total exposed area below the usefulness threshold was accepted.");
            check(ExposureFixture(new Rectangle(0, 0, 32, 32), screens, none, 99, true, false, false), "A meaningful 32-by-32 area failed the exposure threshold.");
            return checks;
        }
        internal static Rectangle PlacementArea(IntPtr window)
        {
            Rectangle monitor = window == IntPtr.Zero ? Screen.PrimaryScreen.WorkingArea : Screen.FromHandle(window).WorkingArea;
            if (window == IntPtr.Zero || !IsVerifiedGame(window) || IsIconic(window)) return monitor;
            ClientRectangle client; var origin = new ClientPoint();
            if (!GetClientRect(window, out client) || !ClientToScreen(window, ref origin)) return monitor;
            Rectangle visible = Rectangle.Intersect(monitor, new Rectangle(origin.X, origin.Y, Math.Max(0, client.Right - client.Left), Math.Max(0, client.Bottom - client.Top)));
            return visible.Width > 0 && visible.Height > 0 ? visible : monitor;
        }
        internal static IntPtr ForegroundGame() { IntPtr window = GetForegroundWindow(); return IsVerifiedGame(window) ? window : IntPtr.Zero; }
        internal static IntPtr CurrentForeground() { return GetForegroundWindow(); }
        internal static bool IsGameForeground() { return ForegroundGame() != IntPtr.Zero; }
        internal static bool IsShortcutForeground(IntPtr mainWindow)
        {
            IntPtr foreground = GetForegroundWindow();
            return IsShortcutWindow(foreground, mainWindow, IsVerifiedGame(foreground));
        }
        internal static bool IsShortcutWindow(IntPtr foreground, IntPtr mainWindow, bool verifiedGame)
        {
            return foreground != IntPtr.Zero && (verifiedGame || (mainWindow != IntPtr.Zero && foreground == mainWindow));
        }
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
            IntPtr main = new IntPtr(10), game = new IntPtr(20), other = new IntPtr(30);
            bool scopePassed = IsShortcutWindow(main, main, false)
                && IsShortcutWindow(game, main, true)
                && !IsShortcutWindow(other, main, false)
                && !IsShortcutWindow(IntPtr.Zero, main, false)
                && !IsShortcutWindow(IntPtr.Zero, IntPtr.Zero, true)
                && !IsShortcutWindow(other, IntPtr.Zero, false);
            if (!scopePassed) throw new InvalidOperationException("Shortcut foreground scope self-test failed.");
            return 13 + ValidateExposureFixtures();
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
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out ClientRectangle rectangle);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref ClientPoint point);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out ClientRectangle rectangle);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
        [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(IntPtr window, out uint colorKey, out byte alpha, out uint flags);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr rectangle, EnumMonitorCallback callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorMetadata metadata);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out ClientRectangle value, int size);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr destination, IntPtr first, IntPtr second, int mode);
        [DllImport("gdi32.dll")] private static extern int OffsetRgn(IntPtr region, int x, int y);
        [DllImport("gdi32.dll")] private static extern bool RectInRegion(IntPtr region, ref ClientRectangle rectangle);
        [DllImport("gdi32.dll")] private static extern uint GetRegionData(IntPtr region, uint size, [Out] byte[] data);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
        [DllImport("user32.dll")] private static extern int GetWindowRgn(IntPtr window, IntPtr region);
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
