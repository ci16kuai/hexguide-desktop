using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;

namespace HexGuide.Desktop
{
    // The scope is a short-lived backend eligibility lease, independent of OCR.
    // Pixel witnesses exist only in this object's bounded memory and are never
    // part of diagnostics, persistence, HTTP requests or the session model.
    internal sealed class ScreenObservationScope
    {
        internal object GameId;
        internal long Epoch, Revision, Lifecycle, CaptureRevision, NotBefore;
        internal string Identity;

        internal static bool TryRead(Dictionary<string, object> value, out ScreenObservationScope scope)
        {
            scope = null;
            long version, epoch, revision, lifecycle, captureRevision, notBefore;
            object game;
            if (value == null || !ModelValue.Boolean(value, "eligible")
                || !Number(value, "version", out version) || version != 1
                || !ModelValue.GameId(value, out game) || !Number(value, "gameEpoch", out epoch)
                || !Number(value, "revision", out revision) || !Number(value, "lifecycle", out lifecycle)
                || !Number(value, "captureRevision", out captureRevision) || !Number(value, "notBefore", out notBefore)) return false;
            scope = new ScreenObservationScope { GameId = game, Epoch = epoch, Revision = revision,
                Lifecycle = lifecycle, CaptureRevision = captureRevision, NotBefore = notBefore };
            scope.Identity = (game as string ?? "null") + "|" + epoch + "|" + revision + "|" + lifecycle + "|" + captureRevision + "|" + notBefore;
            return true;
        }

        private static bool Number(Dictionary<string, object> value, string key, out long result)
        {
            object raw;
            result = 0;
            return value.TryGetValue(key, out raw) && raw != null && !(raw is bool)
                && (raw is int || raw is long || raw is uint || raw is ulong || raw is short || raw is byte)
                && long.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out result) && result >= 0;
        }

        internal bool Matches(ScreenSelectionObservation value)
        { return value != null && object.Equals(GameId, value.GameId) && Epoch == value.Epoch && Revision == value.Revision; }
    }

    internal sealed class EarlySelectionFrame : IDisposable
    {
        internal long At;
        internal int Kind, Column = -1; // 0 independent frame, 1 actual down, 2 actual up.
        internal ScreenSelectionObservation Geometry;
        internal int[][] Signatures;
        internal Bitmap[] TitleBands;
        internal Rectangle[] TitleBoxes;
        internal long Bytes;
        internal bool Disposed;

        internal static EarlySelectionFrame Create(ScreenSelectionObservation geometry)
        { return new EarlySelectionFrame { Geometry = geometry, Signatures = new int[3][], TitleBands = new Bitmap[3], TitleBoxes = new Rectangle[3] }; }

        internal void ReadCard(Bitmap bitmap, int column)
        {
            Rectangle region = Geometry.Regions[column];
            if (bitmap == null || bitmap.Size != region.Size) throw new ArgumentException("Card bitmap geometry mismatch.");
            Rectangle band = EarlySelectionReplay.TitleBox(Geometry, column);
            if (band.IsEmpty) throw new ArgumentException("Title band is empty.");
            Rectangle local = band; local.Offset(-region.X, -region.Y);
            Signatures[column] = ScreenSelectionWatcher.ReadSignature(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            TitleBoxes[column] = band;
            TitleBands[column] = bitmap.Clone(local, PixelFormat.Format32bppArgb);
            Bytes += (long)band.Width * band.Height * 4 + 192 * sizeof(int);
        }

        internal int TitleMask(ScreenSelectionObservation reference)
        {
            if (Disposed || reference.TitleAnchors == null || reference.TitleAnchors.Length != 3) return 0;
            int mask = 0;
            for (int column = 0; column < 3; column++)
            {
                bool match = reference.TitleAnchors[column] != null && reference.TitleAnchors[column].Length > 0;
                if (match) foreach (ScreenTitleAnchor anchor in reference.TitleAnchors[column])
                {
                    if (!TitleBoxes[column].Contains(anchor.Box)) { match = false; break; }
                    Rectangle local = anchor.Box;
                    local.Offset(-TitleBoxes[column].X, -TitleBoxes[column].Y);
                    CardTitleFeature feature = CardTitleIdentity.Extract(TitleBands[column], local);
                    if (!feature.Usable || !CardTitleIdentity.Matches(feature.Feature, anchor.Feature)) { match = false; break; }
                }
                if (match) mask |= 1 << column;
            }
            return mask;
        }

        public void Dispose()
        {
            if (Disposed) return;
            Disposed = true;
            if (TitleBands != null) foreach (Bitmap bitmap in TitleBands) if (bitmap != null) bitmap.Dispose();
            TitleBands = null; Signatures = null;
        }
    }

    internal sealed class EarlySelectionReplay : IDisposable
    {
        internal const int MaximumFrames = 44;
        internal const long MaximumBytes = 64L * 1024 * 1024;
        internal const long MaximumLeaseMs = 5000, ScopeFreshnessMs = 1000;
        private readonly List<EarlySelectionFrame> baseline = new List<EarlySelectionFrame>();
        private readonly List<EarlySelectionFrame> records = new List<EarlySelectionFrame>();
        private readonly RecognitionTrace trace;
        private long lastRejectedReference;
        private string lastRejectedReferenceReason;
        private ScreenObservationScope scope;
        private string lastScopeIdentity;
        private ScreenSelectionObservation geometry, reference;
        private ScreenSelectionDecision replay;
        private long refreshedAt, minimumReferenceAt, pressedAt, releasedAt, bytes, lastFrameAt;
        private int pressedColumn = -1, replayed;
        private bool disposed, emitted;
        internal EarlySelectionReplay(RecognitionTrace recognitionTrace = null)
        { trace = recognitionTrace ?? new RecognitionTrace(); }
        internal string State = "waiting", Reason = "waiting-scope";
        internal bool Active { get { return !disposed && scope != null; } }
        internal bool NeedsFrames { get { return Active && !emitted; } }
        internal bool HasInteraction { get { return pressedAt > 0; } }
        internal long ClickedAt { get { return releasedAt; } }
        internal long ReferenceCapturedAt { get { return reference == null ? 0 : reference.CapturedAt; } }
        internal int FrameCount { get { return baseline.Count + records.Count; } }
        internal long RetainedBytes { get { return bytes; } }
        internal string WatcherStatus
        {
            get
            {
                if (!Active) return "waiting";
                switch (State)
                {
                    case "observed": return "observed";
                    case "ready": return "ready";
                    case "pending": case "replaying": return "pending";
                    case "feedback": return "feedback";
                    case "buffering": return "baseline";
                    default: return "waiting";
                }
            }
        }
        internal int BaselineFrames { get { return replay != null ? replay.BaselineFrames : baseline.Count; } }
        internal int FeedbackFrames { get { return replay != null ? replay.FeedbackFrames : 0; } }
        internal int DismissedFrames { get { return replay != null ? replay.DismissedFrames : 0; } }

        internal void UpdateScope(Dictionary<string, object> value, long now, long issuedAt)
        {
            // Expire the old lease BEFORE a fresh callback can renew it. A UI
            // stall may hide focus or pointer changes even when the next
            // server response contains an otherwise identical scope.
            if (scope != null && (refreshedAt > now + 1000 || now - refreshedAt > ScopeFreshnessMs))
            { Cancel("scope-expired", now); scope = null; }
            ScreenObservationScope incoming;
            if (issuedAt < 0 || issuedAt > now + 1000 || now - issuedAt > ScopeFreshnessMs
                || !ScreenObservationScope.TryRead(value, out incoming) || incoming.NotBefore > now)
            { Cancel("scope-ineligible", now); scope = null; return; }
            if (scope != null && issuedAt < refreshedAt) return;
            if (scope == null || scope.Identity != incoming.Identity)
            {
                if (scope != null && (FrameCount > 0 || reference != null || HasInteraction))
                    RecordTrace("cancelled", "scope-changed", now);
                Clear(); scope = incoming; emitted = false;
                minimumReferenceAt = lastScopeIdentity == incoming.Identity ? Math.Max(minimumReferenceAt, incoming.NotBefore) : incoming.NotBefore;
                lastScopeIdentity = incoming.Identity;
                State = "buffering"; Reason = "waiting-baseline";
            }
            refreshedAt = issuedAt;
        }

        // Explicit fixture convenience. Production always supplies the server
        // issue timestamp; receipt time cannot manufacture a fresh lease.
        internal void UpdateScopeForFixture(Dictionary<string, object> value, long now)
        { UpdateScope(value, now, now); }

        internal void Cancel(string reason, long now, string traceReason = null)
        {
            if (FrameCount > 0 || reference != null || replay != null || HasInteraction || State != "waiting" || Reason != reason)
                RecordTrace("cancelled", traceReason ?? reason, now);
            Clear(); emitted = false; minimumReferenceAt = Math.Max(minimumReferenceAt, now);
            State = "waiting"; Reason = reason;
        }

        internal bool CheckLease(long now)
        {
            if (!Active) return false;
            if (refreshedAt > now + 1000 || now - refreshedAt > ScopeFreshnessMs)
            { Cancel("scope-expired", now); scope = null; return false; }
            if (pressedAt > 0 && (now < pressedAt || now - pressedAt > MaximumLeaseMs))
            { Cancel("interaction-expired", now); return false; }
            return true;
        }

        internal bool WantsFrame(long now)
        { return CheckLease(now) && !emitted && (releasedAt <= 0 || now - releasedAt <= 2500); }

        internal void Bind(ScreenSelectionObservation next, long now)
        {
            if (!CheckLease(now) || next == null) return;
            if (!scope.Matches(next)) { RejectReference(next, "reference-context-mismatch", now); return; }
            if (next.CapturedAt < scope.NotBefore) { RejectReference(next, "reference-before-scope", now); return; }
            if (next.CapturedAt < minimumReferenceAt) { RejectReference(next, "reference-before-fence", now); return; }
            if (next.CapturedAt > now) { RejectReference(next, "reference-in-future", now); return; }
            if (now - next.CapturedAt > MaximumLeaseMs) { RejectReference(next, "reference-too-old", now); return; }
            if (geometry != null && !SameGeometry(geometry, next)) { Cancel("reference-geometry-changed", now); return; }
            if (pressedAt > 0 && next.CapturedAt > pressedAt)
            { RejectReference(next, "reference-after-click", now); Reason = "reference-after-click"; return; }
            if (reference != null)
            {
                if (reference.Identity() == next.Identity())
                {
                    // Idle OCR refreshes keep the lease fresh. Once a press
                    // exists, preserve the exact pre-click reference instead.
                    if (pressedAt <= 0) { reference = next; UpdateIdleStatus(now); }
                    return;
                }
                Cancel("offer-changed", now); return;
            }
            reference = next;
            RecordTrace("reference", "bound", now);
            if (pressedAt <= 0) UpdateIdleStatus(now);
        }

        private void RejectReference(ScreenSelectionObservation value, string reason, long now)
        {
            if (value.CapturedAt == lastRejectedReference && reason == lastRejectedReferenceReason) return;
            lastRejectedReference = value.CapturedAt; lastRejectedReferenceReason = reason;
            RecordTrace("reference-rejected", reason, now);
        }

        private void RecordTrace(string eventCode, string reason, long now)
        { trace.Record(eventCode, reason, now, BaselineFrames, FeedbackFrames, DismissedFrames,
            0, 0, (eventCode == "cancelled" || eventCode == "proof") && reference != null && pressedAt > 0); }

        internal bool Add(EarlySelectionFrame frame, int kind, int column, long now)
        {
            if (frame == null) return false;
            if (!CheckLease(now) || emitted) { frame.Dispose(); return false; }
            if (frame.At < scope.NotBefore || frame.At < minimumReferenceAt || frame.At > now
                || frame.At <= lastFrameAt || kind < 0 || kind > 2)
            { frame.Dispose(); Cancel("frame-time-invalid", now); return false; }
            if (geometry != null && !SameGeometry(geometry, frame.Geometry)
                || reference != null && !SameGeometry(reference, frame.Geometry))
            { frame.Dispose(); Cancel("geometry-changed", now); return false; }
            geometry = frame.Geometry; frame.Kind = kind; frame.Column = column;
            if (kind == 1) RecordTrace("down", "screen", frame.At);
            else if (kind == 2) RecordTrace("up", "screen", frame.At);
            if (kind == 1)
            {
                if (pressedAt > 0 || column < 0 || column > 2 || baseline.Count != 2)
                { frame.Dispose(); Cancel(pressedAt > 0 ? "extra-click" : column < 0 ? "outside-click" : "missing-baseline", now); return false; }
                if (reference != null && reference.CapturedAt > frame.At)
                { frame.Dispose(); Cancel("reference-after-click", now); return false; }
                pressedAt = frame.At; pressedColumn = column;
                records.AddRange(baseline); baseline.Clear();
            }
            else if (kind == 2 && (pressedAt <= 0 || releasedAt > 0 || column != pressedColumn || frame.At - pressedAt > 1500))
            { frame.Dispose(); Cancel("release-unpaired", now); return false; }
            if (kind == 2)
            {
                releasedAt = frame.At;
            }
            if (pressedAt > 0)
            {
                if (releasedAt == 0 && frame.At - pressedAt > 1500
                    || releasedAt > 0 && frame.At - releasedAt > 2500
                    || records.Count >= MaximumFrames || bytes + frame.Bytes > MaximumBytes)
                { frame.Dispose(); Cancel("buffer-limit", now); return false; }
                records.Add(frame); bytes += frame.Bytes; State = "pending"; Reason = "waiting-ocr-or-feedback";
            }
            else
            {
                bool hadBaseline = baseline.Count >= 2;
                while (baseline.Count >= 2) RemoveFirstBaseline();
                if (bytes + frame.Bytes > MaximumBytes)
                { frame.Dispose(); Cancel("buffer-limit", now); return false; }
                baseline.Add(frame); bytes += frame.Bytes;
                if (!hadBaseline && baseline.Count == 2) RecordTrace("baseline", "buffered", frame.At);
                UpdateIdleStatus(frame.At);
            }
            lastFrameAt = frame.At;
            return true;
        }

        internal Dictionary<string, object> TryObserve(long now)
        {
            if (!CheckLease(now) || emitted || pressedAt <= 0 || reference == null) return null;
            if (!scope.Matches(reference) || reference.CapturedAt < minimumReferenceAt || reference.CapturedAt > pressedAt)
            { Cancel("reference-scope-invalid", now); return null; }
            if (now - reference.CapturedAt > MaximumLeaseMs) { Cancel("reference-expired", now); return null; }
            if (replay == null)
            {
                replay = new ScreenSelectionDecision();
                // This new state machine has no historical invalidation to
                // bypass. Every buffered witness independently proves the
                // continuous scope and exact title identity before the click.
                replay.Arm(reference.CapturedAt, records[0].At);
            }
            State = "replaying";
            while (replayed < records.Count)
            {
                EarlySelectionFrame item = records[replayed++];
                int mask = item.TitleMask(reference);
                int beforeFeedback = replay.FeedbackFrames;
                if (item.Kind == 0) replay.FrameWithTitleIdentity(item.Signatures, reference.Signatures, item.At, mask);
                else replay.PointerWithTitleIdentity(item.Kind == 1, item.Column, true, item.At, item.Signatures, reference.Signatures, mask == 7);
                if (replay.Invalid)
                {
                    var state = replay.DiagnosticState(now);
                    var rejection = ModelValue.Object(state, "lastReject");
                    Cancel("proof-rejected", now, ModelValue.Text(rejection, "code"));
                    return null;
                }
                if (beforeFeedback == 0 && replay.FeedbackFrames > 0) RecordTrace("feedback", "unique-feedback", now);
                if (!replay.Complete) continue;
                if (now - item.At > MaximumLeaseMs) { Cancel("evidence-expired", now); return null; }
                var evidence = reference.Evidence(replay, item.At);
                RecordTrace("proof", replay.DirectComplete ? "verified-click-transition" : "full-proof", now);
                Clear(); emitted = true; State = "observed"; Reason = "full-proof";
                return evidence;
            }
            State = replay.FeedbackFrames > 0 ? "feedback" : "pending";
            Reason = "waiting-full-proof";
            return null;
        }

        private void UpdateIdleStatus(long at)
        {
            bool ready = reference != null && baseline.Count == 2
                && baseline[0].TitleMask(reference) == 7 && baseline[1].TitleMask(reference) == 7;
            if (ready && State != "ready") RecordTrace("baseline", "titles-ready", at);
            State = ready ? "ready" : "buffering";
            Reason = ready ? "titles-ready" : baseline.Count < 2 ? "waiting-baseline" : reference == null ? "waiting-ocr" : "waiting-title-match";
        }

        internal Dictionary<string, object> Diagnostics()
        { return new Dictionary<string, object> { { "state", State }, { "reason", Reason }, { "frames", FrameCount }, { "bytes", bytes } }; }

        internal Dictionary<string, object> DecisionDiagnostics(long now)
        {
            var result = replay == null ? new Dictionary<string, object>() : replay.DiagnosticState(now);
            result["ready"] = State == "ready";
            result["pressed"] = pressedAt > 0 && releasedAt == 0;
            result["referenceAgeMs"] = reference == null ? null : ScreenSelectionWatcher.Age(now, reference.CapturedAt);
            result["scopeFreshAgeMs"] = scope == null ? null : ScreenSelectionWatcher.Age(now, refreshedAt);
            return result;
        }

        private void RemoveFirstBaseline()
        { var item = baseline[0]; baseline.RemoveAt(0); bytes -= item.Bytes; item.Dispose(); }

        private void Clear()
        {
            foreach (var frame in baseline) frame.Dispose();
            foreach (var frame in records) frame.Dispose();
            baseline.Clear(); records.Clear(); bytes = 0;
            geometry = reference = null; replay = null; replayed = 0;
            pressedAt = releasedAt = lastFrameAt = 0; pressedColumn = -1;
            lastRejectedReference = 0; lastRejectedReferenceReason = null;
        }

        internal static bool SameGeometry(ScreenSelectionObservation left, ScreenSelectionObservation right)
        {
            if (left == null || right == null || left.Window != right.Window || left.ClientBounds != right.ClientBounds
                || left.Regions == null || right.Regions == null || left.Regions.Length != 3 || right.Regions.Length != 3) return false;
            for (int i = 0; i < 3; i++) if (left.Regions[i] != right.Regions[i]) return false;
            return true;
        }

        // One native geometry definition serves early capture and its tests.
        // These are the exact physical-pixel Get-SelectionRegions rectangles
        // used by the OCR provider, including centred ultrawide viewports.
        internal static ScreenSelectionObservation Geometry(IntPtr window, Rectangle bounds)
        {
            double viewport = Math.Min(bounds.Width, bounds.Height * 16.0 / 9.0);
            double offset = (bounds.Width - viewport) / 2;
            var boxes = new Rectangle[3];
            for (int i = 0; i < 3; i++)
            {
                int left = (int)Math.Floor(offset + (.21 + .20 * i) * viewport);
                int right = (int)Math.Ceiling(offset + (.39 + .20 * i) * viewport);
                boxes[i] = Rectangle.FromLTRB(left, (int)Math.Floor(bounds.Height * .20), right, (int)Math.Ceiling(bounds.Height * .70));
            }
            return new ScreenSelectionObservation { Window = window, ClientBounds = bounds, Regions = boxes };
        }

        internal static Rectangle TitleBox(ScreenSelectionObservation value, int column)
        {
            Rectangle box = value.Regions[column];
            Rectangle band = Rectangle.Intersect(box, Rectangle.FromLTRB(0, (int)Math.Floor(value.ClientBounds.Height * .33),
                value.ClientBounds.Width, (int)Math.Ceiling(value.ClientBounds.Height * .49)));
            // Existing armed providers may supply a valid title elsewhere in
            // the card. Keep their exact anchor crop when sharing this helper.
            if (value.TitleAnchors != null && value.TitleAnchors.Length == 3 && value.TitleAnchors[column] != null)
                foreach (ScreenTitleAnchor anchor in value.TitleAnchors[column])
                {
                    Rectangle anchorBox = Rectangle.Intersect(box, anchor.Box);
                    if (!anchorBox.IsEmpty) band = band.IsEmpty ? anchorBox : Rectangle.Union(band, anchorBox);
                }
            return band;
        }

        public void Dispose() { if (disposed) return; Clear(); disposed = true; scope = null; State = "disposed"; Reason = "disposed"; }
    }

    // Generated bitmap and event-timeline contracts only. No game/window/input
    // API is called by this fixture runner.
    internal static class EarlySelectionReplayFixtures
    {
        private static int checks;
        private static void Check(bool value, string message)
        { checks++; if (!value) throw new InvalidOperationException("Early selection replay: " + message); }

        private static Dictionary<string, object> Scope()
        {
            return new Dictionary<string, object> { { "version", 1 }, { "eligible", true }, { "gameId", "fixture" },
                { "gameEpoch", 2 }, { "revision", 3 }, { "lifecycle", 4 }, { "captureRevision", 5 }, { "notBefore", 900 } };
        }

        private static Bitmap Band(int width, int height, int variant)
        {
            var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            using (var pen = new Pen(Color.White, 3))
            {
                graphics.Clear(Color.FromArgb(15, 20, 25));
                if (variant < 0) return bitmap;
                for (int i = 0; i < 4; i++)
                {
                    int x = 10 + i * 30;
                    graphics.DrawLine(pen, x, 20, x + 20, 20);
                    graphics.DrawLine(pen, x + 10, 12, x + 10, 70);
                    graphics.DrawLine(pen, x, 43, x + 20, 43);
                    if (variant == 0) graphics.DrawLine(pen, x, 70, x + 20, 35);
                    else graphics.DrawEllipse(pen, x, 43, 20, 28);
                }
            }
            return bitmap;
        }

        private static EarlySelectionFrame Frame(long at, int body = 25, bool titles = true, bool feedback = false)
        {
            var geometry = EarlySelectionReplay.Geometry(new IntPtr(42), new Rectangle(0, 0, 800, 600));
            var result = new EarlySelectionFrame { At = at, Geometry = geometry, Signatures = new int[3][],
                TitleBands = new Bitmap[3], TitleBoxes = new Rectangle[3] };
            for (int i = 0; i < 3; i++)
            {
                result.Signatures[i] = new int[192];
                for (int j = 0; j < 192; j++) result.Signatures[i][j] = body;
                Rectangle band = EarlySelectionReplay.TitleBox(geometry, i);
                result.TitleBoxes[i] = band; result.TitleBands[i] = Band(band.Width, band.Height, titles ? 0 : -1);
                result.Bytes += (long)band.Width * band.Height * 4 + 192 * sizeof(int);
            }
            if (feedback) for (int cell = 0; cell < 12; cell++) for (int color = 0; color < 3; color++) result.Signatures[1][cell * 3 + color] = 80;
            return result;
        }

        private static ScreenSelectionObservation Reference(long capturedAt = 950)
        {
            using (var source = Frame(1000))
            {
                var value = source.Geometry;
                value.Token = "01234567890123456789012345678901"; value.GameId = "fixture"; value.Epoch = 2; value.Revision = 3;
                value.CapturedAt = capturedAt; value.Ids = new[] { "left", "middle", "right" };
                value.Signatures = new int[3][]; value.TitleAnchors = new ScreenTitleAnchor[3][];
                for (int i = 0; i < 3; i++)
                {
                    value.Signatures[i] = (int[])source.Signatures[i].Clone();
                    Rectangle local = new Rectangle(3, 3, source.TitleBands[i].Width - 6, source.TitleBands[i].Height - 6);
                    CardTitleFeature feature = CardTitleIdentity.Extract(source.TitleBands[i], local);
                    Check(feature.Usable, "generated glyph was unusable");
                    local.Offset(source.TitleBoxes[i].Location);
                    value.TitleAnchors[i] = new[] { new ScreenTitleAnchor { Box = local, Feature = feature.Feature } };
                }
                return value;
            }
        }

        private static EarlySelectionReplay Started(RecognitionTrace trace = null)
        { var replay = new EarlySelectionReplay(trace); replay.UpdateScopeForFixture(Scope(), 900); return replay; }

        private static int TraceCount(RecognitionTrace trace, string eventCode)
        {
            int value;
            var counts = (Dictionary<string, int>)trace.Snapshot()["counts"];
            return counts.TryGetValue(eventCode, out value) ? value : 0;
        }

        private static object[] TraceEvent(RecognitionTrace trace, string eventCode, string reason)
        {
            foreach (object[] row in (List<object[]>)trace.Snapshot()["events"])
                if ((string)row[2] == eventCode && (string)row[3] == reason) return row;
            return null;
        }

        private static void Heartbeats(EarlySelectionReplay replay, long until)
        { for (long at = 1500; at < until; at += 150) replay.UpdateScopeForFixture(Scope(), at); replay.UpdateScopeForFixture(Scope(), until); }

        private static void Click(EarlySelectionReplay replay, bool includeFeedback)
        {
            replay.Add(Frame(1000), 0, -1, 1000); replay.Add(Frame(1070), 0, -1, 1070);
            replay.Add(Frame(1100), 1, 1, 1100); replay.Add(Frame(1150), 2, 1, 1150);
            if (includeFeedback) replay.Add(Frame(1220, 25, true, true), 0, -1, 1220);
            replay.Add(Frame(1290, 100, false), 0, -1, 1290); replay.Add(Frame(1360, 100, false), 0, -1, 1360);
            replay.Add(Frame(1430, 100, false), 0, -1, 1430);
        }

        internal static int Run()
        {
            checks = 0;
            var successfulTrace = new RecognitionTrace();
            using (var replay = Started(successfulTrace))
            {
                Click(replay, true); replay.Bind(Reference(), 1600);
                Check(replay.TryObserve(1600) != null, "tracing changed a complete delayed recognition proof");
                var proof = TraceEvent(successfulTrace, "proof", "full-proof");
                Check(proof != null && (int)proof[4] == 2 && (int)proof[5] > 0 && (int)proof[6] == 3,
                    "clearing accepted witnesses lost the exact proof counters");
                Check(TraceCount(successfulTrace, "down") == 1 && TraceCount(successfulTrace, "up") == 1
                    && TraceCount(successfulTrace, "feedback") == 1 && TraceCount(successfulTrace, "proof") == 1,
                    "early interaction trace skipped or duplicated physical/visual transitions");
                Check(replay.FrameCount == 0 && replay.RetainedBytes == 0, "trace retained accepted image witnesses");
            }
            var rejectedTrace = new RecognitionTrace();
            using (var replay = Started(rejectedTrace))
            {
                Click(replay, true); var wrong = Reference(); wrong.TitleAnchors[1][0].Feature = new int[128];
                replay.Bind(wrong, 1500); Check(replay.TryObserve(1500) == null, "trace changed a rejected exact-title proof");
                Check(TraceEvent(rejectedTrace, "cancelled", "pointer-title-unverified") != null,
                    "generic cancellation destroyed the state machine's specific rejection code");
                replay.Add(Frame(1600), 0, -1, 1600); replay.Add(Frame(1670), 0, -1, 1670);
                Check(replay.State == "buffering" && TraceEvent(rejectedTrace, "cancelled", "pointer-title-unverified") != null,
                    "returning to baseline erased the earlier missed-click reason");
            }
            var deduplicatedTrace = new RecognitionTrace();
            using (var replay = Started(deduplicatedTrace))
            {
                for (int i = 0; i < 10; i++) replay.Add(Frame(1000 + i * 70), 0, -1, 1000 + i * 70);
                Check(TraceCount(deduplicatedTrace, "baseline") == 1, "every timer frame flooded the event ring");
                replay.Cancel("outside-click", 1700); replay.Cancel("outside-click", 1701);
                Check(TraceCount(deduplicatedTrace, "cancelled") == 1, "unchanged waiting cancellation flooded the event ring");
            }
            var referenceTrace = new RecognitionTrace();
            using (var replay = Started(referenceTrace))
            {
                Click(replay, true); replay.Bind(Reference(1120), 1500); replay.Bind(Reference(1120), 1501);
                Check(TraceCount(referenceTrace, "reference-rejected") == 1
                    && TraceEvent(referenceTrace, "reference-rejected", "reference-after-click") != null,
                    "repeated model delivery lost or flooded a late-reference rejection");
            }
            using (var replay = Started())
            {
                Click(replay, true); Check(replay.TryObserve(1500) == null, "unrecognized IDs produced a selection");
                replay.Bind(Reference(), 1600);
                var value = replay.TryObserve(1600);
                Check(value != null && (int)value["selectedIndex"] == 1 && (long)value["clickedAt"] == 1150 && (long)value["observedAt"] == 1430,
                    "late OCR did not replay the actual early click and visual proof");
                Check(replay.FrameCount == 0 && replay.RetainedBytes == 0 && replay.TryObserve(1601) == null, "accepted witnesses were retained or emitted twice");
            }
            using (var replay = Started())
            {
                replay.Bind(Reference(), 980); Click(replay, true);
                Check(replay.TryObserve(1500) != null, "already recognized offer failed the same replay contract");
            }
            using (var replay = Started())
            {
                Click(replay, true); Heartbeats(replay, 3000); replay.Bind(Reference(), 3000);
                Check(replay.TryObserve(3000) != null, "completed witnesses could not survive a slow OCR response");
            }
            using (var replay = Started())
            {
                Click(replay, false); replay.Bind(Reference(), 1500);
                Check(replay.TryObserve(1500) == null, "short uncorroborated transition was accepted without unique feedback");
            }
            foreach (bool closedAtRelease in new[] { false, true })
            using (var replay = Started())
            {
                replay.Add(Frame(1000), 0, -1, 1000); replay.Add(Frame(1070), 0, -1, 1070);
                replay.Add(Frame(1100), 1, 1, 1100);
                replay.Add(Frame(1178, closedAtRelease ? 100 : 25, !closedAtRelease), 2, 1, 1178);
                for (long at = 1240; at <= 1590; at += 70) replay.Add(Frame(at, 100, false), 0, -1, at);
                replay.Bind(Reference(), 1700);
                var proof = replay.TryObserve(1700);
                Check(proof != null && (int)proof["selectedIndex"] == 1 && (long)proof["observedAt"] == 1590,
                    "anchored no-FX interaction did not replay to the physical choice");
                var detail = ModelValue.Object(proof, "evidence");
                Check(ModelValue.Text(detail, "kind") == "verified-click-transition" && !detail.ContainsKey("uniqueFeedback"),
                    "new path masqueraded as a detected FX");
                Check(replay.FrameCount == 0 && replay.TryObserve(1701) == null, "direct proof retained pixels or emitted twice");
            }
            foreach (string reason in new[] { "interaction-interrupted", "focus-changed", "local-action", "outside-click", "capture-unavailable" })
            using (var replay = Started())
            {
                replay.Bind(Reference(), 980); Click(replay, false);
                replay.Cancel(reason, 1450);
                for (long at = 1500; at <= 1850; at += 70) replay.Add(Frame(at, 100, false), 0, -1, at);
                Check(replay.TryObserve(1850) == null, "cancelled no-FX activation was revived: " + reason);
            }
            using (var replay = Started())
            {
                Click(replay, true); replay.Bind(Reference(1120), 1500);
                Check(replay.TryObserve(1500) == null && replay.Reason == "reference-after-click", "post-click OCR retroactively identified an earlier click");
            }
            using (var replay = Started())
            {
                Click(replay, true); var wrong = Reference(); wrong.TitleAnchors[1][0].Feature = new int[128]; replay.Bind(wrong, 1500);
                Check(replay.TryObserve(1500) == null && replay.Reason == "proof-rejected", "mismatched exact title anchors were accepted");
            }
            foreach (string key in new[] { "gameEpoch", "revision", "lifecycle", "captureRevision", "notBefore" })
            using (var replay = Started())
            {
                Click(replay, true); var changed = Scope(); changed[key] = Convert.ToInt64(changed[key]) + 1;
                replay.UpdateScopeForFixture(changed, 1500); replay.Bind(Reference(), 1500);
                Check(replay.FrameCount == 0 && replay.TryObserve(1500) == null, "scope boundary retained early witnesses: " + key);
            }
            foreach (string reason in new[] { "focus-changed", "local-action", "capture-unavailable", "outside-click" })
            using (var replay = Started())
            {
                var witness = Frame(1000); replay.Add(witness, 0, -1, 1000); replay.Cancel(reason, 1200);
                replay.UpdateScopeForFixture(Scope(), 1250); replay.Bind(Reference(), 1250);
                Check(witness.Disposed && replay.FrameCount == 0 && replay.TryObserve(1250) == null, "cancel did not dispose/fence evidence: " + reason);
            }
            using (var replay = Started())
            {
                Click(replay, true); replay.CheckLease(2000); replay.UpdateScopeForFixture(Scope(), 2100); replay.Bind(Reference(), 2100);
                Check(replay.FrameCount == 0 && replay.TryObserve(2100) == null, "scope heartbeat expiry was bypassed by the same restored scope");
            }
            using (var replay = Started())
            {
                Click(replay, true); replay.UpdateScopeForFixture(Scope(), 2100); replay.Bind(Reference(), 2100);
                Check(replay.FrameCount == 0 && replay.TryObserve(2100) == null, "fresh callback resurrected witnesses before the overdue poll could expire them");
            }
            using (var replay = Started())
            {
                Click(replay, true); replay.UpdateScope(Scope(), 2100, 1000); replay.Bind(Reference(), 2100);
                Check(!replay.Active && replay.FrameCount == 0 && replay.TryObserve(2100) == null, "delayed transport response manufactured a fresh lease from receipt time");
            }
            using (var replay = Started())
            {
                Click(replay, true); var extra = Frame(1500); replay.Add(extra, 1, 1, 1500); replay.Bind(Reference(), 1600);
                Check(extra.Disposed && replay.FrameCount == 0 && replay.TryObserve(1600) == null && replay.Reason == "extra-click", "extra click reused previous witnesses");
            }
            using (var replay = Started())
            {
                replay.Add(Frame(1000), 0, -1, 1000); replay.Add(Frame(1070), 0, -1, 1070); replay.Add(Frame(1100), 1, 1, 1100);
                Check(!replay.Add(Frame(1150), 2, 2, 1150) && replay.Reason == "release-unpaired", "cross-card drag was accepted");
            }
            using (var replay = Started())
            {
                var one = Frame(1000); replay.Add(one, 0, -1, 1000); replay.Add(Frame(1070), 0, -1, 1070); replay.Add(Frame(1140), 0, -1, 1140);
                Check(one.Disposed && replay.FrameCount == 2, "idle memory did not retain exactly two baseline frames");
                var tooLarge = Frame(1210); tooLarge.Bytes = EarlySelectionReplay.MaximumBytes + 1;
                Check(!replay.Add(tooLarge, 1, 1, 1210) && tooLarge.Disposed && replay.FrameCount == 0 && replay.RetainedBytes == 0, "memory cap did not fail closed");
            }
            using (var replay = Started())
            {
                replay.Add(Frame(1000), 0, -1, 1000); replay.Add(Frame(1070), 0, -1, 1070); replay.Add(Frame(1100), 1, 1, 1100); replay.Add(Frame(1150), 2, 1, 1150);
                for (int i = 0; i < 41; i++) replay.Add(Frame(1200 + i * 10), 0, -1, 1200 + i * 10);
                Check(replay.FrameCount == 0 && replay.Reason == "buffer-limit", "frame cap did not discard the entire interaction");
            }
            using (var replay = Started())
            {
                Click(replay, true); Heartbeats(replay, 6200); Check(!replay.CheckLease(6200) && replay.FrameCount == 0, "five-second interaction cap was bypassed");
            }
            using (var replay = Started())
            {
                replay.Bind(Reference(), 980); var moved = Frame(1000); moved.Geometry.ClientBounds.Offset(1, 0);
                Check(!replay.Add(moved, 0, -1, 1000) && moved.Disposed && replay.Reason == "geometry-changed", "reference geometry was not checked on the first buffered frame");
            }
            using (var replay = Started())
            {
                var source = Frame(1000); var reference = Reference(); Check(source.TitleMask(reference) == 7, "bitmap title extraction failed exact generated anchors");
                replay.Add(source, 0, -1, 1000); replay.Dispose(); Check(source.Disposed && replay.RetainedBytes == 0 && !replay.Active, "dispose retained pixel witnesses");
            }
            using (var generated = Frame(1000))
            using (var sampled = EarlySelectionFrame.Create(generated.Geometry))
            {
                for (int i = 0; i < 3; i++)
                using (var card = new Bitmap(generated.Geometry.Regions[i].Width, generated.Geometry.Regions[i].Height, PixelFormat.Format32bppArgb))
                {
                    using (Graphics graphics = Graphics.FromImage(card))
                    {
                        graphics.Clear(Color.FromArgb(25, 25, 25));
                        graphics.DrawImageUnscaled(generated.TitleBands[i], generated.TitleBoxes[i].X - generated.Geometry.Regions[i].X,
                            generated.TitleBoxes[i].Y - generated.Geometry.Regions[i].Y);
                    }
                    sampled.ReadCard(card, i);
                    Check(sampled.Signatures[i].Length == 192 && sampled.TitleBoxes[i] == generated.TitleBoxes[i], "shared capture extractor lost geometry/signature shape");
                }
                Check(sampled.TitleMask(Reference()) == 7 && sampled.Bytes > 0, "shared production card extraction changed exact title witnesses");
            }
            var wide = EarlySelectionReplay.Geometry(new IntPtr(42), new Rectangle(0, 0, 2560, 1080));
            Check(wide.Regions[0] == new Rectangle(723, 216, 346, 540), "ultrawide geometry differs from the OCR capture rectangles");
            var legacy = EarlySelectionReplay.Geometry(new IntPtr(42), new Rectangle(0, 0, 800, 600));
            legacy.Regions[0] = new Rectangle(10, 10, 100, 100);
            legacy.TitleAnchors = new ScreenTitleAnchor[3][];
            legacy.TitleAnchors[0] = new[] { new ScreenTitleAnchor { Box = new Rectangle(20, 20, 50, 20) } };
            Check(EarlySelectionReplay.TitleBox(legacy, 0) == new Rectangle(20, 20, 50, 20), "shared helper changed valid legacy anchors outside the default discovery band");
            var bad = Scope(); bad["revision"] = "3";
            using (var replay = new EarlySelectionReplay()) { replay.UpdateScopeForFixture(bad, 1000); Check(!replay.Active, "string-valued scope integer was accepted"); }
            return checks;
        }
    }
}
