using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // Compiled only by test-main-window-recovery.ps1, never into HexGuide.exe.
    // Plain Forms run on a private desktop which is never switched into view.
    internal static class MainWindowRecoveryFixtures
    {
        private static int checks;

        [STAThread]
        private static int Main(string[] args)
        {
            string resultPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "isolated-form-result.txt");
            if (args.Length == 1 && args[0] == "--isolated-form-child")
            {
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    VerifyOwnForms();
                    File.WriteAllText(resultPath, checks.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    return 0;
                }
                catch (Exception error) { File.WriteAllText(resultPath, error.ToString()); return 1; }
            }
            try
            {
                VerifyGeometry();
                VerifyOwnFormsOnPrivateDesktop();
                Console.WriteLine("{\"checks\":" + checks + ",\"mode\":\"isolated-main-window-recovery\",\"desktop\":\"isolated-not-switched\",\"liveGameVerified\":false}");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Main-window recovery fixture failed after " + checks + " checks: " + error.Message);
                return 1;
            }
        }

        private static void VerifyGeometry()
        {
            var primary = new Rectangle(0, 0, 1920, 1040);
            var secondary = new Rectangle(-1920, 0, 1920, 1040);
            var minimum = new Size(860, 620);
            var mouse = new Point(400, 400);
            var sentinel = new Rectangle(-32000, -32000, 860, 620);
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new[] { primary }, mouse, 32)
                == new Rectangle(530, 210, 860, 620), "actual Normal-state -32000 bounds must recover to the available work area");
            var valid = new Rectangle(120, 80, 1320, 900);
            Check(Resolve(valid, minimum, primary) == valid, "valid position and size must remain unchanged");
            var negative = new Rectangle(-1800, 70, 1320, 900);
            Check(MainWindowRecovery.ResolveBounds(negative, minimum, new[] { primary, secondary }, mouse, 32) == negative,
                "negative coordinates on a connected secondary monitor must remain unchanged");
            Check(MainWindowRecovery.ResolveBounds(negative, minimum, new[] { primary }, mouse, 32)
                == new Rectangle(300, 70, 1320, 900), "removing the secondary monitor must recover the window");
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new[] { primary, secondary }, new Point(-800, 400), 32)
                == new Rectangle(-1390, 210, 860, 620), "recovery must prefer the mouse monitor, including negative coordinates");
            Check(Resolve(new Rectangle(1919, 70, 860, 620), minimum, primary) != new Rectangle(1919, 70, 860, 620),
                "a one-pixel title-bar sliver is not operable");
            Check(Resolve(new Rectangle(100, -40, 860, 620), minimum, primary) != new Rectangle(100, -40, 860, 620),
                "visible body with an off-screen title bar must recover");
            Check(Resolve(new Rectangle(100, -10, 860, 620), minimum, primary) == new Rectangle(100, -10, 860, 620),
                "a usable caption with a small frame overlap must be preserved");
            Check(Resolve(new Rectangle(100, -11, 860, 620), minimum, primary) != new Rectangle(100, -11, 860, 620),
                "less than the minimum usable caption height must recover");
            Check(Resolve(new Rectangle(1792, 70, 860, 620), minimum, primary) == new Rectangle(1792, 70, 860, 620),
                "the exact minimum draggable caption width must remain valid");
            Check(Resolve(new Rectangle(1793, 70, 860, 620), minimum, primary) != new Rectangle(1793, 70, 860, 620),
                "one pixel below the draggable caption width must recover");
            Check(Resolve(new Rectangle(-732, 70, 860, 620), minimum, primary) != new Rectangle(-732, 70, 860, 620),
                "only the right-side control buttons being visible must not count as a draggable caption");
            var maximizedFrame = new Rectangle(-8, -8, 1936, 1056);
            Check(Resolve(maximizedFrame, minimum, primary) == maximizedFrame,
                "normal maximized-style invisible borders must not force a layout change");
            var tiny = new Rectangle(20, 40, 640, 480);
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new[] { tiny }, mouse, 32) == tiny,
                "a smaller work area must take precedence over the nominal minimum");
            var largeDpi = new Rectangle(-32000, -32000, 2640, 1800);
            Check(MainWindowRecovery.ResolveBounds(largeDpi, new Size(1720, 1240), new[] { primary }, mouse, 64) == primary,
                "a large DPI-scaled window must fit the chosen work area");
            var largeDpiFrame = new Rectangle(-16, -16, 1952, 1072);
            Check(MainWindowRecovery.ResolveBounds(largeDpiFrame, minimum, new[] { primary }, mouse, 64) == largeDpiFrame,
                "DPI-scaled invisible borders must remain usable");
            var taskbarArea = new Rectangle(80, 48, 1840, 992);
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new[] { taskbarArea }, mouse, 32)
                == new Rectangle(570, 234, 860, 620), "top and left taskbars must be excluded from placement");
            var upper = new Rectangle(0, -1080, 1920, 1040);
            var upperValid = new Rectangle(200, -1000, 1000, 800);
            Check(MainWindowRecovery.ResolveBounds(upperValid, minimum, new[] { primary, upper }, mouse, 32) == upperValid,
                "a monitor above the primary monitor must remain valid");
            var far = new Rectangle(3000, 0, 1200, 900);
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new[] { primary, far }, new Point(2800, 100), 32)
                == new Rectangle(3170, 140, 860, 620), "a mouse in a monitor gap must choose the nearest work area");
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new Rectangle[0], mouse, 32) == sentinel,
                "no reported work area must not invent a display");
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, null, mouse, 32) == sentinel,
                "a missing display snapshot must be stable");
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new[] { Rectangle.Empty, primary }, mouse, 32)
                == new Rectangle(530, 210, 860, 620), "invalid work areas must be ignored");
            Check(MainWindowRecovery.ResolveBounds(new Rectangle(int.MaxValue - 100, int.MaxValue - 100, 860, 620), minimum,
                new[] { primary }, mouse, 32) == new Rectangle(530, 210, 860, 620), "extreme coordinates must not overflow the policy");
            var undersized = new Rectangle(-32000, -32000, 200, 100);
            Check(Resolve(undersized, minimum, primary) == new Rectangle(530, 210, 860, 620),
                "recovery must honor the nominal minimum when it fits");
            Check(MainWindowRecovery.ResolveBounds(sentinel, minimum, new[] { new Rectangle(0, 0, 80, 40) }, mouse, 32)
                == new Rectangle(0, 0, 80, 40), "an exceptionally small work area must still yield bounded geometry");
            Check(MainWindowRecovery.ResolveMinimumSize(tiny, minimum, new[] { tiny }, 32) == new Size(640, 480),
                "small-screen recovery must reduce the effective minimum");
            Check(MainWindowRecovery.ResolveMinimumSize(tiny, minimum, new[] { primary }, 32) == minimum,
                "returning to a larger work area must restore the nominal minimum");
            var nearBottomRight = new Rectangle(1400, 650, 500, 300);
            Check(MainWindowRecovery.ResolveMinimumSize(nearBottomRight, minimum, new[] { primary }, 32) == new Size(520, 390),
                "minimum restoration must use remaining space without changing a valid position");
            var overhanging = new Rectangle(1792, 70, 860, 620);
            Check(MainWindowRecovery.ResolveMinimumSize(overhanging, new Size(1000, 800), new[] { primary }, 32) == new Size(860, 800),
                "restoring a minimum must not enlarge an existing right-side overhang");
            Check(MainWindowRecovery.ResolveMinimumSize(tiny, new Size(300, 200), new[] { primary }, 32) == new Size(300, 200),
                "a later caller-supplied minimum must replace the old nominal constraint");
            Check(MainWindowRecovery.ResolveMinimumSize(tiny, minimum, new Rectangle[0], 32) == new Size(640, 480),
                "missing screen information must not enlarge the existing window");
            Check(MainWindowRecovery.ResolveMinimumSize(negative, new Size(1600, 1000), new[] { primary, secondary }, 32)
                == new Size(1600, 970), "minimum restoration must use the caption's actual negative-coordinate monitor");
        }

        private static Rectangle Resolve(Rectangle bounds, Size minimum, Rectangle screen)
        {
            return MainWindowRecovery.ResolveBounds(bounds, minimum, new[] { screen }, new Point(400, 400), 32);
        }

        private static void VerifyOwnFormsOnPrivateDesktop()
        {
            string name = "HexGuideRecovery-" + Guid.NewGuid().ToString("N");
            IntPtr desktop = CreateDesktop(name, null, IntPtr.Zero, 0, 0x00ff, IntPtr.Zero);
            if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the isolated fixture desktop.");
            var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Desktop = name };
            ProcessInformation child = new ProcessInformation();
            try
            {
                string executable = Assembly.GetExecutingAssembly().Location;
                var command = new StringBuilder("\"" + executable + "\" --isolated-form-child");
                // Desktop assignment happens before CLR/STA creates any window.
                // No SwitchDesktop call exists anywhere in this fixture.
                if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero,
                    AppDomain.CurrentDomain.BaseDirectory, ref startup, out child))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the private-desktop fixture child.");
                uint wait = WaitForSingleObject(child.Process, 20000);
                if (wait != 0)
                {
                    TerminateProcess(child.Process, 1); // Only this fixture's own child.
                    WaitForSingleObject(child.Process, 1000);
                    throw new TimeoutException("Isolated plain-Form fixtures exceeded 20 seconds.");
                }
                uint exitCode;
                if (!GetExitCodeProcess(child.Process, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
                string result = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "isolated-form-result.txt"));
                if (exitCode != 0) throw new InvalidOperationException(result);
                checks += int.Parse(result, System.Globalization.CultureInfo.InvariantCulture);
            }
            finally
            {
                if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
                if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
                CloseDesktop(desktop);
            }
        }

        private static void VerifyOwnForms()
        {
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            using (var hidden = NewForm())
            {
                hidden.Bounds = new Rectangle(-32000, -32000, 860, 620);
                Rectangle before = hidden.Bounds;
                MainWindowRecovery.EnsureOnScreen(hidden);
                Check(!hidden.Visible && hidden.WindowState == FormWindowState.Normal && hidden.Bounds == before,
                    "EnsureOnScreen must not show or move a hidden form");
            }
            using (var minimized = NewForm())
            {
                minimized.Location = area.Location;
                minimized.Show();
                minimized.WindowState = FormWindowState.Minimized;
                Application.DoEvents();
                Rectangle before = minimized.Bounds;
                MainWindowRecovery.EnsureOnScreen(minimized);
                Check(minimized.WindowState == FormWindowState.Minimized && minimized.Bounds == before,
                    "EnsureOnScreen must not restore or move a minimized form");
                MainWindowRecovery.Apply(minimized);
                Check(minimized.Visible && minimized.WindowState == FormWindowState.Normal,
                    "explicit Apply must restore a minimized form");
                Check(IsOperable(minimized.Bounds), "restored form must have an operable title bar");
            }
            using (var normal = NewForm())
            {
                normal.Show();
                normal.Bounds = new Rectangle(-32000, -32000, 860, 620);
                Application.DoEvents();
                Check(normal.WindowState == FormWindowState.Normal && normal.Left == -32000 && normal.Top == -32000,
                    "plain Form must reproduce the observed visible Normal-state sentinel");
                MainWindowRecovery.EnsureOnScreen(normal);
                Check(normal.Visible && normal.WindowState == FormWindowState.Normal && IsOperable(normal.Bounds),
                    "EnsureOnScreen must repair the actual own-form sentinel");
                Rectangle valid = normal.Bounds;
                Size minimum = normal.MinimumSize;
                MainWindowRecovery.EnsureOnScreen(normal);
                Check(normal.Bounds == valid && normal.MinimumSize == minimum, "a second EnsureOnScreen must preserve valid layout and minimum");
                normal.WindowState = FormWindowState.Maximized;
                Application.DoEvents();
                Rectangle maximized = normal.Bounds;
                MainWindowRecovery.EnsureOnScreen(normal);
                Check(normal.WindowState == FormWindowState.Maximized && normal.Bounds == maximized,
                    "EnsureOnScreen must leave a maximized form untouched");
            }
            using (var explicitRestore = NewForm())
            {
                explicitRestore.Bounds = new Rectangle(-32000, -32000, 860, 620);
                MainWindowRecovery.Apply(explicitRestore);
                Check(explicitRestore.Visible && IsOperable(explicitRestore.Bounds), "Apply must show and place a hidden form");
            }
            using (var displayChange = NewForm())
            {
                var smallArea = new Rectangle(20, 40, 640, 480);
                var largerArea = new Rectangle(0, 0, 1920, 1040);
                displayChange.Show();
                displayChange.Location = new Point(-32000, -32000);
                MainWindowRecovery.EnsureOnScreen(displayChange, new[] { smallArea }, new Point(400, 400), 32);
                Check(displayChange.Bounds == smallArea && displayChange.MinimumSize == new Size(640, 480),
                    "own Form must adopt a smaller snapshot's effective minimum and actual bounds");
                MainWindowRecovery.EnsureOnScreen(displayChange, new[] { largerArea }, new Point(400, 400), 32);
                Check(displayChange.MinimumSize == new Size(860, 620) && displayChange.Bounds == new Rectangle(20, 40, 860, 620),
                    "own Form must restore its nominal minimum after a larger snapshot without relocating");
                Rectangle stable = displayChange.Bounds;
                MainWindowRecovery.EnsureOnScreen(displayChange, new[] { largerArea }, new Point(1800, 900), 32);
                Check(displayChange.Bounds == stable && displayChange.MinimumSize == new Size(860, 620),
                    "restored own-Form minimum must remain stable when only the mouse position changes");
            }
            using (var constrained = NewForm())
            {
                var largest = Size.Empty;
                foreach (Screen screen in Screen.AllScreens)
                {
                    largest.Width = Math.Max(largest.Width, screen.WorkingArea.Width);
                    largest.Height = Math.Max(largest.Height, screen.WorkingArea.Height);
                }
                constrained.MinimumSize = new Size(largest.Width + 400, largest.Height + 400);
                constrained.Show();
                constrained.Location = new Point(-32000, -32000);
                MainWindowRecovery.Apply(constrained);
                Check(IsOperable(constrained.Bounds), "oversized minimum must not prevent own-form recovery");
                Rectangle recovered = constrained.Bounds;
                bool fits = false;
                foreach (Screen screen in Screen.AllScreens) if (screen.WorkingArea.Contains(recovered)) fits = true;
                Check(fits && constrained.MinimumSize.Width <= recovered.Width && constrained.MinimumSize.Height <= recovered.Height,
                    "the effective Form.MinimumSize and actual bounds must fit one work area");
                constrained.MinimumSize = new Size(300, 200);
                constrained.Location = new Point(-32000, -32000);
                MainWindowRecovery.Apply(constrained);
                Check(constrained.MinimumSize == new Size(300, 200) && IsOperable(constrained.Bounds),
                    "a caller minimum change must discard the old module-clamped nominal minimum");
            }
            var disposed = NewForm();
            disposed.Dispose();
            MainWindowRecovery.EnsureOnScreen(disposed);
            MainWindowRecovery.Apply(disposed);
            Check(disposed.IsDisposed, "recovery must ignore a disposed form");
        }

        private static Form NewForm()
        {
            return new PassiveFixtureForm {
                Text = "HexGuide isolated recovery fixture", StartPosition = FormStartPosition.Manual,
                ShowInTaskbar = false, MinimumSize = new Size(860, 620), Size = new Size(860, 620)
            };
        }

        private static bool IsOperable(Rectangle bounds)
        {
            Screen[] screens = Screen.AllScreens;
            var areas = new Rectangle[screens.Length];
            for (int i = 0; i < screens.Length; i++) areas[i] = screens[i].WorkingArea;
            int caption = Math.Max(1, SystemInformation.CaptionHeight + SystemInformation.FrameBorderSize.Height);
            return MainWindowRecovery.ResolveBounds(bounds, Size.Empty, areas, Cursor.Position, caption) == bounds;
        }

        private static void Check(bool value, string message)
        {
            checks++;
            if (!value) throw new InvalidOperationException(message);
        }

        private sealed class PassiveFixtureForm : Form
        {
            protected override bool ShowWithoutActivation { get { return true; } }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateDesktop(string name, string device, IntPtr mode, int flags, uint access, IntPtr security);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr desktop);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            internal int Size;
            internal string Reserved, Desktop, Title;
            internal int X, Y, Width, Height, XChars, YChars, Fill, Flags;
            internal short Show, ReservedBytes;
            internal IntPtr ReservedPointer, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr handle, uint code);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}
