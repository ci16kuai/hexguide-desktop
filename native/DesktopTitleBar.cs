using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // This caption belongs to the host, outside the editable web document.
    // Its buttons remain available during page dialogs, failures and editing.
    internal sealed class DesktopTitleBar : UserControl
    {
        private const float VisualScale = 1.1F;
        private const int CaptionRowHeight = 44;
        private const int NavigationRowHeight = 38;
        private static readonly Color DividerColor = Color.FromArgb(41, 62, 78);
        private readonly Bitmap appIconBitmap;
        private readonly List<CaptionButton> navigation = new List<CaptionButton>();
        private readonly List<CaptionButton> actions = new List<CaptionButton>();
        private readonly ToolTip hints = new ToolTip();
        private readonly ContextMenuStrip menu = new ContextMenuStrip();
        private readonly ToolStripMenuItem sidebarItem, statusItem;
        private CaptionButton maximum;
        private bool arranging;
        private string fontFamily = "";
        internal event Action<string> ActionRequested;
        internal string Page { get; private set; }
        internal DesktopTitleBar(Icon icon)
        {
            appIconBitmap = icon == null ? null : icon.ToBitmap();
            Dock = DockStyle.Top;
            Height = ScaleMetric(CaptionRowHeight, 96);
            BackColor = Color.FromArgb(12, 25, 38);
            ForeColor = Color.FromArgb(166, 189, 205);
            Font = new Font("Microsoft YaHei", 9.75F * VisualScale);
            AccessibleName = "海克斯指南窗口标题栏";
            AccessibleRole = AccessibleRole.TitleBar;
            TabStop = false;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            string[] routes = { "live", "library", "champions", "synergy", "compare", "stats" };
            string[] names = { "我的这一局", "海克斯库", "英雄适配", "联动查询", "三选一推荐", "英雄胜率" };
            for (int i = 0; i < routes.Length; i++)
            {
                var button = MakeButton(routes[i], names[i], routes[i]);
                button.AccessibleRole = AccessibleRole.PageTab;
                navigation.Add(button);
            }
            MakeAction("appearance", "界面设置", "settings");
            MakeAction("more", "更多操作", "more");
            MakeAction("minimize", "最小化", "minimize");
            maximum = MakeAction("maximize", "最大化", "maximize");
            MakeAction("close", "关闭并收进托盘", "close");
            menu.BackColor = BackColor;
            menu.ForeColor = Color.FromArgb(212, 227, 236);
            menu.Font = Font;
            menu.Renderer = new ToolStripProfessionalRenderer(new CaptionMenuColors());
            sidebarItem = AddMenu("显示 / 收起游戏侧栏", "sidebar");
            AddMenu("返回游戏", "game");
            menu.Items.Add(new ToolStripSeparator());
            AddMenu("编辑界面", "layout");
            AddMenu("刷新页面", "refresh");
            AddMenu("更新公告", "announcements");
            AddMenu("数据与版本", "sources");
            menu.Items.Add(new ToolStripSeparator());
            statusItem = new ToolStripMenuItem("Alt + Shift + H：仅助手或游戏前台可用") { Enabled = false };
            menu.Items.Add(statusItem);
            AddMenu("收起到后台", "background");
            AddMenu("完全退出", "exit");
            SetPage("live");
            SetPageReady(false);
        }
        private CaptionButton MakeButton(string action, string text, string kind)
        {
            var button = new CaptionButton { Text = text, IconKind = kind, AccessibleName = text, BackColor = BackColor, ForeColor = ForeColor, Font = Font, TabIndex = Controls.Count };
            button.Click += delegate
            {
                if (action == "more") menu.Show(button, new Point(Math.Min(0, button.Width - menu.Width), button.Height));
                else if (ActionRequested != null) ActionRequested(action);
            };
            Controls.Add(button);
            hints.SetToolTip(button, text);
            return button;
        }
        private CaptionButton MakeAction(string action, string name, string kind)
        {
            var button = MakeButton(action, "", kind);
            button.AccessibleName = name;
            hints.SetToolTip(button, name);
            actions.Add(button);
            return button;
        }
        private ToolStripMenuItem AddMenu(string text, string action)
        {
            var item = new ToolStripMenuItem(text);
            item.Click += delegate { if (ActionRequested != null) ActionRequested(action); };
            menu.Items.Add(item);
            return item;
        }
        internal void SetPage(string page)
        {
            if (!MainWindowChrome.IsRoute(page)) return;
            Page = page;
            foreach (var button in navigation) { button.Selected = button.IconKind == page; button.Invalidate(); }
        }
        internal void SetPageReady(bool ready)
        {
            foreach (var button in navigation) button.Enabled = ready;
        }
        internal void SetMaximized(bool maximized)
        {
            maximum.IconKind = maximized ? "restore" : "maximize";
            maximum.AccessibleName = maximized ? "还原窗口" : "最大化";
            hints.SetToolTip(maximum, maximum.AccessibleName);
            maximum.Invalidate();
        }
        internal void SetSidebarStatus(bool visible, string hint)
        {
            sidebarItem.Text = visible ? "收起游戏侧栏" : "显示游戏侧栏";
            statusItem.Text = hint;
        }
        internal void ApplyAppearance(Dictionary<string, object> model)
        {
            string value = ModelValue.Text(ModelValue.Object(ModelValue.Object(model, "appearance"), "main"), "fontFamily");
            if (value == fontFamily) return;
            fontFamily = value;
            string family = value == "simsun" ? "宋体" : value == "dengxian" ? "等线" : value == "system" ? "Microsoft YaHei UI" : "Microsoft YaHei";
            Font previous = Font;
            Font = new Font(family, 9.75F * VisualScale);
            foreach (Control button in Controls) button.Font = Font;
            menu.Font = Font;
            if (previous != null) previous.Dispose();
            Arrange();
        }
        private static int ScaleMetric(int value, int dpi) { return Math.Max(1, (int)Math.Round(value * VisualScale * Math.Max(96, dpi) / 96.0)); }
        private int S(int value) { return ScaleMetric(value, DeviceDpi); }
        private int NavigationButtonWidth(CaptionButton button)
        {
            return TextRenderer.MeasureText(button.Text, Font, Size.Empty, TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Width + S(35);
        }
        private void Arrange()
        {
            if (arranging || actions.Count != 5) return;
            arranging = true;
            try
            {
                int actionWidth = 2 * S(34) + S(14) + 3 * S(42);
                int navigationWidth = 0;
                foreach (var button in navigation) navigationWidth += NavigationButtonWidth(button) + S(4);
                if (navigation.Count > 0) navigationWidth -= S(4);
                // Measure the enlarged labels so the normal window stays in one
                // row when it fits and switches rows before controls overlap.
                bool narrow = ClientSize.Width < S(178) + navigationWidth + S(20) + actionWidth;
                int top = S(CaptionRowHeight), desired = narrow ? top + S(NavigationRowHeight) : top;
                if (Height != desired) Height = desired;
                int actionX = Width - actionWidth;
                for (int i = 0; i < actions.Count; i++)
                {
                    int width = i < 2 ? S(34) : S(42);
                    int gap = i == 2 ? S(14) : 0;
                    actionX += gap;
                    int height = S(34);
                    actions[i].Bounds = new Rectangle(actionX, (top - height) / 2, width, height);
                    actionX += width;
                }
                int x = narrow ? S(14) : S(178), y = narrow ? top : 0, navHeight = narrow ? S(NavigationRowHeight) : top;
                foreach (var button in navigation)
                {
                    int width = NavigationButtonWidth(button);
                    button.Bounds = new Rectangle(x, y, width, navHeight);
                    x += width + S(4);
                }
            }
            finally { arranging = false; }
            Invalidate();
        }
        protected override void OnResize(EventArgs e) { base.OnResize(e); Arrange(); }
        protected override void OnDpiChangedAfterParent(EventArgs e) { base.OnDpiChangedAfterParent(e); Arrange(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            int top = S(CaptionRowHeight);
            if (appIconBitmap != null)
            {
                var state = e.Graphics.Save();
                try
                {
                    e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    e.Graphics.DrawImage(appIconBitmap, new Rectangle(S(20), (top - S(32)) / 2, S(32), S(32)));
                }
                finally { e.Graphics.Restore(state); }
            }
            using (var font = new Font(Font.FontFamily, 13.5F * VisualScale, FontStyle.Bold))
            {
                var rectangle = new Rectangle(S(62), 0, S(112), top);
                TextRenderer.DrawText(e.Graphics, "海克斯指南", font, rectangle, Color.FromArgb(218, 229, 236), TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
            }
            using (var pen = new Pen(DividerColor)) e.Graphics.DrawLine(pen, 0, Height - 1, Width - 1, Height - 1);
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            Form form = FindForm();
            if (e.Button == MouseButtons.Left)
            {
                if (e.Clicks == 2) { if (ActionRequested != null) ActionRequested("maximize"); }
                else MainWindowChrome.Drag(form);
            }
            else if (e.Button == MouseButtons.Right) MainWindowChrome.ShowSystemMenu(form, PointToScreen(e.Location));
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { hints.Dispose(); menu.Dispose(); Font.Dispose(); if (appIconBitmap != null) appIconBitmap.Dispose(); }
            base.Dispose(disposing);
        }
        internal static int ValidateFixtures()
        {
            int checks = 0;
            using (var header = new DesktopTitleBar(null))
            {
                foreach (int width in new[] { 860, 1120, 1320, 1800 })
                {
                    header.Width = width;
                    header.Arrange();
                    foreach (Control button in header.Controls)
                    {
                        if (!header.ClientRectangle.Contains(button.Bounds) || button.AccessibleName.Length == 0) throw new InvalidOperationException("Native caption has clipped or unnamed controls.");
                        checks++;
                    }
                    for (int i = 0; i < header.Controls.Count; i++) for (int j = i + 1; j < header.Controls.Count; j++)
                    {
                        if (header.Controls[i].Bounds.IntersectsWith(header.Controls[j].Bounds)) throw new InvalidOperationException("Native caption controls overlap.");
                        checks++;
                    }
                }
                header.SetPage("stats");
                if (header.Page != "stats") throw new InvalidOperationException("Native caption did not follow navigation.");
                header.SetPage("javascript:close()");
                if (header.Page != "stats") throw new InvalidOperationException("Native caption accepted an unsupported page.");
                checks += 2;
            }
            return checks;
        }
        private sealed class CaptionMenuColors : ProfessionalColorTable
        {
            public override Color ToolStripDropDownBackground { get { return Color.FromArgb(15, 31, 44); } }
            public override Color ImageMarginGradientBegin { get { return ToolStripDropDownBackground; } }
            public override Color ImageMarginGradientMiddle { get { return ToolStripDropDownBackground; } }
            public override Color ImageMarginGradientEnd { get { return ToolStripDropDownBackground; } }
            public override Color MenuItemSelected { get { return Color.FromArgb(34, 59, 77); } }
            public override Color MenuItemBorder { get { return Color.FromArgb(58, 85, 105); } }
            public override Color MenuBorder { get { return Color.FromArgb(58, 85, 105); } }
        }
        private sealed class CaptionButton : Button
        {
            internal string IconKind = "";
            internal bool Selected;
            private bool hover, pressed;
            internal CaptionButton()
            {
                FlatStyle = FlatStyle.Flat;
                FlatAppearance.BorderSize = 0;
                UseVisualStyleBackColor = false;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            }
            protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { hover = pressed = false; Invalidate(); base.OnMouseLeave(e); }
            protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
            protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
            protected override void OnPaint(PaintEventArgs e)
            {
                Color background = hover ? IconKind == "close" ? Color.FromArgb(188, 58, 70) : Color.FromArgb(29, 49, 65) : BackColor;
                if (pressed) background = ControlPaint.Light(background, .1F);
                e.Graphics.Clear(background);
                Color color = !Enabled ? Color.FromArgb(114, 139, 156) : Selected ? Color.FromArgb(220, 185, 111) : ForeColor;
                int size = ScaleMetric(15, DeviceDpi);
                if (Text.Length > 0)
                {
                    int gap = ScaleMetric(6, DeviceDpi);
                    DrawIcon(e.Graphics, IconKind, color, new Rectangle(gap, (Height - size) / 2, size, size));
                    using (var font = new Font(Font, Selected ? FontStyle.Bold : FontStyle.Regular))
                        TextRenderer.DrawText(e.Graphics, Text, font, new Rectangle(size + gap * 2, 0, Width - size - gap * 2, Height), color, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
                    // Each tab paints over the host surface, so continue the same
                    // bottom edge through it and anchor selection on that edge.
                    using (var pen = new Pen(DividerColor)) e.Graphics.DrawLine(pen, 0, Height - 1, Width - 1, Height - 1);
                    if (Selected)
                    {
                        int thickness = ScaleMetric(2, DeviceDpi), inset = ScaleMetric(4, DeviceDpi);
                        using (var brush = new SolidBrush(color)) e.Graphics.FillRectangle(brush, inset, Height - thickness, Width - inset * 2, thickness);
                    }
                }
                else DrawIcon(e.Graphics, IconKind, color, new Rectangle((Width - size) / 2, (Height - size) / 2, size, size));
                if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -ScaleMetric(4, DeviceDpi), -ScaleMetric(4, DeviceDpi)), color, background);
            }
            private static void DrawIcon(Graphics graphics, string kind, Color color, Rectangle box)
            {
                var state = graphics.Save();
                try
                {
                    graphics.TranslateTransform(box.X, box.Y);
                    graphics.ScaleTransform(box.Width / 24F, box.Height / 24F);
                    // Center the chart paths at (12, 12), matching the other
                    // navigation glyphs, instead of their original (12.5, 11.5).
                    if (kind == "compare" || kind == "stats") graphics.TranslateTransform(-.5F, .5F);
                    graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    using (var pen = new Pen(color, 1.5F))
                    using (var brush = new SolidBrush(color))
                    {
                        if (kind == "close") { graphics.DrawLine(pen, 6, 6, 18, 18); graphics.DrawLine(pen, 18, 6, 6, 18); }
                        else if (kind == "minimize") graphics.DrawLine(pen, 5, 12, 19, 12);
                        else if (kind == "maximize") graphics.DrawRectangle(pen, 5, 5, 14, 14);
                        else if (kind == "restore") { graphics.DrawRectangle(pen, 5, 8, 11, 11); graphics.DrawLines(pen, new[] { new Point(8, 6), new Point(8, 4), new Point(20, 4), new Point(20, 16), new Point(18, 16) }); }
                        else if (kind == "more") { foreach (int x in new[] { 5, 12, 19 }) graphics.FillEllipse(brush, x - 1, 11, 2, 2); }
                        else if (kind == "settings") { graphics.DrawLine(pen, 3, 7, 21, 7); graphics.DrawLine(pen, 3, 17, 21, 17); graphics.FillEllipse(brush, 6, 4, 6, 6); graphics.FillEllipse(brush, 12, 14, 6, 6); }
                        else if (kind == "live") { graphics.DrawEllipse(pen, 4, 4, 16, 16); graphics.DrawEllipse(pen, 9, 9, 6, 6); graphics.DrawLine(pen, 12, 1, 12, 6); graphics.DrawLine(pen, 12, 18, 12, 23); graphics.DrawLine(pen, 1, 12, 6, 12); graphics.DrawLine(pen, 18, 12, 23, 12); }
                        else if (kind == "compare") { graphics.DrawRectangle(pen, 2, 6, 5, 14); graphics.DrawRectangle(pen, 10, 3, 5, 17); graphics.DrawRectangle(pen, 18, 6, 5, 14); }
                        else if (kind == "stats") { graphics.DrawLine(pen, 3, 21, 22, 21); graphics.DrawLine(pen, 6, 18, 6, 12); graphics.DrawLine(pen, 13, 18, 13, 7); graphics.DrawLine(pen, 20, 18, 20, 2); }
                        else if (kind == "synergy") { graphics.DrawPolygon(pen, new[] { new Point(6, 2), new Point(11, 5), new Point(11, 11), new Point(6, 14), new Point(1, 11), new Point(1, 5) }); graphics.DrawPolygon(pen, new[] { new Point(18, 10), new Point(23, 13), new Point(23, 19), new Point(18, 22), new Point(13, 19), new Point(13, 13) }); graphics.DrawLine(pen, 10, 10, 15, 14); }
                        else { graphics.DrawPolygon(pen, new[] { new Point(12, 2), new Point(21, 7), new Point(21, 17), new Point(12, 22), new Point(3, 17), new Point(3, 7) }); graphics.DrawPolygon(pen, new[] { new Point(12, 7), new Point(16, 12), new Point(12, 17), new Point(8, 12) }); }
                    }
                }
                finally { graphics.Restore(state); }
            }
        }
    }
}
