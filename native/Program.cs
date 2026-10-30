using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
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
[assembly: AssemblyVersion("1.18.0.0")]
[assembly: AssemblyFileVersion("1.18.0.0")]
[assembly: AssemblyInformationalVersion("1.18.0")]

namespace HexGuide.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // These modes are isolated diagnostics handled before any app UI,
            // backend, hotkey, game sampling or installed settings are opened.
            if (args.Length == 2 && (args[0] == "--instance-self-test" || args[0] == "--instance-lock-probe")
                || args.Length == 4 && args[0] == "--instance-lock-race-probe")
            {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                try
                {
                    if (args[0] == "--instance-self-test")
                        Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                            { "checks", ApplicationInstance.ValidateFixtures(args[1]) }, { "mode", "offline-instance-no-ui" }, { "liveGameVerified", false }
                        }));
                    else if (args[0] == "--instance-lock-race-probe") ApplicationInstance.RunRaceProbe(args[1], args[2], args[3]);
                    else using (var lease = ApplicationInstance.TryAcquire(args[1])) Console.WriteLine(lease == null ? "already-running" : "acquired");
                }
                catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
                return;
            }
            if (args.Length == 1 && args[0] == "--selection-title-observe")
            {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                var input = new char[16385]; int length = 0, read;
                while (length < input.Length && (read = Console.In.Read(input, length, input.Length - length)) > 0) length += read;
                string payload = length == input.Length ? null : new string(input, 0, length);
                Console.WriteLine(new JavaScriptSerializer().Serialize(ScreenSelectionWatcher.ObserveTitleIdentity(payload)));
                return;
            }
            // Pure fixtures only: no form, message loop, backend, game capture,
            // hotkey registration, or reads of the user's installed settings.
            if (args.Length == 1 && args[0] == "--selection-self-test")
            {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                try
                {
                    int ownedChecks = Convert.ToInt32(OwnedAugmentVerificationFixtures.Run()["checks"]);
                    int checks = ScreenSelectionWatcher.ValidateFixtures() + MainWindow.ValidateSelectionDiagnosticFixtures() + ownedChecks
                        + ScreenLifeObserver.ValidateFixtures() + ScreenLifeController.ValidateFixtures() + OwnedPanelWatcher.ValidateFixtures()
                        + RemoteIconCache.ValidateFixtures() + GameWindowCapture.ValidateFixtures() + SelectionFrameSynchronizerFixtures.Run();
                    Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                        { "version", "1.18.0" }, { "checks", checks },
                        { "titleProbeVersion", 1 },
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
            try
            {
                using (var instance = ApplicationInstance.TryAcquire(dataDirectory))
                {
                    if (instance == null)
                    {
                        if (!ApplicationInstance.NotifyExisting(dataDirectory))
                            MessageBox.Show("助手已在后台运行。请从系统托盘打开已有窗口。", "海克斯指南");
                        return;
                    }
                    var main = new MainWindow(dataDirectory, background, preview);
                    instance.ActivationRequested += main.RestoreExistingInstance;
                    Application.Run(main);
                }
            }
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

    // Brief loss of exposure should not flicker an already visible sidebar.
    // This gate preserves only display state; the visibility policy owns intent.
    internal sealed class SidebarVisibilityDelay
    {
        private const ulong HideDelayMilliseconds = 600;
        private bool visible, hidePending, hasTimestamp;
        private long hideStartedMilliseconds, lastMilliseconds;

        internal static bool IsTransition(long changedAtMilliseconds, long nowMilliseconds)
        {
            return changedAtMilliseconds >= 0 && nowMilliseconds >= changedAtMilliseconds
                && (ulong)(nowMilliseconds - changedAtMilliseconds) < HideDelayMilliseconds;
        }

        internal bool Resolve(bool requestedVisible, bool allowDelay, long nowMilliseconds)
        {
            bool clockReset = hasTimestamp && nowMilliseconds < lastMilliseconds;
            hasTimestamp = true;
            lastMilliseconds = nowMilliseconds;
            if (requestedVisible)
            {
                visible = true; hidePending = false;
                return true;
            }
            if (!allowDelay || !visible || clockReset)
            {
                visible = false; hidePending = false;
                return false;
            }
            if (!hidePending)
            {
                hidePending = true; hideStartedMilliseconds = nowMilliseconds;
                return true;
            }
            // After rollback was rejected above, unsigned subtraction represents
            // elapsed time even when a large forward jump crosses long's range.
            ulong elapsed = unchecked((ulong)nowMilliseconds - (ulong)hideStartedMilliseconds);
            if (elapsed >= HideDelayMilliseconds) { visible = false; hidePending = false; }
            return visible;
        }

        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { if (!condition) throw new InvalidOperationException(message); checks++; };
            var delay = new SidebarVisibilityDelay();
            check(!delay.Resolve(false, true, 0), "An initially hidden sidebar appeared without a visibility request.");
            check(delay.Resolve(true, true, 10), "A visibility request was delayed.");
            check(delay.Resolve(false, true, 1000), "The hide delay started before the first false request.");
            check(delay.Resolve(false, true, 1599), "The sidebar hid before the 600 ms deadline.");
            check(!delay.Resolve(false, true, 1600), "Repeated false requests extended the 600 ms deadline.");
            check(!delay.Resolve(false, true, 1700), "A hidden sidebar resurrected without a true request.");

            var returned = new SidebarVisibilityDelay();
            check(returned.Resolve(true, true, 2000) && returned.Resolve(false, true, 2100), "A visible sidebar did not enter its first hide delay.");
            check(returned.Resolve(true, true, 2600), "Reappearance before the deadline did not cancel hiding.");
            check(returned.Resolve(false, true, 2650), "A second loss of exposure did not start a fresh delay.");
            check(returned.Resolve(false, true, 2700), "The cancelled first deadline hid the sidebar.");
            check(returned.Resolve(false, true, 3249), "A fresh delay did not last its full 599 ms.");
            check(!returned.Resolve(false, true, 3250), "A fresh delay did not end at exactly 600 ms.");

            var immediate = new SidebarVisibilityDelay();
            check(immediate.Resolve(true, false, 0), "Disallowing hide delay suppressed a true visibility request.");
            check(!immediate.Resolve(false, false, 1), "An explicit close or game exit was delayed.");
            check(!immediate.Resolve(false, true, 2), "Reallowing delay revived an explicitly hidden sidebar.");
            check(immediate.Resolve(true, true, 3) && immediate.Resolve(false, true, 4), "The sidebar did not begin a delay after reopening.");
            check(!immediate.Resolve(false, false, 5), "An explicit close did not cancel a pending delay immediately.");
            check(!immediate.Resolve(false, true, 604), "A cancelled pending delay restored sidebar visibility.");

            var reset = new SidebarVisibilityDelay();
            check(reset.Resolve(true, true, 10000) && reset.Resolve(false, true, 10100), "The clock-reset fixture did not start a delay.");
            check(!reset.Resolve(false, true, 100), "A backwards clock retained a stale hide deadline.");
            check(!reset.Resolve(false, true, 699), "A clock reset resurrected a hidden sidebar.");
            check(reset.Resolve(true, true, 50), "A backwards timestamp suppressed an explicit visibility request.");
            check(reset.Resolve(false, true, 100), "Reopening after a clock reset did not start a fresh delay.");
            check(reset.Resolve(false, true, 699), "The fresh delay after a clock reset ended early.");
            check(!reset.Resolve(false, true, 700), "The fresh delay after a clock reset did not expire.");

            var wideClock = new SidebarVisibilityDelay();
            check(wideClock.Resolve(true, true, long.MinValue) && wideClock.Resolve(false, true, long.MinValue + 1), "The delay rejected a valid low-range monotonic timestamp.");
            check(!wideClock.Resolve(false, true, long.MaxValue), "A large forward timestamp jump overflowed and prolonged hiding.");
            var highClock = new SidebarVisibilityDelay();
            check(highClock.Resolve(true, true, long.MaxValue - 1000) && highClock.Resolve(false, true, long.MaxValue - 600), "The delay could not start near the timestamp limit.");
            check(highClock.Resolve(false, true, long.MaxValue - 1), "A near-limit hide deadline ended before 599 ms.");
            check(!highClock.Resolve(false, true, long.MaxValue), "A near-limit hide deadline overflowed at 600 ms.");
            check(!IsTransition(-1, 0) && IsTransition(100, 100), "A missing transition or its initial instant was classified incorrectly.");
            check(IsTransition(100, 699) && !IsTransition(100, 700), "The foreground-switch window exceeded 600 ms.");
            check(!IsTransition(100, 99) && !IsTransition(0, long.MaxValue), "A backwards or overflow-range clock prolonged a transition.");

            var policy = new SidebarVisibilityState(false);
            var transition = new SidebarVisibilityDelay();
            check(transition.Resolve(policy.ShouldShow(true, false, false), true, 0), "The combined visibility policy did not open for a foreground game.");
            check(transition.Resolve(policy.ShouldShow(false, false, false), policy.Enabled && IsTransition(40, 40), 40), "A switch animation immediately hid the visible sidebar.");
            check(transition.Resolve(policy.ShouldShow(false, false, true), policy.Enabled && IsTransition(40, 100), 100), "A background game exposure did not cancel transition hiding.");
            check(!transition.Resolve(policy.ShouldShow(false, false, false), policy.Enabled && IsTransition(40, 2000), 2000), "Stable full coverage outside a foreground switch acquired an extra hide delay.");
            check(transition.Resolve(policy.ShouldShow(false, false, true), true, 2100), "A newly exposed game did not restore the sidebar.");
            policy.Close();
            check(!transition.Resolve(policy.ShouldShow(false, false, true), policy.Enabled && IsTransition(2100, 2110), 2110), "Manual close was delayed during a foreground switch.");
            var repeated = new SidebarVisibilityDelay();
            repeated.Resolve(true, true, 0); repeated.Resolve(false, true, 100);
            check(!repeated.Resolve(false, IsTransition(650, 700), 700), "Repeated foreground changes extended an already pending hide.");
            return checks;
        }
    }

    internal sealed class MainWindow : Form
    {
        private readonly string dataDirectory;
        private readonly Label status;
        private readonly WebView2 browser;
        private readonly DesktopTitleBar titleBar;
        private readonly MainWindowChrome windowChrome;
        private Process backend;
        private ChildJob job;
        private Uri localOrigin;
        private bool closing;
        private bool stoppingBackend;
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem scanMenu;
        private readonly SidebarWindow sidebar;
        private readonly Timer refreshTimer;
        private readonly Timer recognitionTimer;
        private readonly bool startHidden;
        private bool mainRecoveryQueued;
        private bool desktopPageReady, browserEngineFailed;
        private readonly SidebarVisibilityState sidebarVisibility;
        private readonly SidebarVisibilityDelay sidebarVisibilityDelay = new SidebarVisibilityDelay();
        private readonly Stopwatch sidebarVisibilityClock = Stopwatch.StartNew();
        private IntPtr previousVisibilityForeground;
        private long visibilityTransitionAt = -1;
        private readonly SidebarShortcut shortcut;
        private readonly RecognitionTrace recognitionTrace = new RecognitionTrace();
        private readonly ScreenSelectionWatcher selectionWatcher;
        private readonly OwnedPanelWatcher panelWatcher;
        private readonly ScreenLifeController lifeController;
        private Dictionary<string, object> pendingLifeProof;
        private bool lifePosting;
        private bool desiredSidebarVisible;
        private bool explicitActivation, trayHintShown;
        private bool fetching, scanChanging, confirmChanging, recognitionRequesting, appearanceRequested, appearanceOpening, layoutRequested, layoutOpening;
        private long sidebarRequestGeneration;
        private bool recognitionFetching, automaticSelectionPosting;
        private long lastRecognitionAt;
        private Dictionary<string, object> recognitionModel;
        private readonly Queue<KeyValuePair<bool, Dictionary<string, object>>> automaticSelections = new Queue<KeyValuePair<bool, Dictionary<string, object>>>();
        private string sessionToken;
        private IntPtr lastGame;
        private DateTime nextFetch = DateTime.MinValue;
        private DateTime nextBackgroundGameLookup = DateTime.MinValue;
        private DateTime nextSelectionDiagnostics = DateTime.MinValue;
        private int selectionDiagnosticsWriting;

        internal MainWindow(string dataDirectory, bool background, bool preview)
        {
            this.dataDirectory = dataDirectory;
            OverlayVisibilityCompatibility.Prewarm();
            startHidden = background || GameWindow.IsGameForeground();
            sidebarVisibility = new SidebarVisibilityState(preview);
            Text = "海克斯指南 1.18.0 · 我的这一局";
            // The host owns every client pixel. Keep WinForms' client-size
            // conversion borderless; native sizing styles are applied to hWnd.
            FormBorderStyle = FormBorderStyle.None;
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

            windowChrome = new MainWindowChrome(this);
            titleBar = new DesktopTitleBar(Icon);
            titleBar.ActionRequested += OnTitleBarAction;
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
            Controls.Add(titleBar);
            sidebar = new SidebarWindow();
            sidebar.HideRequested += delegate { sidebarVisibility.Close(); sidebar.Hide(); };
            sidebar.DetailsRequested += delegate { ShowMain(); };
            sidebar.GameRequested += delegate { ReturnToGame(); };
            sidebar.RecognitionRequested += async delegate { await RecognizeOnceAsync(); };
            sidebar.OfferConfirmed += async delegate(string id) { await ConfirmOfferAsync(id); };
            sidebar.PendingOfferConfirmed += async delegate(string id, string pendingId) { await ConfirmOfferAsync(id, pendingId); };
            selectionWatcher = new ScreenSelectionWatcher(recognitionTrace);
            selectionWatcher.StatusChanged += delegate(string message)
            {
                if (!closing && !confirmChanging) { sidebar.Notice = message; sidebar.Invalidate(); }
            };
            selectionWatcher.SelectionObserved += async delegate(Dictionary<string, object> evidence) { await QueueAutomaticSelectionAsync(evidence, false); };
            panelWatcher = new OwnedPanelWatcher();
            panelWatcher.EvidenceReady += async delegate(Dictionary<string, object> evidence) { await QueueAutomaticSelectionAsync(evidence, true); };
            panelWatcher.StatusChanged += delegate(string message)
            {
                if (!closing && !confirmChanging && !ClickObservationHasPriority(selectionWatcher.StatusCode)) { sidebar.Notice = message; sidebar.Invalidate(); }
            };
            lifeController = new ScreenLifeController(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native"), dataDirectory);
            lifeController.ProofReady += delegate(Dictionary<string, object> evidence)
            {
                if (closing || IsDisposed || !IsHandleCreated) return;
                Action publish = async delegate { await PublishScreenLifeAsync(evidence); };
                // Construction may precede installation of the WinForms
                // synchronization context; keep the proof queue on the UI thread.
                if (InvokeRequired) { try { BeginInvoke(publish); } catch (InvalidOperationException) { } }
                else publish();
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开海克斯指南", null, delegate { ShowMain(); });
            menu.Items.Add("界面设置", null, async delegate { await OpenAppearanceAsync(); });
            menu.Items.Add("编辑整个界面", null, async delegate { await OpenLayoutAsync(); });
            menu.Items.Add("显示 / 收起游戏侧栏", null, delegate { ToggleSidebar(); });
            menu.Items.Add("预览侧栏（不切换窗口）", null, delegate { sidebarVisibility.OpenPinned(); sidebar.RevealFromIdle(); UpdateSidebarVisibility(); });
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
                await lifeController.PulseAsync();
                if (appearanceRequested) await OpenRequestedAppearanceAsync();
                if (layoutRequested) await OpenRequestedLayoutAsync();
            };
            refreshTimer.Start();
            recognitionTimer = new Timer { Interval = 150 };
            recognitionTimer.Tick += async delegate { await FetchRecognitionAsync(); };
            recognitionTimer.Start();
            Shown += async delegate { windowChrome.Apply(); if (startHidden) Hide(); await StartAsync(); };
            // Taskbar/minimize commands must retain the taskbar entry and the
            // native restore state. Only explicit tray actions call HideMain.
            Activated += delegate { QueueMainWindowRecovery(); };
            Resize += delegate { windowChrome.UpdatePadding(); titleBar.SetMaximized(WindowState == FormWindowState.Maximized); QueueMainWindowRecovery(); };
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
                recognitionTimer.Stop(); recognitionTimer.Dispose();
                selectionWatcher.Dispose();
                panelWatcher.Dispose();
                GameWindowCapture.Shared.Dispose();
                lifeController.Dispose();
                shortcut.Dispose();
                sidebar.Close();
                tray.Visible = false; tray.Dispose();
                StopBackend();
            };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (windowChrome != null) windowChrome.Apply();
        }

        protected override void WndProc(ref Message message)
        {
            if (windowChrome != null && windowChrome.HandleMessage(ref message)) return;
            base.WndProc(ref message);
            if (message.Msg == 0x0117) MainWindowChrome.RefreshSystemMenu(this); // WM_INITMENUPOPUP
        }

        private async void OnTitleBarAction(string action)
        {
            if (closing || IsDisposed) return;
            try
            {
                if (MainWindowChrome.IsRoute(action))
                {
                    if (desktopPageReady && browser.CoreWebView2 != null && MainWindowChrome.RouteFromSource(localOrigin, browser.CoreWebView2.Source) != null)
                        await browser.CoreWebView2.ExecuteScriptAsync("if(window.hexguideLayout?.isEditing())window.hexguideLayout.notify('请先保存或取消当前界面编辑，再切换页面。');else if(!document.querySelector('dialog[open]'))location.hash=" + new JavaScriptSerializer().Serialize("#" + action));
                    return;
                }
                if (action == "minimize") WindowState = FormWindowState.Minimized;
                else if (action == "maximize") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                else if (action == "close") Close();
                else if (action == "appearance") await OpenAppearanceAsync();
                else if (action == "layout") await OpenLayoutAsync();
                else if (action == "refresh" && browserEngineFailed) ShowFailure("页面引擎已停止，请在更多菜单中完全退出，然后重新打开海克斯指南。");
                else if (action == "refresh" && browser.CoreWebView2 != null) browser.Reload();
                else if (action == "sidebar") ToggleSidebar();
                else if (action == "game") ReturnToGame();
                else if (action == "background") HideMain();
                else if (action == "exit") { closing = true; Close(); }
                else if (action == "announcements" && desktopPageReady && browser.CoreWebView2 != null)
                    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#announcement-open')?.click()");
                else if (action == "sources" && desktopPageReady && browser.CoreWebView2 != null)
                    await browser.CoreWebView2.ExecuteScriptAsync("if(window.hexguideLayout?.isEditing())window.hexguideLayout.notify('请先保存或取消当前界面编辑，再查看数据与版本。');else document.querySelector('[data-action=\"sources\"]')?.click()");
            }
            catch (InvalidOperationException) { if (!closing) ShowFailure("页面暂时不可用，请从右上角更多菜单刷新页面。"); }
            catch (COMException) { if (!closing) ShowFailure("页面暂时不可用，请从右上角更多菜单刷新页面。"); }
        }

        private void UpdateTitleBarRoute()
        {
            if (closing || browser.CoreWebView2 == null) return;
            try
            {
                string route = MainWindowChrome.RouteFromSource(localOrigin, browser.CoreWebView2.Source);
                if (route != null) titleBar.SetPage(route);
            }
            catch (InvalidOperationException) { }
            catch (COMException) { }
        }

        private async Task<bool> PrepareDesktopPageAsync()
        {
            if (closing || IsDisposed || browser.IsDisposed || browser.CoreWebView2 == null) return false;
            try
            {
                await browser.CoreWebView2.ExecuteScriptAsync("document.documentElement.classList.add('desktop-native-chrome')");
                return !closing && !IsDisposed && !browserEngineFailed;
            }
            catch (InvalidOperationException) { if (!closing) ShowFailure("页面暂时不可用，请从右上角更多菜单刷新页面。"); }
            catch (COMException) { if (!closing) ShowFailure("页面暂时不可用，请从右上角更多菜单刷新页面。"); }
            return false;
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

        internal void RestoreExistingInstance() { if (!closing && !IsDisposed) ShowMain(); }

        private void QueueMainWindowRecovery()
        {
            // A system taskbar restore can bypass ShowMain. Wait until WinForms
            // has finished its size/state transition before checking the bounds.
            if (closing || IsDisposed || Disposing || !IsHandleCreated || mainRecoveryQueued
                || !Visible || WindowState != FormWindowState.Normal) return;
            mainRecoveryQueued = true;
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    try { if (!closing) MainWindowRecovery.EnsureOnScreen(this); }
                    finally { mainRecoveryQueued = false; }
                });
            }
            catch (InvalidOperationException) { mainRecoveryQueued = false; }
        }

        private void ShowMain()
        {
            if (closing) return;
            if (sidebarVisibility.HideForMainWindow) sidebar.Hide();
            explicitActivation = true;
            MainWindowRecovery.Apply(this);
        }

        private void ToggleSidebar()
        {
            if (sidebar.Visible && sidebar.IsIdleCollapsed) { sidebar.RevealFromIdle(); UpdateSidebarVisibility(); return; }
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
            long visibilityNow = sidebarVisibilityClock.ElapsedMilliseconds;
            if (foreground != previousVisibilityForeground)
            {
                previousVisibilityForeground = foreground;
                visibilityTransitionAt = visibilityNow;
            }
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
            bool requestedSidebarVisible = sidebarVisibility.ShouldShow(gameForeground, mainForeground, backgroundGameExposed);
            desiredSidebarVisible = sidebarVisibilityDelay.Resolve(requestedSidebarVisible,
                sidebarVisibility.Enabled && GameWindow.IsVerifiedGame(lastGame)
                    && SidebarVisibilityDelay.IsTransition(visibilityTransitionAt, visibilityNow), visibilityNow);
            if (!desiredSidebarVisible) { if (sidebar.Visible) sidebar.Hide(); UpdateSidebarHint(false); return; }
            IntPtr target = gameForeground ? foreground : lastGame;
            // A switch animation can briefly minimize/reposition the game.
            // Retain the last sidebar position during the short hide delay.
            if (requestedSidebarVisible) sidebar.Place(GameWindow.PlacementArea(target));
            if (!sidebar.Visible) sidebar.ShowPassive();
            UpdateSidebarHint(sidebar.Visible);
        }

        private void UpdateSidebarHint(bool visible)
        {
            string hint = "Alt + Shift + H：侧栏" + (visible ? "已显示" : "已收起");
            if (!shortcut.ContextAllowed) hint += " · 仅游戏 / 助手前台";
            else if (!shortcut.Registered) hint += " · 备用检测（" + shortcut.RegistrationError + "）";
            titleBar.SetSidebarStatus(visible, hint);
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
                browser.CoreWebView2.SourceChanged += delegate { UpdateTitleBarRoute(); };
                browser.CoreWebView2.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs args)
                {
                    if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                    {
                        browserEngineFailed = true;
                        ShowFailure("页面引擎已停止，请在更多菜单中完全退出，然后重新打开海克斯指南。");
                    }
                    else if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
                        ShowFailure("页面进程已停止，请从右上角更多菜单刷新页面。");
                    // GPU/utility and other auto-recoverable failures must not hide a healthy page.
                };
                browser.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
                { args.Handled = true; OpenExternal(args.Uri); };
                browser.CoreWebView2.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
                {
                    if (!args.IsSuccess) { ShowFailure("页面未能打开，请从右上角更多菜单刷新页面。"); return; }
                    status.Visible = false;
                    browser.Visible = true;
                    // Fixed presentation script only; no messages or host objects are exposed to web content.
                    if (!await PrepareDesktopPageAsync()) return;
                    desktopPageReady = true;
                    titleBar.SetPageReady(true);
                    UpdateTitleBarRoute();
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
            if (localOrigin != null && target.Scheme == localOrigin.Scheme && target.Host == localOrigin.Host && target.Port == localOrigin.Port)
            {
                desktopPageReady = false;
                titleBar.SetPageReady(false);
                return;
            }
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
                titleBar.ApplyAppearance(model);
                if (UpdateSelectionWatchers(model)) lifeController.UpdateModel(model);
                scanMenu.Checked = ModelValue.Boolean(ModelValue.Object(model, "ocr"), "enabled");
                scanMenu.Enabled = !scanChanging;
                sidebar.Invalidate();
            }
            catch
            {
                if (!closing && generation == sidebarRequestGeneration && !confirmChanging && !scanChanging)
                {
                    // A slow recommendation view must not revoke newer, healthy
                    // recognition delivery or its in-flight click witnesses.
                    if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - lastRecognitionAt > 1000)
                    {
                        selectionWatcher.UpdateObservationScope(null);
                        panelWatcher.CancelForLocalAction();
                        lifeController.UpdateModel(null);
                    }
                    sidebar.Model = ModelValue.Failure("正在等待本地连接…"); sidebar.Invalidate();
                }
            }
            finally { fetching = false; }
        }

        private bool UpdateSelectionWatchers(Dictionary<string, object> model)
        {
            long stamp;
            if (ModelValue.Integer(model, "recognitionAt", out stamp))
            {
                if (stamp < lastRecognitionAt) return false;
                long age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - stamp;
                if (age < -1000 || age > 1000)
                {
                    selectionWatcher.UpdateObservationScope(null);
                    panelWatcher.CancelForLocalAction();
                    return false;
                }
                lastRecognitionAt = stamp;
            }
            // Direct click/feedback and player-opened result panels are two
            // independent sources using the same authoritative commit boundary.
            selectionWatcher.UpdateModel(model);
            panelWatcher.UpdateModel(model);
            recognitionModel = model;
            return true;
        }

        private static bool ClickObservationHasPriority(string status)
        {
            return status == "baseline" || status == "ready" || status == "pending"
                || status == "feedback" || status == "observed";
        }

        private async Task FetchRecognitionAsync()
        {
            if (closing || localOrigin == null || recognitionFetching || confirmChanging || scanChanging) return;
            recognitionFetching = true;
            long generation = sidebarRequestGeneration;
            try
            {
                var model = await RequestModelAsync("api/recognition", null);
                if (closing || IsDisposed || generation != sidebarRequestGeneration || confirmChanging || scanChanging) return;
                if (UpdateSelectionWatchers(model))
                {
                    lifeController.UpdateModel(model);
                    recognitionTimer.Interval = ModelValue.Boolean(ModelValue.Object(model, "screenObservationScope"), "eligible") ? 150 : 400;
                }
            }
            catch
            {
                if (!closing && generation == sidebarRequestGeneration)
                {
                    selectionWatcher.UpdateObservationScope(null);
                    panelWatcher.CancelForLocalAction();
                }
            }
            finally { recognitionFetching = false; }
        }

        private void PulseSelectionDiagnostics()
        {
            DateTime now = DateTime.UtcNow;
            if (closing || now < nextSelectionDiagnostics || System.Threading.Interlocked.CompareExchange(ref selectionDiagnosticsWriting, 1, 0) != 0) return;
            nextSelectionDiagnostics = now.AddSeconds(2);
            string json, panelJson;
            try
            {
                json = SelectionDiagnosticsJson(selectionWatcher, recognitionModel ?? sidebar.Model, now, recognitionTrace);
                var panelSnapshot = panelWatcher.Diagnostics();
                panelSnapshot["schemaVersion"] = 2;
                panelSnapshot["appVersion"] = "1.18.0";
                panelSnapshot["updatedAtUtc"] = now.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
                panelSnapshot["backendReason"] = PanelReason(recognitionModel ?? sidebar.Model);
                panelJson = new JavaScriptSerializer().Serialize(panelSnapshot);
                if (Encoding.UTF8.GetByteCount(panelJson) > 2048) throw new InvalidOperationException("Panel diagnostic snapshot exceeds its fixed bound.");
            }
            catch { System.Threading.Interlocked.Exchange(ref selectionDiagnosticsWriting, 0); return; }
            string path = Path.Combine(dataDirectory, "diagnostics", "screen-selection-status.json");
            string panelPath = Path.Combine(dataDirectory, "diagnostics", "panel-selection-status.json");
            Task.Run(delegate
            {
                string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                string panelTemporary = panelPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    File.WriteAllText(temporary, json, new UTF8Encoding(false));
                    if (File.Exists(path)) File.Replace(temporary, path, null);
                    else File.Move(temporary, path);
                    File.WriteAllText(panelTemporary, panelJson, new UTF8Encoding(false));
                    if (File.Exists(panelPath)) File.Replace(panelTemporary, panelPath, null);
                    else File.Move(panelTemporary, panelPath);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                finally
                {
                    try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
                    try { if (File.Exists(panelTemporary)) File.Delete(panelTemporary); } catch { }
                    System.Threading.Interlocked.Exchange(ref selectionDiagnosticsWriting, 0);
                }
            });
        }

        internal static string SelectionDiagnosticsJson(ScreenSelectionWatcher watcher, Dictionary<string, object> model, DateTime now, RecognitionTrace trace = null)
        {
            var native = watcher.Diagnostics();
            if (trace != null) native["trace"] = trace.Snapshot();
            var snapshot = new Dictionary<string, object> {
                { "version", "1.18.0" }, { "schemaVersion", 2 },
                { "updatedAtUtc", now.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture) },
                { "native", native },
                { "backend", ScreenSelectionWatcher.BackendDiagnostics(ModelValue.Object(model, "selectionDiagnostics")) }
            };
            string json = new JavaScriptSerializer().Serialize(snapshot);
            if (Encoding.UTF8.GetByteCount(json) > 4096) throw new InvalidOperationException("Selection diagnostic snapshot exceeds its fixed bound.");
            return json;
        }

        private static string PanelReason(Dictionary<string, object> model)
        {
            string reason = ModelValue.Text(ModelValue.Object(model, "panelSelection"), "reason");
            switch (reason)
            {
                case "waiting-offer": case "waiting-panel": case "panel-recommendation-unavailable":
                case "panel-disabled": case "panel-context-unavailable": case "panel-anchor-unavailable":
                case "panel-recommendation-tied": case "panel-collision-unverified": case "panel-no-new-match":
                case "panel-multiple-new-groups": case "panel-unstable": case "panel-round-ambiguous":
                case "panel-context-invalid": case "panel-evidence-invalid": case "panel-glyph-identity-invalid":
                case "panel-context-mismatch": case "panel-offer-expired": case "panel-ineligible":
                case "panel-capture-before-offer": case "panel-capture-before-scope": case "panel-capture-stale":
                case "panel-capture-future": case "panel-captures-not-independent": case "panel-geometry-changed":
                case "panel-game-unverified": case "panel-not-visible": case "panel-selection-ui-visible": return reason;
                default: return "unavailable";
            }
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
                var trace = new RecognitionTrace();
                for (int i = 0; i < 100; i++) trace.Record("submit-failed", "PRIVATE-MARKER", long.MaxValue, int.MaxValue, int.MaxValue, int.MaxValue, 599, int.MaxValue);
                string json = SelectionDiagnosticsJson(watcher, privateBackend, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc), trace);
                var snapshot = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                if (snapshot.Count != 5 || Encoding.UTF8.GetByteCount(json) > 4096
                    || ModelValue.Text(snapshot, "version") != "1.18.0" || ModelValue.Text(snapshot, "schemaVersion") != "2")
                    throw new InvalidOperationException("The persisted selection diagnostic snapshot exceeded its schema or byte bound.");
                if (json.Contains("PRIVATE-MARKER") || json.Contains("\"ids\"") || json.Contains("windowHandle")
                    || json.Contains("\"signature\"") || json.Contains("\"signatures\"") || json.Contains("\"delta\""))
                    throw new InvalidOperationException("Untrusted or private metadata entered the selection diagnostic snapshot.");
                foreach (string reason in new[] { "panel-context-invalid", "panel-evidence-invalid", "panel-glyph-identity-invalid", "panel-round-ambiguous" })
                    if (PanelReason(new Dictionary<string, object> { { "panelSelection", new Dictionary<string, object> { { "reason", reason } } } }) != reason)
                        throw new InvalidOperationException("A bounded panel rejection reason was hidden from diagnostics.");
                if (PanelReason(new Dictionary<string, object> { { "panelSelection", new Dictionary<string, object> { { "reason", "PRIVATE-MARKER" } } } }) != "unavailable")
                    throw new InvalidOperationException("Untrusted panel reason entered diagnostics.");
                return 7;
            }
        }

        private async Task RecognizeOnceAsync()
        {
            if (closing || localOrigin == null || recognitionRequesting) return;
            if (confirmChanging || scanChanging)
            {
                sidebar.RecognitionRequestNotice = "正在更新本局记录，请稍后再识别。";
                sidebar.Invalidate(); return;
            }
            recognitionRequesting = true;
            sidebar.RecognitionRequestBusy = true;
            sidebar.RecognitionRequestNotice = "正在识别，请保持三选一或六格栏可见…";
            sidebar.Invalidate();
            string game = ModelValue.Text(sidebar.Model, "gameId");
            long epoch; ModelValue.Integer(sidebar.Model, "gameEpoch", out epoch);
            long previousRequestId; ModelValue.Integer(ModelValue.Object(sidebar.Model, "manualRecognition"), "requestId", out previousRequestId);
            try
            {
                // Keep the same panel watcher, polling and commit queue alive.
                // This request does not confirm a choice or change automatic mode.
                var result = await RequestModelAsync("api/recognize-once", "{}", 30000);
                if (closing) return;
                long currentEpoch; ModelValue.Integer(sidebar.Model, "gameEpoch", out currentEpoch);
                long resultId, currentId;
                ModelValue.Integer(ModelValue.Object(result, "manualRecognition"), "requestId", out resultId);
                ModelValue.Integer(ModelValue.Object(sidebar.Model, "manualRecognition"), "requestId", out currentId);
                if (resultId < currentId) { nextFetch = DateTime.MinValue; return; }
                if (game == ModelValue.Text(sidebar.Model, "gameId") && epoch == currentEpoch)
                    sidebar.RecognitionRequestNotice = ModelValue.Text(result, "message");
                else sidebar.RecognitionRequestNotice = "对局已变化，请重新识别。";
                nextFetch = DateTime.MinValue;
                await FetchSidebarAsync();
            }
            catch
            {
                long currentId; ModelValue.Integer(ModelValue.Object(sidebar.Model, "manualRecognition"), "requestId", out currentId);
                if (!closing && currentId <= previousRequestId + 1) sidebar.RecognitionRequestNotice = "本次识别未完成，请保持游戏画面可见后重试。";
            }
            finally
            {
                recognitionRequesting = false;
                if (!closing) { sidebar.RecognitionRequestBusy = false; sidebar.Invalidate(); }
            }
        }

        private async Task ToggleScanningAsync()
        {
            if (closing || localOrigin == null || scanChanging) return;
            selectionWatcher.CancelForLocalAction();
            panelWatcher.CancelForLocalAction();
            sidebarRequestGeneration++;
            scanChanging = true; scanMenu.Enabled = false;
            try
            {
                var model = await RequestModelAsync("api/sidebar/ocr", "{\"enabled\":" + (scanMenu.Checked ? "false" : "true") + "}");
                if (closing) return;
                sidebar.Model = model;
                UpdateSelectionWatchers(model);
                scanMenu.Checked = ModelValue.Boolean(ModelValue.Object(model, "ocr"), "enabled");
                sidebar.Invalidate();
            }
            catch { if (!closing) tray.ShowBalloonTip(2500, "识别设置未保存", "请稍后重试，或打开完整助手手动扫描。", ToolTipIcon.Info); }
            finally { scanChanging = false; if (!closing) scanMenu.Enabled = true; }
        }

        private async Task ConfirmOfferAsync(string id, string pendingId = null)
        {
            if (closing || localOrigin == null || confirmChanging || string.IsNullOrEmpty(id)) return;
            selectionWatcher.CancelForLocalAction();
            panelWatcher.CancelForLocalAction();
            sidebarRequestGeneration++;
            confirmChanging = true;
            shortcut.ConfirmRequests++;
            try
            {
                var current = await RequestModelAsync("api/sidebar", null);
                if (closing) return;
                bool offered = false;
                foreach (object entry in ModelValue.OffersForConfirmation(current, pendingId))
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
                var payload = new Dictionary<string, object> {
                    { "id", id }, { "gameId", currentGameId }, { "revision", revision }
                };
                if (!string.IsNullOrEmpty(pendingId)) payload["pendingId"] = pendingId;
                string body = new JavaScriptSerializer().Serialize(payload);
                var confirmed = await RequestModelAsync("api/session/confirm", body);
                if (closing) return;
                if (!ModelValue.ConfirmsOffer(confirmed, id, currentGameId))
                {
                    sidebar.Notice = "本局状态已变化，请核对当前选择";
                    nextFetch = DateTime.MinValue;
                    return;
                }
                sidebar.Model = confirmed;
                UpdateSelectionWatchers(confirmed);
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

        private async Task QueueAutomaticSelectionAsync(Dictionary<string, object> evidence, bool panel)
        {
            if (closing || localOrigin == null || evidence == null || automaticSelections.Count >= 2)
            {
                recognitionTrace.Record("submit-rejected", closing ? "closing" : evidence == null ? "invalid-proof" : "busy", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (panel) panelWatcher.SubmissionCompleted(false); return;
            }
            automaticSelections.Enqueue(new KeyValuePair<bool, Dictionary<string, object>>(panel, evidence));
            RecordAutomaticTrace("queue", panel ? "panel" : "screen", evidence, panel);
            if (automaticSelectionPosting) return;
            automaticSelectionPosting = true;
            try
            {
                while (!closing && automaticSelections.Count > 0)
                {
                    var pending = automaticSelections.Peek();
                    while (!closing && (confirmChanging || scanChanging)
                        && AutomaticEvidenceFresh(pending.Value, pending.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())) await Task.Delay(50);
                    var next = automaticSelections.Dequeue();
                    if (closing || confirmChanging || scanChanging
                        || !AutomaticEvidenceFresh(next.Value, next.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
                    { RecordAutomaticTrace("submit-expired", closing ? "closing" : "stale-context", next.Value, next.Key); if (next.Key) panelWatcher.SubmissionCompleted(false); continue; }
                    if (next.Key) await ConfirmPanelSelectionAsync(next.Value);
                    else await ConfirmScreenSelectionAsync(next.Value);
                }
            }
            finally
            {
                while (automaticSelections.Count > 0)
                    if (automaticSelections.Dequeue().Key) panelWatcher.SubmissionCompleted(false);
                automaticSelectionPosting = false;
            }
        }

        private static bool AutomaticEvidenceFresh(Dictionary<string, object> evidence, bool panel, long now)
        {
            long observed;
            if (panel)
            {
                var frames = ModelValue.Array(evidence, "frames");
                if (frames.Count == 0 || !ModelValue.Integer(frames[frames.Count - 1] as Dictionary<string, object>, "capturedAt", out observed)) return false;
            }
            else if (!ModelValue.Integer(evidence, "observedAt", out observed)) return false;
            // Leave transport time within the server's existing five-second
            // receipt allowance; another provider's slow request must not drop
            // a still-current direct proof after an arbitrary two seconds.
            return observed - now <= 1000 && now - observed < 4500;
        }

        private void RecordAutomaticTrace(string eventCode, string reason, Dictionary<string, object> evidence, bool panel, int httpStatus = 0)
        {
            long stamp = 0, now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (panel)
            {
                var frames = ModelValue.Array(evidence, "frames");
                if (frames.Count > 0) ModelValue.Integer(frames[frames.Count - 1] as Dictionary<string, object>, "capturedAt", out stamp);
            }
            else ModelValue.Integer(evidence, "clickedAt", out stamp);
            int duration = stamp > 0 ? (int)Math.Max(0, Math.Min(60000, now - stamp)) : 0;
            recognitionTrace.Record(eventCode, reason, now, httpStatus:httpStatus, durationMs:duration);
        }

        private async Task ConfirmScreenSelectionAsync(Dictionary<string, object> evidence)
        {
            if (closing || localOrigin == null || confirmChanging || scanChanging)
            { RecordAutomaticTrace("submit-rejected", closing ? "closing" : "busy", evidence, false); return; }
            long selectedIndex;
            var ids = ModelValue.Array(evidence, "ids");
            if (!ModelValue.Integer(evidence, "selectedIndex", out selectedIndex) || selectedIndex > 2 || ids.Count != 3)
            { RecordAutomaticTrace("submit-rejected", "invalid-proof", evidence, false); return; }
            string selectedId = ids[(int)selectedIndex] as string;
            object requestedGameId;
            if (string.IsNullOrEmpty(selectedId) || !ModelValue.GameId(evidence, out requestedGameId))
            { RecordAutomaticTrace("submit-rejected", "invalid-proof", evidence, false); return; }
            sidebarRequestGeneration++;
            confirmChanging = true;
            bool accepted = false;
            RecordAutomaticTrace("submit-start", "screen", evidence, false);
            try
            {
                // The authoritative server checks the exact offer token, ordered
                // IDs, capture time, game epoch and revision before mutation.
                string body = new JavaScriptSerializer().Serialize(evidence);
                var confirmed = await RequestModelAsync("api/sidebar/selection", body);
                if (closing) return;
                if (!ModelValue.ConfirmsOffer(confirmed, selectedId, requestedGameId))
                {
                    RecordAutomaticTrace("submit-rejected", "stale-context", evidence, false, 200);
                    sidebar.Notice = "屏幕自动确认（实验）：状态已变化，请手动核对";
                    nextFetch = DateTime.MinValue;
                    return;
                }
                accepted = true;
                RecordAutomaticTrace("submit-accepted", "screen", evidence, false, 200);
                sidebar.Model = confirmed;
                UpdateSelectionWatchers(confirmed);
                sidebar.ExpandBuild();
                sidebar.Notice = "屏幕自动确认（实验）：已记录选择，推荐已更新";
                nextFetch = DateTime.MinValue;
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                int statusCode = response == null ? 0 : (int)response.StatusCode;
                if (accepted) RecordAutomaticTrace("client-update-failed", "client-state-error", evidence, false);
                else RecordAutomaticTrace(statusCode == 400 || statusCode == 409 ? "submit-rejected" : "submit-failed",
                    statusCode == 409 ? "stale-context" : statusCode == 400 ? "invalid-proof" : statusCode == 0 ? "transport-error" : "http-error", evidence, false, statusCode);
                if (response != null) response.Close();
                if (!closing) sidebar.Notice = "屏幕自动确认（实验）：未记录本次选择，可手动确认";
                nextFetch = DateTime.MinValue;
            }
            catch { RecordAutomaticTrace(accepted ? "client-update-failed" : "submit-failed", accepted ? "client-state-error" : "transport-error", evidence, false); if (!closing) sidebar.Notice = "屏幕自动确认（实验）：记录未完成，可手动确认"; }
            finally { confirmChanging = false; if (!closing) sidebar.Invalidate(); }
        }

        private async Task ConfirmPanelSelectionAsync(Dictionary<string, object> evidence)
        {
            if (closing || localOrigin == null || confirmChanging || scanChanging || evidence == null)
            { RecordAutomaticTrace("submit-rejected", closing ? "closing" : evidence == null ? "invalid-proof" : "busy", evidence, true); panelWatcher.SubmissionCompleted(false); return; }
            long epoch, revision;
            var before = sidebar.Model;
            if (!ModelValue.Integer(evidence, "gameEpoch", out epoch) || !ModelValue.Integer(evidence, "revision", out revision))
            { RecordAutomaticTrace("submit-rejected", "invalid-proof", evidence, true); panelWatcher.SubmissionCompleted(false); return; }
            sidebarRequestGeneration++;
            confirmChanging = true;
            bool accepted = false;
            RecordAutomaticTrace("submit-start", "panel", evidence, true);
            try
            {
                string body = new JavaScriptSerializer().Serialize(evidence);
                var confirmed = await RequestModelAsync("api/sidebar/panel", body);
                if (closing) return;
                long afterEpoch, afterRevision;
                if (!ModelValue.Integer(confirmed, "gameEpoch", out afterEpoch) || afterEpoch != epoch
                    || !ModelValue.Integer(confirmed, "sessionRevision", out afterRevision) || afterRevision < revision)
                { RecordAutomaticTrace("submit-rejected", "stale-context", evidence, true, 200); nextFetch = DateTime.MinValue; return; }
                accepted = afterRevision > revision;
                RecordAutomaticTrace(accepted ? "submit-accepted" : "submit-rejected", accepted ? "panel" : "invalid-proof", evidence, true, 200);
                sidebar.Model = confirmed;
                UpdateSelectionWatchers(confirmed);
                if (afterRevision > revision && ModelValue.Array(confirmed, "owned").Count > ModelValue.Array(before, "owned").Count)
                {
                    sidebar.ExpandBuild();
                    bool inferred = false;
                    foreach (object entry in ModelValue.Array(confirmed, "owned"))
                        if (ModelValue.Boolean(entry as Dictionary<string, object>, "inferred")) inferred = true;
                    sidebar.Notice = inferred ? "推定已选：同图标存在歧义；可打开详细纠正" : "面板图标已匹配，出装与后续海克斯已更新";
                }
                else if (PanelReason(confirmed) == "panel-recommendation-unavailable" || PanelReason(confirmed) == "panel-recommendation-tied")
                    sidebar.Notice = "同图标暂无可用推荐顺序，请在侧栏手动确认";
                nextFetch = DateTime.MinValue;
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                int statusCode = response == null ? 0 : (int)response.StatusCode;
                if (accepted) RecordAutomaticTrace("client-update-failed", "client-state-error", evidence, true);
                else RecordAutomaticTrace(statusCode == 400 || statusCode == 409 ? "submit-rejected" : "submit-failed",
                    statusCode == 409 ? "stale-context" : statusCode == 400 ? "invalid-proof" : statusCode == 0 ? "transport-error" : "http-error", evidence, true, statusCode);
                if (response != null) response.Close();
                if (!closing) sidebar.Notice = "面板核对未记录，可继续打开面板或手动确认";
                nextFetch = DateTime.MinValue;
            }
            catch { RecordAutomaticTrace(accepted ? "client-update-failed" : "submit-failed", accepted ? "client-state-error" : "transport-error", evidence, true); if (!closing) sidebar.Notice = "面板核对未记录，可继续打开面板或手动确认"; nextFetch = DateTime.MinValue; }
            finally { panelWatcher.SubmissionCompleted(accepted); confirmChanging = false; if (!closing) sidebar.Invalidate(); }
        }

        private async Task PublishScreenLifeAsync(Dictionary<string, object> evidence)
        {
            if (closing || localOrigin == null || evidence == null) return;
            // One newest pending proof. In particular, a focus-loss unknown
            // supersedes older queued observations and is never dropped busy.
            pendingLifeProof = evidence;
            if (lifePosting) return;
            lifePosting = true;
            try
            {
                while (!closing && pendingLifeProof != null)
                {
                    var proof = pendingLifeProof; pendingLifeProof = null;
                    try
                    {
                        string body = new JavaScriptSerializer().Serialize(proof);
                        if (Encoding.UTF8.GetByteCount(body) <= 1024)
                        {
                            for (int attempt = 0; attempt < 2; attempt++)
                            {
                                try { await RequestModelAsync("api/sidebar/life", body); break; }
                                catch (WebException error)
                                {
                                    var response = error.Response as HttpWebResponse;
                                    bool transient = response == null || (int)response.StatusCode >= 500;
                                    if (response != null) response.Close();
                                    if (attempt != 0 || !transient || pendingLifeProof != null || !LifeProofStillCurrent(proof)) break;
                                }
                                await Task.Delay(200);
                                if (pendingLifeProof != null || !LifeProofStillCurrent(proof)) break;
                            }
                        }
                    }
                    catch { /* Expired or changed-context proof cannot change the session. */ }
                    // Do not replace UI/session state with a possibly older
                    // POST reply while a selection confirmation is in flight.
                    nextFetch = DateTime.MinValue;
                }
            }
            finally { lifePosting = false; }
        }

        private bool LifeProofStillCurrent(Dictionary<string, object> proof)
        {
            long proofEpoch, modelEpoch, at;
            return !closing && ModelValue.Integer(proof, "gameEpoch", out proofEpoch)
                && ModelValue.Integer(sidebar.Model, "gameEpoch", out modelEpoch) && proofEpoch == modelEpoch
                && ModelValue.Text(proof, "gameId") == ModelValue.Text(sidebar.Model, "gameId")
                && ModelValue.Integer(proof, "observedAt", out at)
                && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - at >= -1000
                && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - at < 2500;
        }

        private Task<Dictionary<string, object>> RequestModelAsync(string path, string body, int timeout = 2000)
        {
            Uri endpoint = new Uri(localOrigin, path);
            string token = sessionToken;
            string origin = localOrigin.GetLeftPart(UriPartial.Authority);
            return Task.Run(delegate
            {
                var request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Proxy = null;
                request.Timeout = timeout;
                request.ReadWriteTimeout = timeout;
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
            desktopPageReady = false;
            titleBar.SetPageReady(false);
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
        internal int IdleHideSeconds = SidebarIdleState.DefaultDelaySeconds;
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
            long delay;
            if (ModelValue.Integer(settings, "idleHideSeconds", out delay)
                && delay >= SidebarIdleState.MinimumDelaySeconds && delay <= SidebarIdleState.MaximumDelaySeconds)
                result.IdleHideSeconds = (int)delay;
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
        private Font headingFont, normalFont, smallFont, decisionFont, offerNameFont;
        private SidebarAppearance appearance = new SidebarAppearance();
        private Dictionary<string, object> model = ModelValue.Failure("正在连接本地助手…");
        private readonly Color muted = Color.FromArgb(154, 171, 192);
        private readonly Color accent = Color.FromArgb(128, 222, 193);
        private Rectangle hideButton, detailsButton, gameButton, recognitionButton, viewport, scrollTrack, scrollThumb;
        private bool pressedRecognition;
        private int scrollOffset, contentHeight;
        private readonly List<string> paintedSections = new List<string>();
        private string paintedNextItemId = "";
        private readonly List<Rectangle> nextItemTextAreas = new List<Rectangle>();
        private readonly Dictionary<Rectangle, string> offerButtons = new Dictionary<Rectangle, string>();
        private readonly Dictionary<Rectangle, string> offerPendingIds = new Dictionary<Rectangle, string>();
        private readonly Dictionary<Rectangle, KeyValuePair<string, string>> pendingOfferButtons = new Dictionary<Rectangle, KeyValuePair<string, string>>();
        private string pressedOfferId, pressedPendingId;
        private readonly Dictionary<Rectangle, Dictionary<string, object>> augmentTargets = new Dictionary<Rectangle, Dictionary<string, object>>();
        private readonly Dictionary<Rectangle, string> helpTargets = new Dictionary<Rectangle, string>();
        private readonly ToolTip augmentHint = new ToolTip { ShowAlways = true, InitialDelay = 450, ReshowDelay = 100, AutoPopDelay = 15000 };
        private string activeAugmentHint = "";
        private bool activeHintIsHelp;
        private string SidebarHelp { get { return "Ctrl + 左键：拖动侧栏\nAlt+Shift+H：收起或展开\n鼠标离开" + appearance.IdleHideSeconds + "秒：淡化为边缘条；悬停恢复\n等待时间可在主窗口的界面设置中调整\n识别到当前三选一时自动展开\n滚轮：查看侧栏中的其余内容\n识别一次：保持游戏在前台，读三选一或已展开的六格栏。\n六格核对需要此前识别过的本轮候选；证据不足不会猜选。\n打开详细：查看完整构筑和调整记录\n返回游戏：切回游戏窗口\n只读游戏，不替你点击或操作。"; } }
        private const string NextItemHelp = "根据本局英雄、已确认海克斯、\n敌方阵容与可读战绩推荐下一件装备。\n平时完整买出后才推进，组件不算完成。\n确认影响出装的海克斯后，会重新规划；\n若先完成当前目标，随后优先考虑强化装备。\n任务装备仅在确认相关任务海克斯后显示，\n并列出需要完成的合成路线。";
        private const string OffersHelp = "先在游戏内选择；未自动记录时，\n再点对应的“确认”按钮。\n卡片左右位置与游戏一致；\n“首选”和金框表示优先推荐，不表示已选。\n悬停卡片可查看名称与品质。\n出现三选一卡片后会自动检查。\n未确认的旧轮会保留，可继续核对或补录。";
        private const string OfferRecordInstruction = "游戏里选完，再记录";
        private const string OwnedHelp = "这里显示本局已经记录的海克斯。\n自动识别未确认时，可点“确认”。\n标注为推定的记录仍有同图标歧义；\n可在“打开详细”中移除并改选。";
        private readonly RemoteIconCache buildIcons = new RemoteIconCache();
        private readonly Dictionary<string, Image> augmentIcons = new Dictionary<string, Image>();
        private Rectangle buildToggle;
        private bool buildExpanded, remoteIcons = true;
        private bool initialPlanHandled;
        private string initialPlanGame = "";
        private long sessionRevision = -1;
        private long recognitionRequestId;
        private long pendingRevision = -1, pendingRevisionEpoch = -1;
        private Rectangle placementArea;
        private Point dragStartPointer, dragStartLocation;
        private bool dragging, consumeDragClick, customPosition, appearanceLoaded;
        private double horizontalPosition, verticalPosition = 0.5;
        private readonly SidebarIdleState idleState = new SidebarIdleState();
        private readonly Stopwatch idleClock = Stopwatch.StartNew();
        private readonly Timer idleTimer;
        private Rectangle expandedBounds;
        private bool idleCompact, idleTargetCompact, idleAnimating, consumeIdleClick;
        private double idleAnimationFrom, idleAnimationTo;
        private long idleAnimationStart, choiceAttentionUntil;
        private Rectangle idleRevealZone;
        private long idleRevealAt = -1;
        private const int IdleFadeMilliseconds = 180;
        internal bool IsIdleCollapsed { get { return idleCompact || idleTargetCompact; } }
        internal Dictionary<string, object> Model
        {
            get { return model; }
            set
            {
                long nextPendingRevision = -1, nextPendingEpoch = -1;
                bool hasPendingRevision = ModelValue.Integer(value, "pendingRevision", out nextPendingRevision)
                    && ModelValue.Integer(value, "gameEpoch", out nextPendingEpoch);
                if (hasPendingRevision && (nextPendingEpoch < pendingRevisionEpoch
                    || nextPendingEpoch == pendingRevisionEpoch && nextPendingRevision < pendingRevision)) return;
                // A transport failure is not a session update. Preserve unresolved
                // choices for display; confirmation still requires session context.
                if (value != null && !value.ContainsKey("offers") && !value.ContainsKey("gameId")
                    && ModelValue.Array(model, "pendingOffers").Count > 0)
                {
                    value = new Dictionary<string, object>(value);
                    value["offers"] = ModelValue.Array(model, "offers");
                    value["pendingOffers"] = ModelValue.Array(model, "pendingOffers");
                }
                long revision;
                if (ModelValue.Integer(value, "sessionRevision", out revision))
                {
                    if (revision < sessionRevision) return;
                    sessionRevision = revision;
                }
                if (hasPendingRevision) { pendingRevision = nextPendingRevision; pendingRevisionEpoch = nextPendingEpoch; }
                long previousRecognitionEpoch, nextRecognitionEpoch;
                bool recognitionEpochChanged = ModelValue.Integer(model, "gameEpoch", out previousRecognitionEpoch)
                    && ModelValue.Integer(value, "gameEpoch", out nextRecognitionEpoch) && previousRecognitionEpoch != nextRecognitionEpoch;
                if (recognitionEpochChanged || value != null && value.ContainsKey("gameId") && ModelValue.Text(value, "gameId") != ModelValue.Text(model, "gameId"))
                { recognitionRequestId = 0; RecognitionRequestNotice = ""; }
                long incomingRequestId;
                var incomingRequest = ModelValue.Object(value, "manualRecognition");
                var previousRequest = ModelValue.Object(model, "manualRecognition");
                if (ModelValue.Integer(incomingRequest, "requestId", out incomingRequestId))
                {
                    if (incomingRequestId > recognitionRequestId)
                    { recognitionRequestId = incomingRequestId; RecognitionRequestNotice = ""; }
                    else if (incomingRequestId < recognitionRequestId || previousRequest != null && !ModelValue.Boolean(previousRequest, "active") && ModelValue.Boolean(incomingRequest, "active"))
                    {
                        value = new Dictionary<string, object>(value);
                        value["manualRecognition"] = previousRequest;
                    }
                }
                int previousOwned = ModelValue.Array(model, "owned").Count;
                bool previousModel = ModelValue.Object(model, "champion") != null;
                string previousPhase = ModelValue.Text(model, "phase");
                model = value;
                choiceAttentionUntil = idleClock.ElapsedMilliseconds + SidebarOfferAttention.RemainingMilliseconds(value, DateTime.UtcNow);
                int currentOwned = ModelValue.Array(value, "owned").Count;
                string phase = ModelValue.Text(value, "phase"), game = ModelValue.Text(value, "gameId");
                bool boundary = phase == "ChampSelect" || phase == "EndOfGame" || phase == "WaitingForStats";
                bool newGame = game.Length > 0 && initialPlanGame.Length > 0 && game != initialPlanGame;
                if (boundary && phase != previousPhase || newGame) { initialPlanHandled = false; initialPlanGame = ""; RecognitionRequestNotice = ""; }
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
                offerPendingIds.Clear(); pendingOfferButtons.Clear();
                ClearAugmentHint(true);
                // A transient connection error must not reset the user's last saved layout.
                if (ModelValue.Object(value, "appearance") != null) ApplyAppearance(SidebarAppearance.FromModel(value));
                else Invalidate();
                if (Visible) PulseIdle();
            }
        }
        internal string Notice = "";
        internal bool RecognitionRequestBusy;
        internal string RecognitionRequestNotice = "";
        private bool RecognitionBusy { get { return RecognitionRequestBusy || ModelValue.Boolean(ModelValue.Object(model, "manualRecognition"), "active"); } }
        private string RecognitionMessage
        {
            get
            {
                var request = ModelValue.Object(model, "manualRecognition");
                string message = ModelValue.Text(request, "message");
                if (ModelValue.Text(request, "status") == "idle" && RecognitionRequestNotice.Length == 0) return "";
                return ModelValue.Boolean(request, "active") && message.Length > 0 ? message
                    : RecognitionRequestNotice.Length > 0 ? RecognitionRequestNotice : message;
            }
        }
        internal bool IsLoadingPreview { get { return ModelValue.Text(ModelValue.Object(model, "plan"), "stage") == "loading-preview"; } }
        private bool IsLoadingStage { get { return ModelValue.Text(model, "stage") == "loading" || IsLoadingPreview; } }
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
                && ModelValue.Array(enemy, "champions").Count > 0 && ModelValue.Array(plan, "buildItems").Count > 0;
        }
        internal event EventHandler HideRequested, DetailsRequested, GameRequested, RecognitionRequested;
        internal event Action<string> OfferConfirmed;
        internal event Action<string, string> PendingOfferConfirmed;

        internal void ExpandBuild()
        {
            buildExpanded = true;
            scrollOffset = 0;
            Invalidate();
        }
        private List<string> DisplaySections()
        {
            // Presentation is deliberately separate from the persisted four-section
            // schema, which is also edited by the unchanged full application.
            var result = new List<string> { "nextItem" };
            if (!IsLoadingStage) result.Add("offers");
            foreach (string section in appearance.Sections)
                if (section == "hero" || section == "owned" && !IsLoadingStage) result.Add(section);
            return result;
        }

        private static bool FreshRecommendationTime(Dictionary<string, object> value, string key, DateTimeOffset now, bool allowExpired = false)
        {
            DateTimeOffset timestamp;
            if (!DateTimeOffset.TryParse(ModelValue.Text(value, key), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out timestamp)) return false;
            double age = (now - timestamp).TotalMilliseconds;
            return age >= -5000 && (allowExpired || age <= 30000);
        }
        private static bool RecommendationInteger(Dictionary<string, object> value, string key, out long number)
        {
            object raw; number = -1;
            return value != null && value.TryGetValue(key, out raw) && (raw is int || raw is long)
                && ModelValue.Integer(value, key, out number) && number <= 9007199254740991L;
        }
        private static bool RecommendationFlag(Dictionary<string, object> value, string key)
        {
            object raw;
            return value != null && value.TryGetValue(key, out raw) && raw is bool && (bool)raw;
        }
        private static bool SameOwnedSelection(Dictionary<string, object> value, Dictionary<string, object> recommendation)
        {
            object rawOwned, rawIds;
            if (value == null || recommendation == null || !value.TryGetValue("owned", out rawOwned) || !recommendation.TryGetValue("ownedIds", out rawIds)
                || !(rawOwned is ArrayList || rawOwned is object[]) || !(rawIds is ArrayList || rawIds is object[])) return false;
            var owned = ModelValue.Array(value, "owned"); var ids = ModelValue.Array(recommendation, "ownedIds");
            if (owned.Count != ids.Count) return false;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < owned.Count; index++)
            {
                string id = ModelValue.Text(owned[index] as Dictionary<string, object>, "id");
                if (id.Length == 0 || !seen.Add(id) || !(ids[index] is string) || id != (string)ids[index]) return false;
            }
            return true;
        }
        private static bool SameRecommendationRoute(Dictionary<string, object> value, Dictionary<string, object> recommendation)
        {
            object rawRoute, rawRecommendationRoute;
            if (value == null || recommendation == null || !value.TryGetValue("route", out rawRoute) || !recommendation.TryGetValue("route", out rawRecommendationRoute)
                || !(rawRoute is string) || !(rawRecommendationRoute is string)) return false;
            string route = (string)rawRoute;
            return route == (string)rawRecommendationRoute
                && (route == "auto" || route == "attack" || route == "spell" || route == "tank" || route == "support" || route == "crit");
        }
        private Dictionary<string, object> CurrentNextItem()
        {
            var recommendation = ModelValue.Object(Model, "nextItem");
            var mode = ModelValue.Object(Model, "mode");
            string game = ModelValue.Text(Model, "gameId"), champion = ModelValue.Text(ModelValue.Object(Model, "champion"), "id");
            string stage = ModelValue.Text(Model, "stage"), status = ModelValue.Text(recommendation, "status");
            string recommendationStage = ModelValue.Text(recommendation, "stage");
            // A current waiting/stale explanation can describe unusable raw data.
            // It shares the full identity guard, but can never enter the item branch.
            bool waitingStage = (status == "waiting" || status == "stale") && recommendationStage == "waiting";
            long epoch, recommendationEpoch, revision, recommendationRevision;
            object gameId, recommendationGameId;
            DateTimeOffset now = DateTimeOffset.UtcNow;
            if (recommendation == null || ModelValue.Text(ModelValue.Object(Model, "connection"), "status") != "connected"
                || !RecommendationFlag(mode, "known") || !RecommendationFlag(mode, "isMayhem")
                || !ModelValue.GameId(Model, out gameId) || gameId == null || !ModelValue.GameId(recommendation, out recommendationGameId) || recommendationGameId == null
                || game.Length == 0 || game != ModelValue.Text(recommendation, "gameId")
                || champion.Length == 0 || champion != ModelValue.Text(recommendation, "championId")
                || !RecommendationInteger(Model, "gameEpoch", out epoch) || !RecommendationInteger(recommendation, "gameEpoch", out recommendationEpoch) || epoch != recommendationEpoch
                || !RecommendationInteger(Model, "sessionRevision", out revision) || !RecommendationInteger(recommendation, "sessionRevision", out recommendationRevision) || revision != recommendationRevision
                || !(stage == "loading" && (recommendationStage == "loading-preview" || waitingStage)
                    || stage == "live" && ModelValue.Text(Model, "phase") == "InProgress"
                        && (waitingStage || ModelValue.Text(Model, "championSource") == "live-client" && recommendationStage == "live"))
                || !SameOwnedSelection(Model, recommendation) || !SameRecommendationRoute(Model, recommendation)
                || !FreshRecommendationTime(Model, "updatedAt", now, status == "stale") || !FreshRecommendationTime(recommendation, "generatedAt", now)
                || !(status == "ready" || status == "waiting" || status == "stale" || status == "complete" || status == "inventory-full")) return null;
            var item = ModelValue.Object(recommendation, "item");
            if (status == "ready" && (ModelValue.Text(item, "id").Length == 0 || ModelValue.Text(item, "name").Length == 0)) return null;
            return recommendation;
        }
        private string NextItemMessage(Dictionary<string, object> recommendation)
        {
            string status = ModelValue.Text(recommendation, "status");
            string message = ModelValue.Text(recommendation, "message").Trim();
            if (message.Length > 0) return message;
            if (status == "complete") return "当前可用资料暂无后续装备建议，等待本局更新。";
            if (status == "inventory-full") return "装备栏已满，请在完整窗口查看构筑与替换方向。";
            if (status == "stale" || ModelValue.Object(Model, "nextItem") != null
                && (!FreshRecommendationTime(Model, "updatedAt", DateTimeOffset.UtcNow) || !FreshRecommendationTime(ModelValue.Object(Model, "nextItem"), "generatedAt", DateTimeOffset.UtcNow)))
                return "对局数据已过期，等待读取最新状态。";
            return "等待本局装备数据";
        }
        private string NextItemReasons(Dictionary<string, object> recommendation)
        {
            var reasons = new List<string>();
            foreach (object entry in ModelValue.Array(recommendation, "reasons"))
            {
                string reason = entry as string;
                if (!string.IsNullOrWhiteSpace(reason)) reasons.Add(reason.Trim());
                if (reasons.Count == 2) break;
            }
            if (reasons.Count == 0 && ModelValue.Text(recommendation, "reason").Length > 0) reasons.Add(ModelValue.Text(recommendation, "reason"));
            return string.Join("\n", reasons.ToArray());
        }
        private int NextItemTextHeight(string text, Font font, int width)
        {
            if (string.IsNullOrWhiteSpace(text)) return 0;
            return TextRenderer.MeasureText(text, font, new Size(Math.Max(1, width), int.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix).Height + S(2);
        }
        private int NextItemHeight(int width)
        {
            var recommendation = CurrentNextItem();
            if (ModelValue.Text(recommendation, "status") != "ready") return S(33) + NextItemTextHeight(NextItemMessage(recommendation), smallFont, width) + S(18);
            var item = ModelValue.Object(recommendation, "item");
            int heading = Math.Max(S(44), NextItemTextHeight(ModelValue.Text(item, "name"), decisionFont, width - S(52)));
            string effect = ModelValue.Text(item, "effect"), reasons = NextItemReasons(recommendation), evidence = ModelValue.Text(recommendation, "evidenceLabel");
            return S(33) + heading + S(8) + NextItemTextHeight(effect, smallFont, width)
                + (reasons.Length > 0 ? S(7) + NextItemTextHeight(reasons, smallFont, width) : 0)
                + (evidence.Length > 0 ? S(7) + NextItemTextHeight(evidence, smallFont, width) : 0) + S(18);
        }
        private void DrawNextItemText(Graphics g, string text, Font font, Color color, int x, ref int y, int width)
        {
            int height = NextItemTextHeight(text, font, width);
            if (height == 0) return;
            var area = new Rectangle(x, y, Math.Max(1, width), height);
            nextItemTextAreas.Add(area); Write(g, text, font, color, area); y += height;
        }
        private void DrawNextItem(Graphics g, int x, int y, int width)
        {
            DrawHelpHeading(g, IsLoadingStage ? "开局下一件装备" : "下一件装备", normalFont, accent,
                new Rectangle(x, y, width, S(23)), NextItemHelp, viewport); y += S(33);
            var recommendation = CurrentNextItem();
            if (ModelValue.Text(recommendation, "status") != "ready")
            {
                DrawNextItemText(g, NextItemMessage(recommendation), smallFont, muted, x, ref y, width);
                return;
            }
            var item = ModelValue.Object(recommendation, "item");
            paintedNextItemId = ModelValue.Text(item, "id");
            DrawBuildIcon(g, ModelValue.Text(item, "icon"), new Rectangle(x, y, S(42), S(42)));
            int heading = Math.Max(S(44), NextItemTextHeight(ModelValue.Text(item, "name"), decisionFont, width - S(52))), nameY = y;
            DrawNextItemText(g, ModelValue.Text(item, "name"), decisionFont, ForeColor, x + S(52), ref nameY, width - S(52)); y += heading + S(8);
            DrawNextItemText(g, ModelValue.Text(item, "effect"), smallFont, muted, x, ref y, width);
            string reasons = NextItemReasons(recommendation), evidence = ModelValue.Text(recommendation, "evidenceLabel");
            if (reasons.Length > 0) { y += S(7); DrawNextItemText(g, reasons, smallFont, accent, x, ref y, width); }
            if (evidence.Length > 0) { y += S(7); DrawNextItemText(g, evidence, smallFont, muted, x, ref y, width); }
        }

        internal SidebarWindow()
        {
            buildIcons.Evicted += RemoveAugmentVariants;
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
            idleTimer = new Timer { Interval = 200 };
            idleTimer.Tick += delegate { PulseIdle(); };
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
            expandedBounds = desired;
            ApplyIdleBounds();
        }
        private bool CompactOnRight
        {
            get { return customPosition ? horizontalPosition > 0.5 : appearance.Side == "right"; }
        }
        private void ApplyIdleBounds()
        {
            if (dragging || expandedBounds.Width < 1 || expandedBounds.Height < 1) return;
            int edge = Math.Max(1, (int)Math.Round(SidebarIdleGeometry.EdgeWidthDip * Math.Max(96, DeviceDpi) / 96.0));
            Rectangle desired = idleCompact ? SidebarIdleGeometry.CompactBounds(expandedBounds, placementArea, CompactOnRight, edge) : expandedBounds;
            if (Bounds != desired) Bounds = desired;
        }
        internal void RevealFromIdle()
        {
            long now = idleClock.ElapsedMilliseconds;
            idleState.Reveal(now);
            SetIdlePresentation(false, now, Visible && IdleAnimationsEnabled());
        }
        private void PulseIdle()
        {
            if (IsDisposed || Disposing) return;
            long now = idleClock.ElapsedMilliseconds;
            bool pointerInside = Visible && Bounds.Contains(Cursor.Position);
            bool busy = dragging || Capture || pressedRecognition || pressedOfferId != null || RecognitionBusy;
            bool collapsed = idleState.Observe(now, Visible, pointerInside, busy, choiceAttentionUntil > now);
            SetIdlePresentation(collapsed, now, Visible && IdleAnimationsEnabled());
            AdvanceIdleAnimation(now);
        }
        private void SetIdlePresentation(bool compact, long now, bool animate)
        {
            double opacity = appearance.Opacity / 100.0 * (compact ? 0.55 : 1.0);
            if (idleTargetCompact == compact && Math.Abs(idleAnimationTo - opacity) < 0.001) return;
            idleTargetCompact = compact;
            if (!compact)
            {
                if (idleCompact) { idleRevealZone = Bounds; idleRevealAt = now; }
                idleCompact = false; ApplyIdleBounds();
            }
            ClearAugmentHint();
            idleAnimationFrom = Opacity; idleAnimationTo = opacity; idleAnimationStart = now;
            idleAnimating = animate && Math.Abs(idleAnimationFrom - opacity) > 0.001;
            if (idleTimer != null) idleTimer.Interval = idleAnimating ? 16 : 200;
            if (!idleAnimating) FinishIdleAnimation();
        }
        private void AdvanceIdleAnimation(long now)
        {
            if (!idleAnimating) return;
            double progress = Math.Min(1.0, Math.Max(0.0, (now - idleAnimationStart) / (double)IdleFadeMilliseconds));
            double eased = 1.0 - Math.Pow(1.0 - progress, 3);
            Opacity = idleAnimationFrom + (idleAnimationTo - idleAnimationFrom) * eased;
            if (progress >= 1.0) FinishIdleAnimation();
        }
        private static bool IdleAnimationsEnabled()
        {
            bool enabled;
            // SPI_GETCLIENTAREAANIMATION reads Windows' motion preference.
            return SystemParametersInfo(0x1042, 0, out enabled, 0) && enabled;
        }
        private void FinishIdleAnimation()
        {
            idleAnimating = false; idleCompact = idleTargetCompact;
            Opacity = idleAnimationTo;
            if (idleTimer != null) idleTimer.Interval = 200;
            // Completing an expansion only changes opacity: preserve a valid
            // mouse press that started on the restored controls during the fade.
            if (idleCompact) ClearSidebarHitTargets();
            ApplyIdleBounds(); Invalidate();
        }
        private void ClearSidebarHitTargets()
        {
            hideButton = detailsButton = gameButton = recognitionButton = viewport = scrollTrack = scrollThumb = buildToggle = Rectangle.Empty;
            offerButtons.Clear(); offerPendingIds.Clear(); pendingOfferButtons.Clear(); augmentTargets.Clear(); helpTargets.Clear();
            pressedOfferId = null; pressedPendingId = null; pressedRecognition = false;
        }
        private void DrawIdleStrip(Graphics graphics)
        {
            ClearSidebarHitTargets(); paintedSections.Clear(); paintedNextItemId = ""; nextItemTextAreas.Clear();
            int middle = Width / 2, center = Height / 2;
            using (var pen = new Pen(accent, 2))
            {
                int direction = CompactOnRight ? -1 : 1;
                graphics.DrawLines(pen, new[] { new Point(middle - direction * 3, center - 58), new Point(middle + direction * 3, center - 52), new Point(middle - direction * 3, center - 46) });
            }
            using (var pen = new Pen(muted, 1)) graphics.DrawLine(pen, middle, center - 20, middle, center + 20);
        }
        private void BeginManualMove(Point pointer)
        {
            if (placementArea.Width < 1 || placementArea.Height < 1) return;
            ClearAugmentHint();
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
            long now = idleClock.ElapsedMilliseconds;
            bool delayChanged = idleState.SetDelaySeconds(next.IdleHideSeconds, now);
            if (fontsChanged || sectionsChanged || sideChanged || delayChanged || appearance.Width != next.Width) ClearAugmentHint();
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
            SetIdlePresentation(delayChanged ? false : idleTargetCompact, now, false);
            MainWindowChrome.RoundWindow(this, S(12));
            Invalidate();
        }
        private void UpdateFonts()
        {
            Font oldHeading = headingFont, oldNormal = normalFont, oldSmall = smallFont, oldDecision = decisionFont, oldOfferName = offerNameFont;
            float scale = appearance.Scale / 100F;
            headingFont = new Font(appearance.FontName, 10.5F * scale, FontStyle.Bold);
            normalFont = new Font(appearance.FontName, 9F * scale);
            smallFont = new Font(appearance.FontName, 8F * scale);
            decisionFont = new Font(appearance.FontName, 11F * scale, FontStyle.Bold);
            offerNameFont = new Font(appearance.FontName, 9.5F * scale, FontStyle.Bold);
            Font = normalFont;
            if (oldHeading != null) oldHeading.Dispose();
            if (oldNormal != null) oldNormal.Dispose();
            if (oldSmall != null) oldSmall.Dispose();
            if (oldDecision != null) oldDecision.Dispose();
            if (oldOfferName != null) oldOfferName.Dispose();
        }
        private int S(int value) { return Math.Max(1, (int)Math.Round(value * appearance.Scale / 100.0)); }
        internal void ShowPassive()
        {
            if (!Visible) Show();
            SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, PassiveShowFlags);
        }
        protected override void OnVisibleChanged(EventArgs e)
        {
            if (!Visible && augmentHint != null) ClearAugmentHint();
            if (idleState != null && idleClock != null)
            {
                idleState.Reset(idleClock.ElapsedMilliseconds);
                SetIdlePresentation(false, idleClock.ElapsedMilliseconds, false);
            }
            if (idleTimer != null) { if (Visible) idleTimer.Start(); else idleTimer.Stop(); }
            base.OnVisibleChanged(e);
        }
        protected override void OnResize(EventArgs e)
        {
            if (augmentHint != null) ClearAugmentHint();
            base.OnResize(e);
            MainWindowChrome.RoundWindow(this, appearance == null ? 12 : S(12));
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            var borderState = g.Save();
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var border = new Pen(Color.FromArgb(55, 77, 97)))
            using (var outline = MainWindowChrome.RoundedPath(new RectangleF(.5F, .5F, Width - 1F, Height - 1F), S(12))) g.DrawPath(border, outline);
            g.Restore(borderState);
            if (idleCompact) { DrawIdleStrip(g); return; }
            int x = 17, width = Math.Max(1, Width - 34), y = 16;
            helpTargets.Clear();
            DrawHelpHeading(g, "海克斯指南", headingFont, ForeColor, new Rectangle(x, y, width, S(24)), SidebarHelp, ClientRectangle); y += S(32);
            recognitionButton = new Rectangle(x, y, width, S(29));
            PaintButton(g, recognitionButton, RecognitionBusy ? "正在识别…" : "识别一次"); y += S(37);
            string recognitionMessage = RecognitionMessage;
            if (recognitionMessage.Length > 0)
            {
                int messageHeight = Math.Min(S(70), NextItemTextHeight(recognitionMessage, smallFont, width));
                Write(g, recognitionMessage, smallFont, muted, new Rectangle(x, y, width, messageHeight));
                y += messageHeight + S(8);
            }
            viewport = new Rectangle(x, y, width, Math.Max(1, Height - S(82) - y));
            contentHeight = 0;
            foreach (string section in DisplaySections()) contentHeight += SectionHeight(section);
            scrollOffset = Math.Max(0, Math.Min(scrollOffset, Math.Max(0, contentHeight - viewport.Height)));
            offerButtons.Clear(); offerPendingIds.Clear(); pendingOfferButtons.Clear(); augmentTargets.Clear(); paintedSections.Clear();
            paintedNextItemId = ""; nextItemTextAreas.Clear();
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
            string footer = !IsLoadingStage ? Notice : "";
            Write(g, footer, smallFont, muted, new Rectangle(x, Height - S(28), width, S(18)));
            // Polling can repaint while the pointer is still over a help icon.
            // Reconcile with the new geometry without restarting an unchanged hint.
            if (Visible && !dragging) UpdateHoverHint(PointToClient(Cursor.Position));
        }
        private int SectionHeight(string section)
        {
            if (section == "nextItem") return NextItemHeight(Math.Max(1, Width - 34));
            if (section == "hero") return S(25) + NextItemTextHeight(HeroStatus(), smallFont, Math.Max(1, Width - 34)) + S(14);
            if (section == "owned")
            {
                int count = Math.Min(12, ModelValue.Array(Model, "owned").Count);
                int columns = OwnedIconColumns(Math.Max(1, Width - 34));
                return S(25) + (count == 0 ? S(18) : ((count + columns - 1) / columns) * (S(39) + S(7)) + S(5)) + (HasInferredOwned() ? S(35) : 0);
            }
            if (section == "offers")
            {
                int width = Math.Max(1, Width - 34), count = Math.Min(3, ModelValue.Array(Model, "offers").Count);
                var older = OlderPendingOffers();
                int height = S(27) + (count > 0 || older.Count > 0 ? RecordInstructionHeight(width) : 0)
                    + (count == 0 ? EmptyOffersHeight(width) : CreateOfferCardLayout(width).CardHeight + S(14));
                foreach (var pending in older)
                {
                    height += S(29) + S(8);
                    int index = 0;
                    foreach (object entry in ModelValue.Array(pending, "offers"))
                    {
                        if (index++ >= 3) break;
                        height += PendingOfferRowHeight(entry as Dictionary<string, object>, width) + S(6);
                    }
                }
                return height;
            }
            if (!buildExpanded) return S(126);
            var plan = ModelValue.Object(Model, "plan");
            int statisticsHeight = BuildStatisticsHeight(plan, Math.Max(1, Width - 34));
            if (IsLoadingStage) return S(297) + statisticsHeight + ((Math.Min(6, ModelValue.Array(plan, "buildItems").Count) + 1) / 2) * S(77) + S(22);
            return S(ModelValue.Array(Model, "owned").Count > 0 ? 163 : 151) + Math.Min(6, ModelValue.Array(plan, "buildItems").Count) * S(96)
                + statisticsHeight + S(46) + Math.Min(6, ModelValue.Array(plan, "nextAugments").Count) * S(56) + S(22);
        }
        private void DrawSection(Graphics g, string section, int x, int y, int width)
        {
            if (section == "nextItem") { DrawNextItem(g, x, y, width); return; }
            if (section == "hero") { DrawHero(g, x, y, width); return; }
            if (section == "owned") { DrawOwned(g, x, y, width); return; }
            if (section == "offers") { DrawOffers(g, x, y, width); return; }
            DrawBuild(g, x, y, width);
        }
        private void DrawBuild(Graphics g, int x, int y, int width)
        {
            var plan = ModelValue.Object(Model, "plan");
            string title = ModelValue.Text(plan, "title"), summary = ModelValue.Text(plan, "summary");
            bool loading = IsLoadingStage;
            Write(g, loading ? "开局前预览" : buildExpanded ? "本局构筑" : (title.Length > 0 ? title : "本局玩法参考"), normalFont, accent, new Rectangle(x, y, Math.Max(1, width - S(75)), S(23)));
            Rectangle toggle = new Rectangle(x + width - S(72), y, S(72), S(24));
            if (viewport.Contains(toggle)) { buildToggle = toggle; PaintButton(g, toggle, buildExpanded ? "收起构筑" : "展开构筑"); }
            y += S(29);
            if (!buildExpanded)
            {
                Write(g, loading ? "根据当前英雄与双方阵容准备开局装备，入场后自动更新。" : summary.Length > 0 ? summary : "等待英雄与本局选择，推荐将自动更新。", smallFont, muted, new Rectangle(x, y, width, S(78)));
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
            else { Write(g, loading ? "我方阵容" : "等待确认本局海克斯", normalFont, ForeColor, new Rectangle(x, y, width, S(23))); y += S(27); }
            var enemy = ModelValue.Object(plan, "enemyContext");
            if (loading)
            {
                DrawLoadingRoster(g, ModelValue.Object(plan, "allyContext"), x, y, width);
                y += S(73);
                Write(g, "敌方阵容", normalFont, ForeColor, new Rectangle(x, y, width, S(23))); y += S(27);
                DrawLoadingRoster(g, enemy, x, y, width);
                y += S(73);
            }
            string enemySummary = ModelValue.Text(enemy, "summary");
            Write(g, loading ? "根据英雄与对方阵容准备，入场后自动更新。" : enemySummary.Length > 0 ? enemySummary : "等待读取敌方阵容与装备，暂按自身构筑提供选项。", smallFont, muted, new Rectangle(x, y, width, S(loading ? 30 : 57))); y += S(loading ? 35 : 62);
            Write(g, loading ? "开局出装预设" : "本局装备选择", normalFont, accent, new Rectangle(x, y, width, S(23))); y += S(33);
            int statisticsHeight = BuildStatisticsHeight(plan, width);
            if (statisticsHeight > 0)
            {
                Write(g, BuildStatisticsSummary(plan), smallFont, muted, new Rectangle(x, y, width, Math.Max(1, statisticsHeight - S(7))));
                y += statisticsHeight;
            }
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
            if (loading) return;
            Write(g, "后续遇到可考虑", normalFont, accent, new Rectangle(x, y, width, S(23))); y += S(25);
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
        private static string BuildStatisticsSummary(Dictionary<string, object> plan)
        {
            string summary = ModelValue.Text(ModelValue.Object(plan, "statistics"), "summary").Replace('\r', ' ').Replace('\n', ' ').Trim();
            return summary.Length > 160 ? summary.Substring(0, 160) : summary;
        }
        private int BuildStatisticsHeight(Dictionary<string, object> plan, int width)
        {
            string summary = BuildStatisticsSummary(plan);
            if (summary.Length == 0) return 0;
            Size size = TextRenderer.MeasureText(summary, smallFont, new Size(Math.Max(1, width), int.MaxValue), TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
            return size.Height + S(7);
        }
        private void DrawLoadingRoster(Graphics g, Dictionary<string, object> context, int x, int y, int width)
        {
            ArrayList champions = ModelValue.Array(context, "champions");
            if (ModelValue.Text(context, "status") != "detected" || champions.Count == 0)
            {
                Write(g, "等待读取本局阵容", smallFont, muted, new Rectangle(x, y, width, S(30)));
                return;
            }
            int index = 0, cellWidth = Math.Max(1, width / 5);
            foreach (object entry in champions)
            {
                if (index >= 5) break;
                var champion = entry as Dictionary<string, object>;
                int cellX = x + index++ * cellWidth;
                DrawBuildIcon(g, ModelValue.Text(champion, "icon"), new Rectangle(cellX, y, S(34), S(34)));
                Write(g, ModelValue.Text(champion, "name"), smallFont, ForeColor, new Rectangle(cellX, y + S(38), Math.Max(1, cellWidth - S(3)), S(30)));
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
        private void RemoveAugmentVariants(string url)
        {
            foreach (string rarity in new[] { "silver", "gold", "prismatic" })
            {
                string key = url + "\n" + rarity;
                Image image;
                if (augmentIcons.TryGetValue(key, out image)) { augmentIcons.Remove(key); image.Dispose(); }
            }
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
        private struct OfferCardLayout
        {
            internal int CellWidth, IconSize, NameTop, NameHeight, ButtonTop, ButtonHeight, CardHeight;
        }
        private const TextFormatFlags OfferNameTextFlags = TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
        private int OfferTextHeight(string name, int width, int maximumLines)
        {
            int lineHeight = TextRenderer.MeasureText("中", offerNameFont, Size.Empty, OfferNameTextFlags).Height;
            int measured = TextRenderer.MeasureText(name, offerNameFont, new Size(Math.Max(1, width), int.MaxValue), OfferNameTextFlags).Height;
            return Math.Min(Math.Max(lineHeight, measured), lineHeight * maximumLines);
        }
        private OfferCardLayout CreateOfferCardLayout(int width)
        {
            var layout = new OfferCardLayout();
            layout.CellWidth = Math.Max(1, (width - S(6) * 2) / 3);
            layout.IconSize = Math.Min(S(38), Math.Max(1, layout.CellWidth - S(12)));
            layout.NameTop = S(23) + layout.IconSize + S(6);
            // Grow every card in this row together. Names keep the user's font
            // and scale instead of shrinking independently into tiny type.
            layout.NameHeight = OfferTextHeight("海克斯\n名称", layout.CellWidth - S(6), 3);
            int index = 0;
            foreach (object entry in ModelValue.Array(Model, "offers"))
            {
                if (index++ >= 3) break;
                layout.NameHeight = Math.Max(layout.NameHeight,
                    OfferTextHeight(ModelValue.Text(entry as Dictionary<string, object>, "name"), layout.CellWidth - S(6), 3));
            }
            layout.ButtonTop = layout.NameTop + layout.NameHeight + S(8);
            layout.ButtonHeight = S(27);
            layout.CardHeight = layout.ButtonTop + layout.ButtonHeight + S(5);
            return layout;
        }
        private static string OfferRankLabel(string rank)
        {
            return rank == "1" ? "首选" : rank == "2" ? "推荐 2" : rank == "3" ? "推荐 3" : "";
        }
        private int RecordInstructionHeight(int width)
        {
            return NextItemTextHeight(OfferRecordInstruction, smallFont, width) + S(8);
        }
        private int PendingRecordButtonWidth { get { return S(68); } }
        private int PendingOfferRowHeight(Dictionary<string, object> offer, int width)
        {
            int nameWidth = Math.Max(1, width - S(33) - PendingRecordButtonWidth - S(8));
            return Math.Max(S(36), OfferTextHeight(ModelValue.Text(offer, "name"), nameWidth, 2) + S(6));
        }
        private void RegisterOfferHint(Rectangle rectangle, Dictionary<string, object> offer)
        {
            Rectangle visible = Rectangle.Intersect(viewport, rectangle);
            if (visible.Width > 0 && visible.Height > 0) augmentTargets[visible] = offer;
        }
        private void DrawOfferName(Graphics g, string name, Rectangle area)
        {
            TextRenderer.DrawText(g, name, offerNameFont, area, ForeColor,
                OfferNameTextFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.Top
                | TextFormatFlags.EndEllipsis | TextFormatFlags.PreserveGraphicsClipping);
        }
        private RectangleF HelpCircleBounds(Rectangle target)
        {
            int diameter = S(14);
            return new RectangleF(target.Left + (target.Width - diameter) / 2F,
                target.Top + (target.Height - diameter) / 2F, diameter, diameter);
        }
        private GraphicsPath CreateHelpGlyph(RectangleF circle)
        {
            var path = new GraphicsPath();
            using (var format = StringFormat.GenericTypographic)
                path.AddString("?", smallFont.FontFamily, (int)smallFont.Style, 100F, PointF.Empty, format);
            RectangleF ink = path.GetBounds();
            float scale = Math.Min(circle.Width * 0.5F / ink.Width, circle.Height * 0.65F / ink.Height);
            // Center the visible outline, independent of font padding/baseline.
            using (var transform = new Matrix(scale, 0, 0, scale,
                circle.Left + circle.Width / 2F - (ink.Left + ink.Width / 2F) * scale,
                circle.Top + circle.Height / 2F - (ink.Top + ink.Height / 2F) * scale)) path.Transform(transform);
            return path;
        }
        private void DrawHelpHeading(Graphics g, string title, Font font, Color color, Rectangle area, string help, Rectangle clip)
        {
            int size = S(20), gap = S(5);
            var flags = TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
            int titleWidth = Math.Min(Math.Max(1, area.Width - size - gap), TextRenderer.MeasureText(g, title, font, Size.Empty, flags).Width);
            var titleArea = new Rectangle(area.Left, area.Top, titleWidth, area.Height);
            TextRenderer.DrawText(g, title, font, titleArea, color, flags | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.PreserveGraphicsClipping);
            var target = new Rectangle(titleArea.Right + gap, area.Top + (area.Height - size) / 2, size, size);
            // Partially clipped icons must not leave invisible hover targets.
            if (!clip.Contains(target) || !ClientRectangle.Contains(target)) return;
            RectangleF circle = HelpCircleBounds(target);
            var state = g.Save();
            try
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var pen = new Pen(muted)) g.DrawEllipse(pen, circle);
                using (var glyph = CreateHelpGlyph(circle))
                using (var brush = new SolidBrush(muted)) g.FillPath(brush, glyph);
            }
            finally { g.Restore(state); }
            helpTargets[target] = help;
        }
        private void HideHoverHint()
        {
            activeHintIsHelp = false;
            if (activeAugmentHint.Length == 0) return;
            activeAugmentHint = ""; augmentHint.Hide(this); augmentHint.SetToolTip(this, "");
        }
        private void ClearAugmentHint(bool preserveHeaderHint = false)
        {
            augmentTargets.Clear();
            helpTargets.Clear();
            // A routine model refresh must not interrupt reading unchanged help.
            // OnPaint checks the rebuilt targets, including removed/moved sections.
            if (!preserveHeaderHint || !activeHintIsHelp) HideHoverHint();
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
                || !buildIcons.TryBegin(url)) return;
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
                if (IsDisposed || Disposing) { buildIcons.Complete(url, null); return; }
                using (var stream = new MemoryStream(bytes))
                using (var image = Image.FromStream(stream))
                {
                    if (image.Width < 12 || image.Height < 12 || image.Width > 1024 || image.Height > 1024) throw new IOException("Invalid icon dimensions.");
                    buildIcons.Complete(url, new Bitmap(image));
                }
                Invalidate();
            }
            catch { buildIcons.Complete(url, null); /* Bounded retry keeps temporary failures recoverable. */ }
        }
        private void DrawHero(Graphics g, int x, int y, int width)
        {
            var champion = ModelValue.Object(Model, "champion");
            string hero = ModelValue.Text(champion, "name");
            string level = ModelValue.Text(Model, "level");
            if (hero.Length == 0) hero = "等待英雄同步";
            string help = "自动同步本局英雄、等级、装备和属性。\n后台识别可在托盘中开启或暂停；\n识别结果需要核对。\n加载期间显示开局推荐，入场后自动更新。";
            string connection = ModelValue.Text(ModelValue.Object(Model, "connection"), "message");
            if (connection.Length > 0) help += "\n\n当前状态：\n" + WrapHintText(connection);
            DrawHelpHeading(g, hero + (level.Length > 0 && level != "0" ? "  ·  " + level + " 级" : ""), headingFont, accent,
                new Rectangle(x, y, width, S(23)), help, viewport); y += S(25);
            string status = HeroStatus();
            Write(g, status, smallFont, muted, new Rectangle(x, y, width, NextItemTextHeight(status, smallFont, width)));
        }
        private string HeroStatus()
        {
            var connection = ModelValue.Object(Model, "connection");
            if (ModelValue.Text(connection, "status") == "error") return ModelValue.Text(connection, "message");
            if (IsLoadingStage) return "等待进入对局";
            var ocr = ModelValue.Object(Model, "ocr");
            // Local startup/transport failures contain only a connection object
            // (including status=waiting). Keep their actionable message visible.
            if (ocr == null)
            {
                string message = ModelValue.Text(connection, "message");
                return message.Length > 0 ? message : "等待连接状态更新";
            }
            string recognition = ModelValue.Boolean(ocr, "enabled") ? "后台识别已开启" : "后台识别已暂停";
            return ModelValue.Text(Model, "stage") == "waiting" && ModelValue.Object(Model, "champion") != null
                ? "等待对局数据恢复 · " + recognition : recognition;
        }
        private static string WrapHintText(string text)
        {
            // Bound tooltip width even when the connection explanation has no spaces.
            var lines = new List<string>();
            foreach (string line in text.Replace("\r", "").Split('\n'))
                for (int start = 0; start < line.Length; start += 22) lines.Add(line.Substring(start, Math.Min(22, line.Length - start)));
            return string.Join("\n", lines.ToArray());
        }
        private void DrawOwned(Graphics g, int x, int y, int width)
        {
            ArrayList owned = ModelValue.Array(Model, "owned");
            DrawHelpHeading(g, "本局已选  " + owned.Count, normalFont, accent, new Rectangle(x, y, width, S(22)), OwnedHelp, viewport); y += S(25);
            if (owned.Count == 0) return;
            int columns = OwnedIconColumns(width), index = 0, cell = S(39) + S(7);
            foreach (object item in owned)
            {
                if (index >= 12) break;
                DrawAugmentIcon(g, item as Dictionary<string, object>, new Rectangle(x + (index % columns) * cell, y + (index / columns) * cell, S(39), S(39)));
                index++;
            }
            if (HasInferredOwned())
                Write(g, "含推定已选：同图标存在歧义", smallFont, muted,
                    new Rectangle(x, y + ((index + columns - 1) / columns) * cell, width, S(35)));
        }
        private bool HasInferredOwned()
        {
            foreach (object entry in ModelValue.Array(Model, "owned"))
                if (ModelValue.Boolean(entry as Dictionary<string, object>, "inferred")) return true;
            return false;
        }
        private void DrawOffers(Graphics g, int x, int y, int width)
        {
            ArrayList offers = ModelValue.Array(Model, "offers");
            object confirmationGame; long confirmationRevision;
            bool canConfirm = ModelValue.GameId(Model, out confirmationGame)
                && ModelValue.Integer(Model, "sessionRevision", out confirmationRevision) && confirmationRevision >= 0;
            string activePendingId = "";
            bool previousRound = false;
            foreach (object item in ModelValue.Array(Model, "pendingOffers"))
            {
                var pending = item as Dictionary<string, object>;
                if (ModelValue.Boolean(pending, "active"))
                {
                    activePendingId = ModelValue.Text(pending, "pendingId");
                    previousRound = ModelValue.Boolean(pending, "previousRound");
                }
            }
            var older = OlderPendingOffers();
            DrawHelpHeading(g, OffersHeading(), normalFont, accent, new Rectangle(x, y, width, S(22)), OffersHelp, viewport); y += S(27);
            if (offers.Count > 0 || older.Count > 0)
            {
                Write(g, OfferRecordInstruction, smallFont, muted,
                    new Rectangle(x, y, width, NextItemTextHeight(OfferRecordInstruction, smallFont, width)));
                y += RecordInstructionHeight(width);
            }
            if (offers.Count == 0)
            {
                var ocr = ModelValue.Object(Model, "ocr");
                int summaryHeight = NextItemTextHeight(RecognitionSummary(ocr), normalFont, width);
                Write(g, RecognitionSummary(ocr), normalFont, muted, new Rectangle(x, y, width, summaryHeight));
                string time = RecognitionTime(ocr);
                if (time.Length > 0) Write(g, time, smallFont, muted, new Rectangle(x, y + summaryHeight + S(3), width, S(19)));
                y += EmptyOffersHeight(width);
            }
            else
            {
                int index = 0, gap = S(6);
                OfferCardLayout layout = CreateOfferCardLayout(width);
                foreach (object item in offers)
                {
                    if (index >= 3) break;
                    var offer = item as Dictionary<string, object>;
                    int cardX = x + index * (layout.CellWidth + gap);
                    Rectangle card = new Rectangle(cardX, y, layout.CellWidth, layout.CardHeight);
                    using (var brush = new SolidBrush(Color.FromArgb(23, 36, 48))) g.FillRectangle(brush, card);
                    string rank = ModelValue.Text(offer, "rank");
                    DrawOfferFrame(g, card, rank);
                    Rectangle icon = new Rectangle(cardX + (layout.CellWidth - layout.IconSize) / 2, y + S(23), layout.IconSize, layout.IconSize);
                    // Candidate statistics are not a sidebar column or tooltip.
                    // The full application retains the complete ranking evidence.
                    var displayOffer = new Dictionary<string, object>(offer);
                    displayOffer.Remove("reason"); displayOffer.Remove("rankingEvidence"); displayOffer.Remove("summary");
                    DrawAugmentIcon(g, displayOffer, icon);
                    TextRenderer.DrawText(g, OfferRankLabel(rank), smallFont,
                        new Rectangle(cardX + S(3), y + S(3), Math.Max(1, layout.CellWidth - S(6)), S(18)),
                        rank == "1" ? Color.FromArgb(216, 181, 101) : muted,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
                        | TextFormatFlags.NoPrefix | TextFormatFlags.PreserveGraphicsClipping);
                    DrawOfferName(g, ModelValue.Text(offer, "name"),
                        new Rectangle(cardX + S(3), y + layout.NameTop, Math.Max(1, layout.CellWidth - S(6)), layout.NameHeight));
                    Rectangle recordButton = new Rectangle(cardX + S(3), y + layout.ButtonTop,
                        Math.Max(1, layout.CellWidth - S(6)), layout.ButtonHeight);
                    PaintRecordButton(g, recordButton, previousRound ? "补记已选" : "确认", canConfirm && viewport.Contains(recordButton));
                    RegisterOfferHint(new Rectangle(cardX, y, layout.CellWidth, Math.Max(1, layout.ButtonTop - S(2))), displayOffer);
                    string offerId = ModelValue.Text(offer, "id");
                    // A partially visible button is not an action. This excludes
                    // the card's icon, name, rank and any clipped button edge.
                    if (canConfirm && viewport.Contains(recordButton) && offerId.Length > 0)
                    {
                        offerButtons[recordButton] = offerId;
                        if (activePendingId.Length > 0) offerPendingIds[recordButton] = activePendingId;
                    }
                    index++;
                }
                y += layout.CardHeight + S(14);
            }
            foreach (var pending in older)
            {
                string pendingId = ModelValue.Text(pending, "pendingId"), sequence = ModelValue.Text(pending, "sequence");
                Write(g, "上一轮待确认 · 第 " + sequence + " 轮", normalFont, accent, new Rectangle(x, y, width, S(23))); y += S(29);
                int index = 0;
                foreach (object item in ModelValue.Array(pending, "offers"))
                {
                    if (index++ >= 3) break;
                    var offer = item as Dictionary<string, object>;
                    int rowHeight = PendingOfferRowHeight(offer, width);
                    DrawAugmentIcon(g, offer, new Rectangle(x, y + S(2), S(27), S(27)));
                    TextRenderer.DrawText(g, ModelValue.Text(offer, "name"), offerNameFont,
                        new Rectangle(x + S(33), y + S(3), Math.Max(1, width - S(33) - PendingRecordButtonWidth - S(8)), rowHeight - S(6)), ForeColor,
                        OfferNameTextFlags | TextFormatFlags.Left | TextFormatFlags.Top
                        | TextFormatFlags.EndEllipsis | TextFormatFlags.PreserveGraphicsClipping);
                    Rectangle recordButton = new Rectangle(x + width - PendingRecordButtonWidth, y + (rowHeight - S(31)) / 2, PendingRecordButtonWidth, S(31));
                    PaintRecordButton(g, recordButton, "补记已选", canConfirm && viewport.Contains(recordButton));
                    RegisterOfferHint(new Rectangle(x, y, Math.Max(1, width - PendingRecordButtonWidth - S(4)), rowHeight), offer);
                    string id = ModelValue.Text(offer, "id");
                    if (canConfirm && viewport.Contains(recordButton) && pendingId.Length > 0 && id.Length > 0)
                        pendingOfferButtons[recordButton] = new KeyValuePair<string, string>(id, pendingId);
                    y += rowHeight + S(6);
                }
                y += S(8);
            }
        }
        private string OffersHeading()
        {
            foreach (object item in ModelValue.Array(Model, "pendingOffers"))
            {
                var group = item as Dictionary<string, object>;
                long sequence;
                if (ModelValue.Boolean(group, "active") && ModelValue.Boolean(group, "previousRound")
                    && ModelValue.Integer(group, "sequence", out sequence) && sequence > 0)
                    return "上一轮待确认 · 第 " + sequence + " 轮";
            }
            return "三选一海克斯";
        }
        private List<Dictionary<string, object>> OlderPendingOffers()
        {
            var result = new List<Dictionary<string, object>>();
            foreach (object item in ModelValue.Array(Model, "pendingOffers"))
            {
                var pending = item as Dictionary<string, object>;
                if (pending != null && !ModelValue.Boolean(pending, "active") && ModelValue.Text(pending, "pendingId").Length > 0)
                    result.Add(pending);
                if (result.Count == 5) break;
            }
            return result;
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
            return "等待三选一卡片";
        }
        private int EmptyOffersHeight(int width)
        {
            var ocr = ModelValue.Object(Model, "ocr");
            return NextItemTextHeight(RecognitionSummary(ocr), normalFont, width)
                + (RecognitionTime(ocr).Length > 0 ? S(22) : 0) + S(16);
        }
        private static string RecognitionTime(Dictionary<string, object> ocr)
        {
            DateTimeOffset observed;
            return DateTimeOffset.TryParse(ModelValue.Text(ocr, "observedAt"), CultureInfo.InvariantCulture, DateTimeStyles.None, out observed)
                ? "最近检查 · " + observed.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                : "";
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
        private void PaintRecordButton(Graphics graphics, Rectangle rectangle, string title, bool enabled)
        {
            using (var brush = new SolidBrush(Color.FromArgb(35, 56, 69))) graphics.FillRectangle(brush, rectangle);
            TextRenderer.DrawText(graphics, title, normalFont, rectangle, enabled ? ForeColor : muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix
                | TextFormatFlags.NoPadding | TextFormatFlags.PreserveGraphicsClipping);
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (IsIdleCollapsed) { consumeIdleClick = true; RevealFromIdle(); return; }
            // MouseEnter normally expands before MouseDown is delivered. Keep
            // that immediate click on the former strip from hitting a scrollbar
            // or another control now occupying the same screen coordinates.
            long sinceReveal = idleClock.ElapsedMilliseconds - idleRevealAt;
            if (idleRevealAt >= 0 && sinceReveal >= 0 && sinceReveal <= 250
                && idleRevealZone.Contains(PointToScreen(e.Location))) { consumeIdleClick = true; return; }
            idleState.Reveal(idleClock.ElapsedMilliseconds);
            if (e.Button == MouseButtons.Left) { pressedOfferId = null; pressedPendingId = null; pressedRecognition = false; }
            if (e.Button == MouseButtons.Left && (GetAsyncKeyState(0x11) & 0x8000) != 0)
            {
                BeginManualMove(Cursor.Position);
                if (dragging) { Capture = true; Cursor = Cursors.SizeAll; }
                return;
            }
            consumeDragClick = false;
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left)
            {
                pressedRecognition = recognitionButton.Contains(e.Location) && !RecognitionBusy;
                OfferAt(e.Location, out pressedOfferId, out pressedPendingId);
            }
        }
        private bool OfferAt(Point location, out string id, out string pendingId)
        {
            foreach (var entry in offerButtons)
                if (entry.Key.Contains(location))
                {
                    id = entry.Value; offerPendingIds.TryGetValue(entry.Key, out pendingId); return true;
                }
            foreach (var entry in pendingOfferButtons)
                if (entry.Key.Contains(location)) { id = entry.Value.Key; pendingId = entry.Value.Value; return true; }
            id = null; pendingId = null; return false;
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (IsIdleCollapsed) { RevealFromIdle(); return; }
            if (dragging)
            {
                if ((GetAsyncKeyState(0x11) & 0x8000) == 0 || (Control.MouseButtons & MouseButtons.Left) == 0) EndManualMove();
                else MoveManually(Cursor.Position);
                return;
            }
            UpdateHoverHint(e.Location);
            Cursor = (GetAsyncKeyState(0x11) & 0x8000) != 0 ? Cursors.SizeAll : Cursors.Default;
            base.OnMouseMove(e);
        }
        private void UpdateHoverHint(Point location)
        {
            string hint = "";
            bool isHelp = false;
            foreach (var target in helpTargets)
                if (target.Key.Contains(location)) { hint = target.Value; isHelp = true; break; }
            foreach (var target in augmentTargets)
            {
                if (isHelp) break;
                if (!target.Key.Contains(location)) continue;
                string name = ModelValue.Text(target.Value, "name"), reason = ModelValue.Text(target.Value, "reason");
                if (reason.Length == 0) reason = ModelValue.Text(target.Value, "summary");
                string rarity = ModelValue.Text(target.Value, "rarity");
                string quality = rarity == "silver" ? "白银" : rarity == "gold" ? "黄金" : rarity == "prismatic" ? "棱彩" : "品质待核实";
                hint = name + " · " + quality + (reason.Length > 0 ? "\n" + reason : "");
                break;
            }
            if (hint != activeAugmentHint)
            {
                augmentHint.Hide(this);
                activeAugmentHint = hint; augmentHint.SetToolTip(this, hint);
            }
            activeHintIsHelp = isHelp;
        }
        protected override void OnMouseLeave(EventArgs e)
        {
            HideHoverHint();
            base.OnMouseLeave(e);
        }
        protected override void OnMouseEnter(EventArgs e)
        {
            RevealFromIdle();
            base.OnMouseEnter(e);
        }
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (dragging && !Capture) EndManualMove();
            base.OnMouseCaptureChanged(e);
        }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (consumeIdleClick) { consumeIdleClick = false; idleRevealAt = -1; return; }
            bool recognize = pressedRecognition;
            pressedRecognition = false;
            string pressedId = pressedOfferId, pressedScope = pressedPendingId;
            if (e.Button == MouseButtons.Left) { pressedOfferId = null; pressedPendingId = null; }
            if (e.Button == MouseButtons.Left && (dragging || consumeDragClick))
            {
                EndManualMove(); consumeDragClick = false; Cursor = Cursors.Default;
                return;
            }
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            if (recognitionButton.Contains(e.Location))
            {
                if (recognize && !RecognitionBusy && RecognitionRequested != null) RecognitionRequested(this, EventArgs.Empty);
                return;
            }
            if (buildToggle.Contains(e.Location)) { buildExpanded = !buildExpanded; scrollOffset = 0; Invalidate(); return; }
            if (scrollTrack.Contains(e.Location))
            {
                if (!scrollThumb.Contains(e.Location)) ScrollTo(scrollOffset + (e.Y < scrollThumb.Top ? -1 : 1) * Math.Max(S(40), viewport.Height / 2));
                return;
            }
            string releasedId, releasedScope;
            if (OfferAt(e.Location, out releasedId, out releasedScope))
            {
                // A polling repaint/reroll while held must never retarget the
                // release to another pending round, including a shared ID.
                if (releasedId != pressedId || releasedScope != pressedScope) return;
                if (!string.IsNullOrEmpty(releasedScope) && PendingOfferConfirmed != null) PendingOfferConfirmed(releasedId, releasedScope);
                else if (OfferConfirmed != null) OfferConfirmed(releasedId);
                return;
            }
            if (hideButton.Contains(e.Location) && HideRequested != null) HideRequested(this, EventArgs.Empty);
            else if (detailsButton.Contains(e.Location) && DetailsRequested != null) DetailsRequested(this, EventArgs.Empty);
            else if (gameButton.Contains(e.Location) && GameRequested != null) GameRequested(this, EventArgs.Empty);
        }
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            if (IsIdleCollapsed) { RevealFromIdle(); return; }
            idleState.Reveal(idleClock.ElapsedMilliseconds);
            if (dragging) return;
            base.OnMouseWheel(e);
            ScrollTo(scrollOffset - Math.Sign(e.Delta) * S(52));
        }
        private void ScrollTo(int value)
        {
            scrollOffset = Math.Max(0, Math.Min(value, Math.Max(0, contentHeight - viewport.Height)));
            offerButtons.Clear();
            offerPendingIds.Clear(); pendingOfferButtons.Clear();
            pressedOfferId = null; pressedPendingId = null;
            ClearAugmentHint();
            Invalidate();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { idleTimer.Stop(); idleTimer.Dispose(); buildIcons.Dispose(); augmentHint.Dispose(); headingFont.Dispose(); normalFont.Dispose(); smallFont.Dispose(); decisionFont.Dispose(); offerNameFont.Dispose(); foreach (Image image in augmentIcons.Values) image.Dispose(); augmentIcons.Clear(); var shape = Region; Region = null; if (shape != null) shape.Dispose(); }
            base.Dispose(disposing);
        }
        private static Dictionary<string, object> CreateNextItemFixture()
        {
            string now = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            var selected = new object[] { new Dictionary<string, object> { { "id", "fixture-owned" }, { "name", "示例已选海克斯" }, { "rarity", "gold" } } };
            return new Dictionary<string, object> {
                { "connection", new Dictionary<string, object> { { "status", "connected" }, { "message", "离屏布局示例 · 未连接真实对局" } } },
                { "mode", new Dictionary<string, object> { { "known", true }, { "isMayhem", true } } },
                { "phase", "InProgress" }, { "stage", "live" }, { "championSource", "live-client" },
                { "gameId", "next-item-fixture" }, { "gameEpoch", 2 }, { "sessionRevision", 4 }, { "route", "auto" }, { "updatedAt", now },
                { "champion", new Dictionary<string, object> { { "id", "Ahri" }, { "name", "离屏示例英雄" } } },
                { "level", 13 }, { "owned", selected }, { "ocr", new Dictionary<string, object> { { "enabled", true } } },
                { "offers", new object[] {
                    new Dictionary<string, object> { { "id", "candidate-left" }, { "name", "大腕" }, { "rank", 2 }, { "rarity", "prismatic" }, { "reason", "该英雄持有胜率 99.9%；不能显示的统计说明" } },
                    new Dictionary<string, object> { { "id", "candidate-middle" }, { "name", "升级：贪欲九头蛇" }, { "rank", 1 }, { "rarity", "gold" } },
                    new Dictionary<string, object> { { "id", "candidate-right" }, { "name", "鼓声暴起 低音轰鸣" }, { "rank", 3 }, { "rarity", "gold" } }
                } },
                { "plan", new Dictionary<string, object> {
                    { "title", "不应显示的完整构筑" }, { "summary", "该区域仅保留在完整窗口" }, { "stage", "live" },
                    { "buildItems", new object[] { new Dictionary<string, object> { { "id", "wrong-fallback" }, { "name", "不能作为下一件的第一项" } } } },
                    { "nextAugments", new object[] { new Dictionary<string, object> { { "id", "hidden-future" }, { "name", "不应显示的后续海克斯" } } } }
                } },
                { "nextItem", new Dictionary<string, object> {
                    { "status", "ready" }, { "stage", "live" }, { "gameId", "next-item-fixture" }, { "gameEpoch", 2 }, { "sessionRevision", 4 },
                    { "championId", "Ahri" }, { "ownedIds", new object[] { "fixture-owned" } }, { "route", "auto" }, { "generatedAt", now },
                    { "item", new Dictionary<string, object> { { "id", "3135" }, { "name", "虚空之杖（离屏示例）" }, { "icon", "" }, { "effect", "提供法术强度与百分比法术穿透。" }, { "totalGold", 3000 } } },
                    { "reasons", new object[] { "敌方已有魔抗装备，百分比穿透更适合当前对局。", "延续已确认海克斯的法术伤害方向。" } },
                    { "reason", "" }, { "evidenceLabel", "" }, { "message", "" }
                } }
            };
        }
        private static int ValidateNextItemFixtures(string directory)
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool valid, string reason) { Require(valid, reason); checks++; };
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                var fixture = CreateNextItemFixture(); window.Model = fixture;
                using (var before = RenderFixture(window))
                {
                    check(window.paintedNextItemId == "3135" && window.paintedSections[0] == "nextItem", "Ready equipment was not visible by default.");
                    check(window.offerButtons.Count == 3 && window.pendingOfferButtons.Count == 0 && Rectangle.Empty.Equals(window.buildToggle), "Candidates were hidden or the full build regained a toggle.");
                    ModelValue.Object(fixture, "plan")["buildItems"] = new object[0];
                    foreach (object value in ModelValue.Array(fixture, "offers")) ((Dictionary<string, object>)value)["reason"] = "该英雄持有胜率 0.1%；不同的胜率参考";
                    window.Model = fixture;
                    using (var after = RenderFixture(window)) check(EqualFixturePixels(before, after), "Full-build items or candidate win-rate rows changed the sidebar.");
                    foreach (var target in window.augmentTargets)
                        check(!ModelValue.Text(target.Value, "reason").Contains("胜率"), "Candidate win rates leaked into icon tooltips.");
                    string selected = ""; window.OfferConfirmed += delegate(string id) { selected = id; };
                    foreach (var target in window.offerButtons)
                    {
                        Point center = new Point(target.Key.Left + target.Key.Width / 2, target.Key.Top + target.Key.Height / 2);
                        window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                        window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                        check(selected == target.Value, "A candidate card confirmed the wrong augment.");
                    }
                }
                var missing = CreateNextItemFixture(); missing.Remove("nextItem"); window.Model = missing;
                using (var bitmap = RenderFixture(window)) check(window.paintedNextItemId.Length == 0, "A legacy model fell back to buildItems[0].");
                var mutations = new Action<Dictionary<string, object>>[] {
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["ownedIds"] = new object[] { "other-owned" }; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["gameEpoch"] = 1; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["gameEpoch"] = "2"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["gameEpoch"] = 2.0; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["sessionRevision"] = 3; },
                    delegate(Dictionary<string, object> value) { value["sessionRevision"] = "4"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["gameId"] = "previous-game"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["championId"] = "Garen"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["route"] = "spell"; },
                    delegate(Dictionary<string, object> value) { value.Remove("route"); },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem").Remove("route"); },
                    delegate(Dictionary<string, object> value) { value["route"] = 1; ModelValue.Object(value, "nextItem")["route"] = 1; },
                    delegate(Dictionary<string, object> value) { value["route"] = ""; ModelValue.Object(value, "nextItem")["route"] = ""; },
                    delegate(Dictionary<string, object> value) { value["route"] = "unknown"; ModelValue.Object(value, "nextItem")["route"] = "unknown"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["generatedAt"] = DateTimeOffset.UtcNow.AddSeconds(-31).ToString("o"); },
                    delegate(Dictionary<string, object> value) { value["updatedAt"] = DateTimeOffset.UtcNow.AddSeconds(-31).ToString("o"); },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["generatedAt"] = DateTimeOffset.UtcNow.AddSeconds(10).ToString("o"); },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["generatedAt"] = "invalid-time"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["item"] = null; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["status"] = "unexpected"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["stage"] = "loading-preview"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem")["stage"] = "waiting"; },
                    delegate(Dictionary<string, object> value) { value["championSource"] = "champ-select"; },
                    delegate(Dictionary<string, object> value) { value["phase"] = "EndOfGame"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "mode")["known"] = false; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "mode")["known"] = "true"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "mode")["isMayhem"] = false; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "connection")["status"] = "waiting"; },
                    delegate(Dictionary<string, object> value) { value.Remove("owned"); },
                    delegate(Dictionary<string, object> value) { value["owned"] = "not-an-array"; },
                    delegate(Dictionary<string, object> value) { ModelValue.Object(value, "nextItem").Remove("ownedIds"); },
                    delegate(Dictionary<string, object> value) { value["owned"] = new object[] { new Dictionary<string, object> { { "id", "fixture-owned" } }, new Dictionary<string, object> { { "id", "fixture-owned" } } }; ModelValue.Object(value, "nextItem")["ownedIds"] = new object[] { "fixture-owned", "fixture-owned" }; }
                };
                for (int index = 0; index < mutations.Length; index++)
                {
                    var invalid = CreateNextItemFixture(); mutations[index](invalid); window.Model = invalid;
                    using (var bitmap = RenderFixture(window)) check(window.CurrentNextItem() == null && window.paintedNextItemId.Length == 0, "Invalid recommendation context was rendered: " + index);
                }
                var serializer = new JavaScriptSerializer();
                window.Model = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(CreateNextItemFixture()));
                using (var bitmap = RenderFixture(window)) check(window.paintedNextItemId == "3135", "HTTP JSON representation did not preserve the valid recommendation contract.");
                foreach (string route in new string[] { "auto", "attack", "spell", "tank", "support", "crit" })
                {
                    var value = CreateNextItemFixture(); value["route"] = route; ModelValue.Object(value, "nextItem")["route"] = route;
                    window.Model = value;
                    check(window.CurrentNextItem() != null, "A supported matching route was rejected: " + route);
                }
                foreach (string status in new string[] { "waiting", "stale", "complete", "inventory-full" })
                {
                    var value = CreateNextItemFixture(); ModelValue.Object(value, "nextItem")["status"] = status; window.Model = value;
                    using (var bitmap = RenderFixture(window)) check(window.paintedNextItemId.Length == 0 && window.nextItemTextAreas.Count == 1, "A non-ready recommendation displayed a supplied item: " + status);
                }
                foreach (string status in new string[] { "waiting", "stale" })
                {
                    var value = CreateNextItemFixture();
                    var recommendation = ModelValue.Object(value, "nextItem");
                    recommendation["status"] = status; recommendation["stage"] = "waiting";
                    recommendation["message"] = status == "stale" ? "实时数据已过期，等待本局重新读取。" : "等待当前阶段的有效对局资料。";
                    if (status == "stale") value["updatedAt"] = DateTimeOffset.UtcNow.AddSeconds(-15).ToString("o");
                    window.Model = value;
                    using (var bitmap = RenderFixture(window))
                        check(window.CurrentNextItem() != null && window.NextItemMessage(window.CurrentNextItem()) == ModelValue.Text(recommendation, "message") && window.paintedNextItemId.Length == 0,
                            "The real waiting-stage contract lost its message or displayed equipment: " + status);
                    foreach (string key in new string[] { "gameId", "gameEpoch", "sessionRevision", "championId", "ownedIds", "route" })
                    {
                        var mismatched = new Dictionary<string, object>(recommendation);
                        mismatched[key] = key == "gameEpoch" || key == "sessionRevision" ? (object)0 : key == "ownedIds" ? (object)new object[0] : "other-context";
                        value["nextItem"] = mismatched; window.Model = value;
                        using (var bitmap = RenderFixture(window))
                            check(window.CurrentNextItem() == null && window.NextItemMessage(window.CurrentNextItem()) != ModelValue.Text(recommendation, "message") && window.paintedNextItemId.Length == 0,
                                "A waiting message crossed its identity boundary: " + status + "/" + key);
                    }
                    value["nextItem"] = recommendation;
                    recommendation["generatedAt"] = DateTimeOffset.UtcNow.AddSeconds(-31).ToString("o"); window.Model = value;
                    check(window.CurrentNextItem() == null, "An old generated waiting result was accepted: " + status);
                }
                foreach (string stage in new string[] { "live", "loading" })
                {
                    var value = CreateNextItemFixture(); value["stage"] = stage;
                    var recommendation = ModelValue.Object(value, "nextItem");
                    recommendation["status"] = "waiting"; recommendation["stage"] = stage == "loading" ? "loading-preview" : "live";
                    recommendation["message"] = "等待可核验的普通 ARAM／召唤师峡谷核心装备顺序，再给出下一件成装。";
                    window.Model = value;
                    using (var bitmap = RenderFixture(window))
                        check(window.NextItemMessage(window.CurrentNextItem()) == ModelValue.Text(recommendation, "message") && window.paintedNextItemId.Length == 0,
                            "Order-data waiting lost its current stage explanation: " + stage);
                }
                var expired = CreateNextItemFixture();
                var expiredRecommendation = ModelValue.Object(expired, "nextItem");
                expiredRecommendation["status"] = "stale"; expiredRecommendation["stage"] = "waiting"; expiredRecommendation["message"] = "实时数据已过期，等待本局重新读取。";
                expired["updatedAt"] = DateTimeOffset.UtcNow.AddSeconds(-60).ToString("o"); window.Model = expired;
                check(window.NextItemMessage(window.CurrentNextItem()) == ModelValue.Text(expiredRecommendation, "message"), "A current stale result lost its explanation because its input was expired.");
                expired["updatedAt"] = "invalid-time"; window.Model = expired;
                check(window.CurrentNextItem() == null, "A stale status bypassed malformed input time validation.");
                foreach (string status in new string[] { "complete", "inventory-full" })
                {
                    var value = CreateNextItemFixture(); var recommendation = ModelValue.Object(value, "nextItem"); recommendation["status"] = status;
                    recommendation["message"] = status == "complete" ? "已持有所发布样本中的可继续装备，等待新的已选或装备资料。" : "装备槽已满；当前没有可用已有组件直接推进的成装。";
                    window.Model = value;
                    check(window.NextItemMessage(window.CurrentNextItem()) == ModelValue.Text(recommendation, "message"), "A qualified result explanation was replaced: " + status);
                    if (status == "complete")
                    {
                        recommendation["message"] = ""; window.Model = value;
                        check(!window.NextItemMessage(window.CurrentNextItem()).Contains("构筑已完成"), "The complete fallback claimed a full build without evidence.");
                    }
                }
                window.Model = CreateNextItemFixture(); window.Model = ModelValue.Failure("隔离示例连接中断");
                using (var bitmap = RenderFixture(window)) check(window.paintedNextItemId.Length == 0, "Transport failure retained a live recommendation.");
            }
            foreach (int width in new int[] { 280, 324, 460 }) foreach (int scale in new int[] { 85, 100, 130 })
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false; window.ApplyAppearance(new SidebarAppearance { Width = width, Scale = scale, Sections = new string[] { "offers", "owned", "plan", "hero" } });
                window.Place(new Rectangle(0, 0, 1200, 900)); window.Model = CreateNextItemFixture();
                using (var bitmap = RenderFixture(window))
                {
                    bitmap.Save(Path.Combine(directory, "sidebar-next-item-" + width + "-" + scale + ".png"), System.Drawing.Imaging.ImageFormat.Png);
                    check(window.paintedNextItemId == "3135" && string.Join(",", window.paintedSections.ToArray()) == "nextItem,offers,owned,hero", "Next item and candidates did not share the supported layout.");
                    foreach (Rectangle area in window.nextItemTextAreas) check(FixtureContains(window.viewport, area), "Next-item text was clipped at width " + width + " / scale " + scale);
                    check(Rectangle.Empty.Equals(window.buildToggle) && window.offerButtons.Count == 3 && window.pendingOfferButtons.Count == 0, "Candidate confirmations disappeared at a supported size.");
                    check(!window.Visible && window.ShowWithoutActivation, "A next-item fixture activated a window.");
                }
                var questRecommendation = ModelValue.Object(window.Model, "nextItem");
                questRecommendation["reasons"] = new object[] {
                    "先完成已选任务缺少的前置成装。",
                    "贪欲九头蛇（已有） + 亵渎九头蛇 + 巨型九头蛇 → 终极九头蛇。逐件完成缺少的前置成装。"
                };
                using (var bitmap = RenderFixture(window))
                {
                    bitmap.Save(Path.Combine(directory, "sidebar-quest-route-" + width + "-" + scale + ".png"), System.Drawing.Imaging.ImageFormat.Png);
                    foreach (Rectangle area in window.nextItemTextAreas) check(FixtureContains(window.viewport, area), "Quest route text was clipped at width " + width + " / scale " + scale);
                    check(window.paintedNextItemId == "3135" && window.offerButtons.Count == 3, "Quest guidance changed the item or candidate controls.");
                }
            }
            return checks;
        }
        private static int ValidateHelpFixtures(string directory)
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message) { Require(condition, message); checks++; };
            foreach (int width in new int[] { 280, 324, 460 })
            foreach (int scale in new int[] { 85, 100, 130 })
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                window.ApplyAppearance(new SidebarAppearance { Width = width, Scale = scale });
                window.Place(new Rectangle(0, 0, 1200, 900));
                var waiting = ModelValue.Failure("等待英雄联盟客户端或对局；本机尚未读取到游戏数据。");
                waiting["ocr"] = new Dictionary<string, object> { { "enabled", true }, { "status", "waiting" } };
                window.Model = waiting;
                using (var bitmap = RenderFixture(window)) bitmap.Save(Path.Combine(directory, "sidebar-help-waiting-" + width + "-" + scale + ".png"), System.Drawing.Imaging.ImageFormat.Png);
                check(window.helpTargets.Count == 5, "A waiting section lost its help icon at " + width + "/" + scale);
                check(window.contentHeight <= window.viewport.Height, "Compact empty sections require unnecessary scrolling.");
                int actions = 0;
                window.OfferConfirmed += delegate { actions++; };
                window.PendingOfferConfirmed += delegate { actions++; };
                window.HideRequested += delegate { actions++; };
                window.DetailsRequested += delegate { actions++; };
                window.GameRequested += delegate { actions++; };
                foreach (var target in window.helpTargets)
                {
                    check(window.ClientRectangle.Contains(target.Key) && (target.Value == window.SidebarHelp || window.viewport.Contains(target.Key)), "Help escaped the visible heading.");
                    RectangleF circle = window.HelpCircleBounds(target.Key);
                    check(target.Key.Width == window.S(20) && target.Key.Height == window.S(20)
                        && circle.Width == window.S(14) && circle.Height == window.S(14), "Help refinement changed its hover target or lost its compact circle.");
                    using (var glyph = window.CreateHelpGlyph(circle))
                    {
                        RectangleF ink = glyph.GetBounds();
                        check(circle.Contains(ink) && Math.Abs(ink.Left + ink.Width / 2F - circle.Left - circle.Width / 2F) < 0.01F
                            && Math.Abs(ink.Top + ink.Height / 2F - circle.Top - circle.Height / 2F) < 0.01F,
                            "Help question glyph is clipped or not centered in its circle.");
                    }
                    var pointer = new Point(target.Key.Left + target.Key.Width / 2, target.Key.Top + target.Key.Height / 2);
                    window.OnMouseMove(new MouseEventArgs(MouseButtons.None, 0, pointer.X, pointer.Y, 0));
                    check(window.activeAugmentHint == target.Value && window.augmentHint.GetToolTip(window) == target.Value, "Hover did not bind the heading explanation.");
                    window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, pointer.X, pointer.Y, 0));
                    check(actions == 0, "Help triggered a sidebar command or selection.");
                }
                window.OnMouseLeave(EventArgs.Empty);
                check(window.activeAugmentHint.Length == 0 && window.augmentHint.GetToolTip(window).Length == 0, "Help remained after the pointer left.");
                Rectangle nextHelp = Rectangle.Empty;
                foreach (var target in window.helpTargets) if (target.Value == NextItemHelp) nextHelp = target.Key;
                var nextPointer = new Point(nextHelp.Left + 2, nextHelp.Top + 2);
                window.UpdateHoverHint(nextPointer);
                window.Model = new Dictionary<string, object>(waiting);
                check(window.activeAugmentHint == NextItemHelp && window.helpTargets.Count == 0, "Polling interrupted unchanged help or retained old hit regions.");
                using (var bitmap = RenderFixture(window)) { }
                window.UpdateHoverHint(nextPointer);
                check(window.activeAugmentHint == NextItemHelp, "Stationary hover was lost after repaint.");
                window.ScrollTo(0);
                check(window.activeAugmentHint.Length == 0 && window.helpTargets.Count == 0, "Scroll retained a stale help region.");
                using (var bitmap = RenderFixture(window)) { }
                window.UpdateHoverHint(nextPointer);
                window.BeginManualMove(new Point(100, 100));
                check(window.activeAugmentHint.Length == 0 && window.helpTargets.Count == 0, "Dragging retained help.");
                window.EndManualMove();
                window.Model = CreateNextItemFixture();
                using (var bitmap = RenderFixture(window)) { }
                check(window.offerButtons.Count == 3 && window.paintedNextItemId == "3135", "Help layout displaced recommendation or candidate confirmation.");
                foreach (var target in window.helpTargets)
                    foreach (var offer in window.offerButtons) check(!target.Key.IntersectsWith(offer.Key), "A help icon overlaps a candidate action.");
                foreach (var target in window.augmentTargets)
                {
                    window.UpdateHoverHint(new Point(target.Key.Left + 2, target.Key.Top + 2));
                    check(window.activeAugmentHint.Contains(ModelValue.Text(target.Value, "name")) && !window.activeHintIsHelp, "Existing augment hover was replaced by heading help.");
                    break;
                }
                window.Model = waiting;
                using (var bitmap = RenderFixture(window)) { }
                window.UpdateHoverHint(nextPointer);
                window.Height -= 20;
                check(window.activeAugmentHint.Length == 0 && window.helpTargets.Count == 0, "Resize retained help with stale geometry.");
                using (var bitmap = RenderFixture(window)) { }
                window.UpdateHoverHint(nextPointer);
                window.OnVisibleChanged(EventArgs.Empty);
                check(window.activeAugmentHint.Length == 0 && window.helpTargets.Count == 0, "Hidden sidebar retained its tooltip.");
                var loading = new Dictionary<string, object>(waiting); loading["stage"] = "loading";
                window.Model = loading;
                using (var bitmap = RenderFixture(window)) { }
                check(window.helpTargets.Count == 3 && !window.helpTargets.ContainsValue(OffersHelp) && !window.helpTargets.ContainsValue(OwnedHelp), "Loading retained absent-section help.");
                window.Model = new Dictionary<string, object> { { "connection", new Dictionary<string, object> { { "status", "error" }, { "message", "无法确认当前玩家" } } } };
                check(window.HeroStatus() == "无法确认当前玩家", "An actionable connection error was hidden in help.");
                window.Model = ModelValue.Failure("本地连接已停止。请关闭窗口后重新打开软件。");
                check(window.HeroStatus() == "本地连接已停止。请关闭窗口后重新打开软件。", "A local startup failure was reduced to generic waiting copy.");
                check(!window.Visible && window.ShowWithoutActivation && !window.TopMost, "Hover validation activated a sidebar window.");
            }
            return checks;
        }
        private static int ValidateManualRecognitionFixtures(string directory)
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message) { Require(condition, message); checks++; };
            foreach (int width in new int[] { 280, 324, 460 })
            foreach (int scale in new int[] { 85, 100, 130 })
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                window.ApplyAppearance(new SidebarAppearance { Width = width, Scale = scale });
                window.Place(new Rectangle(0, 0, 1200, 900));
                window.Model = CreateNextItemFixture();
                using (var bitmap = RenderFixture(window)) { }
                check(window.ClientRectangle.Contains(window.recognitionButton) && !window.recognitionButton.IntersectsWith(window.viewport), "Recognition button overlaps scroll content.");
                int requests = 0, selections = 0;
                window.RecognitionRequested += delegate { requests++; };
                window.OfferConfirmed += delegate { selections++; };
                Point center = new Point(window.recognitionButton.Left + window.recognitionButton.Width / 2, window.recognitionButton.Top + window.recognitionButton.Height / 2);
                window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                check(requests == 0, "A release without a press started recognition.");
                window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                check(requests == 1 && selections == 0, "Recognition triggered a selection or did not trigger once.");
                window.RecognitionRequestBusy = true;
                window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                check(requests == 1, "Recognition allowed a duplicate local request.");
                window.RecognitionRequestBusy = false;
                window.Model["manualRecognition"] = new Dictionary<string, object> { { "active", true }, { "message", "正在核对六格栏，请保持展开…" } };
                window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                check(requests == 1, "Another UI request did not disable duplicate recognition.");
                using (var bitmap = RenderFixture(window))
                    if (width == 324 && scale == 100) bitmap.Save(Path.Combine(directory, "sidebar-manual-recognition.png"), System.Drawing.Imaging.ImageFormat.Png);
                check(window.paintedNextItemId == "3135" && !window.Visible, "Recognition changed the next-item decision or activated the window.");
                window.RecognitionRequestNotice = "旧请求未识别到";
                var nextRequest = CreateNextItemFixture();
                nextRequest["manualRecognition"] = new Dictionary<string, object> { { "requestId", 2L }, { "active", true }, { "message", "新请求正在核对" } };
                window.Model = nextRequest;
                check(window.RecognitionMessage == "新请求正在核对", "A local result hid a later request started in the full app.");
                var finished = new Dictionary<string, object>(nextRequest);
                finished["manualRecognition"] = new Dictionary<string, object> { { "requestId", 2L }, { "active", false }, { "message", "新请求已结束" } };
                window.Model = finished;
                window.Model = nextRequest;
                check(!window.RecognitionBusy && window.RecognitionMessage == "新请求已结束", "An older poll restored a completed request to busy.");
                window.RecognitionRequestNotice = "上一局已记录";
                var reset = CreateNextItemFixture();
                reset["gameEpoch"] = 3;
                reset["manualRecognition"] = new Dictionary<string, object> { { "requestId", 2L }, { "active", false }, { "status", "idle" }, { "message", "" } };
                window.Model = reset;
                check(window.RecognitionMessage.Length == 0, "A same-ID game epoch retained the previous manual result.");
            }
            return checks;
        }
        private static int ValidateIdlePresentationFixtures(string directory)
        {
            int checks = SidebarIdleState.ValidateFixtures();
            Action<bool, string> check = delegate(bool condition, string message) { Require(condition, message); checks++; };
            foreach (string side in new[] { "left", "right" }) using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                window.ApplyAppearance(new SidebarAppearance { Side = side, Opacity = 75, IdleHideSeconds = 30 });
                window.Model = CreateNextItemFixture(); window.Place(new Rectangle(0, 0, 1280, 720));
                Rectangle expanded = window.Bounds;
                using (var full = RenderFixture(window))
                {
                    check(!window.idleState.Observe(0, true, false, false, false), "Idle fixture collapsed immediately.");
                    check(!window.idleState.Observe(29999, true, false, false, false), "Idle fixture collapsed before thirty seconds.");
                    window.SetIdlePresentation(window.idleState.Observe(30000, true, false, false, false), 30000, false);
                    int expectedEdge = (int)Math.Round(SidebarIdleGeometry.EdgeWidthDip * Math.Max(96, window.DeviceDpi) / 96.0);
                    check(window.idleCompact && window.Width == expectedEdge && window.Height == expanded.Height, "Idle edge did not respect display scaling.");
                    check(Math.Abs(window.Opacity - 0.75 * 0.55) < 0.002, "Idle opacity ignored the saved opacity.");
                    check(side == "left" ? window.Left == 0 : window.Right == 1280, "Idle edge did not follow the configured side.");
                    using (var strip = RenderFixture(window))
                    using (var comparison = new Bitmap(full.Width + 55 + strip.Width, full.Height))
                    using (var graphics = Graphics.FromImage(comparison))
                    {
                        graphics.Clear(Color.FromArgb(35, 43, 54)); graphics.DrawImageUnscaled(full, 0, 0); graphics.DrawImageUnscaled(strip, full.Width + 55, 0);
                        comparison.Save(Path.Combine(directory, "sidebar-idle-" + side + ".png"), System.Drawing.Imaging.ImageFormat.Png);
                    }
                    check(window.offerButtons.Count == 0 && window.pendingOfferButtons.Count == 0 && window.recognitionButton.IsEmpty
                        && window.hideButton.IsEmpty && window.helpTargets.Count == 0, "Collapsed strip retained clickable full-panel controls.");
                    Rectangle compact = window.Bounds;
                    window.Model = CreateNextItemFixture(); window.Place(new Rectangle(0, 0, 1280, 720));
                    check(window.Bounds == compact && window.idleCompact, "Normal model or placement polling expanded the idle strip.");
                    window.SetIdlePresentation(window.idleState.Observe(30001, true, true, false, false), 30001, false);
                    check(window.Bounds == expanded && !window.IsIdleCollapsed && Math.Abs(window.Opacity - .75) < .002, "Hover did not restore the full position and opacity.");
                    using (var restored = RenderFixture(window)) check(window.offerButtons.Count == 3, "Restored cards lost their hit targets.");
                    window.customPosition = true; window.horizontalPosition = .7; window.verticalPosition = .2;
                    window.Place(new Rectangle(0, 0, 1280, 720)); Rectangle custom = window.Bounds;
                    window.SetIdlePresentation(true, 60002, false); window.SetIdlePresentation(false, 60003, false);
                    check(window.Bounds == custom && window.customPosition && window.horizontalPosition == .7, "Idle compaction erased the custom expanded placement.");
                    int actions = 0; window.HideRequested += delegate { actions++; }; window.RecognitionRequested += delegate { actions++; };
                    window.OfferConfirmed += delegate { actions++; };
                    window.SetIdlePresentation(true, 90003, false);
                    window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, 4, 100, 0));
                    window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, 4, 100, 0));
                    check(actions == 0 && !window.IsIdleCollapsed, "Reveal click activated an unrelated full-panel action.");
                    window.idleRevealAt = -1;
                    window.SetIdlePresentation(true, 120000, true);
                    check(window.idleAnimating && !window.idleCompact && window.Bounds == custom, "Fade start prematurely changed the expanded layout.");
                    window.AdvanceIdleAnimation(120090);
                    check(window.Opacity > .75 * .55 && window.Opacity < .75, "Fade did not interpolate the configured opacity.");
                    window.SetIdlePresentation(true, 120100, true);
                    check(window.idleAnimationStart == 120000, "Repeated polling restarted the same fade.");
                    window.SetIdlePresentation(false, 120100, true); window.AdvanceIdleAnimation(120280);
                    check(!window.idleAnimating && !window.idleCompact && window.Bounds == custom && Math.Abs(window.Opacity - .75) < .002,
                        "Interrupted fade did not restore the original window.");
                    window.SetIdlePresentation(true, 150000, true); window.AdvanceIdleAnimation(150180);
                    check(window.idleCompact && !window.idleAnimating, "Completed fade did not leave the narrow strip.");
                    window.SetIdlePresentation(false, 150181, false);
                    check(!window.idleCompact && !window.idleAnimating && window.Bounds == custom, "Reduced-motion restoration animated or lost position.");
                    foreach (bool recognize in new[] { false, true })
                    {
                        window.SetIdlePresentation(true, 180000, false);
                        window.SetIdlePresentation(false, 180001, true);
                        using (var restored = RenderFixture(window)) { }
                        Rectangle target = window.recognitionButton;
                        if (!recognize) foreach (var entry in window.offerButtons) { target = entry.Key; break; }
                        Point point = new Point(target.Left + target.Width / 2, target.Top + target.Height / 2);
                        window.idleRevealAt = -1;
                        int before = actions;
                        window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, point.X, point.Y, 0));
                        check(window.idleAnimating && (recognize ? window.pressedRecognition : window.pressedOfferId != null), "A restored control could not be pressed during fade-in.");
                        window.AdvanceIdleAnimation(180181);
                        window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, point.X, point.Y, 0));
                        check(actions == before + 1, "Completing fade-in lost a valid card or recognition press.");
                    }
                    check(!window.Visible && window.ShowWithoutActivation && !window.TopMost, "Idle fixtures activated a window.");
                }
            }
            using (var configured = new SidebarWindow())
            {
                configured.remoteIcons = false;
                foreach (int seconds in new[] { 5, 300, 10 })
                {
                    var settingsModel = CreateNextItemFixture();
                    settingsModel["appearance"] = new Dictionary<string, object> { { "sidebar", new Dictionary<string, object> { { "idleHideSeconds", seconds } } } };
                    configured.Model = settingsModel;
                    check(configured.appearance.IdleHideSeconds == seconds && configured.idleState.DelayMilliseconds == seconds * 1000L,
                        "A saved wait time did not reach the native idle timer.");
                    check(configured.SidebarHelp.Contains("离开" + seconds + "秒"), "Sidebar help retained the previous wait time.");
                    configured.idleState.Reset(1000000);
                    configured.idleState.Observe(1000000, true, false, false, false);
                    check(configured.idleState.Observe(1000000 + seconds * 1000L, true, false, false, false), "Configured native timer did not reach its deadline.");
                    configured.Model = settingsModel;
                    check(configured.idleState.Collapsed, "Repeated settings polling reset the native timer.");
                }
                var legacy = CreateNextItemFixture();
                legacy["appearance"] = new Dictionary<string, object> { { "sidebar", new Dictionary<string, object> { { "opacity", 85 } } } };
                configured.Model = legacy;
                check(configured.appearance.IdleHideSeconds == 10 && configured.appearance.Opacity == 85, "Legacy settings lost the default delay or another preference.");
                foreach (object invalid in new object[] { 4, 301, 10.5, "NaN", null })
                {
                    ModelValue.Object(ModelValue.Object(legacy, "appearance"), "sidebar")["idleHideSeconds"] = invalid;
                    check(SidebarAppearance.FromModel(legacy).IdleHideSeconds == 10, "Invalid native timeout bypassed its fallback.");
                }
            }
            DateTime now = DateTime.UtcNow;
            var model = CreateNextItemFixture();
            check(SidebarOfferAttention.RemainingMilliseconds(model, now) == 0, "Stored candidates incorrectly held attention.");
            model["offerAttention"] = new Dictionary<string, object> { { "active", true }, { "pendingId", "current-round" },
                { "capturedAt", now.ToString("o") }, { "expiresAt", now.AddSeconds(8).ToString("o") } };
            check(SidebarOfferAttention.RemainingMilliseconds(model, now) == 8000, "Fresh current-card attention was ignored.");
            model["life"] = new Dictionary<string, object> { { "status", "detected" }, { "isDead", true } };
            check(SidebarOfferAttention.RemainingMilliseconds(model, now.AddSeconds(3)) == 5000, "Death blocked fresh card attention or polling renewed it.");
            check(SidebarOfferAttention.RemainingMilliseconds(model, now.AddSeconds(8)) == 0, "Expired attention reopened the sidebar.");
            check(SidebarOfferAttention.RemainingMilliseconds(model, now.AddSeconds(-2)) == 0, "Future attention reopened the sidebar.");
            model["stage"] = "loading"; check(SidebarOfferAttention.RemainingMilliseconds(model, now) == 0, "Loading reused live-card attention.");
            model["stage"] = "live"; ModelValue.Object(model, "connection")["status"] = "waiting";
            check(SidebarOfferAttention.RemainingMilliseconds(model, now) == 0, "Connection failure reused live-card attention.");
            return checks;
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
                window.Model = CreateNextItemFixture();
                using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png); }
                if (window.Visible) throw new InvalidOperationException("Off-screen test unexpectedly displayed a window.");
                int passiveActivationChecks = ValidatePassiveActivationFixtures(window);
                int idleHideChecks = ValidateIdlePresentationFixtures(Path.GetDirectoryName(previewPath));
                int nextItemChecks = ValidateNextItemFixtures(Path.GetDirectoryName(previewPath));
                int helpChecks = ValidateHelpFixtures(Path.GetDirectoryName(previewPath)) + ValidateManualRecognitionFixtures(Path.GetDirectoryName(previewPath));
                window.ExpandBuild();
                string buildPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-build.png");
                using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(buildPreviewPath, System.Drawing.Imaging.ImageFormat.Png); }
                Rectangle buildViewport = window.viewport;
                Require(window.paintedSections[0] == "nextItem" && window.paintedNextItemId == "3135" && Rectangle.Empty.Equals(window.buildToggle), "Next equipment must be visible without a build toggle.");
                Require(!window.Visible && window.ShowWithoutActivation, "Expanded build unexpectedly activated a window.");
                window.buildExpanded = false; window.scrollOffset = 0;
                string statusPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-recognition-status.png");
                int liveStateChecks = ValidateLiveStateFixtures(window, statusPreviewPath);
                string pendingPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-pending.png");
                int pendingOfferChecks = ValidatePendingOfferFixtures(pendingPreviewPath)
                    + ValidateOfferPresentationFixtures(Path.GetDirectoryName(previewPath));
                string loadingPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-loading.png");
                int loadingPreviewChecks = ValidateLoadingPreviewFixtures(window, loadingPreviewPath);
                int buildStatisticsChecks = ValidateBuildStatisticsFixtures(window);
                string earlyLivePreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-early-live.png");
                int initialPlanChecks = ValidateInitialPlanFixtures(window, earlyLivePreviewPath);
                int visibilityChecks = SidebarVisibilityState.ValidateFixtures();
                visibilityChecks += SidebarVisibilityDelay.ValidateFixtures();
                visibilityChecks += OverlayVisibilityCompatibility.ValidateFixtures();
                int shortcutChecks = SidebarShortcut.ValidateFixtures();
                int selectionChecks = ScreenSelectionWatcher.ValidateFixtures();
                selectionChecks += MainWindow.ValidateSelectionDiagnosticFixtures();
                string iconPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-augment-icons.png");
                int augmentIconChecks = ValidateAugmentIconFixtures(iconPreviewPath);
                int defaultWidth = window.Width, defaultHeight = window.Height;
                int appearanceChecks = ValidateAppearanceFixtures(window);
                int nativeChromeChecks = MainWindowChrome.ValidateFixtures() + DesktopTitleBar.ValidateFixtures();
                string placementPreviewPath;
                int positionChecks = ValidatePositionFixtures(Path.GetDirectoryName(previewPath), out placementPreviewPath);
                string customPreviewPath = Path.Combine(Path.GetDirectoryName(previewPath), Path.GetFileNameWithoutExtension(previewPath) + "-custom.png");
                using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(customPreviewPath, System.Drawing.Imaging.ImageFormat.Png); }
                return new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "checks", 10 + idleHideChecks + nextItemChecks + helpChecks + GameWindow.ValidateFixtures() + appearanceChecks + positionChecks + liveStateChecks + pendingOfferChecks + loadingPreviewChecks + buildStatisticsChecks + visibilityChecks + initialPlanChecks + shortcutChecks + augmentIconChecks + passiveActivationChecks + selectionChecks + nativeChromeChecks }, { "nativeChromeChecks", nativeChromeChecks }, { "selectionChecks", selectionChecks }, { "idleHideChecks", idleHideChecks }, { "helpChecks", helpChecks }, { "nextItemChecks", nextItemChecks }, { "pendingOfferChecks", pendingOfferChecks }, { "pendingPreviewPath", pendingPreviewPath }, { "passiveActivationChecks", passiveActivationChecks }, { "augmentIconChecks", augmentIconChecks }, { "shortcutChecks", shortcutChecks }, { "appearanceChecks", appearanceChecks }, { "positionChecks", positionChecks }, { "liveStateChecks", liveStateChecks }, { "loadingPreviewChecks", loadingPreviewChecks }, { "buildStatisticsChecks", buildStatisticsChecks }, { "initialPlanChecks", initialPlanChecks }, { "visibilityChecks", visibilityChecks }, { "width", defaultWidth }, { "height", defaultHeight }, { "previewPath", previewPath }, { "customPreviewPath", customPreviewPath }, { "buildPreviewPath", buildPreviewPath }, { "placementPreviewPath", placementPreviewPath }, { "statusPreviewPath", statusPreviewPath }, { "loadingPreviewPath", loadingPreviewPath }, { "earlyLivePreviewPath", earlyLivePreviewPath }, { "iconPreviewPath", iconPreviewPath } });
            }
        }
        private static int ValidateOfferPresentationFixtures(string directory)
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message) { Require(condition, message); checks++; };
            check(OfferRankLabel("1") == "首选" && OfferRankLabel("2") == "推荐 2"
                && OfferRankLabel("3") == "推荐 3" && OfferRankLabel("") == "", "Recommendation labels are ambiguous or invent a rank.");
            foreach (int width in new int[] { 280, 324, 460 })
            foreach (int scale in new int[] { 85, 100, 103, 130 })
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                window.ApplyAppearance(new SidebarAppearance { Width = width, Scale = scale, FontFamily = "yahei", Side = "right" });
                window.Place(new Rectangle(0, 0, 1200, 900));
                var fixture = CreateNextItemFixture(); window.Model = fixture;
                int recorded = 0; string selected = "";
                window.OfferConfirmed += delegate(string id) { recorded++; selected = id; };
                using (var bitmap = RenderFixture(window))
                {
                    if (width == 324 && scale == 103) bitmap.Save(Path.Combine(directory, "sidebar-recording-324-103.png"), System.Drawing.Imaging.ImageFormat.Png);
                    Rectangle presentationViewport = window.viewport;
                    check(Math.Abs(window.offerNameFont.SizeInPoints - 9.5F * scale / 100F) < 0.01
                        && window.decisionFont.Size > window.headingFont.Size, "Decision typography lost its readable role or the user's scale.");
                    var buttons = new List<KeyValuePair<Rectangle, string>>(window.offerButtons);
                    buttons.Sort(delegate(KeyValuePair<Rectangle, string> first, KeyValuePair<Rectangle, string> second) { return first.Key.Left.CompareTo(second.Key.Left); });
                    check(buttons.Count == 3, "The visible candidate row lost record buttons at " + width + "/" + scale);
                    ArrayList offers = ModelValue.Array(fixture, "offers");
                    for (int index = 0; index < buttons.Count; index++)
                    {
                        var button = buttons[index]; var offer = offers[index] as Dictionary<string, object>;
                        check(button.Value == ModelValue.Text(offer, "id") && presentationViewport.Contains(button.Key)
                            && button.Key.Height == window.S(27), "Recommendation ranking reordered a game position or enlarged its action area.");
                        Point body = new Point(button.Key.Left + button.Key.Width / 2, button.Key.Top - window.S(12));
                        int before = recorded;
                        window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, body.X, body.Y, 0));
                        window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, body.X, body.Y, 0));
                        check(recorded == before, "Candidate information recorded a choice without its explicit button.");
                        window.UpdateHoverHint(body);
                        check(window.activeAugmentHint.Contains(ModelValue.Text(offer, "name")), "The readable card body lost its full-name tooltip.");
                        var center = new Point(button.Key.Left + button.Key.Width / 2, button.Key.Top + button.Key.Height / 2);
                        window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                        window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                        check(recorded == before + 1 && selected == button.Value, "Explicit recording failed or targeted the wrong game position.");
                    }
                    // Clip exactly one pixel from the bottom of the button row.
                    // Visible fragments must not remain active hit targets.
                    Rectangle firstButton = buttons[0].Key;
                    int originalHeight = window.Height;
                    window.Height = firstButton.Bottom + window.S(82) - 1;
                    using (var clipped = RenderFixture(window))
                        check(window.offerButtons.Count == 0, "A bottom-clipped record button remained clickable.");
                    int beforeClippedClick = recorded;
                    Point fragment = new Point(firstButton.Left + firstButton.Width / 2, firstButton.Top + 1);
                    window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, fragment.X, fragment.Y, 0));
                    window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, fragment.X, fragment.Y, 0));
                    check(recorded == beforeClippedClick, "A clipped record-button fragment recorded a choice.");
                    window.Height = originalHeight;
                }
                var longNameOffer = ModelValue.Array(fixture, "offers")[1] as Dictionary<string, object>;
                longNameOffer["name"] = "升级：需要完整核对的超长海克斯名称与特殊效果";
                window.Model = fixture; window.ScrollTo(0);
                using (var bitmap = RenderFixture(window))
                {
                    Rectangle longNameViewport = window.viewport;
                    OfferCardLayout layout = window.CreateOfferCardLayout(longNameViewport.Width);
                    int lineHeight = TextRenderer.MeasureText("中", window.offerNameFont, Size.Empty,
                        TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix).Height;
                    check(layout.NameHeight <= lineHeight * 3 && Math.Abs(window.offerNameFont.Size - 9.5F * scale / 100F) < 0.01,
                        "An unusually long name shrank the font or grew an unbounded card.");
                    bool fullNameAvailable = false;
                    foreach (var target in window.augmentTargets)
                        if (ModelValue.Text(target.Value, "id") == ModelValue.Text(longNameOffer, "id")
                            && ModelValue.Text(target.Value, "name") == ModelValue.Text(longNameOffer, "name")) fullNameAvailable = true;
                    check(fullNameAvailable, "The truncated long name has no full-name information target.");
                }
                check(!window.Visible && window.ShowWithoutActivation && !window.TopMost, "Presentation fixtures activated a game overlay.");
            }
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                window.ApplyAppearance(new SidebarAppearance { Width = 280, Scale = 130, FontFamily = "yahei", Side = "right",
                    Sections = new string[] { "offers", "owned", "plan", "hero" } });
                window.Place(new Rectangle(0, 0, 1200, 900));
                var offer = new Dictionary<string, object> { { "id", "weight-hit" }, { "name", "重量级打击手" }, { "rarity", "gold" } };
                var fixture = CreateNextItemFixture();
                fixture["offers"] = new object[0];
                fixture["pendingOffers"] = new object[] {
                    new Dictionary<string, object> { { "pendingId", "six-character-name" }, { "sequence", 1 }, { "active", false }, { "offers", new object[] { offer } } }
                };
                window.Model = fixture;
                using (var bitmap = RenderFixture(window))
                {
                    bitmap.Save(Path.Combine(directory, "sidebar-pending-long-name-280-130.png"), System.Drawing.Imaging.ImageFormat.Png);
                    check(window.pendingOfferButtons.Count == 1, "The narrow pending-name fixture lost its fully visible record button.");
                    Rectangle nameViewport = window.viewport;
                    Rectangle button = new List<Rectangle>(window.pendingOfferButtons.Keys)[0];
                    int rowHeight = window.PendingOfferRowHeight(offer, nameViewport.Width);
                    int rowTop = button.Top - (rowHeight - window.S(31)) / 2;
                    var nameArea = new Rectangle(nameViewport.Left + window.S(33), rowTop + window.S(3),
                        nameViewport.Width - window.S(33) - window.PendingRecordButtonWidth - window.S(8), rowHeight - window.S(6));
                    var expectedFlags = TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix
                        | TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.PreserveGraphicsClipping;
                    Size fullName = TextRenderer.MeasureText("重量级打击手", window.offerNameFont, new Size(nameArea.Width, int.MaxValue), expectedFlags);
                    check(nameViewport.Contains(nameArea) && fullName.Height <= nameArea.Height,
                        "A real six-character pending name exceeds its measured row.");
                    // Compare the actual painted row with its full, untruncated text.
                    // Default glyph padding previously wrapped this name to a clipped second line.
                    using (var expected = new Bitmap(bitmap))
                    {
                        using (Graphics graphics = Graphics.FromImage(expected))
                        using (var background = new SolidBrush(window.BackColor))
                        {
                            graphics.FillRectangle(background, nameArea);
                            TextRenderer.DrawText(graphics, "重量级打击手", window.offerNameFont, nameArea, window.ForeColor, expectedFlags);
                        }
                        // Control and bitmap DCs can shade ClearType edges differently.
                        // Compare glyph footprints so padding, wrapping and ellipsis regressions
                        // still fail without depending on PNG metadata or antialias colors.
                        bool glyphsMatch = true;
                        int backgroundPixel = window.BackColor.ToArgb();
                        for (int y = nameArea.Top; y < nameArea.Bottom; y++)
                        for (int x = nameArea.Left; x < nameArea.Right; x++)
                            if ((bitmap.GetPixel(x, y).ToArgb() != backgroundPixel) != (expected.GetPixel(x, y).ToArgb() != backgroundPixel)) glyphsMatch = false;
                        check(glyphsMatch, "The rendered pending name differs from its full text or uses mismatched measurement padding.");
                    }
                }
            }
            return checks;
        }
        private static int ValidatePendingOfferFixtures(string previewPath)
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message) { Require(condition, message); checks++; };
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false; window.Height = 750;
                window.ApplyAppearance(new SidebarAppearance { Sections = new string[] { "offers", "owned", "plan", "hero" } });
                var latest = new object[] {
                    new Dictionary<string, object> { { "id", "shared" }, { "name", "最新一轮 A" }, { "rank", 1 } },
                    new Dictionary<string, object> { { "id", "new-b" }, { "name", "最新一轮 B" }, { "rank", 2 } },
                    new Dictionary<string, object> { { "id", "new-c" }, { "name", "最新一轮 C" }, { "rank", 3 } }
                };
                var older = new object[] {
                    new Dictionary<string, object> { { "id", "shared" }, { "name", "上一轮 A" } },
                    new Dictionary<string, object> { { "id", "old-b" }, { "name", "上一轮 B" } },
                    new Dictionary<string, object> { { "id", "old-c" }, { "name", "上一轮 C" } }
                };
                var fixture = new Dictionary<string, object> {
                    { "phase", "InProgress" }, { "gameId", "pending-fixture" }, { "sessionRevision", 4 }, { "gameEpoch", 5 }, { "pendingRevision", 1 },
                    { "isDead", true }, { "offers", latest }, { "owned", new object[0] },
                    { "pendingOffers", new object[] {
                        new Dictionary<string, object> { { "pendingId", "old-round" }, { "sequence", 1 }, { "active", false }, { "offers", older } },
                        new Dictionary<string, object> { { "pendingId", "new-round" }, { "sequence", 2 }, { "active", true }, { "offers", latest } }
                    } }
                };
                window.Model = fixture;
                using (var bitmap = RenderFixture(window)) bitmap.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png);
                check(window.offerButtons.Count == 3 && window.pendingOfferButtons.Count == 3 && window.paintedSections.Contains("offers"), "Death or the compact layout hid unresolved choices.");
                check(ModelValue.OffersForConfirmation(fixture, "old-round").Count == 3 && ModelValue.Text(ModelValue.OffersForConfirmation(fixture, "old-round")[1] as Dictionary<string, object>, "id") == "old-b", "Manual lookup selected the latest round instead of the requested older round.");
                check(ModelValue.OffersForConfirmation(fixture, "rerolled-away").Count == 0, "An expired pending ID fell back to the latest candidates.");
                Rectangle pendingViewport = window.viewport;
                string selected = "", selectedPending = "";
                window.PendingOfferConfirmed += delegate(string id, string pendingId) { selected = id; selectedPending = pendingId; };
                foreach (var target in window.pendingOfferButtons)
                {
                    selected = ""; selectedPending = "";
                    Point body = new Point(pendingViewport.Left + window.S(40), target.Key.Top + target.Key.Height / 2);
                    window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, body.X, body.Y, 0));
                    window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, body.X, body.Y, 0));
                    check(selected.Length == 0 && selectedPending.Length == 0, "An older row's information area recorded a selection.");
                    Point center = new Point(target.Key.Left + target.Key.Width / 2, target.Key.Top + target.Key.Height / 2);
                    window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                    window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, center.X, center.Y, 0));
                    check(selected == target.Value.Key && selectedPending == "old-round", "Older manual confirmation targeted the current round.");
                }
                selected = ""; selectedPending = "";
                Rectangle latestCard = new Rectangle();
                foreach (var target in window.offerButtons) if (target.Value == "shared") latestCard = target.Key;
                Point cardPoint = new Point(latestCard.Left + latestCard.Width / 2, latestCard.Top + latestCard.Height / 2);
                window.OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, cardPoint.X, cardPoint.Y, 0));
                var active = ModelValue.Array(fixture, "pendingOffers")[1] as Dictionary<string, object>;
                active["pendingId"] = "new-reroll"; fixture["pendingRevision"] = 2;
                window.Model = fixture;
                using (var bitmap = RenderFixture(window)) { }
                window.OnMouseUp(new MouseEventArgs(MouseButtons.Left, 1, cardPoint.X, cardPoint.Y, 0));
                check(selected.Length == 0, "A held click retargeted a new pending round.");
                var lateModel = new Dictionary<string, object>(fixture);
                lateModel["pendingRevision"] = 1; lateModel["offers"] = older;
                window.Model = lateModel;
                check(ModelValue.Text(ModelValue.Array(window.Model, "offers")[1] as Dictionary<string, object>, "id") == "new-b", "A late same-session model restored superseded pending offers.");
                window.Model = ModelValue.Failure("隔离示例连接中断");
                using (var bitmap = RenderFixture(window)) { }
                check(window.offerButtons.Count == 0 && window.pendingOfferButtons.Count == 0 && ModelValue.Array(window.Model, "pendingOffers").Count == 2, "Transport failure discarded pending state or exposed hidden choices.");
                window.Model = lateModel;
                check(ModelValue.Text(ModelValue.Array(window.Model, "offers")[1] as Dictionary<string, object>, "id") == "new-b", "A transport failure lost the pending revision watermark.");
                window.ScrollTo(100);
                check(window.offerButtons.Count == 0 && window.pendingOfferButtons.Count == 0, "Scrolling kept stale pending hit targets.");
                var returnedOld = new Dictionary<string, object>(fixture);
                returnedOld["sessionRevision"] = 5; returnedOld["pendingRevision"] = 3;
                returnedOld["offers"] = older;
                returnedOld["pendingOffers"] = new object[] {
                    new Dictionary<string, object> { { "pendingId", "old-round" }, { "sequence", 1 }, { "active", true }, { "previousRound", true }, { "offers", older } }
                };
                foreach (int width in new int[] { 280, 324, 460 })
                foreach (int scale in new int[] { 85, 100, 130 })
                {
                    window.ApplyAppearance(new SidebarAppearance { Width = width, Scale = scale, Sections = new string[] { "offers", "owned", "plan", "hero" } });
                    window.Place(new Rectangle(0, 0, 1200, 900)); window.Model = returnedOld; window.ScrollTo(0);
                    using (var bitmap = RenderFixture(window)) bitmap.Save(Path.Combine(Path.GetDirectoryName(previewPath), "sidebar-previous-round-" + width + "-" + scale + ".png"), System.Drawing.Imaging.ImageFormat.Png);
                    check(window.OffersHeading() == "上一轮待确认 · 第 1 轮" && window.offerButtons.Count == 3, "Promoted older candidates lost their round label or confirmation cards.");
                    foreach (var target in window.offerButtons)
                        check(window.offerPendingIds[target.Key] == "old-round", "Promoted older confirmation used the newer round identity.");
                    check(window.helpTargets.ContainsValue(OffersHelp), "Previous-round title clipped its help icon.");
                }
                fixture["pendingOffers"] = new object[0]; fixture["offers"] = new object[0]; fixture["sessionRevision"] = 5; fixture["pendingRevision"] = 3;
                window.Model = fixture;
                using (var bitmap = RenderFixture(window)) { }
                check(window.offerButtons.Count == 0 && window.pendingOfferButtons.Count == 0 && window.OlderPendingOffers().Count == 0, "An authoritative clear retained old pending choices.");
                check(!window.Visible, "Pending fixtures displayed a real window.");
            }
            return checks;
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
                    { "gameId", "icon-fixture" }, { "sessionRevision", 1 },
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
                    check(window.offerButtons.Count == 3 && window.pendingOfferButtons.Count == 0 && Rectangle.Empty.Equals(window.buildToggle), "Candidate controls disappeared or full build controls returned.");
                    check(window.augmentTargets.Count > 0, "Augment icons disappeared.");
                    Rectangle fixtureViewport = window.viewport;
                    foreach (var target in window.augmentTargets)
                    {
                        Rectangle area = target.Key;
                        check(fixtureViewport.Contains(area), "An owned augment icon overflowed the narrow viewport.");
                        if (area.Width == area.Height)
                        {
                            var expected = (Bitmap)window.GetAugmentIcon(ModelValue.Text(target.Value, "icon"), ModelValue.Text(target.Value, "rarity"));
                            Color actual = before.GetPixel(area.Left + area.Width / 2, area.Top + area.Height / 2), pixel = expected.GetPixel(expected.Width / 2, expected.Height / 2);
                            check(Math.Abs(actual.R - pixel.R) <= 3 && Math.Abs(actual.G - pixel.G) <= 3 && Math.Abs(actual.B - pixel.B) <= 3, "Owned augment art or color did not match its identity.");
                        }
                    }
                    RenameFixtureAugments(owned, next); window.Model = fixture;
                    using (var after = RenderFixture(window)) check(EqualFixturePixels(before, after), "Hidden future or owned labels changed the sidebar.");
                    window.ExpandBuild();
                    using (var after = RenderFixture(window)) check(EqualFixturePixels(before, after), "Legacy expand calls changed the compact sidebar presentation.");
                }
                window.ScrollTo(window.contentHeight);
                check(window.offerButtons.Count == 0 && window.augmentTargets.Count == 0, "Scrolling kept stale icon hit targets before repaint.");
                using (var after = RenderFixture(window))
                {
                    var visibleOwned = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var target in window.augmentTargets)
                    {
                        check(FixtureContains(window.viewport, target.Key), "Scrolled owned icons escaped the viewport.");
                        visibleOwned.Add(ModelValue.Text(target.Value, "id"));
                    }
                    foreach (Dictionary<string, object> augment in owned)
                        check(visibleOwned.Contains(ModelValue.Text(augment, "id")), "Larger candidate names made an owned augment unreachable by scrolling.");
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
                // Exercise the actual sidebar eviction hook, including tinted
                // resources, rather than only the cache's isolated fixtures.
                for (int index = 0; index < 96; index++) window.buildIcons["fixture://lru-" + index] = new Bitmap(12, 12);
                check(window.buildIcons.Count == 96 && window.GetAugmentIcon(sharedUrl, "silver") == null, "Sidebar did not evict old source art at the resident limit.");
                check(!window.augmentIcons.ContainsKey(sharedUrl + "\nsilver") && !window.augmentIcons.ContainsKey(sharedUrl + "\ngold")
                    && !window.augmentIcons.ContainsKey(sharedUrl + "\nprismatic"), "Sidebar retained tinted variants after source eviction.");
                bool tintDisposed = false;
                try { silver.GetPixel(0, 0); } catch (ArgumentException) { tintDisposed = true; }
                check(tintDisposed, "Evicted sidebar tinted art was not disposed.");
                check(window.buildIcons.TryBegin("fixture://after-capacity"), "Sidebar stopped admitting new requests after 96 icons.");
                window.buildIcons.Complete("fixture://after-capacity", new Bitmap(12, 12));
                check(window.buildIcons.Count == 96 && window.buildIcons.PendingCount == 0, "Sidebar completion failed to release a request or preserve the cache limit.");
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
        private static bool FixtureContains(Rectangle outer, Rectangle inner) { return outer.Contains(inner); }
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
        private static int ValidateInitialPlanFixtures(SidebarWindow unused, string earlyLivePreviewPath)
        {
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false; window.Model = CreateNextItemFixture();
                using (var before = RenderFixture(window))
                {
                    before.Save(earlyLivePreviewPath, System.Drawing.Imaging.ImageFormat.Png);
                    Require(window.paintedNextItemId == "3135" && window.paintedSections[0] == "nextItem", "Early live recommendation required expansion.");
                    window.ExpandBuild();
                    using (var after = RenderFixture(window)) Require(EqualFixturePixels(before, after), "A legacy expansion changed the compact sidebar.");
                }
                var ended = CreateNextItemFixture(); ended["phase"] = "EndOfGame";
                window.Model = ended;
                using (var bitmap = RenderFixture(window)) Require(window.paintedNextItemId.Length == 0, "An ended game displayed its previous next equipment.");
                Require(!window.Visible && window.ShowWithoutActivation, "Initial recommendation fixture activated a window.");
            }
            return 4;
        }
        private static int ValidateLoadingPreviewFixtures(SidebarWindow unused, string previewPath)
        {
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false;
                var loading = CreateNextItemFixture(); loading["stage"] = "loading"; loading["phase"] = "GameStart";
                loading["championSource"] = "loading-roster";
                ModelValue.Object(loading, "nextItem")["stage"] = "loading-preview";
                window.Model = loading;
                using (var before = RenderFixture(window))
                {
                    before.Save(previewPath, System.Drawing.Imaging.ImageFormat.Png);
                    Require(window.paintedNextItemId == "3135" && window.paintedSections[0] == "nextItem", "Loading recommendation was not visible by default.");
                    Require(!window.paintedSections.Contains("owned") && window.augmentTargets.Count == 0 && Rectangle.Empty.Equals(window.buildToggle), "Loading exposed augment content or an expansion control.");
                    ModelValue.Object(loading, "plan")["nextAugments"] = new object[0]; window.Model = loading;
                    using (var after = RenderFixture(window)) Require(EqualFixturePixels(before, after), "Hidden full-plan data affected loading presentation.");
                }
                var live = CreateNextItemFixture(); window.Model = live;
                using (var bitmap = RenderFixture(window)) Require(window.paintedSections.Contains("owned") && window.paintedSections.Contains("offers") && window.paintedNextItemId == "3135", "Live entry failed to restore candidates beside the compact recommendation.");
                Require(!window.Visible && window.ShowWithoutActivation, "Loading fixture activated a window.");
            }
            return 5;
        }
        private static int ValidateBuildStatisticsFixtures(SidebarWindow unused)
        {
            using (var window = new SidebarWindow())
            {
                window.remoteIcons = false; window.ApplyAppearance(new SidebarAppearance { Scale = 130, Width = 280 }); window.Width = 280;
                var fixture = CreateNextItemFixture(); window.Model = fixture;
                using (var before = RenderFixture(window))
                {
                    int height = window.NextItemHeight(window.Width - 34);
                    var recommendation = ModelValue.Object(fixture, "nextItem");
                    recommendation["evidenceLabel"] = "海克斯大乱斗 80%＋普通 ARAM 20%（按实际可用来源；权重不表示混合胜率）";
                    window.Model = fixture;
                    Require(window.NextItemHeight(window.Width - 34) > height, "Wrapped evidence copy did not reserve its full height.");
                    using (var after = RenderFixture(window)) Require(!EqualFixturePixels(before, after), "Next-item evidence was not visible.");
                    recommendation["evidenceLabel"] = ""; window.Model = fixture;
                    using (var after = RenderFixture(window)) Require(EqualFixturePixels(before, after), "Removing evidence copy did not restore the compact layout.");
                }
                Require(!window.Visible && window.ShowWithoutActivation, "Evidence fixture activated a window.");
            }
            return 4;
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
            Require(RecognitionTime(recognition) == "", "Malformed scan timestamp reached the product UI.");
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
            using (var isolated = new SidebarWindow())
            {
                isolated.remoteIcons = false;
                var offered = CreateNextItemFixture(); offered["sessionRevision"] = 20;
                ModelValue.Object(offered, "nextItem")["sessionRevision"] = 20;
                isolated.Model = offered;
                using (var bitmap = RenderFixture(isolated)) Require(isolated.offerButtons.Count == 3 && isolated.pendingOfferButtons.Count == 0, "Current candidates lost confirmation targets.");
                var confirmed = CreateNextItemFixture(); confirmed["sessionRevision"] = 21;
                confirmed["offers"] = new object[0];
                ModelValue.Object(confirmed, "nextItem")["sessionRevision"] = 21;
                isolated.Model = confirmed;
                using (var bitmap = RenderFixture(isolated)) Require(isolated.paintedNextItemId == "3135" && isolated.offerButtons.Count == 0 && Rectangle.Empty.Equals(isolated.buildToggle), "Confirmation did not clear candidates or required build expansion.");
                isolated.Model = ModelValue.Failure("测试中的短暂本地连接中断");
                using (var bitmap = RenderFixture(isolated)) Require(isolated.paintedNextItemId.Length == 0, "A disconnected sidebar retained a live equipment recommendation.");
                isolated.Model = confirmed;
                Require(isolated.CurrentNextItem() != null, "A current observation did not restore its equipment after reconnecting.");
                isolated.Model = offered;
                Require(ModelValue.Text(isolated.Model, "sessionRevision") == "21", "A late old model reverted the confirmed session.");
                Require(!isolated.Visible && isolated.ShowWithoutActivation, "Confirmation fixtures displayed or activated a window.");
            }
            window.Model = original; window.buildExpanded = false; window.scrollOffset = 0;
            return 20;
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
            Require(Math.Abs(window.Opacity - 0.75) < 0.001 && Math.Abs(window.headingFont.Size - 13.65F) < 0.01
                && Math.Abs(window.decisionFont.Size - 14.3F) < 0.01 && Math.Abs(window.offerNameFont.Size - 12.35F) < 0.01,
                "Sidebar font roles or opacity did not follow the saved scale.");
            using (var bitmap = new Bitmap(window.Width, window.Height)) window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            Require(string.Join(",", window.paintedSections.ToArray()) == "nextItem,offers,owned,hero" && string.Join(",", window.appearance.Sections) == "plan,offers,owned,hero", "Compact projection changed the saved section order.");
            window.Height = 400;
            using (var bitmap = RenderFixture(window)) { }
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
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SystemParametersInfo(uint action, uint parameter, [MarshalAs(UnmanagedType.Bool)] out bool value, uint flags);
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
        internal static ArrayList OffersForConfirmation(Dictionary<string, object> model, string pendingId)
        {
            if (string.IsNullOrEmpty(pendingId)) return Array(model, "offers");
            foreach (object item in Array(model, "pendingOffers"))
            {
                var pending = item as Dictionary<string, object>;
                if (Text(pending, "pendingId") == pendingId) return Array(pending, "offers");
            }
            return new ArrayList();
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
        // activation or window movement. Unknown game/traversal metadata is hidden;
        // unknown covering-window detail is bounded by that window's known extents.
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
                    ClientRectangle bounds;
                    if (!GetWindowRect(current, out bounds)) return false;
                    if (!SubtractCoveringWindow(remaining, bounds, delegate { return ReadCoveringWindow(current, bounds); })) return false;
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
        private struct CoveringWindowMetadata
        {
            internal bool NonCovering;
            internal IntPtr Region;
        }
        private static CoveringWindowMetadata ReadCoveringWindow(IntPtr window, ClientRectangle bounds)
        {
            bool cloaked;
            if (!TryIsCloaked(window, out cloaked)) return new CoveringWindowMetadata();
            if (cloaked || IsKnownTranslucent(window)) return new CoveringWindowMetadata { NonCovering = true };
            // This versioned graphics-overlay adapter is a display policy, not
            // a generic conclusion about zero-flag layered-window opacity.
            if (OverlayVisibilityCompatibility.IsNonCoveringCompatibilityLayer(window))
                return new CoveringWindowMetadata { NonCovering = true };
            return new CoveringWindowMetadata { Region = WindowCoverageRegion(window, bounds) };
        }
        // The caller must have successfully read bounds. Missing detail can cover
        // at most those bounds, so it must not discard proven exposure elsewhere.
        // The lazy read also keeps unrelated windows' DWM/shape failures irrelevant.
        // False means no exposure remains, or region arithmetic could not be trusted.
        private static bool SubtractCoveringWindow(IntPtr remaining, ClientRectangle bounds, Func<CoveringWindowMetadata> readMetadata)
        {
            if (bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top || !RectInRegion(remaining, ref bounds)) return true;
            CoveringWindowMetadata metadata = readMetadata();
            IntPtr coverage = metadata.Region;
            try
            {
                if (metadata.NonCovering) return true;
                if (coverage != IntPtr.Zero && !RegionWithinBudget(coverage))
                { DeleteObject(coverage); coverage = IntPtr.Zero; }
                if (coverage == IntPtr.Zero) coverage = CreateRectRgn(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
                if (coverage == IntPtr.Zero) return false;
                int result = CombineRgn(remaining, remaining, coverage, RegionDifference);
                return result > EmptyRegion && (result != ComplexRegion || RegionWithinBudget(remaining));
            }
            finally { if (coverage != IntPtr.Zero) DeleteObject(coverage); }
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
            internal Rectangle? Bounds;
            internal bool Visible = true, Minimized, Cloaked, Translucent, UnknownCloak, RegionUnavailable;
            internal int MetadataReads;
        }
        private static CoveringWindowMetadata ReadFixtureCoveringWindow(CoverageFixture window)
        {
            window.MetadataReads++;
            if (window.UnknownCloak) return new CoveringWindowMetadata();
            if (window.Cloaked || window.Translucent) return new CoveringWindowMetadata { NonCovering = true };
            if (window.RegionUnavailable) return new CoveringWindowMetadata();
            IntPtr region = CreateRectRgn(0, 0, 0, 0);
            if (region == IntPtr.Zero) return new CoveringWindowMetadata();
            try
            {
                foreach (Rectangle bounds in window.Areas)
                {
                    IntPtr part = CreateRectRgn(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
                    try
                    {
                        if (part == IntPtr.Zero || CombineRgn(region, region, part, RegionOr) == RegionError)
                        { DeleteObject(region); return new CoveringWindowMetadata(); }
                    }
                    finally { if (part != IntPtr.Zero) DeleteObject(part); }
                }
                return new CoveringWindowMetadata { Region = region };
            }
            catch { DeleteObject(region); throw; }
        }
        // The fixture runner uses the same bounded-metadata subtraction as live
        // traversal, with only supplied metadata and region arithmetic;
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
                    if (window.Id == ignored || !window.Visible || window.Minimized) continue;
                    Rectangle bounds = window.Bounds ?? Rectangle.Empty;
                    if (!window.Bounds.HasValue)
                    {
                        for (int index = 0; index < window.Areas.Length; index++)
                            bounds = index == 0 ? window.Areas[index] : Rectangle.Union(bounds, window.Areas[index]);
                    }
                    var nativeBounds = new ClientRectangle { Left = bounds.Left, Top = bounds.Top, Right = bounds.Right, Bottom = bounds.Bottom };
                    if (!SubtractCoveringWindow(remaining, nativeBounds, delegate { return ReadFixtureCoveringWindow(window); })) return false;
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
            var unrelatedUnknown = new CoverageFixture { Id = 1, Bounds = new Rectangle(400, 0, 200, 160), UnknownCloak = true };
            check(exposed(new[] { unrelatedUnknown }) && unrelatedUnknown.MetadataReads == 0, "An unrelated window's unknown cloak metadata hid the game or was queried unnecessarily.");
            var unrelatedShape = new CoverageFixture { Id = 1, Bounds = new Rectangle(400, 0, 200, 160), RegionUnavailable = true };
            check(exposed(new[] { unrelatedShape }) && unrelatedShape.MetadataReads == 0, "An unrelated window's missing region metadata hid the game or was queried unnecessarily.");
            var partialUnknown = new CoverageFixture { Id = 1, Bounds = new Rectangle(0, 0, 140, 160), UnknownCloak = true };
            check(exposed(new[] { partialUnknown }) && partialUnknown.MetadataReads == 1, "Unknown cloak metadata discarded exposure outside known window bounds.");
            check(!exposed(new[] { new CoverageFixture { Id = 1, Bounds = game, UnknownCloak = true } }), "Unknown cloak metadata ignored a potentially full-covering window.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Bounds = new Rectangle(0, 0, 140, 160), RegionUnavailable = true } }), "An unavailable detailed region discarded exposure outside known window bounds.");
            check(!exposed(new[] { new CoverageFixture { Id = 1, Bounds = game, RegionUnavailable = true } }), "An unavailable detailed region ignored potentially complete coverage.");
            check(!exposed(new[] {
                new CoverageFixture { Id = 1, Bounds = new Rectangle(0, 0, 100, 160), UnknownCloak = true },
                new CoverageFixture { Id = 2, Bounds = new Rectangle(100, 0, 100, 160), RegionUnavailable = true }
            }), "Two windows with unavailable detail did not conservatively cover their combined known bounds.");
            check(exposed(new[] { new CoverageFixture { Id = 1, Bounds = game, Areas = new Rectangle[0] } }), "A known empty region was replaced with opaque bounds.");
            var stripes = new Rectangle[4097];
            for (int index = 0; index < stripes.Length; index++) stripes[index] = new Rectangle(0, 200 + index * 2, 140, 1);
            var oversized = new CoverageFixture { Id = 1, Bounds = new Rectangle(0, 0, 200, 8400), Areas = stripes };
            CoveringWindowMetadata oversizedMetadata = ReadFixtureCoveringWindow(oversized);
            try { check(oversizedMetadata.Region != IntPtr.Zero && !RegionWithinBudget(oversizedMetadata.Region), "The oversized-region fixture did not exceed the production metadata budget."); }
            finally { if (oversizedMetadata.Region != IntPtr.Zero) DeleteObject(oversizedMetadata.Region); }
            check(!exposed(new[] { oversized }), "An oversized detailed region did not fall back to its full-covering known bounds.");
            oversized.Bounds = new Rectangle(0, 0, 140, 8400);
            check(exposed(new[] { oversized }), "An oversized detailed region discarded exposure outside its partial-covering known bounds.");
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
