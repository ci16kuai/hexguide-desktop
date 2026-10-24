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
        internal bool Poll(bool alt, bool shift, bool h, int now)
        {
            if (!h) held = false;
            if (!alt || !shift || !h || held || CoolingDown(now)) return false;
            Accept(now); return true;
        }
        internal bool Message(int messageTime, int now)
        {
            if (held || (accepted && (unchecked(messageTime - acceptedAt) <= 0 || CoolingDown(now)))) return false;
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
        private readonly ShortcutPressGate gate = new ShortcutPressGate();
        private readonly System.Windows.Forms.Timer timer;
        private bool disposed;
        private int writing;
        private DateTime nextWrite = DateTime.MinValue;
        internal bool Registered { get; private set; }
        internal int RegistrationError { get; private set; }
        internal long ReceivedCount, MessageToggleCount, FallbackToggleCount, UiPulseCount, ConfirmRequests, ConfirmSuccesses;
        internal DateTime LastReceivedAt, LastToggleAt, LastUiPulseAt;

        internal SidebarShortcut(Action toggle) : this(toggle, new WindowsShortcutPlatform(), true) { }
        internal SidebarShortcut(Action toggle, IShortcutPlatform platform, bool startPolling)
        {
            this.toggle = toggle; this.platform = platform;
            try
            {
                CreateHandle(new CreateParams { Parent = new IntPtr(-3), Caption = "HexGuide.SidebarShortcut" });
                Registered = platform.Register(Handle);
                // Capture this before any other platform call can replace it.
                RegistrationError = Registered ? 0 : platform.LastError;
            }
            catch (Win32Exception error) { RegistrationError = error.NativeErrorCode; }
            timer = new System.Windows.Forms.Timer { Interval = 40 };
            timer.Tick += delegate { Poll(); };
            if (startPolling) timer.Start();
        }

        internal void Poll()
        {
            if (disposed) return;
            // Only the three keys in the advertised shortcut are sampled. The
            // low "pressed since last call" bit is intentionally never used.
            bool h = platform.IsDown(0x48);
            bool alt = h && platform.IsDown(0x12);
            bool shift = h && platform.IsDown(0x10);
            if (gate.Poll(alt, shift, h, platform.TickCount))
            {
                FallbackToggleCount++; Dispatch();
            }
        }
        internal bool Receive(int message, int id, int messageTime)
        {
            if (disposed || message != 0x0312 || id != Id) return false;
            ReceivedCount++; LastReceivedAt = DateTime.UtcNow;
            if (gate.Message(messageTime, platform.TickCount)) { MessageToggleCount++; Dispatch(); }
            return true;
        }
        private void Dispatch() { LastToggleAt = DateTime.UtcNow; toggle(); }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0312 && Receive(message.Msg, message.WParam.ToInt32(), platform.MessageTime)) return;
            base.WndProc(ref message);
        }

        internal Dictionary<string, object> Snapshot(bool enabled, bool pinned, bool desired, bool actual)
        {
            return new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "appVersion", Application.ProductVersion }, { "updatedAtUtc", Stamp(DateTime.UtcNow) },
                { "registered", Registered }, { "registrationErrorCode", RegistrationError },
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
            internal int Now = 1000, Registers, Unregisters;
            public bool Register(IntPtr window) { Registers++; return RegisterResult; }
            public bool Unregister(IntPtr window) { Unregisters++; return true; }
            public bool IsDown(int key)
            {
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
                check(snapshot.Count == 18 && json.Length < 2048 && !json.Contains("token") && !json.Contains("champion") && !json.Contains("gameId"), "Shortcut diagnostics exceeded their fixed schema.");
                receiver.Dispose(); receiver.Dispose();
                check(platform.Unregisters == 1 && receiver.Handle == IntPtr.Zero && !receiver.Registered, "Shortcut disposal did not unregister exactly once.");
                receiver.Poll(); receiver.Receive(0x0312, Id, platform.Now + 1000);
                check(toggles == 4, "A disposed shortcut dispatched input.");
            }
            var unavailable = new FixturePlatform { RegisterResult = false, Alt = true, Shift = true, H = true };
            using (var receiver = new SidebarShortcut(delegate { toggles++; }, unavailable, false))
            {
                check(!receiver.Registered && receiver.RegistrationError == 1409, "Registration failure lost its native error code.");
                receiver.Poll(); check(toggles == 5, "Registration failure disabled the fixed-chord fallback.");
            }
            check(unavailable.Unregisters == 0, "Failed registration unregistered another owner.");
            var wrap = new ShortcutPressGate();
            check(wrap.Poll(true, true, true, int.MaxValue - 50), "Initial shortcut near clock wrap was lost.");
            wrap.Poll(false, false, false, int.MaxValue - 10);
            check(wrap.Message(int.MinValue + 150, int.MinValue + 150), "Clock wrap disabled the next shortcut.");
            check(!wrap.Message(int.MaxValue - 60, int.MinValue + 400), "Clock wrap accepted a stale message.");
            return checks;
        }
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string caption);
    }
}
