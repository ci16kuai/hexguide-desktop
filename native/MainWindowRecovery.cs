using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.CompilerServices;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // Recovery belongs to the owning UI thread. Valid geometry is left alone;
    // explicit opening and passive geometry checks are separate entry points.
    internal static class MainWindowRecovery
    {
        private sealed class MinimumConstraint
        {
            internal Size Nominal, LastApplied;
            internal MinimumConstraint(Size minimum) { Nominal = LastApplied = minimum; }
        }

        // A small display may require a temporarily smaller effective minimum.
        // Remember the nominal constraint without keeping a disposed Form alive.
        private static readonly ConditionalWeakTable<Form, MinimumConstraint> Minimums =
            new ConditionalWeakTable<Form, MinimumConstraint>();

        internal static void Apply(Form form)
        {
            RequireOwnerThread(form);
            if (form.IsDisposed || form.Disposing) return;
            if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
            form.Show();
            EnsureOnScreen(form);
            if (!form.IsDisposed && !form.Disposing) form.Activate();
        }

        // Safe for deferred Activated/Resize checks: it cannot open a hidden
        // form, restore a minimized form, or disturb a maximized layout.
        internal static void EnsureOnScreen(Form form)
        {
            RequireOwnerThread(form);
            if (form.IsDisposed || form.Disposing || !form.Visible || form.WindowState != FormWindowState.Normal) return;
            Screen[] screens = Screen.AllScreens;
            var areas = new Rectangle[screens.Length];
            for (int i = 0; i < screens.Length; i++) areas[i] = screens[i].WorkingArea;
            int captionHeight = Math.Max(1, SystemInformation.CaptionHeight + SystemInformation.FrameBorderSize.Height);
            EnsureOnScreen(form, areas, Cursor.Position, captionHeight);
        }

        // The same adapter also accepts a captured environment for isolated
        // Form fixtures; tests never need to change real display settings.
        internal static void EnsureOnScreen(Form form, Rectangle[] workingAreas, Point preferredPoint, int captionHeight)
        {
            RequireOwnerThread(form);
            if (form.IsDisposed || form.Disposing || !form.Visible || form.WindowState != FormWindowState.Normal) return;
            var constraint = Minimums.GetValue(form, delegate(Form owner) { return new MinimumConstraint(owner.MinimumSize); });
            // Respect a later caller-supplied constraint instead of confusing it
            // with a minimum which this module reduced on a smaller display.
            if (form.MinimumSize != constraint.LastApplied) constraint.Nominal = constraint.LastApplied = form.MinimumSize;
            bool minimumWasReduced = constraint.LastApplied != constraint.Nominal;
            Rectangle current = form.Bounds;
            Rectangle recovered = ResolveBounds(current, constraint.Nominal, workingAreas, preferredPoint, captionHeight);
            if (recovered == current && !minimumWasReduced) return;
            Size effectiveMinimum = ResolveMinimumSize(recovered, constraint.Nominal, workingAreas, captionHeight);
            var finalBounds = new Rectangle(recovered.Location, new Size(Math.Max(recovered.Width, effectiveMinimum.Width),
                Math.Max(recovered.Height, effectiveMinimum.Height)));
            // Restoring an oversized MinimumSize immediately would make
            // WinForms enlarge Bounds again and undo the screen-size recovery.
            constraint.LastApplied = effectiveMinimum;
            if (form.MinimumSize != effectiveMinimum) form.MinimumSize = effectiveMinimum;
            if (form.Bounds != finalBounds) form.Bounds = finalBounds;
        }

        // Pure geometry policy. All rectangles and captionHeight use the same
        // coordinate space. No screens means no proposed geometry change.
        internal static Rectangle ResolveBounds(Rectangle bounds, Size minimumSize, Rectangle[] workingAreas,
            Point preferredPoint, int captionHeight)
        {
            var areas = UsableAreas(workingAreas);
            if (areas.Count == 0 || HasOperableCaption(bounds, areas, captionHeight)) return bounds;
            Rectangle area = NearestArea(areas, preferredPoint);
            int width = Math.Min(area.Width, Math.Max(1, Math.Max(bounds.Width, minimumSize.Width)));
            int height = Math.Min(area.Height, Math.Max(1, Math.Max(bounds.Height, minimumSize.Height)));
            return new Rectangle(area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height);
        }

        // Restore a previously reduced minimum only as far as the caption's
        // actual monitor and current position permit. Mouse movement does not
        // participate, and existing partially off-screen bounds never grow
        // farther off-screen merely to restore a nominal minimum.
        internal static Size ResolveMinimumSize(Rectangle bounds, Size nominalMinimum, Rectangle[] workingAreas, int captionHeight)
        {
            Rectangle area;
            long width = Math.Max(0, bounds.Width), height = Math.Max(0, bounds.Height);
            if (TryCaptionArea(bounds, UsableAreas(workingAreas), captionHeight, out area))
            {
                width = Math.Max(width, (long)area.X + area.Width - bounds.X);
                height = Math.Max(height, (long)area.Y + area.Height - bounds.Y);
            }
            return new Size((int)Math.Min(Math.Max(0, nominalMinimum.Width), width),
                (int)Math.Min(Math.Max(0, nominalMinimum.Height), height));
        }

        private static void RequireOwnerThread(Form form)
        {
            if (form == null) throw new ArgumentNullException("form");
            if (!form.IsDisposed && form.InvokeRequired)
                throw new InvalidOperationException("Window recovery must run on the form's owning UI thread.");
        }

        private static List<Rectangle> UsableAreas(Rectangle[] workingAreas)
        {
            var result = new List<Rectangle>();
            if (workingAreas != null)
                foreach (Rectangle area in workingAreas)
                    if (area.Width > 0 && area.Height > 0
                        && (long)area.X + area.Width <= int.MaxValue && (long)area.Y + area.Height <= int.MaxValue)
                        result.Add(area);
            return result;
        }

        private static bool HasOperableCaption(Rectangle bounds, List<Rectangle> areas, int captionHeight)
        {
            Rectangle area;
            return TryCaptionArea(bounds, areas, captionHeight, out area);
        }

        private static bool TryCaptionArea(Rectangle bounds, List<Rectangle> areas, int captionHeight, out Rectangle chosen)
        {
            chosen = Rectangle.Empty;
            if (bounds.Width <= 0 || bounds.Height <= 0) return false;
            long bandHeight = Math.Min(bounds.Height, Math.Max(1, captionHeight));
            // A few invisible frame pixels may extend above the work area.
            // Exclude the icon and a conservative DPI-scaled control-box span:
            // visible minimize/maximize/close buttons alone are not draggable.
            long dragLeft = (long)bounds.X + Math.Min(bandHeight, bounds.Width / 4);
            long dragRight = (long)bounds.X + bounds.Width - Math.Min(bandHeight * 5, bounds.Width / 2);
            long requiredHeight = Math.Max(1, (bandHeight * 2 + 2) / 3);
            long requiredWidth = Math.Min(dragRight - dragLeft, Math.Max(48, bandHeight * 3));
            long bestCoverage = 0;
            foreach (Rectangle area in areas)
            {
                long width = Math.Min(dragRight, (long)area.X + area.Width) - Math.Max(dragLeft, area.X);
                long height = Math.Min((long)bounds.Y + bandHeight, (long)area.Y + area.Height) - Math.Max((long)bounds.Y, area.Y);
                if (width >= requiredWidth && height >= requiredHeight && width * height > bestCoverage)
                { chosen = area; bestCoverage = width * height; }
            }
            return bestCoverage > 0;
        }

        private static Rectangle NearestArea(List<Rectangle> areas, Point point)
        {
            Rectangle nearest = areas[0];
            double nearestDistance = double.MaxValue;
            foreach (Rectangle area in areas)
            {
                long right = (long)area.X + area.Width - 1, bottom = (long)area.Y + area.Height - 1;
                long x = Math.Max((long)area.X, Math.Min(right, point.X));
                long y = Math.Max((long)area.Y, Math.Min(bottom, point.Y));
                double dx = (long)point.X - x, dy = (long)point.Y - y;
                double distance = dx * dx + dy * dy;
                if (distance < nearestDistance) { nearest = area; nearestDistance = distance; }
            }
            return nearest;
        }
    }
}
