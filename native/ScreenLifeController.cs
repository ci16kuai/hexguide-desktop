using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace HexGuide.Desktop
{
    // Native owner for the experimental visual fallback. The application's
    // existing timer calls PulseAsync; there is no extra timer/worker loop.
    // Interface life wins. An absent reviewed HUD profile disables all screen
    // access, not merely OCR. No image/text/identity is persisted or published.
    internal sealed class ScreenLifeController : IDisposable
    {
        private readonly string nativeDirectory, calibrationPath;
        private readonly object sync = new object();
        private readonly ScreenLifeObserver observer = new ScreenLifeObserver();
        private readonly SynchronizationContext deliveryContext;
        private LifeContext context;
        private LifeCalibration calibration;
        private Process child;
        private int running, generation;
        private bool disposed;
        private long nextProbeAt, nextTimerAt, nextCalibrationAt, lastProofAt;
        private string lastProofState = "", statusCode = "experimental-calibration-required";
        private Rectangle previousBounds;
        private long previousWindow;
        private int previousDpi;

        internal event Action<Dictionary<string, object>> ProofReady;
        internal string StatusCode { get { lock (sync) return statusCode; } }
        internal bool CalibrationReady { get { lock (sync) return calibration != null; } }

        internal ScreenLifeController(string nativeDir, string dataDir)
        {
            nativeDirectory = Path.GetFullPath(nativeDir);
            calibrationPath = Path.Combine(Path.GetFullPath(dataDir), "screen-life-calibration.json");
            deliveryContext = SynchronizationContext.Current;
        }

        internal void UpdateModel(Dictionary<string, object> model)
        {
            lock (sync)
            {
                if (disposed) return;
                LifeContext previous = context, next = ReadContext(model, Now());
                bool changed = context == null || next == null || context.GameId != next.GameId || context.GameEpoch != next.GameEpoch
                    || context.FallbackEligible != next.FallbackEligible || context.LiveEligible != next.LiveEligible;
                context = next;
                if (changed)
                {
                    generation++; observer.Reset("context-changed"); ClearGeometry();
                    lastProofState = ""; lastProofAt = 0; nextProbeAt = 0;
                    if (previous != null && previous.LiveEligible && (next == null || !next.LiveEligible || previous.GameId != next.GameId || previous.GameEpoch != next.GameEpoch))
                        EmitRetiredScopeUnknownLocked(previous);
                    if (next != null && next.LiveEligible && !next.FallbackEligible) EmitUnknownLocked(next, next.OcrEnabled ? "interface-authoritative" : "recognition-paused");
                }
                if (next == null || !next.LiveEligible) statusCode = "waiting-live-game";
                else if (!next.FallbackEligible) statusCode = next.OcrEnabled ? "interface-authoritative" : "recognition-paused";
            }
        }

        internal Task PulseAsync()
        {
            // This metadata-only fence runs even while an earlier OCR child is
            // busy, so a brief alt-tab cannot preserve an old death chain.
            CheckScopeMetadata();
            if (Interlocked.CompareExchange(ref running, 1, 0) != 0) return Task.FromResult(0);
            int startGeneration; lock (sync) startGeneration = generation;
            return Task.Run(delegate
            {
                try { PulseCore(); }
                catch { lock (sync) { if (!disposed && generation == startGeneration) InvalidateLocked("screen-life-unavailable"); } }
                finally { Interlocked.Exchange(ref running, 0); }
            });
        }

        private void PulseCore()
        {
            LifeContext scope;
            LifeCalibration profile;
            int ticket;
            lock (sync)
            {
                if (disposed || context == null || !context.LiveEligible || !context.FallbackEligible) return;
                if (Now() - context.UpdatedAt > 10000) { InvalidateLocked("model-stale"); return; }
                if (Now() < nextProbeAt) return;
                nextProbeAt = Now() + 1000;
                if (Now() >= nextCalibrationAt)
                {
                    nextCalibrationAt = Now() + 5000;
                    LifeCalibration loaded = LoadCalibration(calibrationPath);
                    if ((calibration == null) != (loaded == null) || calibration != null && loaded != null && calibration.Json != loaded.Json)
                    { generation++; observer.Reset("context-changed"); ClearGeometry(); lastProofState = ""; }
                    calibration = loaded;
                }
                if (calibration == null) { InvalidateLocked("experimental-calibration-required"); return; }
                profile = calibration; scope = context; ticket = generation;
            }

            ScreenLifeFrame cheap;
            string failure;
            if (!TryCheapFrame(profile, scope.GameEpoch, out cheap, out failure)) { InvalidateCurrent(scope, profile, ticket, failure); return; }
            lock (sync)
            {
                if (!Current(scope, profile, ticket)) return;
                if (previousWindow != 0 && (previousWindow != cheap.WindowHandle || previousBounds != cheap.ClientBounds || previousDpi != cheap.Dpi))
                { InvalidateLocked("geometry-changed"); return; }
                previousWindow = cheap.WindowHandle; previousBounds = cheap.ClientBounds; previousDpi = cheap.Dpi;
                statusCode = "watching-experimental";
                if (!observer.ShouldReadTimer(cheap) || Now() < nextTimerAt) return;
                nextTimerAt = Now() + 1000;
            }
            Dictionary<string, object> output = RunTimer(profile, cheap.WindowHandle, ticket);
            if (output == null) { InvalidateCurrent(scope, profile, ticket, "timer-unavailable"); return; }
            ScreenLifeFrame completed;
            if (!ReadCompletedFrame(output, cheap, Now(), out completed, out failure)) { InvalidateCurrent(scope, profile, ticket, failure); return; }
            // Metadata only after the child exits: no stale result can survive
            // a focus/geometry/API/game transition during Windows OCR.
            if (!StillCurrentWindow(completed)) { InvalidateCurrent(scope, profile, ticket, "game-not-foreground"); return; }
            lock (sync)
            {
                if (!Current(scope, profile, ticket)) return;
                ScreenLifeResult result = observer.Observe(completed);
                statusCode = result.Code;
                if (result.State == "dead" && result.StableFrames >= ScreenLifeObserver.RequiredFrames && result.CountdownSeconds.HasValue)
                    EmitLocked(scope, "dead", "verified-dead-countdown", result.StableFrames, result.CountdownSeconds, completed.CapturedAtMs);
                else if (result.State == "alive" && result.Respawned && result.StableFrames >= ScreenLifeObserver.RequiredFrames)
                    EmitLocked(scope, "alive", "verified-respawn", result.StableFrames, null, completed.CapturedAtMs);
                else if (result.State == "unknown") EmitUnknownLocked(scope, result.Code);
            }
        }

        private bool Current(LifeContext scope, LifeCalibration profile, int ticket)
        {
            return !disposed && ticket == generation && context != null && context.LiveEligible && context.FallbackEligible
                && context.GameId == scope.GameId && context.GameEpoch == scope.GameEpoch && Now() - context.UpdatedAt <= 10000
                && object.ReferenceEquals(profile, calibration);
        }

        private void InvalidateCurrent(LifeContext scope, LifeCalibration profile, int ticket, string code)
        { lock (sync) { if (Current(scope, profile, ticket)) InvalidateLocked(code); } }
        private void CheckScopeMetadata()
        {
            ScreenLifeFrame expected; int ticket;
            lock (sync)
            {
                if (disposed || calibration == null || context == null || !context.FallbackEligible || previousWindow == 0) return;
                expected = new ScreenLifeFrame { WindowHandle = previousWindow, ClientBounds = previousBounds, Dpi = previousDpi };
                ticket = generation;
            }
            if (StillCurrentWindow(expected)) return;
            lock (sync) { if (!disposed && ticket == generation) InvalidateLocked("focus-or-geometry-changed"); }
        }
        private void InvalidateLocked(string code)
        {
            generation++; observer.Reset("frame-unavailable"); ClearGeometry();
            statusCode = code;
            nextTimerAt = Now() + 4000;
            if (context != null && context.LiveEligible) EmitUnknownLocked(context, code);
        }
        private void ClearGeometry() { previousWindow = 0; previousBounds = Rectangle.Empty; previousDpi = 0; }
        private void EmitUnknownLocked(LifeContext scope, string diagnosticCode)
        {
            statusCode = diagnosticCode;
            if (lastProofState == "unknown") return;
            EmitLocked(scope, "unknown", "unavailable", 0, null, Now());
        }
        private void EmitRetiredScopeUnknownLocked(LifeContext retired)
        {
            var proof = new Dictionary<string, object> { { "provider", "screen" }, { "gameId", retired.GameId }, { "gameEpoch", retired.GameEpoch },
                { "observedAt", Now() }, { "state", "unknown" }, { "code", "unavailable" }, { "stableFrames", 0 }, { "countdownSeconds", null } };
            // A revocation must survive loss of the local model. The server
            // independently checks the retired game/epoch and can reject it if
            // that scope has already ended; it can never alter a newer game.
            Action deliver = delegate
            {
                Action<Dictionary<string, object>> handler; lock (sync) { if (disposed) return; handler = ProofReady; }
                if (handler != null) handler(proof);
            };
            if (deliveryContext != null) deliveryContext.Post(delegate(object ignored) { deliver(); }, null);
            else ThreadPool.QueueUserWorkItem(delegate(object ignored) { deliver(); });
        }
        private void EmitLocked(LifeContext scope, string state, string code, int stable, int? seconds, long at)
        {
            if (state == "dead" && state == lastProofState && at - lastProofAt < 800) return;
            if (at <= lastProofAt) return;
            lastProofState = state; lastProofAt = at;
            var proof = new Dictionary<string, object> { { "provider", "screen" }, { "gameId", scope.GameId }, { "gameEpoch", scope.GameEpoch },
                { "observedAt", at }, { "state", state }, { "code", code }, { "stableFrames", stable }, { "countdownSeconds", seconds.HasValue ? (object)seconds.Value : null } };
            int ticket = generation;
            Action deliver = delegate
            {
                Action<Dictionary<string, object>> handler;
                lock (sync)
                {
                    if (disposed || ticket != generation || context == null || context.GameId != scope.GameId || context.GameEpoch != scope.GameEpoch) return;
                    handler = ProofReady;
                }
                if (handler != null) handler(proof);
            };
            if (deliveryContext != null) deliveryContext.Post(delegate(object ignored) { deliver(); }, null);
            else ThreadPool.QueueUserWorkItem(delegate(object ignored) { deliver(); });
        }

        private Dictionary<string, object> RunTimer(LifeCalibration profile, long window, int ticket)
        {
            string script = Path.Combine(nativeDirectory, "scan-life.ps1");
            if (!File.Exists(script)) return null;
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
            var start = new ProcessStartInfo { FileName = powershell,
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(script) + " -ReadTimer -WindowHandle " + window.ToString(CultureInfo.InvariantCulture)
                    + " -ParentProcessId " + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                    + " -CalibrationBase64 " + Convert.ToBase64String(Encoding.UTF8.GetBytes(profile.Json)),
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true };
            using (var process = new Process { StartInfo = start })
            {
                try
                {
                    lock (sync) { if (disposed || ticket != generation || !process.Start()) return null; child = process; }
                    Task<string> stdout = Task.Run(delegate { return ReadLimited(process.StandardOutput, 4096); });
                    Task<string> stderr = Task.Run(delegate { return ReadLimited(process.StandardError, 1024); });
                    if (!process.WaitForExit(12000)) { try { process.Kill(); } catch { } return null; }
                    if (!Task.WaitAll(new Task[] { stdout, stderr }, 1000)) return null;
                    string text = stdout.Result, errors = stderr.Result;
                    if (process.ExitCode != 0 || errors == null || errors.Length > 0 || text == null) return null;
                    return new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 8 }.Deserialize<Dictionary<string, object>>(text);
                }
                catch { return null; }
                finally { lock (sync) { if (object.ReferenceEquals(child, process)) child = null; } }
            }
        }
        private static string ReadLimited(StreamReader reader, int maximum)
        {
            try
            {
                var builder = new StringBuilder(); var buffer = new char[512]; int count;
                while ((count = reader.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (builder.Length + count > maximum) return null;
                    builder.Append(buffer, 0, count);
                }
                return builder.ToString();
            }
            catch { return null; }
        }

        private static string Quote(string value)
        {
            // A resolved Windows file path cannot contain a quotation mark,
            // and the bundled .ps1 filename never ends in a backslash.
            if (value.IndexOf('"') >= 0 || value.EndsWith("\\", StringComparison.Ordinal)) throw new ArgumentException("Invalid script path.");
            return "\"" + value + "\"";
        }

        private static LifeContext ReadContext(Dictionary<string, object> model, long now)
        {
            if (model == null) return null;
            string game = Text(model, "gameId"); long epoch;
            if (!Regex.IsMatch(game, "^[A-Za-z0-9_-]{1,40}$") || Regex.IsMatch(game, "^0+$") || !Integer(model, "gameEpoch", out epoch)) return null;
            var life = Object(model, "life"); var connection = Object(model, "connection"); var mode = Object(model, "mode");
            bool enabled = Boolean(Object(model, "ocr"), "enabled");
            DateTimeOffset updated;
            bool fresh = DateTimeOffset.TryParse(Text(model, "updatedAt"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out updated)
                && now - updated.ToUnixTimeMilliseconds() <= 10000 && updated.ToUnixTimeMilliseconds() - now <= 1000;
            bool live = fresh && Text(model, "phase") == "InProgress" && Text(model, "stage") == "live" && Text(connection, "status") == "connected"
                && (!Boolean(mode, "known") || Boolean(mode, "isMayhem"));
            bool apiUnknown = life != null && (Text(life, "status") == "unavailable" || Text(life, "source") == "screen");
            return new LifeContext { GameId = game, GameEpoch = epoch, UpdatedAt = fresh ? updated.ToUnixTimeMilliseconds() : 0,
                LiveEligible = live, OcrEnabled = enabled, FallbackEligible = live && enabled && apiUnknown };
        }

        private static LifeCalibration LoadCalibration(string path)
        {
            try
            {
                var file = new FileInfo(path);
                if (!file.Exists || file.Length < 2 || file.Length > 4096 || (file.Attributes & FileAttributes.ReparsePoint) != 0) return null;
                string json = File.ReadAllText(path, Encoding.UTF8);
                if (Encoding.UTF8.GetByteCount(json) > 4096) return null;
                var value = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 8 }.Deserialize<Dictionary<string, object>>(json);
                return ReadCalibration(value, json);
            }
            catch { return null; }
        }
        private static LifeCalibration ReadCalibration(Dictionary<string, object> value, string json)
        {
            long version, width, height, dpi;
            if (!Integer(value, "version", out version) || version != 1 || !Boolean(value, "verified") || !Integer(value, "clientWidth", out width)
                || !Integer(value, "clientHeight", out height) || !Integer(value, "dpi", out dpi) || width < 640 || height < 360
                || width > 8192 || height > 8192 || width * height > 24000000 || dpi < 72 || dpi > 768) return null;
            Rectangle timer;
            if (!ReadRegion(Object(value, "timer"), (int)width, (int)height, 8, 256, 160, out timer) || timer.Y < (int)(height * .65)) return null;
            IList scene = Array(value, "scene");
            if (scene == null || scene.Count != 3) return null;
            var probes = new SceneProbe[3];
            for (int index = 0; index < 3; index++)
            {
                var entry = scene[index] as Dictionary<string, object>; Rectangle region; double baseline;
                if (!ReadRegion(entry, (int)width, (int)height, 16, 512, 512, out region) || !Number(entry, "aliveSaturation", out baseline)
                    || baseline < .15 || baseline > 1) return null;
                if (region.IntersectsWith(timer)) return null;
                for (int previous = 0; previous < index; previous++) if (region.IntersectsWith(probes[previous].Region)) return null;
                probes[index] = new SceneProbe { Region = region, AliveSaturation = baseline };
            }
            return new LifeCalibration { Json = json, Width = (int)width, Height = (int)height, Dpi = (int)dpi, Timer = timer, Scene = probes };
        }
        private static bool ReadRegion(Dictionary<string, object> value, int width, int height, int minimum, int maxWidth, int maxHeight, out Rectangle result)
        {
            result = Rectangle.Empty; long x, y, w, h;
            if (!Integer(value, "x", out x) || !Integer(value, "y", out y) || !Integer(value, "width", out w) || !Integer(value, "height", out h)
                || w < minimum || h < minimum || w > maxWidth || h > maxHeight || x > width - w || y > height - h) return false;
            result = new Rectangle((int)x, (int)y, (int)w, (int)h); return true;
        }

        private static bool TryCheapFrame(LifeCalibration profile, long epoch, out ScreenLifeFrame frame, out string failure)
        {
            frame = null; failure = "screen-life-unavailable"; IntPtr previous = IntPtr.Zero;
            try
            {
                IntPtr window = GameWindow.CurrentForeground();
                if (!GameWindow.IsVerifiedGame(window)) { failure = "game-not-foreground"; return false; }
                previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
                if (previous == IntPtr.Zero) previous = SetThreadDpiAwarenessContext(new IntPtr(-3));
                if (previous == IntPtr.Zero) { failure = "dpi-unavailable"; return false; }
                Rectangle bounds; int dpi;
                if (!ReadGeometry(window, out bounds, out dpi)) { failure = "geometry-unavailable"; return false; }
                if (bounds.Width != profile.Width || bounds.Height != profile.Height || dpi != profile.Dpi) { failure = "calibration-geometry-mismatch"; return false; }
                int gray = 0, color = 0;
                foreach (SceneProbe probe in profile.Scene)
                {
                    Rectangle physical = probe.Region; physical.Offset(bounds.Location);
                    if (!Unoccluded(window, physical)) { failure = "region-occluded"; return false; }
                    using (var bitmap = new Bitmap(probe.Region.Width, probe.Region.Height, PixelFormat.Format32bppArgb))
                    {
                        using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(physical.Location, Point.Empty, bitmap.Size, CopyPixelOperation.SourceCopy);
                        ScreenLifePixelSummary summary = ScreenLifePixels.Measure(bitmap);
                        if (summary.NonBlackRatio >= .6 && summary.MeanLuminance > .06)
                        {
                            if (summary.MeanSaturation <= Math.Min(.15, probe.AliveSaturation * .35)) gray++;
                            if (summary.MeanSaturation >= Math.Max(.12, probe.AliveSaturation * .75)) color++;
                        }
                    }
                }
                Rectangle final; int finalDpi;
                if (GameWindow.CurrentForeground() != window || !GameWindow.IsVerifiedGame(window) || !ReadGeometry(window, out final, out finalDpi)
                    || final != bounds || finalDpi != dpi) { failure = "geometry-changed"; return false; }
                foreach (SceneProbe probe in profile.Scene) { Rectangle box = probe.Region; box.Offset(bounds.Location); if (!Unoccluded(window, box)) { failure = "region-occluded"; return false; } }
                frame = new ScreenLifeFrame { CapturedAtMs = Now(), GameEpoch = epoch, WindowHandle = window.ToInt64(), ClientBounds = bounds, Dpi = dpi,
                    InterfaceLifeUnknown = true, ForegroundGameVerified = true, Unoccluded = true, Calibrated = true,
                    SceneGray = gray == 3, SceneColorRestored = color == 3 };
                return true;
            }
            catch { return false; }
            finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        }

        private static bool ReadCompletedFrame(Dictionary<string, object> output, ScreenLifeFrame expected, long now, out ScreenLifeFrame frame, out string failure)
        {
            frame = null; failure = "timer-result-invalid";
            string[] keys = { "version", "source", "status", "code", "timerStatus", "countdownSeconds", "capturedAtMs", "windowHandle", "clientBounds", "dpi", "sceneGray", "sceneColorRestored", "timerOcrAttempted", "timerOcrComplete", "elapsedMs" };
            if (output == null || output.Count != keys.Length) return false;
            foreach (string key in keys) if (!output.ContainsKey(key)) return false;
            long version, at, window, dpi, elapsed; bool gray, color, attempted, complete;
            if (!Integer(output, "version", out version) || version != 1 || Text(output, "source") != "screen-life-experimental" || Text(output, "status") != "unknown"
                || !Integer(output, "elapsedMs", out elapsed) || elapsed > 12000
                || !Integer(output, "capturedAtMs", out at) || !Integer(output, "windowHandle", out window) || !Integer(output, "dpi", out dpi)
                || !ReadBoolean(output, "sceneGray", out gray) || !ReadBoolean(output, "sceneColorRestored", out color)
                || !ReadBoolean(output, "timerOcrAttempted", out attempted) || !ReadBoolean(output, "timerOcrComplete", out complete)) return false;
            if (at < 1 || at > now + 250 || now - at > 2500) { failure = "timer-result-stale"; return false; }
            if (window != expected.WindowHandle || dpi != expected.Dpi) { failure = "geometry-changed"; return false; }
            var bounds = Object(output, "clientBounds"); long x, y, width, height;
            if (!SignedInteger(bounds, "x", out x) || !SignedInteger(bounds, "y", out y) || !Integer(bounds, "width", out width) || !Integer(bounds, "height", out height)
                || x != expected.ClientBounds.X || y != expected.ClientBounds.Y || width != expected.ClientBounds.Width || height != expected.ClientBounds.Height) { failure = "geometry-changed"; return false; }
            int? seconds = null; long parsed;
            string code = Text(output, "code"), timer = Text(output, "timerStatus");
            if (code == "timer-digit-consensus" && timer == "detected" && attempted && complete && Integer(output, "countdownSeconds", out parsed) && parsed >= 1 && parsed <= 180) seconds = (int)parsed;
            else if (!(code == "timer-absent-consensus" && timer == "absent" && attempted && complete && output["countdownSeconds"] == null)
                && !(code == "timer-ambiguous" && timer == "unknown" && attempted && !complete && output["countdownSeconds"] == null)) return false;
            if (gray && color) return false;
            frame = new ScreenLifeFrame { CapturedAtMs = at, GameEpoch = expected.GameEpoch, WindowHandle = window, ClientBounds = expected.ClientBounds, Dpi = (int)dpi,
                InterfaceLifeUnknown = true, ForegroundGameVerified = true, Unoccluded = true, Calibrated = true,
                SceneGray = gray, SceneColorRestored = color, TimerOcrAttempted = attempted, TimerOcrComplete = complete, CountdownSeconds = seconds };
            return true;
        }

        private static bool StillCurrentWindow(ScreenLifeFrame frame)
        {
            IntPtr previous = IntPtr.Zero;
            try
            {
                IntPtr window = new IntPtr(frame.WindowHandle);
                if (GameWindow.CurrentForeground() != window || !GameWindow.IsVerifiedGame(window)) return false;
                previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
                if (previous == IntPtr.Zero) previous = SetThreadDpiAwarenessContext(new IntPtr(-3));
                if (previous == IntPtr.Zero) return false;
                Rectangle bounds; int dpi;
                return ReadGeometry(window, out bounds, out dpi) && bounds == frame.ClientBounds && dpi == frame.Dpi;
            }
            catch { return false; }
            finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        }
        private static bool ReadGeometry(IntPtr window, out Rectangle bounds, out int dpi)
        {
            bounds = Rectangle.Empty; dpi = 0; NativeRect rectangle; var origin = new NativePoint();
            if (!IsWindowVisible(window) || IsIconic(window) || !GetClientRect(window, out rectangle) || !ClientToScreen(window, ref origin)) return false;
            long width = (long)rectangle.Right - rectangle.Left, height = (long)rectangle.Bottom - rectangle.Top;
            if (width < 640 || height < 360 || width > 8192 || height > 8192) return false;
            bounds = new Rectangle(origin.X, origin.Y, (int)width, (int)height); dpi = (int)GetDpiForWindow(window); return dpi >= 72 && dpi <= 768;
        }
        private static bool Unoccluded(IntPtr game, Rectangle region)
        {
            var visited = new HashSet<IntPtr>();
            for (IntPtr above = GetWindow(game, 3); above != IntPtr.Zero; above = GetWindow(above, 3))
            {
                if (visited.Count >= 256 || !visited.Add(above)) return false;
                if (!IsWindowVisible(above) || IsIconic(above)) continue;
                NativeRect rectangle;
                if (!GetWindowRect(above, out rectangle)) return false;
                if (region.IntersectsWith(Rectangle.FromLTRB(rectangle.Left, rectangle.Top, rectangle.Right, rectangle.Bottom))) return false;
            }
            return true;
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return; disposed = true; generation++; observer.Reset("frame-unavailable");
                if (child != null) try { if (!child.HasExited) child.Kill(); } catch { }
            }
        }

        // Pure parsers only: this entry point never constructs a controller,
        // reads files, calls user32, starts PowerShell or samples a real frame.
        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message) { checks++; if (!condition) throw new InvalidOperationException(message); };
            long now = 1700000000000;
            var serializer = new JavaScriptSerializer();
            var model = serializer.Deserialize<Dictionary<string, object>>("{\"gameId\":\"fixture-game\",\"gameEpoch\":0,\"phase\":\"InProgress\",\"stage\":\"live\",\"connection\":{\"status\":\"connected\"},\"mode\":{\"known\":true,\"isMayhem\":true},\"ocr\":{\"enabled\":true},\"life\":{\"status\":\"unavailable\",\"isDead\":null,\"source\":\"unavailable\"}}");
            model["updatedAt"] = DateTimeOffset.FromUnixTimeMilliseconds(now).ToString("o", CultureInfo.InvariantCulture);
            LifeContext scope = ReadContext(model, now);
            check(scope != null && scope.LiveEligible && scope.FallbackEligible && scope.GameEpoch == 0, "Epoch-zero unavailable API context was rejected.");
            Object(model, "life")["status"] = "detected"; Object(model, "life")["source"] = "screen";
            check(ReadContext(model, now).FallbackEligible, "Visual life disabled its own observer.");
            Object(model, "life")["source"] = "live-client"; Object(model, "life")["isDead"] = false;
            check(!ReadContext(model, now).FallbackEligible, "Live-client life was overridden.");
            Object(model, "life")["status"] = "unavailable"; Object(model, "life")["source"] = "unavailable";
            Object(model, "ocr")["enabled"] = false;
            check(!ReadContext(model, now).FallbackEligible, "Master OCR pause was ignored.");
            Object(model, "ocr")["enabled"] = true; model["stage"] = "loading";
            check(!ReadContext(model, now).LiveEligible, "Loading ran fallback capture.");
            model["stage"] = "live";
            check(!ReadContext(model, now + 10001).LiveEligible, "Stale game context was accepted.");
            check(ReadContext(null, now) == null, "A missing model was eligible.");
            model["gameId"] = "000";
            check(ReadContext(model, now) == null, "Empty game identity was accepted.");

            string profileJson = "{\"version\":1,\"verified\":true,\"clientWidth\":1920,\"clientHeight\":1080,\"dpi\":96,\"timer\":{\"x\":500,\"y\":970,\"width\":48,\"height\":40},\"scene\":[{\"x\":600,\"y\":300,\"width\":100,\"height\":100,\"aliveSaturation\":0.4},{\"x\":900,\"y\":300,\"width\":100,\"height\":100,\"aliveSaturation\":0.4},{\"x\":1200,\"y\":300,\"width\":100,\"height\":100,\"aliveSaturation\":0.4}]}";
            var profile = serializer.Deserialize<Dictionary<string, object>>(profileJson);
            check(ReadCalibration(profile, profileJson) != null, "Valid reviewed geometry was rejected.");
            profile["verified"] = "true";
            check(ReadCalibration(profile, profileJson) == null, "String-typed approval was accepted.");
            profile["verified"] = true; Object(profile, "timer")["y"] = 40;
            check(ReadCalibration(profile, profileJson) == null, "An arbitrary screen text region was accepted as portrait timer.");
            Object(profile, "timer")["y"] = 970; profile["clientWidth"] = "1920";
            check(ReadCalibration(profile, profileJson) == null, "String-typed dimensions were accepted.");
            profile = serializer.Deserialize<Dictionary<string, object>>(profileJson);
            var scenes = Array(profile, "scene"); ((Dictionary<string, object>)scenes[1])["x"] = 600;
            check(ReadCalibration(profile, profileJson) == null, "Repeated scene regions were treated as independent evidence.");
            profile = serializer.Deserialize<Dictionary<string, object>>(profileJson);
            scenes = Array(profile, "scene"); ((Dictionary<string, object>)scenes[0])["x"] = 500; ((Dictionary<string, object>)scenes[0])["y"] = 970;
            check(ReadCalibration(profile, profileJson) == null, "Scene evidence was sampled from the timer itself.");

            var expected = new ScreenLifeFrame { GameEpoch = 0, WindowHandle = 42, ClientBounds = new Rectangle(-20, 0, 1920, 1080), Dpi = 96 };
            var output = new Dictionary<string, object> { { "version", 1 }, { "source", "screen-life-experimental" }, { "status", "unknown" }, { "code", "timer-digit-consensus" },
                { "timerStatus", "detected" }, { "countdownSeconds", 9 }, { "capturedAtMs", now - 1000 }, { "windowHandle", 42 },
                { "clientBounds", new Dictionary<string, object> { { "x", -20 }, { "y", 0 }, { "width", 1920 }, { "height", 1080 } } }, { "dpi", 96 },
                { "sceneGray", true }, { "sceneColorRestored", false }, { "timerOcrAttempted", true }, { "timerOcrComplete", true }, { "elapsedMs", 1000 } };
            ScreenLifeFrame parsed; string failure;
            check(ReadCompletedFrame(output, expected, now, out parsed, out failure) && parsed.GameEpoch == 0 && parsed.CountdownSeconds == 9, "Same-frame numeric proof was rejected.");
            output["rawText"] = "never-export";
            check(!ReadCompletedFrame(output, expected, now, out parsed, out failure), "An unexpected raw field was accepted.");
            output.Remove("rawText"); output["capturedAtMs"] = now - 2501;
            check(!ReadCompletedFrame(output, expected, now, out parsed, out failure) && failure == "timer-result-stale", "Old OCR result was accepted.");
            output["capturedAtMs"] = now + 251;
            check(!ReadCompletedFrame(output, expected, now, out parsed, out failure), "Future OCR timestamp was accepted.");
            output["capturedAtMs"] = now - 100; output["windowHandle"] = 43;
            check(!ReadCompletedFrame(output, expected, now, out parsed, out failure), "A different game window was accepted.");
            output["windowHandle"] = 42; output["sceneColorRestored"] = true;
            check(!ReadCompletedFrame(output, expected, now, out parsed, out failure), "Contradictory scene flags were accepted.");
            output["sceneGray"] = false; output["countdownSeconds"] = null; output["code"] = "timer-absent-consensus"; output["timerStatus"] = "absent";
            check(ReadCompletedFrame(output, expected, now, out parsed, out failure) && !parsed.CountdownSeconds.HasValue, "Completed blank timer consensus was rejected.");
            output["timerOcrComplete"] = false;
            check(!ReadCompletedFrame(output, expected, now, out parsed, out failure), "Incomplete OCR was timer absence.");
            output["code"] = "timer-ambiguous"; output["timerStatus"] = "unknown";
            check(ReadCompletedFrame(output, expected, now, out parsed, out failure) && !parsed.TimerOcrComplete && !parsed.CountdownSeconds.HasValue, "A same-frame ambiguous timer was not passed as unknown evidence.");
            check(Quote(@"H:\Example Folder\native\scan-life.ps1") == "\"H:\\Example Folder\\native\\scan-life.ps1\"", "Bundled script path lost Windows quoting.");
            return checks;
        }

        private sealed class LifeContext { internal string GameId; internal long GameEpoch, UpdatedAt; internal bool LiveEligible, FallbackEligible, OcrEnabled; }
        private sealed class LifeCalibration { internal string Json; internal int Width, Height, Dpi; internal Rectangle Timer; internal SceneProbe[] Scene; }
        private sealed class SceneProbe { internal Rectangle Region; internal double AliveSaturation; }
        private static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
        private static Dictionary<string, object> Object(Dictionary<string, object> value, string key) { object item; return value != null && value.TryGetValue(key, out item) ? item as Dictionary<string, object> : null; }
        private static string Text(Dictionary<string, object> value, string key) { object item; return value != null && value.TryGetValue(key, out item) && item is string ? (string)item : ""; }
        private static IList Array(Dictionary<string, object> value, string key) { object item; return value != null && value.TryGetValue(key, out item) ? item as IList : null; }
        private static bool ReadBoolean(Dictionary<string, object> value, string key, out bool result) { object item; result = false; if (value == null || !value.TryGetValue(key, out item) || !(item is bool)) return false; result = (bool)item; return true; }
        private static bool Boolean(Dictionary<string, object> value, string key) { bool result; return ReadBoolean(value, key, out result) && result; }
        private static bool Integer(Dictionary<string, object> value, string key, out long result) { return SignedInteger(value, key, out result) && result >= 0; }
        private static bool SignedInteger(Dictionary<string, object> value, string key, out long result) { object item; result = 0; if (value == null || !value.TryGetValue(key, out item) || !(item is int || item is long)) return false; result = Convert.ToInt64(item, CultureInfo.InvariantCulture); return result <= 9007199254740991L && result >= -9007199254740991L; }
        private static bool Number(Dictionary<string, object> value, string key, out double result) { object item; result = 0; if (value == null || !value.TryGetValue(key, out item) || !(item is int || item is long || item is double || item is decimal)) return false; result = Convert.ToDouble(item, CultureInfo.InvariantCulture); return !double.IsNaN(result) && !double.IsInfinity(result); }
        [StructLayout(LayoutKind.Sequential)] private struct NativeRect { internal int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct NativePoint { internal int X, Y; }
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out NativeRect rectangle);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rectangle);
    }
}
