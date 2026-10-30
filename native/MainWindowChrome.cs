using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // Window policy stays native: web content never receives a host-object or
    // WebMessage capability, and editing/hiding a page cannot hide its caption.
    internal sealed class MainWindowChrome
    {
        private readonly Form owner;
        internal MainWindowChrome(Form form) { owner = form; }
        internal void Apply()
        {
            if (!owner.IsHandleCreated || owner.IsDisposed) return;
            UpdatePadding();
            // WinForms must calculate a borderless client size when restoring.
            // Put standard resizing/system-menu capabilities only on the real
            // hWnd so AdjustWindowRectEx(CreateParams) cannot add a second frame.
            long style = GetWindowLongPtr(owner.Handle, -16).ToInt64();
            long nativeStyle = (style & ~0x80000000L) | 0x00CF0000L;
            if (style != nativeStyle) SetWindowLongPtr(owner.Handle, -16, new IntPtr(nativeStyle));
            SetWindowPos(owner.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020);
            try
            {
                int dark = 1, round = 2;
                DwmSetWindowAttribute(owner.Handle, 20, ref dark, sizeof(int));
                DwmSetWindowAttribute(owner.Handle, 33, ref round, sizeof(int));
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }
        internal void UpdatePadding()
        {
            int border = owner.WindowState == FormWindowState.Maximized ? 0 : BorderForDpi(owner.DeviceDpi);
            var padding = new Padding(border);
            if (owner.Padding != padding) owner.Padding = padding;
        }
        internal bool HandleMessage(ref Message message)
        {
            if (message.Msg == 0x0083) // WM_NCCALCSIZE: replace only the native frame's drawn caption.
            {
                if (message.LParam != IntPtr.Zero && IsZoomed(message.HWnd))
                {
                    var proposed = (NativeRect)Marshal.PtrToStructure(message.LParam, typeof(NativeRect));
                    Rectangle area = Screen.FromRectangle(proposed.Rectangle).WorkingArea;
                    Rectangle result = ResolveClientBounds(proposed.Rectangle, area, true);
                    Marshal.StructureToPtr(new NativeRect(result), message.LParam, false);
                }
                message.Result = IntPtr.Zero;
                return true;
            }
            if (message.Msg == 0x0084 && owner.WindowState != FormWindowState.Maximized)
            {
                NativeRect window;
                if (GetWindowRect(message.HWnd, out window))
                {
                    long point = message.LParam.ToInt64();
                    int hit = HitTest(window.Rectangle, new Point((short)(point & 0xffff), (short)((point >> 16) & 0xffff)), false, owner.DeviceDpi);
                    if (hit != 1) { message.Result = new IntPtr(hit); return true; }
                }
            }
            return false;
        }
        internal static int BorderForDpi(int dpi) { return Math.Max(4, (int)Math.Round(6 * Math.Max(96, dpi) / 96.0)); }
        internal static Rectangle ResolveClientBounds(Rectangle proposed, Rectangle workingArea, bool maximized)
        {
            return maximized && workingArea.Width > 0 && workingArea.Height > 0 ? workingArea : proposed;
        }
        internal static int HitTest(Rectangle bounds, Point point, bool maximized, int dpi)
        {
            if (maximized || !bounds.Contains(point)) return 1;
            int border = BorderForDpi(dpi);
            bool left = point.X < bounds.Left + border, right = point.X >= bounds.Right - border;
            bool top = point.Y < bounds.Top + border, bottom = point.Y >= bounds.Bottom - border;
            if (top && left) return 13;
            if (top && right) return 14;
            if (bottom && left) return 16;
            if (bottom && right) return 17;
            return left ? 10 : right ? 11 : top ? 12 : bottom ? 15 : 1;
        }
        internal static void Drag(Form form)
        {
            if (form == null || !form.IsHandleCreated) return;
            ReleaseCapture();
            SendMessage(form.Handle, 0x00A1, new IntPtr(2), IntPtr.Zero);
        }
        internal static void ShowSystemMenu(Form form, Point location)
        {
            if (form == null || !form.IsHandleCreated) return;
            RefreshSystemMenu(form);
            IntPtr menu = GetSystemMenu(form.Handle, false);
            int command = TrackPopupMenu(menu, 0x0100 | 0x0002, location.X, location.Y, 0, form.Handle, IntPtr.Zero);
            if (command != 0) SendMessage(form.Handle, 0x0112, new IntPtr(command), IntPtr.Zero);
        }
        internal static void RefreshSystemMenu(Form form)
        {
            if (form == null || !form.IsHandleCreated) return;
            IntPtr menu = GetSystemMenu(form.Handle, false);
            bool normal = form.WindowState == FormWindowState.Normal;
            // WinForms sees a borderless form and otherwise disables Size.
            EnableMenuItem(menu, 0xF000, normal ? 0U : 1U);
            EnableMenuItem(menu, 0xF010, normal ? 0U : 1U);
            EnableMenuItem(menu, 0xF120, normal ? 1U : 0U);
            EnableMenuItem(menu, 0xF030, form.WindowState == FormWindowState.Maximized ? 1U : 0U);
            EnableMenuItem(menu, 0xF020, form.WindowState == FormWindowState.Minimized ? 1U : 0U);
        }
        internal static string RouteFromSource(Uri origin, string source)
        {
            Uri uri;
            if (origin == null || !Uri.TryCreate(source, UriKind.Absolute, out uri)
                || uri.Scheme != origin.Scheme || uri.Host != origin.Host || uri.Port != origin.Port
                || uri.UserInfo.Length != 0 || uri.Query.Length != 0
                || uri.AbsolutePath != "/" && uri.AbsolutePath != "/index.html") return null;
            string route = uri.Fragment.Length > 0 ? uri.Fragment.Substring(1) : "live";
            return IsRoute(route) ? route : "live";
        }
        internal static bool IsRoute(string route)
        {
            return route == "live" || route == "library" || route == "champions" || route == "synergy" || route == "compare" || route == "stats";
        }
        internal static GraphicsPath RoundedPath(RectangleF bounds, float radius)
        {
            var path = new GraphicsPath();
            if (bounds.Width <= 0 || bounds.Height <= 0) return path;
            radius = Math.Max(0, Math.Min(radius, Math.Min(bounds.Width, bounds.Height) / 2));
            if (radius < 0.5F) { path.AddRectangle(bounds); return path; }
            float size = radius * 2;
            path.AddArc(bounds.Left, bounds.Top, size, size, 180, 90);
            path.AddArc(bounds.Right - size, bounds.Top, size, size, 270, 90);
            path.AddArc(bounds.Right - size, bounds.Bottom - size, size, size, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - size, size, size, 90, 90);
            path.CloseFigure();
            return path;
        }
        internal static void RoundWindow(Control control, int radius)
        {
            if (control.Width < 1 || control.Height < 1) return;
            Region previous = control.Region;
            using (var outline = RoundedPath(new RectangleF(0, 0, control.Width, control.Height), radius))
                control.Region = new Region(outline);
            if (previous != null) previous.Dispose();
        }
        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool ok, string text) { if (!ok) throw new InvalidOperationException(text); checks++; };
            var bounds = new Rectangle(-1280, -120, 1280, 900);
            foreach (int dpi in new[] { 96, 144, 192 })
            {
                check(HitTest(bounds, new Point(bounds.Left + 1, bounds.Top + 1), false, dpi) == 13, "Custom caption lost negative-coordinate resize corner.");
                check(HitTest(bounds, new Point(bounds.Right - 1, bounds.Bottom - 1), false, dpi) == 17, "Custom caption lost bottom resize corner.");
                check(HitTest(bounds, new Point(bounds.Left + 100, bounds.Top + 1), false, dpi) == 12, "Custom caption lost top resize border.");
                check(HitTest(bounds, new Point(bounds.Left + 100, bounds.Top + 100), false, dpi) == 1, "Custom caption intercepted content.");
                check(HitTest(bounds, new Point(bounds.Left + 1, bounds.Top + 1), true, dpi) == 1, "Maximized caption enabled resizing.");
            }
            var work = new Rectangle(-1280, 0, 1280, 860);
            check(ResolveClientBounds(bounds, work, true) == work && ResolveClientBounds(bounds, work, false) == bounds, "Maximized content covered the taskbar or normal bounds changed.");
            var origin = new Uri("http://127.0.0.1:43123/");
            foreach (string route in new[] { "live", "library", "champions", "synergy", "compare", "stats" })
                check(RouteFromSource(origin, "http://127.0.0.1:43123/#" + route) == route, "Native navigation lost a page.");
            foreach (string bad in new[] { "https://127.0.0.1:43123/#live", "http://localhost:43123/#live", "http://127.0.0.1:43124/#live", "http://user@127.0.0.1:43123/#live", "http://127.0.0.1:43123/not-app.html#live", "http://127.0.0.1:43123/?action=close#live", "javascript:close()" })
                check(RouteFromSource(origin, bad) == null, "Native caption accepted a foreign source.");
            check(RouteFromSource(origin, "http://127.0.0.1:43123/#session=private") == "live", "Native caption rejected the bootstrap fragment.");
            foreach (int width in new[] { 18, 280, 324, 460 })
            foreach (int scale in new[] { 85, 100, 130 })
            using (var path = RoundedPath(new RectangleF(0, 0, width, 720), (int)Math.Round(12 * scale / 100.0)))
            using (var region = new Region(path))
            {
                check(!region.IsVisible(0, 0) && region.IsVisible(width / 2, 1) && region.IsVisible(width / 2, 360), "Rounded sidebar clipped its content or kept a square corner.");
                check(path.GetBounds().Width <= width + .01F, "Rounded idle strip escaped its width.");
            }
            return checks;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect
        {
            internal int Left, Top, Right, Bottom;
            internal NativeRect(Rectangle value) { Left = value.Left; Top = value.Top; Right = value.Right; Bottom = value.Bottom; }
            internal Rectangle Rectangle { get { return System.Drawing.Rectangle.FromLTRB(Left, Top, Right, Bottom); } }
        }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out NativeRect rectangle);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr handle, int index, IntPtr value);
        [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr handle);
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetSystemMenu(IntPtr handle, bool revert);
        [DllImport("user32.dll")] private static extern uint EnableMenuItem(IntPtr menu, uint item, uint flags);
        [DllImport("user32.dll")] private static extern int TrackPopupMenu(IntPtr menu, uint flags, int x, int y, int reserved, IntPtr owner, IntPtr rectangle);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);
    }
}
