using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace HexGuide.Desktop
{
    // Player-opened HUD result observation, separate from pointer/animation
    // observation. The class never opens a panel, activates a window, sends
    // input, reads game memory, persists pixels, or chooses among tied glyphs.
    internal sealed class OwnedPanelWatcher : IDisposable
    {
        private readonly Timer timer;
        private readonly Dictionary<string, OwnedPanelShape> templates = new Dictionary<string, OwnedPanelShape>(StringComparer.Ordinal);
        private readonly HashSet<string> requested = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> needed = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, long> retryAt = new Dictionary<string, long>(StringComparer.Ordinal);
        private readonly OwnedPanelStability stability = new OwnedPanelStability();
        private OwnedPanelContext context;
        private bool disposed, publishing;
        private string emittedIdentity = "", lastCode = "waiting-offers";
        private int attempts, captured, matched, blocked;
        private long lastAt;
        internal event Action<Dictionary<string, object>> EvidenceReady;
        internal event Action<string> StatusChanged;
        internal string StatusCode { get { return lastCode; } }
        internal static int ValidateFixtures() { return OwnedPanelFixtures.Run(); }

        internal OwnedPanelWatcher()
        {
            timer = new Timer { Interval = 400 };
            timer.Tick += delegate { Poll(); };
        }

        internal void UpdateModel(Dictionary<string, object> model)
        {
            if (disposed) return;
            var ocr = ModelValue.Object(model, "ocr");
            var mode = ModelValue.Object(model, "mode");
            OwnedPanelContext next;
            if (!ModelValue.Boolean(ocr, "enabled") || ModelValue.Text(model, "phase") != "InProgress"
                || ModelValue.Text(model, "stage") == "loading"
                || (ModelValue.Boolean(mode, "known") && !ModelValue.Boolean(mode, "isMayhem"))
                || !OwnedPanelContext.TryRead(ModelValue.Object(model, "panelSelection"), out next))
            {
                context = null; stability.Reset(); timer.Stop(); SetStatus("waiting-offers"); return;
            }
            if (context == null || context.Identity != next.Identity) { stability.Reset(); publishing = false; }
            context = next;
            needed.Clear();
            foreach (string url in next.IconUrls) needed.Add(url);
            foreach (string url in next.ExcludedUrls) needed.Add(url);
            TrimCache();
            foreach (string url in next.IconUrls) QueueTemplate(url);
            foreach (string url in next.ExcludedUrls) QueueTemplate(url);
            timer.Start();
        }

        internal void CancelForLocalAction()
        {
            context = null; stability.Reset(); timer.Stop(); SetStatus("local-action");
        }

        // The parent supplies the shared commit endpoint. A failed submission
        // may be retried only after a fresh three-frame sequence.
        internal void SubmissionCompleted(bool accepted)
        {
            publishing = false; stability.Reset();
            if (!accepted) { emittedIdentity = ""; SetStatus("submission-rejected"); }
        }

        internal Dictionary<string, object> Diagnostics()
        {
            return new Dictionary<string, object> {
                { "provider", "panel-icon" }, { "profile", OwnedPanelMatcher.Profile },
                { "status", lastCode }, { "attempts", attempts }, { "captured", captured },
                { "matched", matched }, { "blocked", blocked }, { "lastAt", lastAt },
                { "stableFrames", stability.Count }, { "templateCount", templates.Count },
                { "liveVerified", false }, { "skillExclusion", context != null && context.ExcludedUrls.Length > 0 ? "provided" : "unavailable" }
            };
        }

        private void SetStatus(string code)
        {
            if (lastCode == code) return;
            lastCode = code;
            var handler = StatusChanged;
            if (handler == null) return;
            string message;
            switch (code)
            {
                case "loading-icons": message = "图标确认（实验）：正在准备本轮图标"; break;
                case "cards-open": message = "图标确认（实验）：请先在游戏选好，再打开六格强化符文面板"; break;
                case "waiting-panel": message = "图标确认（实验）：等待玩家打开六格强化符文面板"; break;
                case "pending": message = "图标确认（实验）：正在连续核对面板图标"; break;
                case "observed": message = "图标确认（实验）：图标已匹配，正在记录"; break;
                case "waiting-offers": message = "图标确认（实验）：等待新的完整三选一"; break;
                case "game-not-foreground": message = "图标确认（实验）：等待游戏画面位于前台"; break;
                default: message = "图标确认（实验）：证据不足，可重新打开面板或手动确认"; break;
            }
            handler(message);
        }

        private async void QueueTemplate(string url)
        {
            Uri uri;
            long retry;
            if (disposed || templates.ContainsKey(url) || requested.Contains(url) || requested.Count >= 8 || !TrustedIcon(url, out uri)
                || (retryAt.TryGetValue(url, out retry) && retry > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())) return;
            requested.Add(url);
            try
            {
                OwnedPanelShape shape = await Task.Run(delegate
                {
                    var request = (HttpWebRequest)WebRequest.Create(uri);
                    request.Timeout = 2500; request.ReadWriteTimeout = 2500; request.AllowAutoRedirect = false;
                    using (var response = request.GetResponse())
                    using (var stream = response.GetResponseStream())
                    using (var bytes = new MemoryStream())
                    {
                        var buffer = new byte[8192]; int read;
                        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            if (bytes.Length + read > 262144) throw new IOException("Icon size limit.");
                            bytes.Write(buffer, 0, read);
                        }
                        bytes.Position = 0;
                        using (var image = Image.FromStream(bytes))
                        {
                            if (image.Width < 12 || image.Height < 12 || image.Width > 1024 || image.Height > 1024) return null;
                            using (var bitmap = new Bitmap(image)) return OwnedPanelShape.Extract(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                        }
                    }
                });
                if (!disposed && shape != null) { templates[url] = shape; retryAt.Remove(url); TrimCache(); }
                else if (!disposed) DelayRetry(url);
            }
            catch { if (!disposed) DelayRetry(url); /* A missing template withholds confirmation; no fallback guessing. */ }
            finally { requested.Remove(url); }
        }

        private void DelayRetry(string url)
        {
            retryAt[url] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30000;
            if (retryAt.Count <= 96) return;
            string remove = null;
            foreach (string old in retryAt.Keys) if (!needed.Contains(old) && old != url) { remove = old; break; }
            if (remove != null) retryAt.Remove(remove);
        }

        private void TrimCache()
        {
            while (templates.Count > 96)
            {
                string remove = null;
                foreach (string url in templates.Keys) if (!needed.Contains(url)) { remove = url; break; }
                if (remove == null) break;
                templates.Remove(remove);
            }
        }

        internal static bool TrustedIcon(string url, out Uri uri)
        {
            uri = null;
            return !string.IsNullOrEmpty(url) && url.Length <= 500 && Uri.TryCreate(url, UriKind.Absolute, out uri)
                && uri.Scheme == "https" && string.IsNullOrEmpty(uri.UserInfo)
                && (uri.Host == "ddragon.leagueoflegends.com" || uri.Host == "raw.communitydragon.org")
                && uri.IsDefaultPort;
        }

        private void Poll()
        {
            if (disposed || context == null || publishing || emittedIdentity == context.Identity) return;
            var expected = context;
            var shapes = new OwnedPanelShape[3];
            for (int index = 0; index < 3; index++)
                if (!templates.TryGetValue(expected.IconUrls[index], out shapes[index])) { stability.Reset(); SetStatus("loading-icons"); return; }
            var excluded = new List<OwnedPanelShape>();
            foreach (string url in expected.ExcludedUrls)
            {
                OwnedPanelShape shape;
                if (!templates.TryGetValue(url, out shape)) { stability.Reset(); SetStatus("loading-icons"); return; }
                excluded.Add(shape);
            }
            long stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lastAt = stamp; attempts = Increment(attempts);
            Bitmap bitmap; bool titlesVisible; string failure;
            if (!Capture(expected, out bitmap, out titlesVisible, out failure))
            { blocked = Increment(blocked); stability.Reset(); SetStatus(failure); return; }
            using (bitmap)
            {
                captured = Increment(captured);
                if (titlesVisible) { stability.Reset(); SetStatus("cards-open"); return; }
                OwnedPanelLayout layout;
                if (!OwnedPanelMatcher.TryLocate(bitmap, expected.Reference.ClientBounds.Size, out layout))
                { stability.Reset(); SetStatus("waiting-panel"); return; }
                OwnedPanelSlotMatch[] slots = OwnedPanelMatcher.ReadSlots(bitmap, layout, shapes, excluded.ToArray());
                bool any = false;
                foreach (var slot in slots) if (slot.Indices.Length > 0) any = true;
                if (!any) { stability.Reset(); SetStatus("waiting-panel"); return; }
                matched = Increment(matched);
                string geometry = expected.GeometryKey + ":" + layout.Key;
                var frame = new OwnedPanelProofFrame(stamp, geometry, slots);
                if (!stability.Observe(expected.Identity, frame)) { SetStatus("pending"); return; }
                if (context != expected || disposed) return;
                var proof = new Dictionary<string, object> {
                    { "provider", "panel-icon" }, { "offerToken", expected.Token }, { "gameId", expected.GameId },
                    { "gameEpoch", expected.Epoch }, { "revision", expected.Revision }, { "ids", expected.Ids },
                    { "frames", stability.Proof() }
                };
                publishing = true; emittedIdentity = expected.Identity; SetStatus("observed");
                var handler = EvidenceReady;
                if (handler != null) handler(proof); else SubmissionCompleted(false);
            }
        }

        private static int Increment(int value) { return Math.Min(1000000, value + 1); }

        private static bool Capture(OwnedPanelContext expected, out Bitmap bitmap, out bool titlesVisible, out string failure)
        {
            bitmap = null; titlesVisible = false; failure = "capture-unavailable";
            IntPtr previous = IntPtr.Zero;
            try
            {
                previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
                if (previous == IntPtr.Zero) previous = SetThreadDpiAwarenessContext(new IntPtr(-3));
                if (previous == IntPtr.Zero) { failure = "dpi-unavailable"; return false; }
                IntPtr window = expected.Reference.Window;
                if (GetForegroundWindow() != window || !GameWindow.IsVerifiedGame(window)) { failure = "game-not-foreground"; return false; }
                if (!IsWindowVisible(window) || IsIconic(window)) { failure = "game-not-visible"; return false; }
                Rectangle client;
                if (!ClientBounds(window, out client) || client != expected.Reference.ClientBounds) { failure = "geometry-changed"; return false; }
                Rectangle roi = OwnedPanelMatcher.CaptureRegion(client.Size);
                var sampled = new List<Rectangle>(); sampled.Add(new Rectangle(client.X + roi.X, client.Y + roi.Y, roi.Width, roi.Height));
                foreach (ScreenTitleAnchor[] card in expected.Reference.TitleAnchors)
                    foreach (ScreenTitleAnchor anchor in card) sampled.Add(new Rectangle(client.X + anchor.Box.X, client.Y + anchor.Box.Y, anchor.Box.Width, anchor.Box.Height));
                if (!Unoccluded(window, sampled)) { failure = "region-occluded"; return false; }
                bitmap = new Bitmap(roi.Width, roi.Height, PixelFormat.Format32bppArgb);
                using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(client.X + roi.X, client.Y + roi.Y, 0, 0, roi.Size, CopyPixelOperation.SourceCopy);
                foreach (ScreenTitleAnchor[] card in expected.Reference.TitleAnchors)
                {
                    bool all = true;
                    foreach (ScreenTitleAnchor anchor in card)
                    {
                        using (var title = new Bitmap(anchor.Box.Width, anchor.Box.Height, PixelFormat.Format32bppArgb))
                        {
                            using (var graphics = Graphics.FromImage(title)) graphics.CopyFromScreen(client.X + anchor.Box.X, client.Y + anchor.Box.Y, 0, 0, title.Size, CopyPixelOperation.SourceCopy);
                            CardTitleFeature feature = CardTitleIdentity.Extract(title, new Rectangle(Point.Empty, title.Size));
                            if (!feature.Usable || !CardTitleIdentity.Matches(feature.Feature, anchor.Feature)) all = false;
                        }
                    }
                    if (all) titlesVisible = true;
                }
                Rectangle final;
                if (GetForegroundWindow() != window || !GameWindow.IsVerifiedGame(window) || !ClientBounds(window, out final)
                    || final != client || !Unoccluded(window, sampled))
                { bitmap.Dispose(); bitmap = null; failure = "geometry-or-focus-changed"; return false; }
                failure = "captured"; return true;
            }
            catch { if (bitmap != null) { bitmap.Dispose(); bitmap = null; } return false; }
            finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        }

        private static bool ClientBounds(IntPtr window, out Rectangle bounds)
        {
            bounds = Rectangle.Empty;
            NativeRect native; var origin = new NativePoint();
            if (!GetClientRect(window, out native) || !ClientToScreen(window, ref origin)) return false;
            int width = native.Right - native.Left, height = native.Bottom - native.Top;
            if (width < 960 || height < 540 || width > 8192 || height > 4320) return false;
            bounds = new Rectangle(origin.X, origin.Y, width, height); return true;
        }

        private static bool Unoccluded(IntPtr window, List<Rectangle> regions)
        {
            var visited = new HashSet<IntPtr>();
            for (IntPtr above = GetWindow(window, 3); above != IntPtr.Zero; above = GetWindow(above, 3))
            {
                if (visited.Count >= 256 || !visited.Add(above)) return false;
                if (!IsWindowVisible(above) || IsIconic(above)) continue;
                NativeRect native;
                if (DwmGetWindowAttribute(above, 9, out native, Marshal.SizeOf(typeof(NativeRect))) != 0 && !GetWindowRect(above, out native)) return false;
                var box = Rectangle.FromLTRB(native.Left, native.Top, native.Right, native.Bottom);
                bool overlaps = false;
                foreach (Rectangle region in regions) if (region.IntersectsWith(box)) { overlaps = true; break; }
                if (!overlaps) continue;
                int cloaked;
                if (DwmGetWindowAttribute(above, 14, out cloaked, sizeof(int)) != 0 || cloaked == 0) return false;
            }
            return true;
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true; context = null; timer.Stop(); timer.Dispose(); templates.Clear(); requested.Clear(); needed.Clear(); retryAt.Clear(); stability.Reset();
        }

        [StructLayout(LayoutKind.Sequential)] private struct NativeRect { internal int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct NativePoint { internal int X, Y; }
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out NativeRect rect);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint direction);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out NativeRect value, int size);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    }

    internal sealed class OwnedPanelContext
    {
        internal string Token, Identity, GeometryKey;
        internal object GameId;
        internal long Epoch, Revision;
        internal string[] Ids, IconUrls, ExcludedUrls;
        internal ScreenSelectionObservation Reference;

        internal static bool TryRead(Dictionary<string, object> value, out OwnedPanelContext result)
        {
            result = null;
            if (ModelValue.Text(value, "status") != "watching") return false;
            string token = ModelValue.Text(value, "offerToken");
            long epoch, revision, captureAt;
            object game;
            var capture = ModelValue.Object(value, "capture");
            if (token.Length < 16 || token.Length > 128 || !ModelValue.Integer(value, "gameEpoch", out epoch)
                || !ModelValue.Integer(value, "revision", out revision) || !ModelValue.GameId(value, out game)
                || !ModelValue.Integer(capture, "capturedAt", out captureAt) || captureAt <= 0) return false;
            // ScreenSelectionObservation validates the complete geometry/title
            // descriptor. Its input timestamp is not a lease here; freshness
            // and round lifetime are enforced by the server's panel context.
            var referenceValue = new Dictionary<string, object>(value);
            referenceValue["status"] = "armed"; referenceValue["provider"] = "screen";
            referenceValue["experimental"] = true; referenceValue["capturedAt"] = captureAt;
            ScreenSelectionObservation reference;
            if (!ScreenSelectionObservation.TryRead(referenceValue, captureAt, out reference)) return false;
            var offers = ModelValue.Array(value, "offers");
            if (offers.Count != 3) return false;
            var urls = new string[3];
            for (int index = 0; index < 3; index++)
            {
                var entry = offers[index] as Dictionary<string, object>;
                Uri uri; urls[index] = ModelValue.Text(entry, "icon");
                if (ModelValue.Text(entry, "id") != reference.Ids[index] || !OwnedPanelWatcher.TrustedIcon(urls[index], out uri)) return false;
            }
            var excluded = new List<string>();
            foreach (object raw in ModelValue.Array(value, "excluded"))
            {
                if (excluded.Count >= 16) return false;
                string url = raw as string ?? ModelValue.Text(raw as Dictionary<string, object>, "icon");
                Uri uri;
                if (!OwnedPanelWatcher.TrustedIcon(url, out uri)) return false;
                excluded.Add(url);
            }
            string geometry = reference.Window.ToInt64().ToString(CultureInfo.InvariantCulture) + ":" + reference.ClientBounds.X + ":" + reference.ClientBounds.Y + ":" + reference.ClientBounds.Width + ":" + reference.ClientBounds.Height;
            result = new OwnedPanelContext { Token = token, GameId = game, Epoch = epoch, Revision = revision,
                Reference = reference, Ids = reference.Ids, IconUrls = urls, ExcludedUrls = excluded.ToArray(), GeometryKey = geometry,
                Identity = token + "|" + (game as string ?? "null") + "|" + epoch + "|" + revision + "|" + string.Join("|", reference.Ids) + "|" + string.Join("|", urls) + "|" + string.Join("|", excluded.ToArray()) + "|" + geometry };
            return true;
        }
    }

    internal sealed class OwnedPanelShape
    {
        internal const int Side = 28;
        internal bool[] Pixels;
        internal static OwnedPanelShape Extract(Bitmap source, Rectangle region)
        {
            region = Rectangle.Intersect(new Rectangle(Point.Empty, source.Size), region);
            if (region.Width < 8 || region.Height < 8 || region.Width > 1024 || region.Height > 1024) return null;
            var histogram = new int[256];
            for (int y = region.Top; y < region.Bottom; y++) for (int x = region.Left; x < region.Right; x++)
            {
                Color pixel = source.GetPixel(x, y);
                if (pixel.A >= 128) histogram[Math.Max(pixel.R, Math.Max(pixel.G, pixel.B))]++;
            }
            int all = 0; for (int b = 0; b < 256; b++) all += histogram[b];
            if (all == 0) return null;
            int total = 0, p90 = 0;
            for (; p90 < 255; p90++) { total += histogram[p90]; if (total >= all * .90) break; }
            int threshold = Math.Max(85, (int)Math.Round(p90 * .62));
            int minX = region.Right, minY = region.Bottom, maxX = -1, maxY = -1, active = 0;
            var mask = new bool[region.Width * region.Height];
            for (int y = region.Top; y < region.Bottom; y++) for (int x = region.Left; x < region.Right; x++)
            {
                Color pixel = source.GetPixel(x, y);
                int light = Math.Max(pixel.R, Math.Max(pixel.G, pixel.B));
                if (pixel.A < 128 || light < threshold) continue;
                mask[(y - region.Top) * region.Width + x - region.Left] = true; active++;
                minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
            }
            if (active < 8 || active > region.Width * region.Height * .72 || maxX - minX < 3 || maxY - minY < 3) return null;
            int width = maxX - minX + 1, height = maxY - minY + 1;
            int extent = Math.Max(width, height);
            double left = minX - (extent - width) / 2.0, top = minY - (extent - height) / 2.0;
            var normalized = new bool[Side * Side];
            for (int y = 0; y < Side; y++) for (int x = 0; x < Side; x++)
            {
                int hits = 0;
                for (int sy = 0; sy < 3; sy++) for (int sx = 0; sx < 3; sx++)
                {
                    int px = (int)Math.Floor(left + (x + (sx + .5) / 3.0) * extent / Side);
                    int py = (int)Math.Floor(top + (y + (sy + .5) / 3.0) * extent / Side);
                    if (region.Contains(px, py) && mask[(py - region.Top) * region.Width + px - region.Left]) hits++;
                }
                normalized[y * Side + x] = hits >= 4;
            }
            return new OwnedPanelShape { Pixels = normalized };
        }

        internal static double Similarity(OwnedPanelShape first, OwnedPanelShape second)
        {
            if (first == null || second == null || first.Pixels == null || second.Pixels == null) return 0;
            int countA = 0, countB = 0, exact = 0, tolerantA = 0, tolerantB = 0;
            for (int y = 0; y < Side; y++) for (int x = 0; x < Side; x++)
            {
                int index = y * Side + x; bool a = first.Pixels[index], b = second.Pixels[index];
                if (a) { countA++; if (Near(second.Pixels, x, y)) tolerantA++; }
                if (b) { countB++; if (Near(first.Pixels, x, y)) tolerantB++; }
                if (a && b) exact++;
            }
            if (countA < 8 || countB < 8) return 0;
            double tolerant = (tolerantA / (double)countA + tolerantB / (double)countB) / 2;
            double dice = 2.0 * exact / (countA + countB);
            return .55 * tolerant + .45 * dice;
        }
        private static bool Near(bool[] shape, int x, int y)
        {
            for (int py = Math.Max(0, y - 1); py <= Math.Min(Side - 1, y + 1); py++)
                for (int px = Math.Max(0, x - 1); px <= Math.Min(Side - 1, x + 1); px++) if (shape[py * Side + px]) return true;
            return false;
        }
    }

    internal sealed class OwnedPanelLayout
    {
        internal Rectangle[] Slots;
        internal string Key;
        internal double StructureScore;
    }

    internal sealed class OwnedPanelSlotMatch
    {
        internal int Index;
        internal string State;
        internal int[] Indices;
        internal double Similarity;
        internal Dictionary<string, object> Proof()
        {
            return new Dictionary<string, object> { { "slotIndex", Index }, { "state", State }, { "candidateIndices", Indices } };
        }
    }

    internal static class OwnedPanelMatcher
    {
        internal const string Profile = "hud-six-slots-4.0-experimental-v1";
        // One supplied 2559x1440 screenshot establishes this HUD geometry. Search
        // a bounded family of HUD scales, requiring the complete gold L-frame,
        // all six dark slot interiors and their grid gutters. It does not treat
        // arbitrary white symbols or a screen coordinate alone as a panel.
        internal static Rectangle CaptureRegion(Size client)
        {
            double scale = client.Height / 1440.0;
            int left = Math.Max(0, (int)Math.Floor(client.Width / 2.0 - 800 * scale));
            int right = Math.Min(client.Width, (int)Math.Ceiling(client.Width / 2.0 - 250 * scale));
            int height = Math.Max(1, (int)Math.Ceiling(190 * scale));
            return new Rectangle(left, client.Height - height, Math.Max(1, right - left), height);
        }

        internal static bool TryLocate(Bitmap roi, Size client, out OwnedPanelLayout layout)
        {
            layout = null;
            Rectangle capture = CaptureRegion(client);
            if (roi.Width != capture.Width || roi.Height != capture.Height) return false;
            double best = 0;
            for (int step = 0; step <= 110; step++)
            {
                double scale = client.Height / 1440.0 * (.65 + step * .005);
                for (int dx = -3; dx <= 3; dx += 3)
                {
                    var slots = new Rectangle[6];
                    int left = (int)Math.Round(client.Width / 2.0 - 634.5 * scale) - capture.Left + dx;
                    int top = client.Height - (int)Math.Round(147 * scale) - capture.Top;
                    int panelWidth = (int)Math.Round(210 * scale), panelHeight = (int)Math.Round(146 * scale);
                    var panel = new Rectangle(left, top, panelWidth, panelHeight);
                    if (!new Rectangle(Point.Empty, roi.Size).Contains(panel) || panelWidth < 65 || panelHeight < 45) continue;
                    for (int slot = 0; slot < 6; slot++) slots[slot] = new Rectangle(left + (int)Math.Round((11 + slot % 3 * 64) * scale),
                        top + (int)Math.Round((10 + slot / 3 * 66) * scale), Math.Max(8, (int)Math.Round(57 * scale)), Math.Max(8, (int)Math.Round(57 * scale)));
                    double score = StructureScore(roi, panel, slots, scale);
                    if (score < .85 || score <= best) continue;
                    best = score; layout = new OwnedPanelLayout { Slots = slots, StructureScore = score,
                        Key = Profile + ":" + left + ":" + top + ":" + panelWidth + ":" + panelHeight };
                }
            }
            return layout != null;
        }

        private static double StructureScore(Bitmap image, Rectangle panel, Rectangle[] slots, double scale)
        {
            int gold = 0, goldCount = 0, dark = 0, darkCount = 0;
            int rim = Math.Max(1, (int)Math.Round(scale));
            for (int i = 1; i < 15; i++)
            {
                int y = panel.Top + panel.Height * i / 15;
                int x = panel.Left + panel.Width * i / 15;
                if (GoldNearby(image, panel.Left, y, rim)) gold++; goldCount++;
                if (GoldNearby(image, x, panel.Bottom - 1, rim)) gold++; goldCount++;
            }
            if (gold < goldCount * .72) return 0;
            int gutters = 0, gutterCount = 0;
            // An undivided dark gold-framed stats panel cannot satisfy the
            // six-cell result geometry: both vertical and horizontal blue
            // gutters must be present at the expected positions.
            foreach (int column in new[] { 72, 136 }) foreach (int row in new[] { 18, 40, 62, 84, 106, 128 })
            {
                Color c = image.GetPixel(panel.X + (int)Math.Round(column * scale), panel.Y + (int)Math.Round(row * scale));
                if (c.B >= 25 && c.B > c.R + 9 && c.G >= 18 && c.R < 85) gutters++;
                gutterCount++;
            }
            foreach (int column in new[] { 20, 43, 85, 106, 148, 170 })
            {
                Color c = image.GetPixel(panel.X + (int)Math.Round(column * scale), panel.Y + (int)Math.Round(72 * scale));
                if (c.B >= 25 && c.B > c.R + 9 && c.G >= 18 && c.R < 85) gutters++;
                gutterCount++;
            }
            if (gutters < gutterCount * .78) return 0;
            foreach (Rectangle slot in slots)
            {
                if (!new Rectangle(Point.Empty, image.Size).Contains(slot)) return 0;
                int ownDark = 0, ownTotal = 0;
                for (int sy = 0; sy < 5; sy++) for (int sx = 0; sx < 5; sx++)
                {
                    Color pixel = image.GetPixel(slot.X + (slot.Width - 1) * sx / 4, slot.Y + (slot.Height - 1) * sy / 4);
                    ownTotal++; if (pixel.R < 64 && pixel.G < 76 && pixel.B < 78) ownDark++;
                }
                if (ownDark < ownTotal * .60) return 0;
                dark += ownDark; darkCount += ownTotal;
            }
            return .35 * gold / goldCount + .45 * dark / darkCount + .20 * gutters / gutterCount;
        }

        private static bool GoldNearby(Bitmap bitmap, int x, int y, int radius)
        {
            for (int py = Math.Max(0, y - radius); py <= Math.Min(bitmap.Height - 1, y + radius); py++)
                for (int px = Math.Max(0, x - radius); px <= Math.Min(bitmap.Width - 1, x + radius); px++)
                {
                    Color c = bitmap.GetPixel(px, py);
                    if (c.R > 85 && c.G > 65 && c.R > c.B * 1.20 && c.G > c.B * 1.12 && c.G > c.R * .58) return true;
                }
            return false;
        }

        internal static OwnedPanelSlotMatch[] ReadSlots(Bitmap bitmap, OwnedPanelLayout layout, OwnedPanelShape[] candidates, OwnedPanelShape[] excluded)
        {
            var result = new OwnedPanelSlotMatch[6];
            for (int index = 0; index < result.Length; index++)
            {
                var area = layout.Slots[index]; area.Inflate(-Math.Max(1, area.Width / 20), -Math.Max(1, area.Height / 20));
                var shape = OwnedPanelShape.Extract(bitmap, area);
                result[index] = Match(shape, candidates, excluded); result[index].Index = index;
            }
            return result;
        }

        internal static OwnedPanelSlotMatch Match(OwnedPanelShape shape, OwnedPanelShape[] candidates, OwnedPanelShape[] excluded)
        {
            var output = new OwnedPanelSlotMatch { State = shape == null ? "empty" : "unmatched", Indices = new int[0] };
            if (shape == null || candidates == null || candidates.Length != 3) return output;
            if (excluded != null) foreach (OwnedPanelShape skill in excluded)
                if (OwnedPanelShape.Similarity(shape, skill) >= .88) { output.State = "excluded"; return output; }
            var scores = new double[3]; int best = 0;
            for (int i = 0; i < 3; i++) { scores[i] = OwnedPanelShape.Similarity(shape, candidates[i]); if (scores[i] > scores[best]) best = i; }
            output.Similarity = scores[best];
            if (scores[best] < .90) return output;
            var group = new List<int>(); group.Add(best);
            for (int i = 0; i < 3; i++) if (i != best)
            {
                double pair = OwnedPanelShape.Similarity(candidates[best], candidates[i]);
                if (pair >= .985 && scores[i] >= .90 && scores[best] - scores[i] <= .035) group.Add(i);
                else if (scores[best] - scores[i] < .065) return output;
            }
            group.Sort(); output.Indices = group.ToArray(); output.State = group.Count == 1 ? "candidate" : "ambiguous";
            return output;
        }
    }

    internal sealed class OwnedPanelProofFrame
    {
        internal long At;
        internal string Geometry;
        internal OwnedPanelSlotMatch[] Slots;
        internal OwnedPanelProofFrame(long at, string geometry, OwnedPanelSlotMatch[] slots) { At = at; Geometry = geometry; Slots = slots; }
        internal string Signature()
        {
            string value = Geometry;
            foreach (var slot in Slots) value += "|" + slot.Index + ":" + slot.State + ":" + string.Join(",", Array.ConvertAll(slot.Indices, delegate(int i) { return i.ToString(CultureInfo.InvariantCulture); }));
            return value;
        }
        internal Dictionary<string, object> Proof()
        {
            var slots = new object[Slots.Length]; for (int i = 0; i < slots.Length; i++) slots[i] = Slots[i].Proof();
            return new Dictionary<string, object> { { "captureId", "hud-" + At.ToString(CultureInfo.InvariantCulture) }, { "capturedAt", At },
                { "panelVisible", true }, { "gameSurfaceVerified", true }, { "selectionUiVisible", false }, { "geometryKey", Geometry }, { "slots", slots } };
        }
    }

    internal sealed class OwnedPanelStability
    {
        private readonly List<OwnedPanelProofFrame> frames = new List<OwnedPanelProofFrame>();
        private string scope = "", signature = "";
        internal int Count { get { return frames.Count; } }
        internal void Reset() { frames.Clear(); scope = signature = ""; }
        internal bool Observe(string currentScope, OwnedPanelProofFrame frame)
        {
            if (frame == null || frame.At <= 0 || frame.Slots == null || frame.Slots.Length != 6) { Reset(); return false; }
            string next = frame.Signature();
            if (scope != currentScope || signature != next || (frames.Count > 0 && frame.At - frames[frames.Count - 1].At > 2000))
            { Reset(); scope = currentScope; signature = next; }
            if (frames.Count > 0 && frame.At - frames[frames.Count - 1].At < 250) return false;
            frames.Add(frame); if (frames.Count > 3) frames.RemoveAt(0);
            return frames.Count == 3 && frames[2].At - frames[0].At >= 500;
        }
        internal object[] Proof() { var value = new object[frames.Count]; for (int i = 0; i < value.Length; i++) value[i] = frames[i].Proof(); return value; }
    }

    internal static class OwnedPanelFixtures
    {
        internal static int Run()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string name) { checks++; if (!condition) throw new InvalidOperationException("Owned panel fixture: " + name); };
            var serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
            Func<Dictionary<string, object>> backendModel = delegate
            {
                return serializer.DeserializeObject(serializer.Serialize(BackendModel())) as Dictionary<string, object>;
            };
            var model = backendModel();
            var contextValue = ModelValue.Object(model, "panelSelection");
            OwnedPanelContext parsed;
            check(ModelValue.Text(model, "phase") == "InProgress" && ModelValue.Text(model, "stage") == "live", "backend stage fixture");
            check(OwnedPanelContext.TryRead(contextValue, out parsed), "backend panelSelection JSON round trip");
            check(parsed != null && parsed.Epoch == 7 && parsed.Revision == 12 && parsed.Ids[1] == "b"
                && parsed.Reference.ClientBounds.X == -2500 && parsed.Reference.TitleAnchors.Length == 3,
                "backend scope and negative monitor coordinates retained");
            contextValue["ids"] = new ArrayList(ModelValue.Array(contextValue, "ids"));
            contextValue["offers"] = new ArrayList(ModelValue.Array(contextValue, "offers"));
            check(OwnedPanelContext.TryRead(contextValue, out parsed), "ArrayList backend arrays accepted");
            contextValue["ids"] = new[] { "b", "a", "c" };
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "ordered offers and IDs must agree");
            contextValue = ModelValue.Object(backendModel(), "panelSelection");
            ModelValue.Object(contextValue, "capture").Remove("identityAnchors");
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "missing card title reference rejected");
            contextValue = ModelValue.Object(backendModel(), "panelSelection");
            ModelValue.Object(contextValue, "capture")["width"] = 99;
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "invalid physical geometry rejected");
            contextValue = ModelValue.Object(backendModel(), "panelSelection");
            (ModelValue.Array(contextValue, "offers")[0] as Dictionary<string, object>)["icon"] = "https://untrusted.example/icon.png";
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "unsafe backend template URL rejected");
            contextValue = ModelValue.Object(backendModel(), "panelSelection");
            var identity = ModelValue.Object(ModelValue.Object(contextValue, "capture"), "identityAnchors");
            var card = ModelValue.Array(identity, "cards")[0] as Dictionary<string, object>;
            (ModelValue.Array(card, "anchors")[0] as Dictionary<string, object>)["feature"] = new int[128];
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "unusable reference title rejected");
            contextValue = ModelValue.Object(backendModel(), "panelSelection");
            ModelValue.Object(contextValue, "capture").Remove("capturedAt");
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "missing original capture timestamp rejected");
            Uri uri;
            check(OwnedPanelWatcher.TrustedIcon("https://raw.communitydragon.org/latest/game/icon.png", out uri), "trusted icon");
            check(!OwnedPanelWatcher.TrustedIcon("http://raw.communitydragon.org/icon.png", out uri), "plain HTTP rejected");
            check(!OwnedPanelWatcher.TrustedIcon("https://raw.communitydragon.org.evil.example/icon.png", out uri), "lookalike host rejected");
            check(!OwnedPanelWatcher.TrustedIcon("https://raw.communitydragon.org:444/icon.png", out uri), "alternate port rejected");
            var shapes = new[] { FixtureShape(0, 64), FixtureShape(1, 64), FixtureShape(2, 64) };
            check(OwnedPanelShape.Similarity(shapes[0], shapes[0]) == 1, "identical shape");
            check(OwnedPanelShape.Similarity(shapes[0], FixtureShape(0, 128)) > .94, "template scale normalization");
            check(OwnedPanelMatcher.Match(shapes[0], shapes, new OwnedPanelShape[0]).State == "candidate", "unique candidate");
            var collision = new[] { shapes[0], shapes[1], shapes[0] };
            var ambiguous = OwnedPanelMatcher.Match(shapes[0], collision, new OwnedPanelShape[0]);
            check(ambiguous.State == "ambiguous" && ambiguous.Indices.Length == 2 && ambiguous.Indices[0] == 0 && ambiguous.Indices[1] == 2, "same glyph preserved for server inference");
            check(OwnedPanelMatcher.Match(shapes[0], collision, new[] { shapes[0] }).State == "excluded", "known skill wins over candidate collision");
            check(OwnedPanelMatcher.Match(FixtureShape(3, 64), shapes, new OwnedPanelShape[0]).State == "unmatched", "unrelated skill never counted");
            check(OwnedPanelMatcher.Match(null, shapes, new OwnedPanelShape[0]).State == "empty", "empty slot");
            var slots = new OwnedPanelSlotMatch[6];
            for (int i = 0; i < 6; i++) slots[i] = new OwnedPanelSlotMatch { Index = i, State = i == 4 ? "candidate" : "empty", Indices = i == 4 ? new[] { 1 } : new int[0] };
            var stable = new OwnedPanelStability();
            check(!stable.Observe("round1", new OwnedPanelProofFrame(1000, "geometry1", slots)), "one frame insufficient");
            check(!stable.Observe("round1", new OwnedPanelProofFrame(1000, "geometry1", slots)) && stable.Count == 1, "duplicate capture ignored");
            check(!stable.Observe("round1", new OwnedPanelProofFrame(1100, "geometry1", slots)) && stable.Count == 1, "closely spaced frame ignored");
            check(!stable.Observe("round1", new OwnedPanelProofFrame(1400, "geometry1", slots)), "two frames insufficient");
            check(stable.Observe("round1", new OwnedPanelProofFrame(1800, "geometry1", slots)), "three independent frames accepted");
            check(stable.Proof().Length == 3, "bounded frame evidence");
            var proof = new Dictionary<string, object> {
                { "provider", "panel-icon" }, { "offerToken", "0123456789abcdef0123456789abcdef" }, { "gameId", "fixture-game" },
                { "gameEpoch", 7L }, { "revision", 12L }, { "ids", new[] { "a", "b", "c" } }, { "frames", stable.Proof() }
            };
            string proofJson = serializer.Serialize(proof);
            check(System.Text.Encoding.UTF8.GetByteCount(proofJson) <= 4096, "native proof fits authenticated endpoint body limit");
            var decodedProof = serializer.DeserializeObject(proofJson) as Dictionary<string, object>;
            check(decodedProof.Count == 7 && ModelValue.Text(decodedProof, "provider") == "panel-icon"
                && ModelValue.Array(decodedProof, "ids").Count == 3 && ModelValue.Array(decodedProof, "frames").Count == 3,
                "proof JSON top-level schema matches server");
            long previousAt = 0;
            var captureIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (object rawFrame in ModelValue.Array(decodedProof, "frames"))
            {
                var frame = rawFrame as Dictionary<string, object>;
                long at;
                check(frame != null && frame.Count == 7 && ModelValue.Boolean(frame, "panelVisible") && ModelValue.Boolean(frame, "gameSurfaceVerified")
                    && !ModelValue.Boolean(frame, "selectionUiVisible") && ModelValue.Text(frame, "geometryKey") == "geometry1"
                    && ModelValue.Integer(frame, "capturedAt", out at), "proof frame server schema");
                ModelValue.Integer(frame, "capturedAt", out at);
                check(captureIds.Add(ModelValue.Text(frame, "captureId")) && (previousAt == 0 || at - previousAt >= 250), "proof captures distinct and independently spaced");
                previousAt = at;
                var frameSlots = ModelValue.Array(frame, "slots");
                check(frameSlots.Count == 6, "proof frame contains exactly six slots");
                for (int i = 0; i < frameSlots.Count; i++)
                {
                    var slot = frameSlots[i] as Dictionary<string, object>;
                    long index;
                    check(slot != null && slot.Count == 3 && ModelValue.Integer(slot, "slotIndex", out index) && index == i
                        && ModelValue.Text(slot, "state") == (i == 4 ? "candidate" : "empty")
                        && ModelValue.Array(slot, "candidateIndices").Count == (i == 4 ? 1 : 0), "proof slot server schema " + i);
                }
            }
            check(!stable.Observe("round2", new OwnedPanelProofFrame(2200, "geometry1", slots)) && stable.Count == 1, "round change resets");
            check(!stable.Observe("round2", new OwnedPanelProofFrame(2600, "geometry2", slots)) && stable.Count == 1, "geometry change resets");
            check(!stable.Observe("round2", new OwnedPanelProofFrame(6000, "geometry2", slots)) && stable.Count == 1, "capture gap resets");
            foreach (Size size in new[] { new Size(2559, 1440), new Size(1920, 1080), new Size(2560, 1080) })
            {
                using (var panel = DrawPanel(size, 1.0, shapes[0], true))
                {
                    OwnedPanelLayout layout;
                    check(OwnedPanelMatcher.TryLocate(panel, size, out layout), "complete HUD panel located " + size);
                    var matches = OwnedPanelMatcher.ReadSlots(panel, layout, shapes, new OwnedPanelShape[0]);
                    check(matches.Length == 6 && matches[0].State == "candidate", "correct six-slot extraction " + size);
                    for (int i = 1; i < 6; i++) check(matches[i].Indices.Length == 0, "empty slot ignored " + i);
                }
                using (var blank = DrawPanel(size, 1.0, shapes[0], false))
                { OwnedPanelLayout layout; check(!OwnedPanelMatcher.TryLocate(blank, size, out layout), "closed panel rejected " + size); }
            }
            foreach (double scale in new[] { .675, .825, 1.175 })
            {
                Size client = new Size(2559, 1440);
                using (var panel = DrawPanel(client, scale, shapes[0], true))
                {
                    OwnedPanelLayout layout;
                    check(OwnedPanelMatcher.TryLocate(panel, client, out layout), "HUD scale search " + scale);
                    check(OwnedPanelMatcher.ReadSlots(panel, layout, shapes, new OwnedPanelShape[0])[0].State == "candidate", "HUD scale glyph " + scale);
                }
            }
            using (var rectangle = DrawPanel(new Size(2559, 1440), 1.0, shapes[0], true, false))
            { OwnedPanelLayout layout; check(!OwnedPanelMatcher.TryLocate(rectangle, new Size(2559, 1440), out layout), "undivided stats panel rejected"); }
            return checks;
        }

        private static Dictionary<string, object> BackendModel()
        {
            var regions = new object[3]; var cards = new object[3]; var offers = new object[3];
            for (int column = 0; column < 3; column++)
            {
                int x = 200 + column * 450;
                regions[column] = new Dictionary<string, object> { { "column", column }, { "x", x }, { "y", 150 },
                    { "width", 320 }, { "height", 500 }, { "signature", new int[192] } };
                var feature = new int[128]; for (int i = 0; i < feature.Length; i++) feature[i] = i % 2 == 0 ? 0 : 8;
                cards[column] = new Dictionary<string, object> { { "column", column }, { "anchors", new object[] {
                    new Dictionary<string, object> { { "box", new Dictionary<string, object> { { "x", x + 10 }, { "y", 300 }, { "width", 180 }, { "height", 30 } } }, { "feature", feature } }
                } } };
                offers[column] = new Dictionary<string, object> { { "id", new[] { "a", "b", "c" }[column] },
                    { "icon", "https://raw.communitydragon.org/16.21/game/fixture-" + column + ".png" }, { "rarity", "silver" } };
            }
            var capture = new Dictionary<string, object> { { "capturedAt", 1000L }, { "width", 1920 }, { "height", 1080 },
                { "originX", -2500 }, { "originY", 100 }, { "windowHandle", "42" }, { "regions", regions },
                { "identityAnchors", new Dictionary<string, object> { { "version", 1 }, { "algorithm", CardTitleIdentity.Algorithm },
                    { "frameId", "synthetic-only" }, { "pass", "card-titles-color" }, { "cards", cards } } } };
            return new Dictionary<string, object> { { "phase", "InProgress" }, { "stage", "live" },
                { "ocr", new Dictionary<string, object> { { "enabled", true } } },
                { "mode", new Dictionary<string, object> { { "known", true }, { "isMayhem", true } } },
                { "panelSelection", new Dictionary<string, object> { { "status", "watching" }, { "reason", "waiting-panel" },
                    { "offerToken", "0123456789abcdef0123456789abcdef" }, { "gameId", "fixture-game" }, { "gameEpoch", 7L }, { "revision", 12L },
                    { "ids", new[] { "a", "b", "c" } }, { "offeredAt", 1000L }, { "capture", capture }, { "offers", offers }, { "owned", new object[0] } } } };
        }

        private static OwnedPanelShape FixtureShape(int kind, int size)
        {
            using (var image = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(image))
                using (var pen = new Pen(Color.White, size / 10F))
                {
                    graphics.Clear(Color.Transparent);
                    if (kind == 0) { graphics.DrawLine(pen, size / 4, size / 4, size * 3 / 4, size * 3 / 4); graphics.DrawLine(pen, size / 4, size * 3 / 4, size * 3 / 4, size / 4); }
                    else if (kind == 1) graphics.DrawEllipse(pen, size / 5, size / 5, size * 3 / 5, size * 3 / 5);
                    else if (kind == 2) { graphics.DrawLine(pen, size / 2, size / 5, size / 2, size * 4 / 5); graphics.DrawLine(pen, size / 5, size / 2, size * 4 / 5, size / 2); }
                    else graphics.FillRectangle(Brushes.White, size / 4, size / 4, size / 2, size / 2);
                }
                return OwnedPanelShape.Extract(image, new Rectangle(Point.Empty, image.Size));
            }
        }

        private static Bitmap DrawPanel(Size client, double factor, OwnedPanelShape icon, bool visible, bool grid = true)
        {
            Rectangle region = OwnedPanelMatcher.CaptureRegion(client);
            var image = new Bitmap(region.Width, region.Height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(image))
            {
                graphics.Clear(Color.FromArgb(35, 65, 100));
                if (!visible) return image;
                double scale = client.Height / 1440.0 * factor;
                int left = (int)Math.Round(client.Width / 2.0 - 634.5 * scale) - region.Left;
                int top = client.Height - (int)Math.Round(147 * scale) - region.Top;
                using (var brush = new SolidBrush(Color.FromArgb(20, 35, 45))) graphics.FillRectangle(brush, left, top, (float)(210 * scale), (float)(146 * scale));
                using (var pen = new Pen(Color.FromArgb(180, 149, 75), Math.Max(1, (float)scale))) graphics.DrawRectangle(pen, left, top, (float)(210 * scale - 1), (float)(146 * scale - 1));
                if (!grid)
                {
                    using (var brush = new SolidBrush(Color.FromArgb(1, 14, 13))) graphics.FillRectangle(brush, left + 3, top + 3, (float)(210 * scale - 6), (float)(146 * scale - 6));
                    return image;
                }
                for (int slot = 0; slot < 6; slot++)
                {
                    var cell = new Rectangle(left + (int)Math.Round((11 + slot % 3 * 64) * scale), top + (int)Math.Round((10 + slot / 3 * 66) * scale), Math.Max(8, (int)Math.Round(57 * scale)), Math.Max(8, (int)Math.Round(57 * scale)));
                    using (var brush = new SolidBrush(Color.FromArgb(1, 14, 13))) graphics.FillRectangle(brush, cell);
                    if (slot != 0) continue;
                    int side = Math.Max(10, cell.Width - 14);
                    for (int y = 0; y < side; y++) for (int x = 0; x < side; x++)
                        if (icon.Pixels[Math.Min(27, y * 28 / side) * 28 + Math.Min(27, x * 28 / side)]) image.SetPixel(cell.X + (cell.Width - side) / 2 + x, cell.Y + (cell.Height - side) / 2 + y, Color.FromArgb(226, 215, 173));
                }
            }
            return image;
        }
    }
}
