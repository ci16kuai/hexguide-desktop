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
    // The filesystem lease is authoritative across processes and Windows
    // sessions. The message-only window merely restores this session's owner;
    // no backend, token, game state or command line crosses the activation IPC.
    internal sealed class ApplicationInstance : NativeWindow, IDisposable
    {
        private const int ActivateMessage = 0x8000 + 0x347;
        private readonly FileStream lease;
        private bool disposed;
        internal event Action ActivationRequested;

        private ApplicationInstance(FileStream lease, string directory)
        {
            this.lease = lease;
            try { CreateHandle(new CreateParams { Parent = new IntPtr(-3), Caption = WindowName(directory) }); }
            catch { lease.Dispose(); throw; }
        }

        internal static ApplicationInstance TryAcquire(string directory)
        {
            directory = Path.GetFullPath(directory);
            Directory.CreateDirectory(directory);
            FileStream stream;
            try
            {
                // Stale lock files are harmless: ownership is the open handle,
                // never a persisted PID or the presence of a marker file.
                stream = new FileStream(Path.Combine(directory, ".hexguide-instance.lock"),
                    FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read);
            }
            catch (IOException error)
            {
                int code = Marshal.GetHRForException(error) & 0xffff;
                if (code == 32 || code == 33) return null;
                throw;
            }
            return new ApplicationInstance(stream, directory);
        }

        internal static string WindowName(string directory)
        {
            string canonical = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant();
            using (var sha = SHA256.Create())
                return "HexGuide.Instance." + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(canonical))).Replace("-", "");
        }

        internal static bool NotifyExisting(string directory)
        {
            string caption = WindowName(directory);
            for (int attempt = 0; attempt < 10; attempt++)
            {
                IntPtr existing = FindWindowEx(new IntPtr(-3), IntPtr.Zero, null, caption);
                if (existing != IntPtr.Zero) return PostMessage(existing, ActivateMessage, IntPtr.Zero, IntPtr.Zero);
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
            finally { lease.Dispose(); }
        }

        internal static int ValidateFixtures(string workDirectory)
        {
            string root = Path.GetFullPath(workDirectory);
            Directory.CreateDirectory(root);
            string directory = Path.Combine(root, "instance-" + Guid.NewGuid().ToString("N"));
            string other = directory + "-other";
            int checks = 0;
            Action<bool, string> check = delegate(bool value, string reason) { checks++; if (!value) throw new InvalidOperationException("Instance fixture: " + reason); };
            try
            {
                check(WindowName(directory) == WindowName(directory.ToLowerInvariant() + Path.DirectorySeparatorChar), "path case and trailing separator share identity");
                using (var first = TryAcquire(directory))
                {
                    check(first != null, "first owner acquires");
                    using (var second = TryAcquire(directory)) check(second == null, "same-process duplicate rejected");
                    using (var separate = TryAcquire(other)) check(separate != null, "different data directories remain independent");
                    int activations = 0;
                    first.ActivationRequested += delegate { activations++; };
                    check(NotifyExisting(directory), "existing receiver notified");
                    // Only our fixture's empty message-only receiver runs. It
                    // has no form, backend, shortcut or activation callback.
                    Application.DoEvents();
                    check(activations == 1, "one notification dispatches once");
                    check(ProbeChild(directory) == "already-running", "second process cannot acquire shared data");
                }
                using (var afterExit = TryAcquire(directory)) check(afterExit != null, "released/stale lock file can be reopened");
                check(ProbeChild(directory) == "acquired", "child can acquire after owner exits");
            }
            finally
            {
                // These are fresh, exact fixture paths; never an installed
                // application directory or a caller-selected recursive target.
                foreach (string candidate in new[] { directory, other })
                {
                    if (!candidate.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("Unexpected instance fixture path.");
                    if (Directory.Exists(candidate))
                    {
                        File.Delete(Path.Combine(candidate, ".hexguide-instance.lock"));
                        Directory.Delete(candidate);
                    }
                }
            }
            return checks;
        }

        private static string ProbeChild(string directory)
        {
            // directory is a generated fixture folder; Windows folder names
            // cannot contain a double quote and this path has no trailing slash.
            var start = new ProcessStartInfo(Application.ExecutablePath, "--instance-lock-probe \"" + directory + "\"") {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
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
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    }
}
