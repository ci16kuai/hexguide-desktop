using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // A physical press may arrive through WM_HOTKEY and the fixed-chord fallback.
    // They share one gate so the second route cannot undo the first toggle.
    internal sealed class ShortcutPressGate
    {
        private bool held, accepted;
        private int acceptedAt;
        private bool hasScopeWatermark;
        private int scopeSince;
        internal void BlockUntilRelease(int now) { held = true; hasScopeWatermark = true; scopeSince = now; }
        internal bool Poll(bool alt, bool shift, bool h, int now)
        {
            if (!h) held = false;
            if (!alt || !shift || !h || held || CoolingDown(now)) return false;
            Accept(now); return true;
        }
        internal bool Message(int messageTime, int now)
        {
            if (held || (hasScopeWatermark && unchecked(messageTime - scopeSince) <= 0)
                || (accepted && (unchecked(messageTime - acceptedAt) <= 0 || CoolingDown(now)))) return false;
            Accept(now); return true;
        }
        private bool CoolingDown(int now) { return accepted && unchecked(now - acceptedAt) < 120; }
        private void Accept(int now) { held = true; accepted = true; acceptedAt = now; }
    }

    internal interface IShortcutPlatform
    {
        bool Register(IntPtr window);
        bool Unregister(IntPtr window);
        bool IsDown(int key);
        int TickCount { get; }
        int MessageTime { get; }
        int LastError { get; }
    }

    internal sealed class WindowsShortcutPlatform : IShortcutPlatform
    {
        public bool Register(IntPtr window) { return RegisterHotKey(window, SidebarShortcut.Id, 0x4005, 0x48); }
        public bool Unregister(IntPtr window) { return UnregisterHotKey(window, SidebarShortcut.Id); }
        public bool IsDown(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
        public int TickCount { get { return Environment.TickCount; } }
        public int MessageTime { get { return GetMessageTime(); } }
        public int LastError { get { return Marshal.GetLastWin32Error(); } }
        [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] private static extern int GetMessageTime();
    }

    // This invisible message-only window belongs to the application lifetime,
    // never to MainWindow.Handle. Hiding/recreating the main form leaves it intact.
    internal sealed class SidebarShortcut : NativeWindow, IDisposable
    {
        internal const int Id = 0x4847;
        private readonly IShortcutPlatform platform;
        private readonly Action toggle;
        private readonly Func<bool> allowedContext;
        private readonly ShortcutPressGate gate = new ShortcutPressGate();
        private readonly System.Windows.Forms.Timer timer;
        private bool disposed, contextKnown;
        private int writing;
        private DateTime nextWrite = DateTime.MinValue;
        internal bool Registered { get; private set; }
        internal bool ContextAllowed { get; private set; }
        internal int RegistrationError { get; private set; }
        internal long RegistrationAttempts, BlockedMessageCount;
        internal long ReceivedCount, MessageToggleCount, FallbackToggleCount, UiPulseCount, ConfirmRequests, ConfirmSuccesses;
        internal DateTime LastReceivedAt, LastToggleAt, LastUiPulseAt;
        internal event Action<bool> ContextChanged;

        internal SidebarShortcut(Action toggle, Func<bool> allowedContext) : this(toggle, allowedContext, new WindowsShortcutPlatform(), true) { }
        internal SidebarShortcut(Action toggle, IShortcutPlatform platform, bool startPolling)
            : this(toggle, delegate { return true; }, platform, startPolling) { }
        internal SidebarShortcut(Action toggle, Func<bool> allowedContext, IShortcutPlatform platform, bool startPolling)
        {
            this.toggle = toggle; this.allowedContext = allowedContext; this.platform = platform;
            try
            {
                CreateHandle(new CreateParams { Parent = new IntPtr(-3), Caption = "HexGuide.SidebarShortcut" });
            }
            catch (Win32Exception error) { RegistrationError = error.NativeErrorCode; }
            RefreshContext();
            timer = new System.Windows.Forms.Timer { Interval = 40 };
            timer.Tick += delegate { Poll(); };
            if (startPolling) timer.Start();
        }

        internal void Poll()
        {
            if (disposed || !RefreshContext()) return;
            // Only the three keys in the advertised shortcut are sampled. The
            // low "pressed since last call" bit is intentionally never used.
            bool h = platform.IsDown(0x48);
            bool alt = h && platform.IsDown(0x12);
            bool shift = h && platform.IsDown(0x10);
            if (gate.Poll(alt, shift, h, platform.TickCount))
            {
                if (Dispatch()) FallbackToggleCount++;
            }
        }
        internal bool Receive(int message, int id, int messageTime)
        {
            if (disposed || message != 0x0312 || id != Id) return false;
            ReceivedCount++; LastReceivedAt = DateTime.UtcNow;
            if (!RefreshContext()) { BlockedMessageCount++; return true; }
            if (gate.Message(messageTime, platform.TickCount) && Dispatch()) MessageToggleCount++;
            return true;
        }
        internal bool RefreshContext()
        {
            if (disposed) return false;
            bool allowed = allowedContext();
            if (contextKnown && allowed == ContextAllowed) return allowed;
            contextKnown = true; ContextAllowed = allowed;
            // Do not interpret keys held in another app as a new press when
            // returning. A queued message from an earlier context is stale too.
            gate.BlockUntilRelease(platform.TickCount);
            if (!allowed)
            {
                if (Registered) { platform.Unregister(Handle); Registered = false; }
            }
            else if (Handle != IntPtr.Zero)
            {
                RegistrationAttempts++;
                Registered = platform.Register(Handle);
                RegistrationError = Registered ? 0 : platform.LastError;
            }
            if (ContextChanged != null) ContextChanged(allowed);
            return allowed;
        }
        private bool Dispatch()
        {
            if (!RefreshContext()) return false;
            LastToggleAt = DateTime.UtcNow; toggle(); return true;
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0312 && message.WParam == new IntPtr(Id) && Receive(message.Msg, Id, platform.MessageTime)) return;
            base.WndProc(ref message);
        }

        internal Dictionary<string, object> Snapshot(bool enabled, bool pinned, bool desired, bool actual)
        {
            return new Dictionary<string, object> {
                { "schemaVersion", 2 }, { "appVersion", Application.ProductVersion }, { "updatedAtUtc", Stamp(DateTime.UtcNow) },
                { "registered", Registered }, { "registrationErrorCode", RegistrationError },
                { "scopeAllowed", ContextAllowed }, { "registrationAttempts", RegistrationAttempts }, { "blockedMessageCount", BlockedMessageCount },
                { "receivedCount", ReceivedCount }, { "lastReceivedAtUtc", Stamp(LastReceivedAt) },
                { "messageToggleCount", MessageToggleCount }, { "fallbackToggleCount", FallbackToggleCount },
                { "lastToggleAtUtc", Stamp(LastToggleAt) }, { "uiPulseCount", UiPulseCount }, { "lastUiPulseAtUtc", Stamp(LastUiPulseAt) },
                { "enabled", enabled }, { "pinned", pinned }, { "desiredVisible", desired }, { "actualVisible", actual },
                { "confirmRequests", ConfirmRequests }, { "confirmSuccesses", ConfirmSuccesses }
            };
        }
        private static string Stamp(DateTime time) { return time == DateTime.MinValue ? null : time.ToString("o"); }
        internal void Pulse(string dataDirectory, bool enabled, bool pinned, bool desired, bool actual)
        {
            UiPulseCount++; LastUiPulseAt = DateTime.UtcNow;
            if (disposed || LastUiPulseAt < nextWrite || Interlocked.CompareExchange(ref writing, 1, 0) != 0) return;
            nextWrite = LastUiPulseAt.AddSeconds(5);
            string json = new JavaScriptSerializer().Serialize(Snapshot(enabled, pinned, desired, actual));
            string path = Path.Combine(dataDirectory, "diagnostics", "sidebar-shortcut.json");
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
                    Interlocked.Exchange(ref writing, 0);
                }
            });
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true; timer.Stop(); timer.Dispose();
            if (Registered) { platform.Unregister(Handle); Registered = false; }
            if (Handle != IntPtr.Zero) DestroyHandle();
        }

        // Fake platform only: no registration, input sampling, game, backend,
        // visible window, or actual key injection in the off-screen self-test.
        private sealed class FixturePlatform : IShortcutPlatform
        {
            internal bool RegisterResult = true, Alt, Shift, H;
            internal int Now = 1000, Registers, Unregisters, KeyReads;
            public bool Register(IntPtr window) { Registers++; return RegisterResult; }
            public bool Unregister(IntPtr window) { Unregisters++; return true; }
            public bool IsDown(int key)
            {
                KeyReads++;
                if (key == 0x48) return H;
                if (key == 0x12) return Alt;
                if (key == 0x10) return Shift;
                throw new InvalidOperationException("Shortcut sampled an unrelated key.");
            }
            public int TickCount { get { return Now; } }
            public int MessageTime { get { return Now; } }
            public int LastError { get { return 1409; } }
        }
        private sealed class FixtureHost : Form
        {
            internal void RebuildHandle() { RecreateHandle(); }
        }
        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { if (!condition) throw new InvalidOperationException(message); checks++; };
            var platform = new FixturePlatform(); int toggles = 0;
            using (var receiver = new SidebarShortcut(delegate { toggles++; }, platform, false))
            {
                receiver.Poll(); // Observe the initially released H key.
                IntPtr handle = receiver.Handle;
                IntPtr found = IntPtr.Zero;
                for (int i = 0; i < 1000; i++)
                {
                    found = FindWindowEx(new IntPtr(-3), found, null, "HexGuide.SidebarShortcut");
                    if (found == IntPtr.Zero || found == handle) break;
                }
                check(handle != IntPtr.Zero && found == handle, "Shortcut must own an independent message-only window.");
                check(receiver.Registered && receiver.RegistrationError == 0 && platform.Registers == 1, "Shortcut registration was not stable.");
                using (var host = new FixtureHost())
                {
                    IntPtr ignored = host.Handle;
                    host.Hide(); host.RebuildHandle();
                    check(!host.Visible && host.IsHandleCreated && receiver.Handle == handle && platform.Registers == 1 && platform.Unregisters == 0,
                        "Hiding or recreating a host window disturbed the shortcut receiver.");
                }
                check(receiver.Handle == handle && receiver.Registered, "Disposing a host window destroyed the shortcut receiver.");
                check(!receiver.Receive(0x0100, Id, 1000) && !receiver.Receive(0x0312, Id + 1, 1000) && toggles == 0, "Unrelated input toggled the sidebar.");
                platform.H = true; receiver.Poll();
                platform.Alt = true; platform.Now += 40; receiver.Poll();
                check(toggles == 0, "An incomplete shortcut toggled the sidebar.");
                platform.Shift = true; platform.Now += 40; receiver.Poll();
                check(toggles == 1 && receiver.FallbackToggleCount == 1, "Missing WM_HOTKEY did not use the background fallback.");
                receiver.Receive(0x0312, Id, platform.Now);
                check(toggles == 1 && receiver.ReceivedCount == 1, "Message and fallback toggled the same press twice.");
                for (int i = 0; i < 20; i++) { platform.Now += 40; receiver.Poll(); }
                check(toggles == 1, "Holding the shortcut caused repeated toggles.");
                platform.H = false; receiver.Poll(); platform.Now += 200;
                receiver.Receive(0x0312, Id, 1079);
                check(toggles == 1, "A late message undid an already processed press after release.");
                platform.H = true; receiver.Receive(0x0312, Id, platform.Now); receiver.Poll();
                check(toggles == 2 && receiver.MessageToggleCount == 1, "Message-first processing was not deduplicated.");
                platform.Now += 200; receiver.Receive(0x0312, Id, platform.Now);
                check(toggles == 2, "A late message during a held press caused another toggle.");
                platform.H = false; receiver.Poll(); platform.Now += 200;
                platform.H = true; receiver.Receive(0x0312, Id, platform.Now);
                check(toggles == 3, "Releasing and pressing again did not reopen the sidebar.");
                receiver.ConfirmRequests++; receiver.ConfirmSuccesses++;
                platform.H = false; receiver.Poll(); platform.Now += 200;
                platform.H = true; receiver.Poll();
                check(toggles == 4 && receiver.Handle == handle && receiver.Registered && platform.Registers == 1, "Confirmation state broke the independent shortcut.");
                var snapshot = receiver.Snapshot(true, true, true, true);
                string json = new JavaScriptSerializer().Serialize(snapshot);
                check(snapshot.Count == 21 && json.Length < 2048 && !json.Contains("token") && !json.Contains("champion") && !json.Contains("gameId"), "Shortcut diagnostics exceeded their fixed schema.");
                receiver.Dispose(); receiver.Dispose();
                check(platform.Unregisters == 1 && receiver.Handle == IntPtr.Zero && !receiver.Registered, "Shortcut disposal did not unregister exactly once.");
                receiver.Poll(); receiver.Receive(0x0312, Id, platform.Now + 1000);
                check(toggles == 4, "A disposed shortcut dispatched input.");
            }
            var unavailable = new FixturePlatform { RegisterResult = false, Alt = true, Shift = true };
            using (var receiver = new SidebarShortcut(delegate { toggles++; }, unavailable, false))
            {
                check(!receiver.Registered && receiver.RegistrationError == 1409, "Registration failure lost its native error code.");
                receiver.Poll(); unavailable.H = true; unavailable.Now += 200;
                receiver.Poll(); check(toggles == 5, "Registration failure disabled the fixed-chord fallback.");
            }
            check(unavailable.Unregisters == 0, "Failed registration unregistered another owner.");
            var wrap = new ShortcutPressGate();
            check(wrap.Poll(true, true, true, int.MaxValue - 50), "Initial shortcut near clock wrap was lost.");
            wrap.Poll(false, false, false, int.MaxValue - 10);
            check(wrap.Message(int.MinValue + 150, int.MinValue + 150), "Clock wrap disabled the next shortcut.");
            check(!wrap.Message(int.MaxValue - 60, int.MinValue + 400), "Clock wrap accepted a stale message.");
            bool allowed = false;
            var scoped = new FixturePlatform { Alt = true, Shift = true, H = true };
            int scopedToggles = 0;
            using (var receiver = new SidebarShortcut(delegate { scopedToggles++; }, delegate { return allowed; }, scoped, false))
            {
                var contextEvents = new List<bool>();
                var openIntent = new SidebarVisibilityState(true);
                bool panelShown = false;
                receiver.ContextChanged += delegate(bool active) { contextEvents.Add(active); panelShown = openIntent.ShouldShow(false, active); };
                receiver.Poll();
                check(!receiver.Registered && scoped.Registers == 0 && scoped.KeyReads == 0, "Other apps must not register or sample the shortcut.");
                receiver.Receive(0x0312, Id, scoped.Now);
                check(scopedToggles == 0 && receiver.BlockedMessageCount == 1, "Other-app messages must not toggle the sidebar.");
                allowed = true; scoped.Now += 200; receiver.Poll();
                check(receiver.Registered && scoped.Registers == 1 && scopedToggles == 0, "Entering an allowed window with held keys triggered the sidebar.");
                check(panelShown && contextEvents.Count == 1, "Entering the allowed context did not restore the panel's open intent.");
                scoped.H = false; receiver.Poll(); scoped.Now += 200;
                receiver.Receive(0x0312, Id, 1000);
                check(scopedToggles == 0, "A queued message from outside the allowed context was accepted.");
                scoped.H = true; receiver.Poll();
                check(scopedToggles == 1, "A fresh shortcut in an allowed window was ignored.");
                allowed = false; scoped.Now += 200;
                receiver.Receive(0x0312, Id, scoped.Now);
                int reads = scoped.KeyReads; receiver.Poll();
                check(scopedToggles == 1 && !receiver.Registered && scoped.Unregisters == 1 && scoped.KeyReads == reads,
                    "Switching to another app did not immediately gate messages, release registration and stop key sampling.");
                check(!panelShown && openIntent.Pinned && openIntent.Enabled && contextEvents.Count == 2, "Leaving the allowed context changed the panel's saved open intent.");
                allowed = true; scoped.Now += 200; receiver.Poll();
                check(scopedToggles == 1 && scoped.Registers == 2, "Returning with H held caused an accidental toggle.");
                check(panelShown && contextEvents.Count == 3 && contextEvents[0] && !contextEvents[1] && contextEvents[2], "Returning did not restore the panel exactly once per context transition.");
                scoped.H = false; receiver.Poll(); scoped.Now += 200;
                scoped.H = true; receiver.Receive(0x0312, Id, scoped.Now); receiver.Poll();
                check(scopedToggles == 2, "A new message-first press after returning did not toggle exactly once.");
                receiver.Dispose();
                check(scoped.Unregisters == 2, "Disposal after a scope change unregistered an incorrect number of times.");
            }
            return checks;
        }
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string caption);
    }
}
