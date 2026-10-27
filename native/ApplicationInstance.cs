using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // The logical directory owns one kernel identity in this Windows session.
    // Packaged launchers can redirect the same AppData path to a different
    // physical file, so a file lease alone cannot prevent duplicate panels.
    // Retain the filesystem lease as protection across Windows sessions too.
    // The message-only window only restores the owner; no app state crosses IPC.
    internal sealed class ApplicationInstance : NativeWindow, IDisposable
    {
        private const int ActivateMessage = 0x8000 + 0x347;
        private readonly FileStream lease;
        private readonly Mutex sessionIdentity;
        private bool disposed;
        internal event Action ActivationRequested;

        private ApplicationInstance(FileStream lease, Mutex sessionIdentity, string directory)
        {
            this.lease = lease;
            this.sessionIdentity = sessionIdentity;
            try { CreateHandle(new CreateParams { Parent = new IntPtr(-3), Caption = WindowName(directory) }); }
            catch { lease.Dispose(); ReleaseIdentity(sessionIdentity); throw; }
        }

        internal static ApplicationInstance TryAcquire(string directory)
        { return TryAcquire(directory, directory); }

        // Only fixtures supply a distinct storage directory to simulate Windows
        // AppData redirection without touching the user's installed data.
        private static ApplicationInstance TryAcquire(string directory, string storageDirectory)
        {
            directory = Path.GetFullPath(directory);
            bool created;
            var identity = new Mutex(true, @"Local\" + WindowName(directory), out created);
            // Mutex ownership is recursive on one thread. Object creation, not
            // WaitOne, also rejects a second owner within the current process.
            if (!created) { identity.Dispose(); return null; }
            FileStream stream = null;
            try
            {
                Directory.CreateDirectory(storageDirectory);
                // Stale lock files are harmless: ownership is the open handle,
                // never a persisted PID or the presence of a marker file.
                stream = new FileStream(Path.Combine(storageDirectory, ".hexguide-instance.lock"),
                    FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read);
            }
            catch (IOException error)
            {
                ReleaseIdentity(identity);
                int code = Marshal.GetHRForException(error) & 0xffff;
                if (code == 32 || code == 33) return null;
                throw;
            }
            catch { ReleaseIdentity(identity); throw; }
            return new ApplicationInstance(stream, identity, directory);
        }

        private static void ReleaseIdentity(Mutex identity)
        {
            try { identity.ReleaseMutex(); }
            finally { identity.Dispose(); }
        }

        internal static string WindowName(string directory)
        {
            string canonical = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant();
            using (var sha = SHA256.Create())
                return "HexGuide.Instance." + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(canonical))).Replace("-", "");
        }

        internal static bool NotifyExisting(string directory)
        { return NotifyExisting(directory, delegate(uint processId) { return AllowSetForegroundWindow(processId); }); }

        // The launching process receives the user's foreground permission,
        // not the background owner. Transfer it before the owner handles the
        // message; Show/Activate alone cannot reliably perform that transfer.
        internal static bool NotifyExisting(string directory, Func<uint, bool> grantForeground)
        {
            if (grantForeground == null) throw new ArgumentNullException("grantForeground");
            string caption = WindowName(directory);
            for (int attempt = 0; attempt < 10; attempt++)
            {
                IntPtr existing = FindWindowEx(new IntPtr(-3), IntPtr.Zero, null, caption);
                if (existing != IntPtr.Zero)
                {
                    uint owner;
                    bool permitted = GetWindowThreadProcessId(existing, out owner) != 0 && owner != 0 && grantForeground(owner);
                    // Even when Windows refuses foreground permission, asking
                    // the owner to restore is useful; return false so the
                    // launcher offers its explicit tray fallback.
                    bool posted = PostMessage(existing, ActivateMessage, IntPtr.Zero, IntPtr.Zero);
                    return posted && permitted;
                }
                Thread.Sleep(50); // Allow the first owner to create its receiver.
            }
            return false;
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == ActivateMessage)
            {
                if (!disposed && ActivationRequested != null) ActivationRequested();
                message.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref message);
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            ActivationRequested = null;
            try { if (Handle != IntPtr.Zero) DestroyHandle(); }
            finally
            {
                try { lease.Dispose(); }
                finally { ReleaseIdentity(sessionIdentity); }
            }
        }

        internal static int ValidateFixtures(string workDirectory)
        {
            string root = Path.GetFullPath(workDirectory);
            Directory.CreateDirectory(root);
            string directory = Path.Combine(root, "instance-" + Guid.NewGuid().ToString("N"));
            string other = directory + "-other";
            string redirected = directory + "-redirected";
            string blocked = directory + "-blocked";
            string race = directory + "-race";
            int checks = 0;
            Action<bool, string> check = delegate(bool value, string reason) { checks++; if (!value) throw new InvalidOperationException("Instance fixture: " + reason); };
            try
            {
                check(WindowName(directory) == WindowName(directory.ToLowerInvariant() + Path.DirectorySeparatorChar), "path case and trailing separator share identity");
                using (var first = TryAcquire(directory))
                {
                    check(first != null, "first owner acquires");
                    using (var second = TryAcquire(directory)) check(second == null, "same-process duplicate rejected");
                    using (var virtualized = TryAcquire(directory, redirected))
                        check(virtualized == null && !Directory.Exists(redirected), "same logical path with redirected physical storage cannot create another runtime");
                    using (var alias = TryAcquire(directory.ToLowerInvariant() + Path.DirectorySeparatorChar, redirected))
                        check(alias == null, "path aliases cannot bypass the kernel identity");
                    using (var separate = TryAcquire(other)) check(separate != null, "different data directories remain independent");
                    int activations = 0;
                    first.ActivationRequested += delegate { activations++; };
                    int permissions = 0;
                    check(NotifyExisting(directory, delegate(uint owner) {
                        check(owner == (uint)Process.GetCurrentProcess().Id, "permission addresses the actual receiver PID");
                        check(activations == 0, "permission transfers before notification dispatch");
                        permissions++; return true;
                    }), "existing receiver notified after permission transfer");
                    // Only our fixture's empty message-only receiver runs. It
                    // has no form, backend, shortcut or activation callback.
                    Application.DoEvents();
                    check(activations == 1 && permissions == 1, "one notification and one permission transfer dispatch once");
                    check(!NotifyExisting(directory, delegate(uint owner) { return false; }), "permission refusal is not reported as successful activation");
                    Application.DoEvents();
                    check(activations == 2, "restore notification remains available when permission is denied");
                    check(ProbeChild(directory) == "already-running", "second process cannot acquire shared data");
                    GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
                    check(ProbeChild(directory) == "already-running", "forced collection retains lifetime ownership");
                }
                using (var afterExit = TryAcquire(directory)) check(afterExit != null, "released/stale lock file can be reopened");
                check(ProbeChild(directory) == "acquired", "child can acquire after owner exits");
                using (var virtualized = TryAcquire(directory, redirected))
                {
                    check(virtualized != null, "a redirected owner can acquire after release");
                    check(ProbeChild(directory) == "already-running", "kernel identity also blocks another process using unredirected storage");
                }
                Directory.CreateDirectory(blocked);
                using (var physicalLease = new FileStream(Path.Combine(blocked, ".hexguide-instance.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read))
                    using (var denied = TryAcquire(blocked)) check(denied == null, "an existing file lease still blocks an owner without a kernel guard");
                using (var retry = TryAcquire(blocked)) check(retry != null, "a failed file acquisition releases its kernel identity");
                check(ProbeConcurrentChildren(race) == 1, "simultaneous launches elect exactly one owner");
                using (var afterRace = TryAcquire(race)) check(afterRace != null, "race winner releases both leases when it exits");
            }
            finally
            {
                // These are fresh, exact fixture paths; never an installed
                // application directory or a caller-selected recursive target.
                foreach (string candidate in new[] { directory, other, redirected, blocked, race })
                {
                    if (!candidate.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("Unexpected instance fixture path.");
                    if (Directory.Exists(candidate))
                    {
                        File.Delete(Path.Combine(candidate, ".hexguide-instance.lock"));
                        File.Delete(Path.Combine(candidate, "start.fixture"));
                        File.Delete(Path.Combine(candidate, "release.fixture"));
                        Directory.Delete(candidate);
                    }
                }
            }
            return checks;
        }

        internal static void RunRaceProbe(string directory, string startGate, string releaseGate)
        {
            WaitForFixtureGate(startGate);
            using (var owner = TryAcquire(directory))
            {
                Console.WriteLine(owner == null ? "already-running" : "acquired");
                if (owner != null) WaitForFixtureGate(releaseGate);
            }
        }

        private static void WaitForFixtureGate(string path)
        {
            var timer = Stopwatch.StartNew();
            while (!File.Exists(path))
            {
                if (timer.ElapsedMilliseconds > 10000) throw new IOException("Isolated instance gate timed out.");
                Thread.Sleep(10);
            }
        }

        private static int ProbeConcurrentChildren(string directory)
        {
            Directory.CreateDirectory(directory);
            string startGate = Path.Combine(directory, "start.fixture"), releaseGate = Path.Combine(directory, "release.fixture");
            var children = new List<Process>();
            try
            {
                for (int i = 0; i < 4; i++)
                    children.Add(Process.Start(ProbeStart("--instance-lock-race-probe \"" + directory + "\" \"" + startGate + "\" \"" + releaseGate + "\"")));
                File.WriteAllText(startGate, "");
                var lines = new System.Threading.Tasks.Task<string>[children.Count];
                for (int i = 0; i < children.Count; i++) lines[i] = children[i].StandardOutput.ReadLineAsync();
                if (!System.Threading.Tasks.Task.WaitAll(lines, 10000)) throw new IOException("Isolated instance race timed out.");
                int owners = 0;
                foreach (var line in lines)
                {
                    if (line.Result == "acquired") owners++;
                    else if (line.Result != "already-running") throw new IOException("Isolated instance race returned an unexpected result.");
                }
                File.WriteAllText(releaseGate, "");
                foreach (var child in children)
                    if (!child.WaitForExit(10000) || child.ExitCode != 0) throw new IOException("Isolated instance race child failed.");
                return owners;
            }
            finally
            {
                // Only generated children from this fixture can be terminated.
                foreach (var child in children)
                {
                    try { if (!child.HasExited) child.Kill(); }
                    finally { child.Dispose(); }
                }
            }
        }

        private static ProcessStartInfo ProbeStart(string arguments)
        {
            return new ProcessStartInfo(Application.ExecutablePath, arguments) {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
        }

        private static string ProbeChild(string directory)
        {
            // directory is a generated fixture folder; Windows folder names
            // cannot contain a double quote and this path has no trailing slash.
            var start = ProbeStart("--instance-lock-probe \"" + directory + "\"");
            using (var child = Process.Start(start))
            {
                var stdout = child.StandardOutput.ReadToEndAsync();
                var stderr = child.StandardError.ReadToEndAsync();
                if (!child.WaitForExit(10000)) { child.Kill(); throw new IOException("Isolated instance probe timed out."); }
                if (child.ExitCode != 0) throw new IOException("Isolated instance probe failed: " + stderr.GetAwaiter().GetResult());
                return stdout.GetAwaiter().GetResult().Trim();
            }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string caption);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(uint processId);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    }
}
