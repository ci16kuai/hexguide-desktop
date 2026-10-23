using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HexGuide.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e)
            {
                MessageBox.Show("窗口遇到问题，请关闭后重新打开。\r\n" + e.Exception.Message, "海克斯指南", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            string dataDirectory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "appdata");
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--data-dir" && i + 1 < args.Length) dataDirectory = Path.GetFullPath(args[++i]);
            }
            try { Application.Run(new MainWindow(dataDirectory)); }
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

        internal MainWindow(string dataDirectory)
        {
            this.dataDirectory = dataDirectory;
            Text = "海克斯指南 · 实时助手";
            Size = new Size(1320, 900);
            MinimumSize = new Size(860, 620);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(12, 17, 26);
            Font = new Font("Microsoft YaHei UI", 9F);
            Icon = SystemIcons.Application;
            AutoScaleMode = AutoScaleMode.Dpi;

            var toolbar = new ToolStrip();
            toolbar.GripStyle = ToolStripGripStyle.Hidden;
            toolbar.BackColor = Color.FromArgb(22, 29, 40);
            toolbar.ForeColor = Color.FromArgb(222, 231, 239);
            toolbar.Padding = new Padding(10, 4, 10, 4);
            var title = new ToolStripLabel("海克斯指南  /  本地实时助手");
            var pin = new ToolStripButton("窗口置顶");
            pin.CheckOnClick = true;
            pin.CheckedChanged += delegate { TopMost = pin.Checked; };
            reload = new ToolStripButton("刷新页面");
            reload.Enabled = false;
            reload.Click += delegate { if (browser.CoreWebView2 != null) browser.Reload(); };
            toolbar.Items.Add(title);
            toolbar.Items.Add(new ToolStripSeparator());
            toolbar.Items.Add(pin);
            toolbar.Items.Add(reload);
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
            Shown += async delegate { await StartAsync(); };
            FormClosing += delegate { closing = true; StopBackend(); };
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
                localOrigin = new Uri("http://127.0.0.1:" + port + "/");
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
                    browser.BringToFront();
                    reload.Enabled = true;
                };
                // The token stays in this process and the fragment, never an HTTP query or log.
                browser.Source = new Uri(localOrigin, "#session=" + Uri.EscapeDataString(token));
                // The handshake is the only backend stdout line needed by the shell.
                DrainOutput(backend);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                ShowFailure("此电脑缺少 Microsoft Edge WebView2 运行环境。\r\n请从微软官网安装 Evergreen Runtime 后重试。\r\nhttps://developer.microsoft.com/microsoft-edge/webview2/");
                StopBackend();
            }
            catch (UnauthorizedAccessException)
            {
                ShowFailure("软件目录无法写入。请将完整文件夹放到可写位置后再打开，\r\n或使用 --data-dir 指定自己的数据文件夹。");
                StopBackend();
            }
            catch (Exception error)
            {
                ShowFailure("启动失败：" + error.Message);
                StopBackend();
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
            status.BringToFront();
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
