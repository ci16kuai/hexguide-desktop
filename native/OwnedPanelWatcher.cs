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
using System.Security.Cryptography;
using System.Text;
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
        private readonly OwnedPanelStageDiagnostics captureStages = new OwnedPanelStageDiagnostics();
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
            foreach (string url in next.OwnedUrls) needed.Add(url);
            foreach (string url in next.ExcludedUrls) needed.Add(url);
            TrimCache();
            foreach (string url in next.IconUrls) QueueTemplate(url);
            foreach (string url in next.OwnedUrls) QueueTemplate(url);
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
            var result = new Dictionary<string, object> {
                { "provider", "panel-icon" }, { "profile", OwnedPanelMatcher.Profile },
                { "status", lastCode }, { "attempts", attempts }, { "captured", captured },
                { "matched", matched }, { "blocked", blocked }, { "lastAt", lastAt },
                { "stableFrames", stability.Count }, { "templateCount", templates.Count },
                { "liveVerified", false }, { "skillExclusion", context != null && context.ExcludedUrls.Length > 0 ? "provided" : "unavailable" }
            };
            captureStages.AddTo(result, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            return result;
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
                if (!templates.TryGetValue(expected.IconUrls[index], out shapes[index])) { QueueTemplate(expected.IconUrls[index]); stability.Reset(); SetStatus("loading-icons"); return; }
            var owned = new OwnedPanelShape[expected.OwnedUrls.Length];
            for (int index = 0; index < owned.Length; index++)
                if (!templates.TryGetValue(expected.OwnedUrls[index], out owned[index])) { QueueTemplate(expected.OwnedUrls[index]); stability.Reset(); SetStatus("loading-icons"); return; }
            var excluded = new List<OwnedPanelShape>();
            foreach (string url in expected.ExcludedUrls)
            {
                OwnedPanelShape shape;
                if (!templates.TryGetValue(url, out shape)) { QueueTemplate(url); stability.Reset(); SetStatus("loading-icons"); return; }
                excluded.Add(shape);
            }
            long stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lastAt = stamp; attempts = Increment(attempts);
            Bitmap bitmap; bool titlesVisible; string failure;
            if (!Capture(expected, out bitmap, out titlesVisible, out failure))
            { blocked = Increment(blocked); captureStages.Record("capture-blocked", stamp, failure); stability.Reset(); SetStatus(failure); return; }
            using (bitmap)
            {
                captured = Increment(captured);
                if (titlesVisible) { captureStages.Record("cards-open", stamp); stability.Reset(); SetStatus("cards-open"); return; }
                OwnedPanelLayout layout;
                if (!OwnedPanelMatcher.TryLocate(bitmap, expected.Reference.ClientBounds.Size, shapes, owned, excluded.ToArray(), out layout))
                { captureStages.Record("layout-missing", stamp); stability.Reset(); SetStatus("waiting-panel"); return; }
                OwnedPanelSlotMatch[] slots = OwnedPanelMatcher.ReadSlots(bitmap, layout, shapes, owned, excluded.ToArray());
                bool any = false;
                foreach (var slot in slots) if (slot.Indices.Length > 0) any = true;
                if (!any) { captureStages.Record("slot-mismatch", stamp); stability.Reset(); SetStatus("waiting-panel"); return; }
                matched = Increment(matched);
                captureStages.Record("slot-matched", stamp);
                string geometry = expected.GeometryKey + ":" + layout.Key;
                var frame = new OwnedPanelProofFrame(stamp, geometry, slots);
                if (!stability.Observe(expected.Identity, frame)) { SetStatus("pending"); return; }
                if (context != expected || disposed) return;
                var proof = new Dictionary<string, object> {
                    { "version", 2 }, { "provider", "panel-icon" }, { "offerToken", expected.Token }, { "gameId", expected.GameId },
                    { "gameEpoch", expected.Epoch }, { "revision", expected.Revision }, { "ids", expected.Ids },
                    { "glyphs", OwnedPanelGlyphIdentity.Proof(expected, shapes, owned) },
                    { "frames", stability.Proof() }
                };
                // The HTTP boundary has the same hard limit. Never emit an
                // oversized observation, including maximum owned/template IDs.
                if (Encoding.UTF8.GetByteCount(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(proof)) > 4096)
                { stability.Reset(); SetStatus("proof-too-large"); return; }
                publishing = true; emittedIdentity = expected.Identity; captureStages.Record("evidence-ready", stamp); SetStatus("observed");
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

    // These lifetime totals and the last actual attempt survive model scope
    // changes. A later waiting-offers/local-action status must not erase whether
    // the previous capture saw cards, missed the HUD layout, or missed a glyph.
    internal sealed class OwnedPanelStageDiagnostics
    {
        private string lastStage = "not-attempted", lastCode = "not-attempted";
        private long lastAt;
        private int cardsOpen, layoutMissing, slotMismatch, evidenceReady;

        internal static int Increment(int value) { return Math.Min(1000000, value + 1); }

        internal void Record(string stage, long at, string captureCode = null)
        {
            if (at <= 0) return;
            switch (stage)
            {
                case "cards-open": cardsOpen = Increment(cardsOpen); break;
                case "layout-missing": layoutMissing = Increment(layoutMissing); break;
                case "slot-mismatch": slotMismatch = Increment(slotMismatch); break;
                case "evidence-ready": evidenceReady = Increment(evidenceReady); break;
                case "slot-matched": case "capture-blocked": break;
                default: return;
            }
            lastStage = stage; lastAt = at;
            lastCode = stage == "capture-blocked" ? CaptureCode(captureCode) : "captured";
        }

        private static string CaptureCode(string code)
        {
            switch (code)
            {
                case "dpi-unavailable": case "game-not-foreground": case "game-not-visible":
                case "geometry-changed": case "region-occluded": case "geometry-or-focus-changed":
                    return code;
                default: return "capture-unavailable";
            }
        }

        internal void AddTo(Dictionary<string, object> result, long now)
        {
            result["lastCaptureStage"] = lastStage;
            result["lastCaptureCode"] = lastCode;
            result["lastCaptureStageAgeMs"] = lastAt <= 0 ? (object)null : Math.Min(3600000L, now >= lastAt ? now - lastAt : 0L);
            result["cardsOpen"] = cardsOpen;
            result["layoutMissing"] = layoutMissing;
            result["slotMismatch"] = slotMismatch;
            result["evidenceReady"] = evidenceReady;
        }
    }

    internal sealed class OwnedPanelContext
    {
        internal string Token, Identity, GeometryKey;
        internal object GameId;
        internal long Epoch, Revision;
        internal string[] Ids, IconUrls, OwnedIds, OwnedUrls, ExcludedUrls;
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
            var ownedIds = new List<string>(); var ownedUrls = new List<string>();
            long evidenceNotBefore;
            bool pendingScope = ModelValue.Boolean(value, "pendingUntilConfirmed")
                && ModelValue.Integer(value, "evidenceNotBefore", out evidenceNotBefore);
            // An older unanswered round can contain a candidate confirmed in
            // a newer round. Keep that identity for owned-glyph subtraction;
            // the server excludes it from selectable outcomes.
            var seen = pendingScope ? new HashSet<string>(StringComparer.Ordinal)
                : new HashSet<string>(reference.Ids, StringComparer.Ordinal);
            foreach (object raw in ModelValue.Array(value, "owned"))
            {
                if (ownedIds.Count >= 6) return false;
                var entry = raw as Dictionary<string, object>;
                string id = ModelValue.Text(entry, "id"), url = ModelValue.Text(entry, "icon"); Uri uri;
                if (id.Length == 0 || id.Length > 100 || id.IndexOf('\0') >= 0 || !seen.Add(id)
                    || !OwnedPanelWatcher.TrustedIcon(url, out uri)) return false;
                ownedIds.Add(id); ownedUrls.Add(url);
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
                Reference = reference, Ids = reference.Ids, IconUrls = urls, OwnedIds = ownedIds.ToArray(), OwnedUrls = ownedUrls.ToArray(), ExcludedUrls = excluded.ToArray(), GeometryKey = geometry,
                Identity = token + "|" + (game as string ?? "null") + "|" + epoch + "|" + revision + "|" + string.Join("|", reference.Ids) + "|" + string.Join("|", urls) + "|" + string.Join("|", ownedIds.ToArray()) + "|" + string.Join("|", ownedUrls.ToArray()) + "|" + string.Join("|", excluded.ToArray()) + "|" + geometry };
            return true;
        }
    }

    // This protocol binds descriptors to the exact catalog IDs/URLs supplied
    // by the server. Both runtimes use the same normalized glyph identity for
    // current-offer collisions and subtraction of already owned occurrences.
    internal static class OwnedPanelGlyphIdentity
    {
        internal const string Algorithm = "normalized28-sha256-v1";
        internal static string Hash(byte[] bytes)
        {
            using (var algorithm = SHA256.Create())
                return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
        internal static string Binding(string id, string url)
        { return Hash(Encoding.UTF8.GetBytes(Algorithm + "\0" + id + "\0" + url)); }
        internal static Dictionary<string, object> Proof(OwnedPanelContext context, OwnedPanelShape[] offers, OwnedPanelShape[] owned)
        {
            var entries = new object[offers.Length + owned.Length];
            for (int i = 0; i < offers.Length; i++) entries[i] = new[] { Binding(context.Ids[i], context.IconUrls[i]), offers[i].Fingerprint };
            for (int i = 0; i < owned.Length; i++) entries[offers.Length + i] = new[] { Binding(context.OwnedIds[i], context.OwnedUrls[i]), owned[i].Fingerprint };
            return new Dictionary<string, object> { { "algorithm", Algorithm }, { "templates", entries } };
        }
    }

    internal sealed class OwnedPanelShape
    {
        internal const int Side = 28;
        internal bool[] Pixels;
        internal string Fingerprint
        {
            get
            {
                if (Pixels == null || Pixels.Length != Side * Side) return "";
                var packed = new byte[Side * Side / 8];
                for (int i = 0; i < Pixels.Length; i++) if (Pixels[i]) packed[i / 8] |= (byte)(1 << (i % 8));
                return OwnedPanelGlyphIdentity.Hash(packed);
            }
        }
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
        internal const string Profile = "hud-six-slots-4.0-experimental-v2";
        // One supplied 2559x1440 screenshot establishes this HUD geometry. Search
        // a bounded family of HUD scales, requiring the complete gold L-frame,
        // all six cell boundaries and their grid gutters. It does not treat
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
        { return TryLocate(roi, client, null, null, null, out layout); }

        internal static bool TryLocate(Bitmap roi, Size client, OwnedPanelShape[] candidates, OwnedPanelShape[] owned, OwnedPanelShape[] excluded, out OwnedPanelLayout layout)
        {
            layout = null;
            Rectangle capture = CaptureRegion(client);
            if (roi.Width != capture.Width || roi.Height != capture.Height) return false;
            double best = 0;
            int bestMatches = 0;
            double bestSimilarity = 0;
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
                    if (score < .85) continue;
                    var candidateLayout = new OwnedPanelLayout { Slots = slots, StructureScore = score,
                        Key = Profile + ":" + left + ":" + top + ":" + panelWidth + ":" + panelHeight };
                    int matches = 0; double similarity = 0;
                    if (candidates != null)
                    {
                        foreach (var slot in ReadSlots(roi, candidateLayout, candidates, owned, excluded))
                            if (slot.State == "candidate" || slot.State == "ambiguous" || slot.State == "owned")
                            { matches++; similarity += slot.Similarity; }
                    }
                    // Borders alone can favour a few pixels of offset. Among
                    // structurally valid grids, use the same strict scoped
                    // glyph classifier to align the cell interiors. No new
                    // template, relaxed threshold or selection is introduced.
                    if (layout != null && (matches < bestMatches || matches == bestMatches
                        && (similarity < bestSimilarity || similarity == bestSimilarity && score <= best))) continue;
                    best = score; bestMatches = matches; bestSimilarity = similarity; layout = candidateLayout;
                }
            }
            return layout != null;
        }

        private static double StructureScore(Bitmap image, Rectangle panel, Rectangle[] slots, double scale)
        {
            int gold = 0, goldCount = 0;
            double cells = 0;
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
                double boundary = CellBoundaryScore(image, slot, scale);
                if (boundary < .60) return 0;
                cells += boundary;
            }
            return .35 * gold / goldCount + .45 * cells / slots.Length + .20 * gutters / gutterCount;
        }

        // Occupied cells can contain bright full-colour illustrations or a
        // coloured rarity rim. Locate the grid by the transition across each
        // cell edge, not by requiring its contents to be mostly black. An
        // undivided attribute panel has no repeated inner/outer transitions.
        private static double CellBoundaryScore(Bitmap image, Rectangle cell, double scale)
        {
            int inset = Math.Max(1, (int)Math.Round(3 * scale));
            int outside = Math.Max(1, (int)Math.Round(3 * scale));
            int matched = 0, count = 0;
            for (int side = 0; side < 4; side++) for (int step = 1; step <= 4; step++)
            {
                int x = cell.Left + (cell.Width - 1) * step / 5;
                int y = cell.Top + (cell.Height - 1) * step / 5;
                Point inner, outer;
                if (side == 0) { inner = new Point(cell.Left + inset, y); outer = new Point(cell.Left - outside, y); }
                else if (side == 1) { inner = new Point(cell.Right - 1 - inset, y); outer = new Point(cell.Right - 1 + outside, y); }
                else if (side == 2) { inner = new Point(x, cell.Top + inset); outer = new Point(x, cell.Top - outside); }
                else { inner = new Point(x, cell.Bottom - 1 - inset); outer = new Point(x, cell.Bottom - 1 + outside); }
                if (!new Rectangle(Point.Empty, image.Size).Contains(outer)) return 0;
                Color a = image.GetPixel(inner.X, inner.Y), b = image.GetPixel(outer.X, outer.Y);
                if (Math.Abs(a.R - b.R) + Math.Abs(a.G - b.G) + Math.Abs(a.B - b.B) >= 36) matched++;
                count++;
            }
            return matched / (double)count;
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
        { return ReadSlots(bitmap, layout, candidates, new OwnedPanelShape[0], excluded); }

        internal static OwnedPanelSlotMatch[] ReadSlots(Bitmap bitmap, OwnedPanelLayout layout, OwnedPanelShape[] candidates, OwnedPanelShape[] owned, OwnedPanelShape[] excluded)
        {
            var result = new OwnedPanelSlotMatch[6];
            for (int index = 0; index < result.Length; index++)
            {
                var area = layout.Slots[index]; area.Inflate(-Math.Max(1, area.Width / 20), -Math.Max(1, area.Height / 20));
                var shape = OwnedPanelShape.Extract(bitmap, area);
                result[index] = Match(shape, candidates, owned, excluded); result[index].Index = index;
            }
            return result;
        }

        internal static OwnedPanelSlotMatch Match(OwnedPanelShape shape, OwnedPanelShape[] candidates, OwnedPanelShape[] excluded)
        { return Match(shape, candidates, new OwnedPanelShape[0], excluded); }

        internal static OwnedPanelSlotMatch Match(OwnedPanelShape shape, OwnedPanelShape[] candidates, OwnedPanelShape[] owned, OwnedPanelShape[] excluded)
        {
            var output = new OwnedPanelSlotMatch { State = shape == null ? "empty" : "unmatched", Indices = new int[0] };
            if (shape == null || candidates == null || candidates.Length != 3) return output;
            if (excluded != null) foreach (OwnedPanelShape skill in excluded)
                if (OwnedPanelShape.Similarity(shape, skill) >= .88) { output.State = "excluded"; return output; }
            if (owned == null || owned.Length > 6) return output;
            var all = new OwnedPanelShape[3 + owned.Length];
            Array.Copy(candidates, all, 3); Array.Copy(owned, 0, all, 3, owned.Length);
            var scores = new double[all.Length]; int best = 0;
            for (int i = 0; i < all.Length; i++) { scores[i] = OwnedPanelShape.Similarity(shape, all[i]); if (scores[i] > scores[best]) best = i; }
            output.Similarity = scores[best];
            if (scores[best] < .90) return output;
            string identity = all[best].Fingerprint;
            if (identity.Length == 0) return output;
            var group = new List<int>();
            for (int i = 0; i < all.Length; i++)
            {
                // A near match is not proof of a shared glyph. Only the exact
                // normalized descriptor can form a statistics-resolvable group.
                if (all[i] != null && all[i].Fingerprint == identity) { if (i < 3) group.Add(i); }
                else if (scores[best] - scores[i] < .065) return output;
            }
            output.Indices = group.ToArray(); output.State = group.Count == 0 ? "owned" : group.Count == 1 ? "candidate" : "ambiguous";
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
            var stages = new OwnedPanelStageDiagnostics();
            var stageSnapshot = new Dictionary<string, object>();
            stages.AddTo(stageSnapshot, 1000);
            check(stageSnapshot.Count == 7 && (string)stageSnapshot["lastCaptureStage"] == "not-attempted"
                && stageSnapshot["lastCaptureStageAgeMs"] == null, "stage diagnostics distinguish no attempted capture");
            stages.Record("cards-open", 1100);
            stages.Record("layout-missing", 1200);
            stages.Record("slot-mismatch", 1300);
            stages.Record("slot-matched", 1400);
            stages.AddTo(stageSnapshot, 1500);
            check((int)stageSnapshot["cardsOpen"] == 1 && (int)stageSnapshot["layoutMissing"] == 1
                && (int)stageSnapshot["slotMismatch"] == 1 && (int)stageSnapshot["evidenceReady"] == 0,
                "capture stage totals distinguish titles, layout, glyph and unsubmitted matches");
            check((string)stageSnapshot["lastCaptureStage"] == "slot-matched" && (string)stageSnapshot["lastCaptureCode"] == "captured"
                && (long)stageSnapshot["lastCaptureStageAgeMs"] == 100, "last matched frame retains its stage and age");
            stages.Record("evidence-ready", 1600);
            stageSnapshot["status"] = "waiting-offers";
            stages.AddTo(stageSnapshot, 1700);
            check((string)stageSnapshot["status"] == "waiting-offers" && (string)stageSnapshot["lastCaptureStage"] == "evidence-ready"
                && (int)stageSnapshot["evidenceReady"] == 1, "scope status cannot erase the last real capture stage");
            stages.Record("capture-blocked", 1800, "game-not-foreground");
            stages.AddTo(stageSnapshot, 1900);
            check((string)stageSnapshot["lastCaptureStage"] == "capture-blocked" && (string)stageSnapshot["lastCaptureCode"] == "game-not-foreground",
                "capture failure code survives a subsequent scope-only diagnostic snapshot");
            stages.Record("private-untrusted-data", 2000, "private-untrusted-data");
            stages.AddTo(stageSnapshot, 2100);
            check((string)stageSnapshot["lastCaptureStage"] == "capture-blocked" && (long)stageSnapshot["lastCaptureStageAgeMs"] == 300,
                "unlisted diagnostic stage cannot publish or replace capture data");
            stages.Record("capture-blocked", 2200, "private-untrusted-data");
            stages.AddTo(stageSnapshot, 2200);
            check((string)stageSnapshot["lastCaptureCode"] == "capture-unavailable", "unlisted capture detail is normalized to a fixed code");
            stages.AddTo(stageSnapshot, long.MaxValue);
            check((long)stageSnapshot["lastCaptureStageAgeMs"] == 3600000, "old capture stage age is bounded");
            stages.AddTo(stageSnapshot, 2100);
            check((long)stageSnapshot["lastCaptureStageAgeMs"] == 0, "clock adjustment cannot publish a negative stage age");
            check(OwnedPanelStageDiagnostics.Increment(999999) == 1000000 && OwnedPanelStageDiagnostics.Increment(1000000) == 1000000,
                "stage lifetime counters saturate at the fixed diagnostic bound");
            var largestDiagnostic = new Dictionary<string, object> {
                { "provider", "panel-icon" }, { "profile", OwnedPanelMatcher.Profile }, { "status", "geometry-or-focus-changed" },
                { "attempts", 1000000 }, { "captured", 1000000 }, { "matched", 1000000 }, { "blocked", 1000000 }, { "lastAt", long.MaxValue },
                { "stableFrames", 3 }, { "templateCount", 96 }, { "liveVerified", false }, { "skillExclusion", "unavailable" },
                { "schemaVersion", 1 }, { "appVersion", "2147483647.2147483647.2147483647" },
                { "updatedAtUtc", "9999-12-31T23:59:59.9999999Z" }, { "backendReason", new string('x', 128) }
            };
            stages.AddTo(largestDiagnostic, long.MaxValue);
            foreach (string counter in new[] { "cardsOpen", "layoutMissing", "slotMismatch", "evidenceReady" }) largestDiagnostic[counter] = 1000000;
            check(Encoding.UTF8.GetByteCount(serializer.Serialize(largestDiagnostic)) <= 2048, "maximal panel stage diagnostics fit the existing complete-file bound");
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
            contextValue = ModelValue.Object(backendModel(), "panelSelection");
            contextValue["owned"] = new object[] { new Dictionary<string, object> { { "id", "previous" }, { "icon", "https://raw.communitydragon.org/16.21/game/previous.png" } } };
            check(OwnedPanelContext.TryRead(contextValue, out parsed) && parsed.OwnedIds.Length == 1 && parsed.OwnedIds[0] == "previous", "owned template identities retained");
            string ownedIdentity = parsed.Identity;
            (ModelValue.Array(contextValue, "owned")[0] as Dictionary<string, object>)["icon"] = "https://raw.communitydragon.org/16.21/game/changed.png";
            check(OwnedPanelContext.TryRead(contextValue, out parsed) && parsed.Identity != ownedIdentity, "owned template change resets observation identity");
            (ModelValue.Array(contextValue, "owned")[0] as Dictionary<string, object>)["icon"] = "https://untrusted.example/previous.png";
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "untrusted owned template rejected");
            contextValue = ModelValue.Object(backendModel(), "panelSelection");
            contextValue["owned"] = new object[] { new Dictionary<string, object> { { "id", "a" }, { "icon", "https://raw.communitydragon.org/16.21/game/previous.png" } } };
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "owned candidate overlap rejected");
            contextValue["pendingUntilConfirmed"] = true;
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "pending overlap requires a fresh evidence fence");
            contextValue["evidenceNotBefore"] = 2000L;
            check(OwnedPanelContext.TryRead(contextValue, out parsed) && parsed.OwnedIds[0] == "a", "pending overlap retained for owned occurrence subtraction");
            contextValue["owned"] = new object[] {
                new Dictionary<string, object> { { "id", "a" }, { "icon", "https://raw.communitydragon.org/16.21/game/previous.png" } },
                new Dictionary<string, object> { { "id", "a" }, { "icon", "https://raw.communitydragon.org/16.21/game/previous.png" } }
            };
            check(!OwnedPanelContext.TryRead(contextValue, out parsed), "pending overlap never allows duplicate owned IDs");
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
            check(OwnedPanelMatcher.Match(FixtureShape(3, 64), shapes, new[] { FixtureShape(3, 64) }, new OwnedPanelShape[0]).State == "owned", "distinct known-owned template classified without a candidate");
            check(OwnedPanelMatcher.Match(shapes[0], shapes, new[] { shapes[0] }, new OwnedPanelShape[0]).State == "candidate", "owned equivalent shares candidate glyph for occurrence counting");
            var near = new OwnedPanelShape { Pixels = (bool[])shapes[0].Pixels.Clone() }; near.Pixels[0] = !near.Pixels[0];
            check(near.Fingerprint != shapes[0].Fingerprint && OwnedPanelShape.Similarity(near, shapes[0]) > .985, "near descriptors have separate identity");
            check(OwnedPanelMatcher.Match(shapes[0], new[] { shapes[0], near, shapes[2] }, new OwnedPanelShape[0]).State == "unmatched", "near current templates cannot be promoted to aliases");
            check(OwnedPanelMatcher.Match(shapes[0], shapes, new[] { near }, new OwnedPanelShape[0]).State == "unmatched", "near known-owned glyph prevents false new selection");
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
                { "version", 2 }, { "provider", "panel-icon" }, { "offerToken", "0123456789abcdef0123456789abcdef" }, { "gameId", "fixture-game" },
                { "gameEpoch", 7L }, { "revision", 12L }, { "ids", new[] { "a", "b", "c" } },
                { "glyphs", OwnedPanelGlyphIdentity.Proof(new OwnedPanelContext { Ids = new[] { "a", "b", "c" }, IconUrls = new[] { "url-a", "url-b", "url-c" }, OwnedIds = new string[0], OwnedUrls = new string[0] }, shapes, new OwnedPanelShape[0]) }, { "frames", stable.Proof() }
            };
            string proofJson = serializer.Serialize(proof);
            check(System.Text.Encoding.UTF8.GetByteCount(proofJson) <= 4096, "native proof fits authenticated endpoint body limit");
            var decodedProof = serializer.DeserializeObject(proofJson) as Dictionary<string, object>;
            check(decodedProof.Count == 9 && ModelValue.Text(decodedProof, "version") == "2" && ModelValue.Text(decodedProof, "provider") == "panel-icon"
                && ModelValue.Array(decodedProof, "ids").Count == 3 && ModelValue.Array(decodedProof, "frames").Count == 3,
                "proof JSON top-level schema matches server");
            check(ModelValue.Text(ModelValue.Object(decodedProof, "glyphs"), "algorithm") == OwnedPanelGlyphIdentity.Algorithm
                && ModelValue.Array(ModelValue.Object(decodedProof, "glyphs"), "templates").Count == 3, "proof carries versioned bound template fingerprints");
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
                    check(OwnedPanelMatcher.TryLocate(panel, size, shapes, new OwnedPanelShape[0], new OwnedPanelShape[0], out layout), "scoped glyph alignment retains structure " + size);
                    check(OwnedPanelMatcher.ReadSlots(panel, layout, shapes, new OwnedPanelShape[0])[0].State == "candidate", "scoped glyph alignment retains candidate " + size);
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
            // A fully illustrated augment and rarity rims are real occupied
            // cells, not evidence that the whole result panel has disappeared.
            foreach (double factor in new[] { .825, 1.0, 1.175 })
            using (var panel = DrawPanel(new Size(2560, 1440), factor, shapes[0], true))
            {
                Rectangle capture = OwnedPanelMatcher.CaptureRegion(new Size(2560, 1440));
                int left = (int)Math.Round(1280 - 634.5 * factor) - capture.Left;
                int top = 1440 - (int)Math.Round(147 * factor) - capture.Top;
                using (var graphics = Graphics.FromImage(panel))
                {
                    for (int slot = 0; slot < 6; slot++)
                    {
                        var cell = new Rectangle(left + (int)Math.Round((11 + slot % 3 * 64) * factor),
                            top + (int)Math.Round((10 + slot / 3 * 66) * factor), (int)Math.Round(57 * factor), (int)Math.Round(57 * factor));
                        if (slot == 0) { using (var fill = new SolidBrush(Color.FromArgb(180, 95, 20))) graphics.FillRectangle(fill, cell); }
                        using (var pen = new Pen(slot % 2 == 0 ? Color.FromArgb(220, 180, 80) : Color.FromArgb(165, 75, 190), Math.Max(1, (float)(2 * factor))))
                            graphics.DrawRectangle(pen, cell.X, cell.Y, cell.Width - 1, cell.Height - 1);
                    }
                }
                OwnedPanelLayout layout;
                check(OwnedPanelMatcher.TryLocate(panel, new Size(2560, 1440), out layout), "bright occupied cell and rarity rims remain locatable " + factor);
            }
            // Contents cannot veto a genuine frame even when all six cells
            // are bright. They still cannot produce a candidate match alone.
            using (var panel = DrawPanel(new Size(2560, 1440), 1.0, shapes[0], true))
            {
                var region = OwnedPanelMatcher.CaptureRegion(new Size(2560, 1440));
                using (var graphics = Graphics.FromImage(panel))
                using (var fill = new SolidBrush(Color.FromArgb(180, 100, 60)))
                    for (int slot = 0; slot < 6; slot++) graphics.FillRectangle(fill,
                        (int)Math.Round(1280 - 634.5) - region.Left + 11 + slot % 3 * 64,
                        1440 - 147 - region.Top + 10 + slot / 3 * 66, 57, 57);
                OwnedPanelLayout layout;
                check(OwnedPanelMatcher.TryLocate(panel, new Size(2560, 1440), shapes, new OwnedPanelShape[0], new OwnedPanelShape[0], out layout), "six bright cells remain a result grid");
                foreach (var slot in OwnedPanelMatcher.ReadSlots(panel, layout, shapes, new OwnedPanelShape[0]))
                    check(slot.Indices.Length == 0, "bright fill without a scoped glyph cannot select");
            }
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
