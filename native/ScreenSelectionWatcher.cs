using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // Experimental, screen-only observation. No input is sent, no hook is
    // installed, and no game memory, screenshot file or player identity is read.
    internal sealed class ScreenSelectionWatcher : IDisposable
    {
        private readonly Timer timer;
        private readonly ScreenSelectionDecision decision = new ScreenSelectionDecision();
        private ScreenSelectionObservation observation;
        private bool disposed, lastButtonDown, buttonKnown, eligible, hadGameFocus;
        private long nextFrameAt, lastSeenCapture, nextIdentityCheck;
        private IntPtr identityWindow;
        private bool identityVerified;
        private Dictionary<string, object> lastAttempt;
        internal event Action<Dictionary<string, object>> SelectionObserved;
        internal event Action<string> StatusChanged;
        internal string StatusCode { get; private set; }

        internal ScreenSelectionWatcher()
        {
            StatusCode = "waiting";
            timer = new Timer { Interval = 25 };
            timer.Tick += delegate { Poll(); };
        }

        internal void UpdateModel(Dictionary<string, object> model)
        {
            if (disposed) return;
            var ocr = ModelValue.Object(model, "ocr");
            var mode = ModelValue.Object(model, "mode");
            bool nextEligible = ModelValue.Boolean(ocr, "enabled") && ModelValue.Text(model, "phase") == "InProgress"
                && ModelValue.Text(model, "stage") != "loading"
                && (!ModelValue.Boolean(mode, "known") || ModelValue.Boolean(mode, "isMayhem"));
            if (!nextEligible)
            {
                bool wasEligible = eligible;
                eligible = false; buttonKnown = false; hadGameFocus = false;
                Suspend("paused", wasEligible);
                return;
            }
            if (!eligible) decision.Invalidate(Now()); // No input history exists before this eligible interval.
            eligible = true;
            // While OCR is processing, observe only button edges in the verified
            // foreground game. This closes the capture-to-result reroll gap.
            timer.Start();
            ScreenSelectionObservation next;
            if (!ScreenSelectionObservation.TryRead(ModelValue.Object(model, "selection"), Now(), out next))
            { Suspend("waiting", observation != null); return; }
            if (observation != null)
            {
                if (observation.Identity() != next.Identity()) { Suspend("offers-changed", true); return; }
                if (observation.CapturedAt == next.CapturedAt || PreservePendingObservation(observation, next, decision)) return;
            }
            // A model cached before a click/roll must not arm the watcher again.
            if (next.CapturedAt <= lastSeenCapture) return;
            if (!decision.ConsiderCapture(next.CapturedAt, next.Identity())) { SetStatus("settling"); return; }
            lastSeenCapture = next.CapturedAt;
            observation = next;
            decision.Arm(next.CapturedAt);
            nextFrameAt = 0;
            if (buttonKnown && lastButtonDown) { Suspend("held-before-arm", true); return; }
            SetStatus("baseline");
        }

        internal void CancelForLocalAction() { Suspend("local-action", true); }

        internal static bool PreservePendingObservation(ScreenSelectionObservation active, ScreenSelectionObservation incoming, ScreenSelectionDecision state)
        {
            return active != null && incoming != null && state.Pending && !state.Invalid
                && active.Identity() == incoming.Identity();
        }

        private void SetStatus(string code)
        {
            if (StatusCode == code) return;
            StatusCode = code;
            var handler = StatusChanged;
            if (handler != null) handler(StatusMessage(code));
        }

        private static string StatusMessage(string code)
        {
            switch (code)
            {
                case "baseline": return "屏幕自动确认（实验）：正在核对本轮卡片";
                case "ready": return "屏幕自动确认（实验）：已就绪，等待游戏内选择";
                case "pending": return "屏幕自动确认（实验）：正在核对选择特效";
                case "feedback": return "屏幕自动确认（实验）：已观察到变化，等待卡片收起";
                case "observed": return "屏幕自动确认（实验）：正在记录本次选择";
                case "paused": return "屏幕自动确认（实验）：识别已暂停";
                case "waiting": return "屏幕自动确认（实验）：等待新的完整三选一";
                case "settling": return "屏幕自动确认（实验）：等待操作结束后的两次重新识别";
                default: return "屏幕自动确认（实验）：本次证据不足，可手动确认或等待重新识别";
            }
        }

        private void Suspend(string code, bool invalidate)
        {
            if (decision.BaselineFrames > 0 || decision.Pending || decision.FeedbackFrames > 0)
                lastAttempt = DecisionDiagnostics(code);
            if (observation != null && invalidate) decision.Invalidate(Now());
            observation = null;
            decision.Reset();
            if (!eligible) timer.Stop();
            SetStatus(code);
        }

        private static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
        private static bool ButtonDown() { return (GetAsyncKeyState(0x01) & 0x8000) != 0; }

        private void Poll()
        {
            if (disposed || !eligible) return;
            long now = Now();
            try
            {
                IntPtr foreground = GetForegroundWindow();
                if (foreground != identityWindow || now >= nextIdentityCheck)
                {
                    identityWindow = foreground;
                    identityVerified = GameWindow.IsVerifiedGame(foreground);
                    nextIdentityCheck = now + 1000;
                }
                if (!identityVerified)
                {
                    if (hadGameFocus || observation != null) { decision.Invalidate(now); Suspend("focus-changed", false); }
                    hadGameFocus = false; buttonKnown = false;
                    return; // Do not observe buttons in browsers or other apps.
                }
                hadGameFocus = true;
                if (observation != null && (now < observation.CapturedAt || now - observation.CapturedAt > 30000))
                    Suspend("expired", true);
                if (observation != null && foreground != observation.Window) Suspend("focus-changed", true);
                bool down = ButtonDown();
                bool edge = buttonKnown ? down != lastButtonDown : down;
                buttonKnown = true;
                if (edge)
                {
                    PhysicalPoint point;
                    bool onGame = GetPhysicalCursorPos(out point) && RootWindow(WindowFromPhysicalPoint(point)) == foreground;
                    lastButtonDown = down;
                    if (observation == null)
                    {
                        // Any game click during the unarmed/OCR interval makes
                        // all earlier captures ineligible, even with a new token.
                        if (onGame) { decision.Invalidate(now); SetStatus("settling"); }
                        return;
                    }
                    int column = onGame ? observation.ColumnAt(point.X, point.Y) : -1;
                    if (!onGame || column < 0) { Suspend("outside-click", true); return; }
                    int[][] edgeFrame;
                    if (!TryCapture(observation, out edgeFrame)) { Suspend("geometry-or-occlusion", true); return; }
                    // Capture on both edges. A highlight already visible by
                    // release must not be mistaken for a NEW selection effect.
                    decision.Pointer(down, column, onGame, now, edgeFrame, observation.Signatures);
                    if (decision.Invalid) { Suspend("outside-click", true); return; }
                    if (decision.Pending) SetStatus("pending");
                }
                else lastButtonDown = down;
                if (observation == null) return;
                if (now < nextFrameAt) return;
                nextFrameAt = now + 65;
                int[][] signatures;
                if (!TryCapture(observation, out signatures)) { Suspend("geometry-or-occlusion", true); return; }
                decision.Frame(signatures, observation.Signatures, now);
                if (decision.Invalid) { Suspend("visual-evidence-incomplete", true); return; }
                if (decision.Ready) SetStatus("ready");
                if (decision.FeedbackFrames > 0) SetStatus("feedback");
                if (!decision.Complete) return;
                var evidence = observation.Evidence(decision.SelectedIndex, decision.ClickedAt, now,
                    decision.DismissedFrames, decision.FeedbackFrames);
                lastAttempt = DecisionDiagnostics("observed");
                decision.Invalidate(now);
                observation = null;
                // Keep the cheap foreground-game button observer alive while
                // waiting for the next round or a long-running OCR response.
                SetStatus("observed");
                var handler = SelectionObserved;
                if (handler != null) handler(evidence);
            }
            catch { Suspend("capture-unavailable", true); }
        }

        // This stays in memory and is bounded to counters and three RGB deltas.
        // It deliberately contains no window handles, identities, text or images.
        internal Dictionary<string, object> Diagnostics()
        {
            var current = DecisionDiagnostics(StatusCode);
            if (lastAttempt != null) current["lastAttempt"] = new Dictionary<string, object>(lastAttempt);
            return current;
        }

        private Dictionary<string, object> DecisionDiagnostics(string status)
        {
            return new Dictionary<string, object> {
                { "status", status }, { "baselineFrames", decision.BaselineFrames },
                { "feedbackFrames", decision.FeedbackFrames }, { "dismissedFrames", decision.DismissedFrames },
                { "pending", decision.Pending }, { "delta", (double[])decision.LastDelta.Clone() }
            };
        }

        private static IntPtr RootWindow(IntPtr window) { return window == IntPtr.Zero ? IntPtr.Zero : GetAncestor(window, 2); }

        private static bool TryCapture(ScreenSelectionObservation value, out int[][] signatures)
        {
            signatures = null;
            IntPtr previous = IntPtr.Zero;
            try
            {
                previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
                if (previous == IntPtr.Zero) previous = SetThreadDpiAwarenessContext(new IntPtr(-3));
                if (previous == IntPtr.Zero || !GameWindow.IsVerifiedGame(value.Window) || GetForegroundWindow() != value.Window
                    || !IsWindowVisible(value.Window) || IsIconic(value.Window)) return false;
                Rectangle client;
                if (!ClientBounds(value.Window, out client) || client != value.ClientBounds || !Unoccluded(value)) return false;
                var frames = new int[3][];
                for (int index = 0; index < 3; index++)
                {
                    Rectangle region = value.Regions[index];
                    if ((long)region.Width * region.Height > 2000000) return false;
                    using (var bitmap = new Bitmap(region.Width, region.Height, PixelFormat.Format32bppArgb))
                    {
                        using (var graphics = Graphics.FromImage(bitmap))
                            graphics.CopyFromScreen(client.Left + region.Left, client.Top + region.Top, 0, 0,
                                region.Size, CopyPixelOperation.SourceCopy);
                        frames[index] = ReadSignature(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                    }
                }
                Rectangle final;
                if (GetForegroundWindow() != value.Window || !ClientBounds(value.Window, out final)
                    || final != client || !Unoccluded(value)) return false;
                signatures = frames;
                return true;
            }
            finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        }

        internal static int[] ReadSignature(Bitmap image, Rectangle region)
        {
            using (var thumbnail = new Bitmap(8, 8, PixelFormat.Format32bppArgb))
            {
                using (var resize = Graphics.FromImage(thumbnail))
                {
                    resize.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    resize.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    resize.CompositingMode = CompositingMode.SourceCopy;
                    resize.DrawImage(image, new Rectangle(0, 0, 8, 8), region.X, region.Y, region.Width, region.Height, GraphicsUnit.Pixel);
                }
                var signature = new int[192];
                for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++)
                {
                    Color color = thumbnail.GetPixel(x, y);
                    int offset = (y * 8 + x) * 3;
                    signature[offset] = color.R; signature[offset + 1] = color.G; signature[offset + 2] = color.B;
                }
                return signature;
            }
        }

        private static bool ClientBounds(IntPtr window, out Rectangle bounds)
        {
            bounds = Rectangle.Empty;
            NativeRect client; var origin = new PhysicalPoint();
            if (!GetClientRect(window, out client) || !ClientToScreen(window, ref origin)) return false;
            int width = client.Right - client.Left, height = client.Bottom - client.Top;
            if (width < 640 || height < 360 || width > 8192 || height > 8192) return false;
            bounds = new Rectangle(origin.X, origin.Y, width, height);
            return true;
        }

        private static bool Unoccluded(ScreenSelectionObservation value)
        {
            // Reject any visible top-level window overlapping a sampled card.
            // Do not ignore our NOACTIVATE sidebar: it can cover game pixels.
            var visited = new HashSet<IntPtr>();
            IntPtr above = GetWindow(value.Window, 3);
            while (above != IntPtr.Zero)
            {
                if (visited.Count >= 256 || !visited.Add(above)) return false;
                IntPtr current = above;
                above = GetWindow(current, 3);
                if (!IsWindowVisible(current) || IsIconic(current)) continue;
                int cloaked;
                if (DwmGetWindowAttribute(current, 14, out cloaked, sizeof(int)) != 0) return false;
                if (cloaked != 0) continue;
                NativeRect frame;
                if (DwmGetWindowAttribute(current, 9, out frame, Marshal.SizeOf(typeof(NativeRect))) != 0
                    && !GetWindowRect(current, out frame)) return false;
                Rectangle bounds = Rectangle.FromLTRB(frame.Left, frame.Top, frame.Right, frame.Bottom);
                foreach (Rectangle region in value.Regions)
                {
                    Rectangle physical = region; physical.Offset(value.ClientBounds.Location);
                    if (bounds.IntersectsWith(physical)) return false;
                }
            }
            return true;
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            timer.Stop(); timer.Dispose();
            observation = null;
            decision.Invalidate(Now()); decision.Reset();
            lastAttempt = null;
            SelectionObserved = null; StatusChanged = null;
        }

        internal static int ValidateFixtures() { return ScreenSelectionDecision.ValidateFixtures(); }
        [StructLayout(LayoutKind.Sequential)] private struct NativeRect { internal int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct PhysicalPoint { internal int X, Y; }
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool GetPhysicalCursorPos(out PhysicalPoint point);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPhysicalPoint(PhysicalPoint point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out NativeRect rectangle);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref PhysicalPoint point);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rectangle);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out NativeRect value, int size);
    }

    internal sealed class ScreenSelectionObservation
    {
        internal string Token;
        internal object GameId;
        internal long Epoch, Revision, CapturedAt;
        internal IntPtr Window;
        internal Rectangle ClientBounds;
        internal Rectangle[] Regions;
        internal int[][] Signatures;
        internal string[] Ids;

        private static bool Number(Dictionary<string, object> value, string key, long minimum, long maximum, out long result)
        {
            result = 0;
            object raw;
            if (value == null || !value.TryGetValue(key, out raw) || raw == null || raw is bool) return false;
            if (!long.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out result)) return false;
            return result >= minimum && result <= maximum;
        }

        internal static bool TryRead(Dictionary<string, object> value, long now, out ScreenSelectionObservation observation)
        {
            observation = null;
            if (ModelValue.Text(value, "status") != "armed" || ModelValue.Text(value, "provider") != "screen"
                || !ModelValue.Boolean(value, "experimental")) return false;
            string token = ModelValue.Text(value, "offerToken");
            if (token.Length < 16 || token.Length > 128) return false;
            long epoch, revision, capturedAt;
            if (!Number(value, "gameEpoch", 0, long.MaxValue, out epoch) || !Number(value, "revision", 0, long.MaxValue, out revision)
                || !Number(value, "capturedAt", 1, long.MaxValue, out capturedAt) || capturedAt > now || now - capturedAt > 30000) return false;
            object gameId;
            if (!ModelValue.GameId(value, out gameId)) return false;
            var ids = ModelValue.Array(value, "ids");
            if (ids.Count != 3) return false;
            var names = new string[3];
            for (int index = 0; index < 3; index++)
            {
                string id = ids[index] as string;
                if (string.IsNullOrEmpty(id) || id.Length > 100 || (index > 0 && id == names[0]) || (index > 1 && id == names[1])) return false;
                names[index] = id;
            }
            var capture = ModelValue.Object(value, "capture");
            long width, height, originX, originY, handle;
            if (!Number(capture, "width", 640, 8192, out width) || !Number(capture, "height", 360, 8192, out height)
                || !Number(capture, "originX", -32768, 32768, out originX) || !Number(capture, "originY", -32768, 32768, out originY)
                || !Number(capture, "windowHandle", 1, long.MaxValue, out handle)) return false;
            var regions = ModelValue.Array(capture, "regions");
            if (regions.Count != 3) return false;
            var boxes = new Rectangle[3]; var signatures = new int[3][];
            for (int index = 0; index < 3; index++)
            {
                var region = regions[index] as Dictionary<string, object>;
                long column, x, y, regionWidth, regionHeight;
                if (!Number(region, "column", index, index, out column) || !Number(region, "x", 0, width, out x)
                    || !Number(region, "y", 0, height, out y) || !Number(region, "width", 8, width, out regionWidth)
                    || !Number(region, "height", 8, height, out regionHeight) || x + regionWidth > width || y + regionHeight > height) return false;
                var raw = ModelValue.Array(region, "signature");
                if (raw.Count != 192) return false;
                var signature = new int[192];
                for (int cell = 0; cell < 192; cell++)
                {
                    long number;
                    if (raw[cell] == null || raw[cell] is bool || !long.TryParse(Convert.ToString(raw[cell], CultureInfo.InvariantCulture), out number)
                        || number < 0 || number > 255) return false;
                    signature[cell] = (int)number;
                }
                boxes[index] = new Rectangle((int)x, (int)y, (int)regionWidth, (int)regionHeight);
                signatures[index] = signature;
                if (index > 0 && boxes[index - 1].Right >= boxes[index].Left) return false;
            }
            observation = new ScreenSelectionObservation { Token = token, GameId = gameId, Epoch = epoch, Revision = revision,
                CapturedAt = capturedAt, Window = new IntPtr(handle), ClientBounds = new Rectangle((int)originX, (int)originY, (int)width, (int)height),
                Regions = boxes, Signatures = signatures, Ids = names };
            return true;
        }

        internal int ColumnAt(int physicalX, int physicalY)
        {
            var point = new Point(physicalX - ClientBounds.Left, physicalY - ClientBounds.Top);
            for (int index = 0; index < Regions.Length; index++)
            {
                // Keep clicks away from card edges, reroll controls and gaps.
                Rectangle interior = Regions[index];
                interior.Inflate(-Math.Max(3, interior.Width / 30), -Math.Max(3, interior.Height / 40));
                if (interior.Contains(point)) return index;
            }
            return -1;
        }

        internal string Identity()
        {
            string identity = Token + "|" + (GameId as string ?? "null") + "|" + Epoch + "|" + Revision + "|" + string.Join("|", Ids)
                + "|" + Window.ToInt64() + "|" + ClientBounds.X + "|" + ClientBounds.Y
                + "|" + ClientBounds.Width + "|" + ClientBounds.Height;
            foreach (Rectangle region in Regions)
                identity += "|" + region.X + "|" + region.Y + "|" + region.Width + "|" + region.Height;
            return identity;
        }

        internal Dictionary<string, object> Evidence(int selectedIndex, long clickedAt, long observedAt, int stableFrames, int feedbackFrames)
        {
            return new Dictionary<string, object> {
                { "provider", "screen" }, { "offerToken", Token }, { "gameId", GameId }, { "gameEpoch", Epoch }, { "revision", Revision },
                { "ids", Ids }, { "selectedIndex", selectedIndex }, { "capturedAt", CapturedAt }, { "clickedAt", clickedAt }, { "observedAt", observedAt },
                { "evidence", new Dictionary<string, object> { { "click", true }, { "uniqueFeedback", true }, { "cardsDismissed", true },
                    { "stableFrames", stableFrames }, { "feedbackFrames", feedbackFrames } } }
            };
        }
    }

    // Deterministic state machine, independent of all real input and capture.
    // Thresholds are deliberately conservative and require real-match calibration.
    internal sealed class ScreenSelectionDecision
    {
        private int[][] preClick;
        private long invalidatedAt, pressedAt, lastFrameAt;
        private long witnessCapture, acceptedCapture;
        private string witnessIdentity;
        private int pressedColumn = -1;
        internal bool Invalid, Ready, Pending, Complete;
        internal int BaselineFrames, FeedbackFrames, DismissedFrames, SelectedIndex = -1;
        internal long ClickedAt;
        internal double[] LastDelta = new double[3];
        internal bool CanArm(long capturedAt)
        {
            return invalidatedAt == 0 ? capturedAt > 0 : capturedAt >= invalidatedAt + 2000 && capturedAt == acceptedCapture;
        }
        internal bool ConsiderCapture(long capturedAt, string identity)
        {
            if (invalidatedAt == 0) return capturedAt > 0;
            if (capturedAt < invalidatedAt + 2000 || capturedAt <= witnessCapture) return false;
            if (witnessIdentity != identity)
            {
                witnessIdentity = identity; witnessCapture = capturedAt;
                return false;
            }
            if (capturedAt - witnessCapture < 300) return false;
            acceptedCapture = capturedAt;
            return true;
        }
        internal void Invalidate(long now)
        {
            if (now > invalidatedAt)
            {
                invalidatedAt = now; witnessCapture = acceptedCapture = 0; witnessIdentity = null;
            }
            Invalid = true;
        }
        internal void Reset()
        {
            Invalid = Ready = Pending = Complete = false;
            BaselineFrames = FeedbackFrames = DismissedFrames = 0;
            pressedColumn = SelectedIndex = -1; pressedAt = lastFrameAt = ClickedAt = 0;
            preClick = null; LastDelta = new double[3];
        }
        internal void Arm(long capturedAt) { Reset(); if (!CanArm(capturedAt)) Invalid = true; }

        internal void Pointer(bool down, int column, bool onGame, long now, int[][] edgeFrame, int[][] baseline)
        {
            if (Invalid || Complete) return;
            if (!onGame || column < 0 || column > 2) { Invalidate(now); return; }
            if (!Valid(edgeFrame) || !Valid(baseline) || !PanelMatches(edgeFrame, baseline)) { Invalidate(now); return; }
            if (down)
            {
                if (!Ready || Pending || preClick == null || now - lastFrameAt > 180) { Invalidate(now); return; }
                pressedColumn = column; pressedAt = now; Ready = false;
            }
            else
            {
                if (pressedColumn != column || now - pressedAt > 1500 || now <= pressedAt) { Invalidate(now); return; }
                SelectedIndex = column; ClickedAt = now; Pending = true;
            }
            // This is the frame captured at this actual button edge, not the
            // preceding timer frame. Release refresh also excludes held-hover FX.
            preClick = Clone(edgeFrame);
            lastFrameAt = now;
        }

        internal void Frame(int[][] current, int[][] baseline, long now)
        {
            if (Invalid || Complete) return;
            if (!Valid(current) || !Valid(baseline)) { Invalidate(now); return; }
            bool panelMatches = true;
            for (int index = 0; index < 3; index++)
            {
                LastDelta[index] = Difference(current[index], baseline[index]);
                panelMatches &= LastDelta[index] <= 10 && CloseFraction(current[index], baseline[index]) >= .78;
            }
            if (!Pending)
            {
                if (pressedColumn >= 0) { if (now - pressedAt > 1500) Invalidate(now); return; }
                if (!panelMatches) { Invalidate(now); return; }
                BaselineFrames = Math.Min(1000, BaselineFrames + 1);
                Ready = BaselineFrames >= 2;
                preClick = Clone(current); lastFrameAt = now;
                return;
            }
            if (now < ClickedAt || now - ClickedAt > 2500) { Invalidate(now); return; }
            if (now - ClickedAt <= 950 && UniqueFeedback(current, preClick, SelectedIndex)) FeedbackFrames = Math.Min(1000, FeedbackFrames + 1);
            bool gone = true;
            for (int index = 0; index < 3; index++)
                gone &= LastDelta[index] >= 18 && CloseFraction(current[index], baseline[index]) <= .45;
            DismissedFrames = gone ? Math.Min(1000, DismissedFrames + 1) : 0;
            // A click followed only by disappearing cards is insufficient.
            Complete = FeedbackFrames > 0 && DismissedFrames >= 3;
        }

        private static bool Valid(int[][] values)
        {
            if (values == null || values.Length != 3) return false;
            foreach (int[] row in values)
            {
                if (row == null || row.Length != 192) return false;
                foreach (int value in row) if (value < 0 || value > 255) return false;
            }
            return true;
        }
        private static bool PanelMatches(int[][] current, int[][] baseline)
        {
            for (int index = 0; index < 3; index++)
                if (Difference(current[index], baseline[index]) > 10 || CloseFraction(current[index], baseline[index]) < .78) return false;
            return true;
        }
        private static int[][] Clone(int[][] source) { return new[] { (int[])source[0].Clone(), (int[])source[1].Clone(), (int[])source[2].Clone() }; }
        private static double Difference(int[] left, int[] right)
        {
            double sum = 0; for (int index = 0; index < 192; index++) sum += Math.Abs(left[index] - right[index]); return sum / 192;
        }
        private static double CloseFraction(int[] left, int[] right)
        {
            int close = 0;
            for (int cell = 0; cell < 64; cell++)
            {
                int offset = cell * 3;
                double delta = (Math.Abs(left[offset] - right[offset]) + Math.Abs(left[offset + 1] - right[offset + 1]) + Math.Abs(left[offset + 2] - right[offset + 2])) / 3.0;
                if (delta <= 12) close++;
            }
            return close / 64.0;
        }
        private static bool UniqueFeedback(int[][] current, int[][] before, int selected)
        {
            if (before == null || selected < 0 || selected > 2) return false;
            double selectedDifference = Difference(current[selected], before[selected]);
            double otherMaximum = 0;
            for (int index = 0; index < 3; index++) if (index != selected)
            {
                otherMaximum = Math.Max(otherMaximum, Difference(current[index], before[index]));
                if (CloseFraction(current[index], before[index]) < .90) return false;
            }
            // Most of the selected panel must remain visible during feedback;
            // disappearance of one card ahead of the others is not a pick FX.
            if (selectedDifference < 5 || selectedDifference < otherMaximum * 2.5 + 2
                || otherMaximum > 4.5 || CloseFraction(current[selected], before[selected]) < .65) return false;
            int brighter = 0; double positive = 0;
            for (int cell = 0; cell < 64; cell++)
            {
                int offset = cell * 3;
                double change = ((current[selected][offset] + current[selected][offset + 1] + current[selected][offset + 2])
                    - (before[selected][offset] + before[selected][offset + 1] + before[selected][offset + 2])) / 3.0;
                if (change >= 18) brighter++;
                if (change > 0) positive += change;
            }
            return brighter >= 4 && positive / 64 >= 3.5;
        }

        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); checks++; };
            Func<int, int[][]> frame = delegate(int value)
            {
                var rows = new[] { new int[192], new int[192], new int[192] };
                foreach (int[] row in rows) for (int index = 0; index < row.Length; index++) row[index] = value;
                return rows;
            };
            int[][] baseline = frame(25), gone = frame(100), feedback = frame(25);
            for (int cell = 0; cell < 12; cell++) for (int color = 0; color < 3; color++) feedback[1][cell * 3 + color] = 80;
            Func<ScreenSelectionDecision> armed = delegate
            {
                var value = new ScreenSelectionDecision(); value.Arm(1000); value.Frame(baseline, baseline, 1100); value.Frame(baseline, baseline, 1170); return value;
            };
            var valid = armed(); check(valid.Ready, "Synthetic selection did not require stable baseline frames.");
            valid.Pointer(true, 1, true, 1200, baseline, baseline); valid.Pointer(false, 1, true, 1250, baseline, baseline);
            valid.Frame(feedback, baseline, 1310); check(valid.FeedbackFrames == 1 && !valid.Complete, "Feedback alone confirmed a synthetic choice.");
            valid.Frame(gone, baseline, 1380); valid.Frame(gone, baseline, 1450);
            check(!valid.Complete, "Fewer than three disappearance frames confirmed a synthetic choice.");
            valid.Frame(gone, baseline, 1520); check(valid.Complete && valid.SelectedIndex == 1, "Synthetic unique feedback and stable dismissal were not accepted.");
            var noFx = armed(); noFx.Pointer(true, 1, true, 1200, baseline, baseline); noFx.Pointer(false, 1, true, 1250, baseline, baseline);
            noFx.Frame(gone, baseline, 1320); noFx.Frame(gone, baseline, 1390); noFx.Frame(gone, baseline, 1460);
            check(!noFx.Complete && noFx.FeedbackFrames == 0, "Click and disappearance alone confirmed a synthetic choice.");
            var smallHover = frame(25);
            for (int cell = 0; cell < 6; cell++) for (int color = 0; color < 3; color++) smallHover[1][cell * 3 + color] = 70;
            var hoverBeforeClick = armed(); hoverBeforeClick.Frame(smallHover, baseline, 1190);
            hoverBeforeClick.Pointer(true, 1, true, 1200, baseline, baseline); hoverBeforeClick.Pointer(false, 1, true, 1250, baseline, baseline);
            hoverBeforeClick.Frame(smallHover, baseline, 1320); hoverBeforeClick.Frame(gone, baseline, 1390); hoverBeforeClick.Frame(gone, baseline, 1460); hoverBeforeClick.Frame(gone, baseline, 1530);
            check(!hoverBeforeClick.Complete && hoverBeforeClick.FeedbackFrames == 0, "An existing hover highlight was treated as new post-click feedback.");
            var oneCardGone = Clone(baseline); oneCardGone[1] = (int[])gone[1].Clone();
            var earlyDismissal = armed(); earlyDismissal.Pointer(true, 1, true, 1200, baseline, baseline); earlyDismissal.Pointer(false, 1, true, 1250, baseline, baseline);
            earlyDismissal.Frame(oneCardGone, baseline, 1320); earlyDismissal.Frame(gone, baseline, 1390); earlyDismissal.Frame(gone, baseline, 1460); earlyDismissal.Frame(gone, baseline, 1530);
            check(!earlyDismissal.Complete && earlyDismissal.FeedbackFrames == 0, "One card disappearing before the others was treated as selected-card feedback.");
            var hover = armed(); hover.Frame(feedback, baseline, 1190); check(hover.Invalid, "An unmatched pre-click frame did not invalidate the baseline.");
            var outside = armed(); outside.Pointer(true, -1, true, 1200, baseline, baseline);
            check(outside.Invalid && !outside.CanArm(1000) && !outside.CanArm(1199) && !outside.CanArm(1200), "Outside click allowed same or older capture to rearm.");
            check(!outside.ConsiderCapture(1201, "old-transition") && !outside.ConsiderCapture(3000, "old-transition"),
                "A new timestamp inside the reroll settle fence was accepted.");
            outside.Arm(1000); check(outside.Invalid, "Changing token without a fresh capture bypassed outside-click invalidation.");
            check(!outside.ConsiderCapture(3200, "old-token-old-ids") && !outside.ConsiderCapture(3200, "old-token-old-ids"),
                "One post-fence capture or its cached duplicate rearmed the watcher.");
            check(!outside.ConsiderCapture(3300, "old-token-old-ids"), "OCR captures less than 300ms apart were accepted.");
            check(!outside.ConsiderCapture(3500, "new-token-new-ids") && !outside.CanArm(3500),
                "Different candidate identities were combined into a two-capture proof.");
            check(outside.ConsiderCapture(3800, "new-token-new-ids") && outside.CanArm(3800),
                "Two fresh, matching post-fence OCR captures could not rearm.");
            outside.Arm(3800); outside.Frame(baseline, baseline, 3900); outside.Frame(baseline, baseline, 3970);
            check(outside.Ready, "A validated post-reroll two-capture proof did not arm.");
            var gap = new ScreenSelectionDecision(); gap.Invalidate(5000);
            check(!gap.ConsiderCapture(4900, "ocr-running") && !gap.ConsiderCapture(5001, "ocr-running"),
                "A click during the unarmed OCR interval allowed an earlier capture to arm.");
            check(!gap.ConsiderCapture(7000, "stable-ids"), "One capture after an unarmed game click was enough to arm.");
            gap.Invalidate(7100);
            check(!gap.ConsiderCapture(7300, "stable-ids") && !gap.CanArm(7300),
                "A second unarmed click failed to invalidate a partially collected OCR proof.");
            check(!gap.ConsiderCapture(9100, "stable-ids") && gap.ConsiderCapture(9400, "stable-ids"),
                "The fresh two-capture proof did not recover from a click during OCR.");
            var lateHover = frame(25);
            for (int cell = 0; cell < 12; cell++) for (int color = 0; color < 3; color++) lateHover[1][cell * 3 + color] = 60;
            var late = armed(); late.Pointer(true, 1, true, 1200, lateHover, baseline); late.Pointer(false, 1, true, 1250, lateHover, baseline);
            late.Frame(lateHover, baseline, 1320); late.Frame(gone, baseline, 1390); late.Frame(gone, baseline, 1460); late.Frame(gone, baseline, 1530);
            check(!late.Complete && late.FeedbackFrames == 0, "A highlight appearing between the timer frame and mouse-down was treated as a new selection FX.");
            var held = armed(); held.Pointer(true, 1, true, 1200, baseline, baseline); held.Frame(lateHover, baseline, 1220);
            held.Pointer(false, 1, true, 1250, lateHover, baseline); held.Frame(lateHover, baseline, 1320);
            held.Frame(gone, baseline, 1390); held.Frame(gone, baseline, 1460); held.Frame(gone, baseline, 1530);
            check(!held.Complete && held.FeedbackFrames == 0, "Feedback first seen while the mouse was held was counted after release.");
            var overlay = armed(); overlay.Pointer(true, 1, false, 1200, baseline, baseline); check(overlay.Invalid, "A NOACTIVATE sidebar click was treated as a game click.");
            var crossed = armed(); crossed.Pointer(true, 0, true, 1200, baseline, baseline); crossed.Pointer(false, 1, true, 1250, baseline, baseline); check(crossed.Invalid, "Cross-card mouse drag was treated as a selection.");
            var otherFx = armed(); otherFx.Pointer(true, 0, true, 1200, baseline, baseline); otherFx.Pointer(false, 0, true, 1250, baseline, baseline);
            otherFx.Frame(feedback, baseline, 1320); otherFx.Frame(gone, baseline, 1390); otherFx.Frame(gone, baseline, 1460); otherFx.Frame(gone, baseline, 1530);
            check(!otherFx.Complete, "A different card's synthetic feedback confirmed the clicked card.");
            var globalFx = armed(); globalFx.Pointer(true, 1, true, 1200, baseline, baseline); globalFx.Pointer(false, 1, true, 1250, baseline, baseline);
            var flash = Clone(feedback); flash[0] = (int[])feedback[1].Clone(); flash[2] = (int[])feedback[1].Clone();
            globalFx.Frame(flash, baseline, 1320); check(globalFx.FeedbackFrames == 0, "Global flash was treated as unique selected-card feedback.");
            var expired = armed(); expired.Pointer(true, 1, true, 1200, baseline, baseline); expired.Pointer(false, 1, true, 1250, baseline, baseline); expired.Frame(feedback, baseline, 3800);
            check(expired.Invalid && !expired.Complete, "Expired feedback confirmed a synthetic choice.");
            var beforeClick = armed(); beforeClick.Frame(feedback, baseline, 1180); check(beforeClick.FeedbackFrames == 0, "Pre-click changes counted as post-click feedback.");
            var stale = armed(); stale.Pointer(true, 1, true, 1400, baseline, baseline); check(stale.Invalid, "Stale pre-click frame permitted a synthetic choice.");
            var bad = armed(); bad.Frame(new[] { new int[1], new int[192], new int[192] }, baseline, 1200); check(bad.Invalid, "Malformed signature was accepted.");
            var tooEarly = new ScreenSelectionDecision(); tooEarly.Arm(1000); tooEarly.Pointer(true, 1, true, 1100, baseline, baseline);
            check(tooEarly.Invalid, "A click without two stable panel observations was accepted.");
            using (var image = new Bitmap(16, 16))
            {
                using (var paint = Graphics.FromImage(image)) paint.Clear(Color.FromArgb(21, 44, 88));
                int[] signature = ScreenSelectionWatcher.ReadSignature(image, new Rectangle(0, 0, 16, 16));
                check(signature.Length == 192 && Math.Abs(signature[0] - 21) <= 1 && Math.Abs(signature[1] - 44) <= 1 && Math.Abs(signature[2] - 88) <= 1,
                    "Synthetic RGB signature did not retain row-major channel order.");
            }
            var regionRows = new object[3];
            for (int index = 0; index < 3; index++) regionRows[index] = new Dictionary<string, object> {
                { "column", index }, { "x", 403 + index * 384 }, { "y", 216 }, { "width", 346 }, { "height", 540 }, { "signature", new ArrayList(baseline[index]) }
            };
            var metadata = new Dictionary<string, object> {
                { "status", "armed" }, { "provider", "screen" }, { "experimental", true }, { "offerToken", "synthetic-offer-token-only" },
                { "gameId", "synthetic-game" }, { "gameEpoch", 1 }, { "revision", 2 }, { "capturedAt", 1000L },
                { "ids", new[] { "a", "b", "c" } }, { "capture", new Dictionary<string, object> {
                    { "width", 1920 }, { "height", 1080 }, { "originX", -2500 }, { "originY", 100 }, { "windowHandle", "42" }, { "regions", regionRows }
                } }
            };
            ScreenSelectionObservation parsed;
            check(ScreenSelectionObservation.TryRead(metadata, 1100, out parsed), "Valid synthetic screen metadata was rejected.");
            if (parsed != null)
            {
                check(parsed.ColumnAt(-2500 + 423, 100 + 240) == 0 && parsed.ColumnAt(-2500 + 777, 100 + 240) == -1,
                    "Negative monitor coordinates or card gaps broke the synthetic click geometry.");
                var evidence = parsed.Evidence(1, 1200, 1500, 3, 1);
                check(evidence.Count == 11 && ModelValue.Array(evidence, "ids").Count == 3
                    && ModelValue.Text(evidence, "selectedIndex") == "1" && !evidence.ContainsKey("capture"),
                    "Synthetic evidence did not use the bounded selection contract.");
                metadata["capturedAt"] = 1050L;
                ScreenSelectionObservation newer;
                check(ScreenSelectionObservation.TryRead(metadata, 1100, out newer), "Newer same-context synthetic OCR capture was rejected.");
                var inFlight = armed(); inFlight.Pointer(true, 1, true, 1200, baseline, baseline); inFlight.Pointer(false, 1, true, 1250, baseline, baseline);
                check(ScreenSelectionWatcher.PreservePendingObservation(parsed, newer, inFlight),
                    "A same-identity OCR refresh would reset pending animation recognition.");
                newer.Ids = new[] { "a", "rerolled", "c" };
                check(!ScreenSelectionWatcher.PreservePendingObservation(parsed, newer, inFlight),
                    "A different candidate identity was allowed to preserve pending recognition.");
                newer.Ids = new[] { "a", "b", "c" };
                newer.Regions[1].Offset(1, 0);
                check(!ScreenSelectionWatcher.PreservePendingObservation(parsed, newer, inFlight),
                    "Changed physical card regions were allowed to preserve pending recognition.");
                inFlight.Frame(feedback, baseline, 1320); inFlight.Frame(gone, baseline, 1390); inFlight.Frame(gone, baseline, 1460); inFlight.Frame(gone, baseline, 1530);
                check(inFlight.Complete, "Preserving a pending observation lost the subsequent animation/disappearance sequence.");
            }
            check(!ScreenSelectionObservation.TryRead(metadata, 32000, out parsed), "Expired synthetic metadata was accepted.");
            return checks;
        }
    }
}
