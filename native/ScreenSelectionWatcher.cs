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
        private readonly RecognitionTrace trace;
        private readonly EarlySelectionReplay early;
        private bool earlyScopeSupported, earlyButtonKnown, earlyLastDown, earlyHadFocus;
        private long earlyNextFrameAt;
        private ScreenSelectionObservation observation;
        private bool disposed, lastButtonDown, buttonKnown, eligible, hadGameFocus;
        private long nextFrameAt, lastSeenCapture, nextIdentityCheck;
        private IntPtr identityWindow;
        private bool identityVerified;
        private Dictionary<string, object> lastAttempt;
        private string lastCaptureCode = "not-attempted", lastFailureCode = "none";
        private string lastCancelCode = "none";
        private long lastCaptureAt, lastFailureAt, lastCancelAt;
        private int captureAttempts, captureSuccesses, captureFailures;
        private long lastRefreshCapture;
        private int sameIdentityRefreshes, pendingRefreshesPreserved;
        private int sameIdentityReferenceUpdates, pressedRefreshesPreserved;
        private int titleChecks, titleMatches, lastTitleMatchMask;
        internal event Action<Dictionary<string, object>> SelectionObserved;
        internal event Action<string> StatusChanged;
        internal string StatusCode { get; private set; }
        internal static int LargestDiagnosticFixtureBytes { get; private set; }

        internal ScreenSelectionWatcher(RecognitionTrace recognitionTrace = null)
        {
            trace = recognitionTrace ?? new RecognitionTrace();
            early = new EarlySelectionReplay(trace);
            StatusCode = "waiting";
            timer = new Timer { Interval = 25 };
            timer.Tick += delegate { Poll(); };
        }

        internal void UpdateModel(Dictionary<string, object> model)
        {
            if (disposed) return;
            object scopeValue;
            if (model != null && model.TryGetValue("screenObservationScope", out scopeValue))
            {
                object rawIssuedAt; long issuedAt;
                if (!model.TryGetValue("recognitionAt", out rawIssuedAt) || !(rawIssuedAt is int || rawIssuedAt is long)
                    || !ModelValue.Integer(model, "recognitionAt", out issuedAt))
                { UpdateObservationScope(null); return; }
                UpdateObservationScope(scopeValue as Dictionary<string, object>, issuedAt);
                ScreenSelectionObservation nextEarly;
                long stamp = Now();
                if (ScreenSelectionObservation.TryRead(ModelValue.Object(model, "selection"), stamp, out nextEarly)
                    || ScreenSelectionObservation.TryReadContinuation(ModelValue.Object(model, "selectionResult"), stamp, early.ClickedAt, out nextEarly))
                    early.Bind(nextEarly, stamp);
                PublishEarly(stamp);
                return;
            }
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
            {
                // OCR can finish on the first empty post-click frame while the
                // faster watcher is still collecting dismissal evidence. Only
                // an already-released click may continue on this bounded lease;
                // it is never a source of Ready or a new pointer observation.
                ScreenSelectionObservation continuation;
                if (observation != null && decision.Pending && !decision.Invalid
                    && ScreenSelectionObservation.TryReadContinuation(ModelValue.Object(model, "selectionResult"), Now(), decision.ClickedAt, out continuation)
                    && observation.Identity() == continuation.Identity()) return;
                Suspend("waiting", observation != null); return;
            }
            if (TryApplySameIdentityReference(next, Now())) return;
            // A model cached before a click/roll must not arm the watcher again.
            if (next.CapturedAt <= lastSeenCapture) return;
            if (!decision.ConsiderCapture(next.CapturedAt, next.Identity())) { SetStatus("settling"); return; }
            lastSeenCapture = next.CapturedAt;
            lastRefreshCapture = next.CapturedAt;
            observation = next;
            decision.Arm(next.CapturedAt, Now());
            nextFrameAt = 0;
            if (buttonKnown && lastButtonDown) { Suspend("held-before-arm", true); return; }
            SetStatus("baseline");
        }

        // Called by the lightweight model guard independently of heavyweight
        // sidebar rendering and recommendation generation.
        internal void UpdateObservationScope(Dictionary<string, object> scope)
        { UpdateObservationScope(null, 0); } // Revocation only; issuing a lease requires its server timestamp.

        private void UpdateObservationScope(Dictionary<string, object> scope, long issuedAt)
        {
            if (disposed) return;
            earlyScopeSupported = true;
            early.UpdateScope(scope, Now(), issuedAt);
            eligible = early.Active;
            if (eligible) timer.Start();
            else { earlyButtonKnown = earlyHadFocus = false; timer.Stop(); }
            SetStatus(early.WatcherStatus);
        }

        internal void CancelForLocalAction()
        {
            early.Cancel("local-action", Now()); earlyButtonKnown = false;
            Suspend("local-action", true);
        }

        // Separate from timer startup so model refresh ordering can be checked
        // with deterministic, in-memory fixtures only.
        private bool TryApplySameIdentityReference(ScreenSelectionObservation next, long now)
        {
            if (observation == null) return false;
            if (observation.Identity() != next.Identity()) { Suspend("offers-changed", true); return true; }
            bool preserveInput = PreserveInputObservation(observation, next, decision);
            TrackReferenceRefresh(next.CapturedAt, preserveInput && decision.Pending, preserveInput && decision.Pressed);
            if (observation.CapturedAt == next.CapturedAt || preserveInput) return true;
            if (next.CapturedAt <= lastSeenCapture) return true;
            if (!decision.ConsiderCapture(next.CapturedAt, next.Identity())) { SetStatus("settling"); return true; }
            lastSeenCapture = lastRefreshCapture = next.CapturedAt;
            observation = next;
            // A new OCR image of the exact same ordered offer is a reference
            // update, not a new interaction. The next frame and every edge still
            // have to match this new image using the unchanged strict thresholds.
            decision.RefreshReference(next.CapturedAt);
            sameIdentityReferenceUpdates = Math.Min(1000000, sameIdentityReferenceUpdates + 1);
            return true;
        }

        private void TrackReferenceRefresh(long capturedAt, bool preservePending, bool preservePressed)
        {
            if (capturedAt <= lastRefreshCapture) return;
            lastRefreshCapture = capturedAt;
            sameIdentityRefreshes = Math.Min(1000000, sameIdentityRefreshes + 1);
            if (preservePending) pendingRefreshesPreserved = Math.Min(1000000, pendingRefreshesPreserved + 1);
            if (preservePressed) pressedRefreshesPreserved = Math.Min(1000000, pressedRefreshesPreserved + 1);
        }


        internal static bool PreservePendingObservation(ScreenSelectionObservation active, ScreenSelectionObservation incoming, ScreenSelectionDecision state)
        {
            return active != null && incoming != null && state.Pending && !state.Invalid
                && active.Identity() == incoming.Identity();
        }

        internal static bool PreserveInputObservation(ScreenSelectionObservation active, ScreenSelectionObservation incoming, ScreenSelectionDecision state)
        {
            return active != null && incoming != null && (state.Pressed || state.Pending) && !state.Invalid
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
                case "identity-waiting": return "屏幕自动确认（实验）：标题暂不可核对，保留本轮等待清晰画面";
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
            // Routine waiting models must not erase the reason the last active
            // observation was cancelled, including a first-frame mismatch.
            if (code != "waiting" || observation != null)
            {
                lastCancelCode = CancellationCode(code);
                lastCancelAt = Now();
            }
            if (decision.BaselineFrames > 0 || decision.Pending || decision.FeedbackFrames > 0)
                lastAttempt = DecisionDiagnostics(code);
            if (observation != null && invalidate) decision.Invalidate(Now());
            observation = null;
            decision.Reset(Now());
            if (!eligible) timer.Stop();
            SetStatus(code);
        }

        private static string CancellationCode(string code)
        {
            switch (code)
            {
                case "paused": case "offers-changed": case "held-before-arm": case "local-action":
                case "focus-changed": case "expired": case "outside-click": case "geometry-or-occlusion":
                case "visual-evidence-incomplete": case "capture-unavailable": return code;
                case "waiting": return "metadata-unavailable";
                default: return "other-cancel";
            }
        }

        private static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
        private static bool ButtonDown() { return (GetAsyncKeyState(0x01) & 0x8000) != 0; }
        // Only sampled after verifying the foreground game. These inputs can
        // open an in-game overlay or divert release away from a card.
        private static bool SelectionInterrupted()
        {
            foreach (int key in new[] { 0x02, 0x04, 0x1B, 0x09, 0x50 })
                if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
            return false;
        }

        private void Poll()
        {
            if (earlyScopeSupported) { PollEarly(); return; }
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
                if ((down || decision.Pressed || decision.Pending) && SelectionInterrupted())
                { Suspend("interaction-interrupted", true); return; }
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
                    int[][] edgeFrame; int edgeTitleMask;
                    if (!Capture(observation, out edgeFrame, out edgeTitleMask)) { Suspend("geometry-or-occlusion", true); return; }
                    // Capture on both edges. A highlight already visible by
                    // release must not be mistaken for a NEW selection effect.
                    decision.PointerWithTitleIdentity(down, column, onGame, now, edgeFrame, observation.Signatures, edgeTitleMask == 7);
                    if (decision.Invalid) { Suspend("visual-evidence-incomplete", true); return; }
                    if (decision.Pending) SetStatus("pending");
                }
                else lastButtonDown = down;
                if (observation == null || edge) return;
                if (now < nextFrameAt) return;
                nextFrameAt = now + 65;
                int[][] signatures; int titleMask;
                if (!Capture(observation, out signatures, out titleMask)) { Suspend("geometry-or-occlusion", true); return; }
                decision.FrameWithTitleIdentity(signatures, observation.Signatures, now, titleMask);
                if (decision.Invalid) { Suspend("visual-evidence-incomplete", true); return; }
                if (!decision.Ready && !decision.Pending && !decision.Pressed) SetStatus("identity-waiting");
                if (decision.Ready) SetStatus("ready");
                if (decision.FeedbackFrames > 0) SetStatus("feedback");
                if (!decision.Complete) return;
                var evidence = observation.Evidence(decision, now);
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

        private void PollEarly()
        {
            if (disposed) return;
            long now = Now();
            if (!early.CheckLease(now)) { earlyHadFocus = earlyButtonKnown = false; SetStatus(early.WatcherStatus); return; }
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
                    if (earlyHadFocus || early.FrameCount > 0) CancelEarly("focus-changed", now);
                    earlyHadFocus = earlyButtonKnown = false;
                    return;
                }
                earlyHadFocus = true;
                bool down = ButtonDown();
                if ((down || early.HasInteraction) && SelectionInterrupted())
                { CancelEarly("interaction-interrupted", now); earlyButtonKnown = false; return; }
                if (!earlyButtonKnown)
                {
                    earlyButtonKnown = true; earlyLastDown = down;
                    if (down) { CancelEarly("held-before-observation", now); return; }
                }
                bool edge = down != earlyLastDown;
                earlyLastDown = down;
                if (!edge && (now < earlyNextFrameAt || !early.WantsFrame(now))) { PublishEarly(now); return; }
                if (edge || now >= earlyNextFrameAt)
                {
                    Rectangle bounds;
                    if (!ClientBounds(foreground, out bounds)) { CancelEarly("capture-unavailable", now, "client-unavailable"); return; }
                    var geometry = EarlySelectionReplay.Geometry(foreground, bounds);
                    int column = -1;
                    if (edge)
                    {
                        PhysicalPoint point;
                        bool onGame = GetPhysicalCursorPos(out point) && RootWindow(WindowFromPhysicalPoint(point)) == foreground;
                        column = onGame ? geometry.ColumnAt(point.X, point.Y) : -1;
                        if (!onGame || column < 0) { CancelEarly("outside-click", now); return; }
                    }
                    EarlySelectionFrame frame;
                    string failure;
                    bool success = TryCaptureFrame(geometry, out frame, out failure);
                    RecordCaptureResult(success, failure, Now());
                    if (!success) { CancelEarly("capture-unavailable", now, failure); return; }
                    // Timestamp before capture is paired with the actual edge
                    // sampled above; no final cursor position is replayed.
                    frame.At = now;
                    early.Add(frame, edge ? (down ? 1 : 2) : 0, column, Now());
                    earlyNextFrameAt = now + 65;
                    PublishEarly(Now());
                }
            }
            catch { CancelEarly("capture-unavailable", now, "capture-exception"); }
        }

        private void CancelEarly(string reason, long now, string traceReason = null)
        { early.Cancel(reason, now, traceReason); SetStatus(early.WatcherStatus); }

        private void PublishEarly(long now)
        {
            var evidence = early.TryObserve(now);
            SetStatus(early.WatcherStatus);
            if (evidence == null) return;
            SetStatus("observed");
            var handler = SelectionObserved;
            if (handler != null) handler(evidence);
        }

        // A bounded technical snapshot. No pixel deltas, handles, identities,
        // coordinates, candidate text, or arbitrary backend values are exposed.
        internal Dictionary<string, object> Diagnostics()
        {
            long now = Now();
            var current = DecisionDiagnostics(StatusCode);
            current["eligible"] = eligible;
            current["gameForeground"] = earlyScopeSupported ? earlyHadFocus : hadGameFocus;
            current["captureAttempts"] = captureAttempts;
            current["captureSuccesses"] = captureSuccesses;
            current["captureFailures"] = captureFailures;
            current["lastCaptureCode"] = lastCaptureCode;
            current["lastCaptureAgeMs"] = Age(now, lastCaptureAt);
            current["lastFailureCode"] = lastFailureCode;
            current["lastFailureAgeMs"] = Age(now, lastFailureAt);
            current["lastCancelCode"] = lastCancelCode;
            current["lastCancelAgeMs"] = Age(now, lastCancelAt);
            current["activeCaptureAgeMs"] = Age(now, earlyScopeSupported ? early.ReferenceCapturedAt : observation == null ? 0 : observation.CapturedAt);
            current["sameIdentityRefreshes"] = sameIdentityRefreshes;
            current["pendingRefreshesPreserved"] = pendingRefreshesPreserved;
            current["pressedRefreshesPreserved"] = pressedRefreshesPreserved;
            current["sameIdentityReferenceUpdates"] = sameIdentityReferenceUpdates;
            current["titleChecks"] = titleChecks;
            current["titleMatches"] = titleMatches;
            current["titleMatchMask"] = lastTitleMatchMask;
            foreach (var entry in earlyScopeSupported ? early.DecisionDiagnostics(now) : decision.DiagnosticState(now)) current[entry.Key] = entry.Value;
            if (lastAttempt != null) current["lastAttempt"] = new Dictionary<string, object>(lastAttempt);
            current["early"] = early.Diagnostics();
            return current;
        }

        private Dictionary<string, object> DecisionDiagnostics(string status)
        {
            if (earlyScopeSupported) return new Dictionary<string, object> {
                { "status", status }, { "baselineFrames", early.BaselineFrames },
                { "feedbackFrames", early.FeedbackFrames }, { "dismissedFrames", early.DismissedFrames },
                { "pending", early.HasInteraction }
            };
            return new Dictionary<string, object> {
                { "status", status }, { "baselineFrames", decision.BaselineFrames },
                { "feedbackFrames", decision.FeedbackFrames }, { "dismissedFrames", decision.DismissedFrames },
                { "pending", decision.Pending }
            };
        }

        internal static object Age(long now, long stamp)
        {
            return stamp <= 0 ? null : (object)Math.Max(0, Math.Min(60000, now - stamp));
        }

        internal static Dictionary<string, object> BackendDiagnostics(Dictionary<string, object> value)
        {
            string status = ModelValue.Text(value, "metadataStatus");
            switch (status)
            {
                case "accepted": case "missing": case "shape-invalid": case "title-outside-region":
                case "title-incomplete": case "not-scanned": case "stale": case "context-ineligible": break;
                default: status = "not-scanned"; break;
            }
            object armed;
            return new Dictionary<string, object> {
                { "metadataStatus", status }, { "captureAgeMs", BackendAge(value, "captureAgeMs") },
                { "scanCode", BackendScanCode(ModelValue.Text(value, "scanCode")) },
                { "backendArmed", value != null && value.TryGetValue("backendArmed", out armed) && armed is bool && (bool)armed },
                { "lastScanAgeMs", BackendAge(value, "lastScanAgeMs") }
            };
        }

        private static string BackendScanCode(string code)
        {
            // Exact mirror of SELECTION_SCAN_CODES in server/scan-diagnostics.mjs.
            switch (code)
            {
                case "title-layout-confirmed": case "capture-size-invalid": case "ocr-no-text":
                case "title-name-unmatched": case "title-layout-incomplete": case "title-layout-ambiguous":
                case "game-not-foreground": case "foreground-changed": case "ocr-language-missing":
                case "ocr-engine-unavailable": case "window-bounds-unavailable": case "window-size-unsupported":
                case "ocr-passes-incomplete": case "ocr-initializing-failed": case "ocr-native-window-failed":
                case "ocr-foreground-check-failed": case "ocr-winrt-runtime-failed": case "ocr-ocr-language-failed":
                case "ocr-ocr-engine-failed": case "ocr-window-bounds-failed": case "ocr-capture-failed":
                case "ocr-resize-failed": case "ocr-encode-failed": case "ocr-stream-write-failed":
                case "ocr-decode-failed": case "ocr-software-bitmap-failed": case "ocr-recognize-failed":
                case "ocr-result-failed": case "ocr-unavailable": case "scan-busy":
                case "scan-platform-unsupported": case "scan-output-too-large": case "scan-output-invalid":
                case "scan-execution-failed": case "not-scanned": case "scan-loop-failed":
                case "scan-context-ineligible": case "scan-context-changed": case "scan-proposals-incomplete":
                case "scan-offer-owned": case "scan-offer-consumed": case "scan-capture-stale": return code;
                default: return "not-scanned";
            }
        }

        private static object BackendAge(Dictionary<string, object> value, string key)
        {
            object raw; long age;
            if (value == null || !value.TryGetValue(key, out raw) || raw == null || raw is bool
                || !(raw is byte || raw is short || raw is int || raw is long || raw is uint || raw is ulong)
                || !long.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out age) || age < 0) return null;
            return Math.Min(60000, age);
        }

        private bool Capture(ScreenSelectionObservation value, out int[][] signatures, out int titleMask)
        {
            string code;
            bool success = TryCapture(value, out signatures, out titleMask, out code);
            RecordCaptureResult(success, code, Now());
            if (success) { lastTitleMatchMask = titleMask; titleChecks = Math.Min(1000000, titleChecks + 1); if (titleMask == 7) titleMatches = Math.Min(1000000, titleMatches + 1); }
            return success;
        }

        internal void RecordCaptureResult(bool success, string code, long stamp)
        {
            if (success) code = "captured";
            else switch (code)
            {
                case "dpi-unavailable": case "game-unverified": case "game-not-foreground": case "game-not-visible":
                case "client-unavailable": case "client-changed": case "region-too-large":
                case "occlusion-enumeration-incomplete": case "occlusion-bounds-unavailable":
                case "occlusion-state-unavailable": case "card-occluded": case "capture-exception": break;
                default: code = "capture-exception"; break;
            }
            captureAttempts = Math.Min(1000000, captureAttempts + 1);
            lastCaptureAt = stamp > 0 ? stamp : Now();
            lastCaptureCode = code;
            if (success) captureSuccesses = Math.Min(1000000, captureSuccesses + 1);
            else
            {
                captureFailures = Math.Min(1000000, captureFailures + 1);
                lastFailureCode = lastCaptureCode;
                lastFailureAt = lastCaptureAt;
            }
        }

        private static IntPtr RootWindow(IntPtr window) { return window == IntPtr.Zero ? IntPtr.Zero : GetAncestor(window, 2); }

        // Explicit diagnostic entry point only. It never starts this watcher's
        // timer, sends input, opens UI, contacts the backend or commits a choice.
        internal static Dictionary<string, object> ObserveTitleIdentity(string input)
        {
            var output = new Dictionary<string, object> {
                { "mode", "read-only-game-title-probe" }, { "actualSelectionConfirmed", false },
                { "status", "invalid-input" }, { "captures", 0 }, { "allTitlesMatched", 0 },
                { "legacyRgbWouldReject", 0 }, { "readyFrames", 0 }, { "titleMaskCounts", new int[8] }
            };
            if (input == null || System.Text.Encoding.UTF8.GetByteCount(input) > 16384) return output;
            ScreenSelectionObservation reference;
            try
            {
                var serializer = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 20 };
                if (!ScreenSelectionObservation.TryRead(serializer.DeserializeObject(input) as Dictionary<string, object>, Now(), out reference)) return output;
            }
            catch { return output; }
            int captures = 0, matches = 0, oldRejects = 0, readyFrames = 0;
            var counts = new int[8]; var decision = new ScreenSelectionDecision();
            decision.Arm(reference.CapturedAt, Now());
            var clock = System.Diagnostics.Stopwatch.StartNew();
            string status = "completed";
            while (clock.ElapsedMilliseconds < 8000 && captures < 100)
            {
                int[][] frame; int mask; string failure;
                if (!TryCapture(reference, out frame, out mask, out failure)) { status = failure; break; }
                long stamp = Now(); captures++; counts[mask]++;
                if (mask == 7) matches++;
                var legacy = new ScreenSelectionDecision(); legacy.Arm(reference.CapturedAt, stamp);
                legacy.Frame(frame, reference.Signatures, stamp);
                if (legacy.Invalid) oldRejects++;
                decision.FrameWithTitleIdentity(frame, reference.Signatures, stamp, mask);
                if (decision.Ready && !decision.Invalid) readyFrames++;
                System.Threading.Thread.Sleep(65);
            }
            output["status"] = status; output["captures"] = captures; output["allTitlesMatched"] = matches;
            output["legacyRgbWouldReject"] = oldRejects; output["readyFrames"] = readyFrames; output["titleMaskCounts"] = counts;
            output["elapsedMs"] = (int)Math.Min(10000, clock.ElapsedMilliseconds);
            return output;
        }

        private static bool TryCapture(ScreenSelectionObservation value, out int[][] signatures, out int titleMask, out string failure)
        {
            signatures = null;
            titleMask = 0;
            EarlySelectionFrame frame;
            if (!TryCaptureFrame(value, out frame, out failure)) return false;
            using (frame)
            {
                signatures = frame.Signatures;
                titleMask = frame.TitleMask(value);
                return true;
            }
        }

        private static bool TryCaptureFrame(ScreenSelectionObservation value, out EarlySelectionFrame captured, out string failure)
        {
            captured = null;
            failure = "capture-exception";
            IntPtr previous = IntPtr.Zero;
            EarlySelectionFrame witness = null;
            try
            {
                previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
                if (previous == IntPtr.Zero) previous = SetThreadDpiAwarenessContext(new IntPtr(-3));
                if (previous == IntPtr.Zero) { failure = "dpi-unavailable"; return false; }
                if (!GameWindow.IsVerifiedGame(value.Window)) { failure = "game-unverified"; return false; }
                if (GetForegroundWindow() != value.Window) { failure = "game-not-foreground"; return false; }
                if (!IsWindowVisible(value.Window) || IsIconic(value.Window)) { failure = "game-not-visible"; return false; }
                Rectangle client;
                if (!ClientBounds(value.Window, out client)) { failure = "client-unavailable"; return false; }
                if (client != value.ClientBounds) { failure = "client-changed"; return false; }
                if (!Unoccluded(value, out failure)) return false;
                witness = EarlySelectionFrame.Create(value);
                for (int index = 0; index < 3; index++)
                {
                    Rectangle region = value.Regions[index];
                    if ((long)region.Width * region.Height > 2000000) { failure = "region-too-large"; return false; }
                    using (var bitmap = new Bitmap(region.Width, region.Height, PixelFormat.Format32bppArgb))
                    {
                        using (var graphics = Graphics.FromImage(bitmap))
                            graphics.CopyFromScreen(client.Left + region.Left, client.Top + region.Top, 0, 0,
                                region.Size, CopyPixelOperation.SourceCopy);
                        witness.ReadCard(bitmap, index);
                    }
                }
                Rectangle final;
                if (GetForegroundWindow() != value.Window) { failure = "game-not-foreground"; return false; }
                if (!ClientBounds(value.Window, out final)) { failure = "client-unavailable"; return false; }
                if (final != client) { failure = "client-changed"; return false; }
                if (!Unoccluded(value, out failure)) return false;
                captured = witness; witness = null;
                failure = "captured";
                return true;
            }
            catch { failure = "capture-exception"; return false; }
            finally
            {
                if (witness != null) witness.Dispose();
                if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
            }
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

        private static bool Unoccluded(ScreenSelectionObservation value, out string failure)
        {
            failure = "captured";
            // Reject any visible top-level window overlapping a sampled card.
            // Do not ignore our NOACTIVATE sidebar: it can cover game pixels.
            var visited = new HashSet<IntPtr>();
            IntPtr above = GetWindow(value.Window, 3);
            while (above != IntPtr.Zero)
            {
                if (visited.Count >= 256 || !visited.Add(above)) { failure = "occlusion-enumeration-incomplete"; return false; }
                IntPtr current = above;
                above = GetWindow(current, 3);
                if (!IsWindowVisible(current) || IsIconic(current)) continue;
                NativeRect frame;
                if (DwmGetWindowAttribute(current, 9, out frame, Marshal.SizeOf(typeof(NativeRect))) != 0
                    && !GetWindowRect(current, out frame)) { failure = "occlusion-bounds-unavailable"; return false; }
                Rectangle bounds = Rectangle.FromLTRB(frame.Left, frame.Top, frame.Right, frame.Bottom);
                // Metadata for a window that cannot cover any sampled pixels
                // must not block observation (e.g. an off-card input helper).
                if (!IntersectsCard(value, bounds)) continue;
                int cloaked;
                bool cloakKnown = DwmGetWindowAttribute(current, 14, out cloaked, sizeof(int)) == 0;
                if (BlocksRelevantWindow(true, cloakKnown, cloaked != 0, out failure)) return false;
            }
            return true;
        }

        private static bool IntersectsCard(ScreenSelectionObservation value, Rectangle bounds)
        {
            foreach (Rectangle region in value.Regions)
            {
                Rectangle physical = region; physical.Offset(value.ClientBounds.Location);
                if (bounds.IntersectsWith(physical)) return true;
            }
            return false;
        }

        internal static bool BlocksRelevantWindow(bool intersects, bool cloakKnown, bool cloaked, out string failure)
        {
            failure = "captured";
            if (!intersects) return false;
            if (!cloakKnown) { failure = "occlusion-state-unavailable"; return true; }
            if (cloaked) return false;
            failure = "card-occluded";
            return true;
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            timer.Stop(); timer.Dispose();
            early.Dispose();
            observation = null;
            decision.Invalidate(Now()); decision.Reset();
            lastAttempt = null;
            SelectionObserved = null; StatusChanged = null;
        }

        internal static int ValidateFixtures()
        {
            int checks = ScreenSelectionDecision.ValidateFixtures() + ValidateReferenceRefreshFixtures()
                + CardTitleIdentity.ValidateFixtures() + ScreenSelectionDecision.ValidateTitleIdentityFixtures()
                + EarlySelectionReplayFixtures.Run() + RecognitionTrace.ValidateFixtures() + ScreenSelectionDecision.ValidateDirectFixtures();
            using (var watcher = new ScreenSelectionWatcher())
            {
                watcher.RecordCaptureResult(true, "captured", Now());
                watcher.Suspend("visual-evidence-incomplete", true);
                watcher.Suspend("waiting", false);
                var snapshot = watcher.Diagnostics();
                if (Convert.ToInt32(snapshot["baselineFrames"]) != 0 || (string)snapshot["status"] != "waiting"
                    || (string)snapshot["lastCancelCode"] != "visual-evidence-incomplete"
                    || Convert.ToInt32(snapshot["captureFailures"]) != 0 || snapshot["lastCancelAgeMs"] == null)
                    throw new InvalidOperationException("A first-frame visual mismatch was lost after returning to waiting.");
                checks++;
            }
            return checks + ValidateMaximumDiagnosticFixture();
        }

        private static int ValidateMaximumDiagnosticFixture()
        {
            using (var watcher = new ScreenSelectionWatcher())
            {
                watcher.StatusCode = "visual-evidence-incomplete";
                watcher.eligible = watcher.hadGameFocus = true;
                watcher.captureAttempts = watcher.captureSuccesses = watcher.captureFailures = 1000000;
                watcher.sameIdentityRefreshes = watcher.sameIdentityReferenceUpdates = 1000000;
                watcher.pendingRefreshesPreserved = watcher.pressedRefreshesPreserved = 1000000;
                watcher.lastCaptureAt = watcher.lastFailureAt = watcher.lastCancelAt = 1;
                watcher.lastCaptureCode = watcher.lastFailureCode = "occlusion-enumeration-incomplete";
                watcher.lastCancelCode = "visual-evidence-incomplete";
                watcher.observation = new ScreenSelectionObservation { CapturedAt = 1 };
                watcher.decision.PrepareMaximumDiagnosticFixture();
                watcher.lastAttempt = new Dictionary<string, object> {
                    { "status", "visual-evidence-incomplete" }, { "baselineFrames", 1000 }, { "feedbackFrames", 1000 },
                    { "dismissedFrames", 1000 }, { "pending", true }
                };
                string json = new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(watcher.Diagnostics());
                LargestDiagnosticFixtureBytes = System.Text.Encoding.UTF8.GetByteCount(json);
                if (LargestDiagnosticFixtureBytes > 3400 || json.Contains("synthetic-private") || json.Contains("\"delta\"")
                    || json.Contains("signature") || json.Contains("windowHandle") || json.Contains("\"ids\""))
                    throw new InvalidOperationException("The maximum native diagnostic snapshot exceeded its privacy or 3400-byte budget.");
                return 1;
            }
        }

        private static int ValidateReferenceRefreshFixtures()
        {
            Func<long, ScreenSelectionObservation> capture = delegate(long time)
            {
                var rows = new[] { new int[192], new int[192], new int[192] };
                foreach (var row in rows) for (int i = 0; i < row.Length; i++) row[i] = 25;
                return new ScreenSelectionObservation {
                    Token = "synthetic-private-token", GameId = "synthetic-private-game", Epoch = 1, Revision = 1,
                    CapturedAt = time, Window = new IntPtr(42), ClientBounds = new Rectangle(0, 0, 800, 600),
                    Regions = new[] { new Rectangle(100, 100, 100, 200), new Rectangle(300, 100, 100, 200), new Rectangle(500, 100, 100, 200) },
                    Signatures = rows, Ids = new[] { "private-a", "private-b", "private-c" }
                };
            };
            var failures = new List<string>();
            using (var ready = new ScreenSelectionWatcher())
            {
                ready.observation = capture(1000); ready.lastSeenCapture = ready.lastRefreshCapture = 1000;
                ready.decision.Arm(1000);
                ready.decision.Frame(ready.observation.Signatures, ready.observation.Signatures, 1100);
                ready.decision.Frame(ready.observation.Signatures, ready.observation.Signatures, 1170);
                ready.TryApplySameIdentityReference(capture(1150), 1190);
                ready.decision.Pointer(true, 1, true, 1200, ready.observation.Signatures, ready.observation.Signatures);
                ready.decision.Pointer(false, 1, true, 1250, ready.observation.Signatures, ready.observation.Signatures);
                if (ready.decision.Invalid || !ready.decision.Pending) failures.Add("same-identity refresh created a ready-to-click blind interval");
            }
            using (var pressed = new ScreenSelectionWatcher())
            {
                pressed.observation = capture(1000); pressed.lastSeenCapture = pressed.lastRefreshCapture = 1000;
                pressed.decision.Arm(1000);
                pressed.decision.Frame(pressed.observation.Signatures, pressed.observation.Signatures, 1100);
                pressed.decision.Frame(pressed.observation.Signatures, pressed.observation.Signatures, 1170);
                pressed.decision.Pointer(true, 1, true, 1200, pressed.observation.Signatures, pressed.observation.Signatures);
                pressed.TryApplySameIdentityReference(capture(1150), 1225);
                pressed.decision.Pointer(false, 1, true, 1250, pressed.observation.Signatures, pressed.observation.Signatures);
                if (pressed.decision.Invalid || !pressed.decision.Pending) failures.Add("same-identity refresh erased a mouse-down before its matching mouse-up");
            }
            if (failures.Count > 0) throw new InvalidOperationException(string.Join("; ", failures));
            int checks = 2;
            using (var mismatch = new ScreenSelectionWatcher())
            {
                mismatch.observation = capture(1000); mismatch.lastSeenCapture = mismatch.lastRefreshCapture = 1000;
                mismatch.decision.Arm(1000); mismatch.decision.Frame(mismatch.observation.Signatures, mismatch.observation.Signatures, 1100);
                mismatch.decision.Frame(mismatch.observation.Signatures, mismatch.observation.Signatures, 1170);
                var changedReference = capture(1150);
                foreach (var row in changedReference.Signatures) for (int i = 0; i < row.Length; i++) row[i] = 75;
                mismatch.TryApplySameIdentityReference(changedReference, 1190);
                mismatch.decision.Frame(capture(1000).Signatures, mismatch.observation.Signatures, 1250);
                if (!mismatch.decision.Invalid || ModelValue.Text(ModelValue.Object(mismatch.decision.DiagnosticState(1300), "lastReject"), "code") != "frame-preclick-mae-close")
                    throw new InvalidOperationException("A same-identity reference refresh bypassed strict next-frame matching.");
                checks++;
            }
            using (var edgeMismatch = new ScreenSelectionWatcher())
            {
                edgeMismatch.observation = capture(1000); edgeMismatch.lastSeenCapture = edgeMismatch.lastRefreshCapture = 1000;
                edgeMismatch.decision.Arm(1000); edgeMismatch.decision.Frame(edgeMismatch.observation.Signatures, edgeMismatch.observation.Signatures, 1100);
                edgeMismatch.decision.Frame(edgeMismatch.observation.Signatures, edgeMismatch.observation.Signatures, 1170);
                var changedReference = capture(1150);
                foreach (var row in changedReference.Signatures) for (int i = 0; i < row.Length; i++) row[i] = 75;
                edgeMismatch.TryApplySameIdentityReference(changedReference, 1190);
                edgeMismatch.decision.Pointer(true, 1, true, 1200, capture(1000).Signatures, edgeMismatch.observation.Signatures);
                if (!edgeMismatch.decision.Invalid || ModelValue.Text(ModelValue.Object(edgeMismatch.decision.DiagnosticState(1300), "lastReject"), "code") != "pointer-panel-mae-close")
                    throw new InvalidOperationException("A same-identity reference refresh bypassed strict pointer-edge matching.");
                checks++;
            }
            for (int change = 0; change < 3; change++) using (var changedIdentity = new ScreenSelectionWatcher())
            {
                changedIdentity.observation = capture(1000); changedIdentity.lastSeenCapture = changedIdentity.lastRefreshCapture = 1000;
                changedIdentity.decision.Arm(1000); changedIdentity.decision.Frame(changedIdentity.observation.Signatures, changedIdentity.observation.Signatures, 1100);
                changedIdentity.decision.Frame(changedIdentity.observation.Signatures, changedIdentity.observation.Signatures, 1170);
                changedIdentity.decision.Pointer(true, 1, true, 1200, changedIdentity.observation.Signatures, changedIdentity.observation.Signatures);
                var replacement = capture(1150);
                if (change == 0) replacement.Token = "different-private-token";
                if (change == 1) replacement.Ids[1] = "different-private-id";
                if (change == 2) replacement.Regions[1].Offset(1, 0);
                changedIdentity.TryApplySameIdentityReference(replacement, 1225);
                if (changedIdentity.observation != null || changedIdentity.decision.Pressed || changedIdentity.decision.Pending
                    || ModelValue.Text(changedIdentity.Diagnostics(), "lastCancelCode") != "offers-changed")
                    throw new InvalidOperationException("A token, candidate, or physical-region change preserved an old pressed interaction.");
                checks++;
            }
            using (var preserved = new ScreenSelectionWatcher())
            {
                preserved.observation = capture(1000); preserved.lastSeenCapture = preserved.lastRefreshCapture = 1000;
                preserved.decision.Arm(1000); preserved.decision.Frame(preserved.observation.Signatures, preserved.observation.Signatures, 1100);
                preserved.decision.Frame(preserved.observation.Signatures, preserved.observation.Signatures, 1170);
                preserved.decision.Pointer(true, 1, true, 1200, preserved.observation.Signatures, preserved.observation.Signatures);
                preserved.TryApplySameIdentityReference(capture(1150), 1225); preserved.TryApplySameIdentityReference(capture(1150), 1230);
                if (preserved.observation.CapturedAt != 1000 || preserved.pressedRefreshesPreserved != 1 || preserved.sameIdentityRefreshes != 1)
                    throw new InvalidOperationException("Repeated cached captures replaced or double-counted a preserved press.");
                preserved.decision.Frame(preserved.observation.Signatures, preserved.observation.Signatures, 2801);
                if (!preserved.decision.Invalid) throw new InvalidOperationException("Preserving an OCR reference disabled the existing held-input deadline.");
                checks++;
            }
            return checks;
        }
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

    internal sealed class ScreenTitleAnchor
    {
        internal Rectangle Box;
        internal int[] Feature;
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
        internal ScreenTitleAnchor[][] TitleAnchors;
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
        { return TryReadCore(value, now, "armed", out observation); }

        internal static bool TryReadContinuation(Dictionary<string, object> value, long now, long clickedAt, out ScreenSelectionObservation observation)
        {
            observation = null;
            long suspendedAt, expiresAt;
            if (!Number(value, "suspendedAt", 1, long.MaxValue, out suspendedAt)
                || !Number(value, "expiresAt", now, long.MaxValue, out expiresAt)
                || clickedAt <= 0 || clickedAt > suspendedAt || now < suspendedAt || now - suspendedAt > 2500) return false;
            return TryReadCore(value, now, "leased", out observation);
        }

        private static bool TryReadCore(Dictionary<string, object> value, long now, string requiredStatus, out ScreenSelectionObservation observation)
        {
            observation = null;
            if (ModelValue.Text(value, "status") != requiredStatus || ModelValue.Text(value, "provider") != "screen"
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
            var identity = ModelValue.Object(capture, "identityAnchors");
            long identityVersion;
            if (ModelValue.Text(identity, "algorithm") != CardTitleIdentity.Algorithm
                || !Number(identity, "version", 1, 1, out identityVersion)) return false;
            var identityCards = ModelValue.Array(identity, "cards");
            if (identityCards.Count != 3) return false;
            var titleAnchors = new ScreenTitleAnchor[3][];
            for (int index = 0; index < 3; index++)
            {
                var card = identityCards[index] as Dictionary<string, object>;
                long column;
                if (!Number(card, "column", index, index, out column)) return false;
                var anchors = ModelValue.Array(card, "anchors");
                if (anchors.Count < 1 || anchors.Count > 2) return false;
                titleAnchors[index] = new ScreenTitleAnchor[anchors.Count];
                for (int line = 0; line < anchors.Count; line++)
                {
                    var anchor = anchors[line] as Dictionary<string, object>;
                    var box = ModelValue.Object(anchor, "box");
                    long x, y, anchorWidth, anchorHeight;
                    if (!Number(box, "x", 0, width, out x) || !Number(box, "y", 0, height, out y)
                        || !Number(box, "width", 8, width, out anchorWidth) || !Number(box, "height", 8, height, out anchorHeight)) return false;
                    Rectangle rectangle = new Rectangle((int)x, (int)y, (int)anchorWidth, (int)anchorHeight);
                    if (!boxes[index].Contains(rectangle)) return false;
                    var raw = ModelValue.Array(anchor, "feature");
                    if (raw.Count != 128) return false;
                    var feature = new int[128];
                    for (int cell = 0; cell < 128; cell++)
                    {
                        long number;
                        if (raw[cell] == null || raw[cell] is bool || !long.TryParse(Convert.ToString(raw[cell], CultureInfo.InvariantCulture), out number)
                            || number < 0 || number > 64) return false;
                        feature[cell] = (int)number;
                    }
                    if (!CardTitleIdentity.IsUsable(feature)) return false;
                    titleAnchors[index][line] = new ScreenTitleAnchor { Box = rectangle, Feature = feature };
                }
            }
            observation = new ScreenSelectionObservation { Token = token, GameId = gameId, Epoch = epoch, Revision = revision,
                CapturedAt = capturedAt, Window = new IntPtr(handle), ClientBounds = new Rectangle((int)originX, (int)originY, (int)width, (int)height),
                Regions = boxes, Signatures = signatures, TitleAnchors = titleAnchors, Ids = names };
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

        internal Dictionary<string, object> Evidence(ScreenSelectionDecision decision, long observedAt)
        {
            var result = Evidence(decision.SelectedIndex, decision.ClickedAt, observedAt,
                decision.DismissedFrames, decision.FeedbackFrames);
            if (decision.DirectComplete) result["evidence"] = decision.DirectEvidence();
            return result;
        }
    }

    // Deterministic state machine, independent of all real input and capture.
    // Thresholds are deliberately conservative and require real-match calibration.
    internal sealed class ScreenSelectionDecision
    {
        private int[][] preClick;
        private int[][] downImage;
        private long baselineFirstAt, baselineLastAt, directBaselineFirstAt, directBaselineLastAt;
        private long directLastSampleAt, directFirstTransitionAt;
        private int directFrames, directMaxGap;
        private bool directEligible;
        internal bool DirectComplete;
        private long invalidatedAt, pressedAt, lastFrameAt;
        private long witnessCapture, acceptedCapture;
        private string witnessIdentity;
        private string witnessState = "not-started";
        private int invalidations;
        private long referenceCapturedAt, lastDecisionAt, lastObservedFrameAt, readySince;
        private long lastReadyMs, longestReadyMs, lastRejectAt;
        private int frameGapMs, lastEdgeColumn = -1;
        private bool lastEdgeDown, metricsAvailable;
        private int maeFailureMask, closeFailureMask;
        private int[] closeCells = new int[3];
        private Dictionary<string, object> lastReject;
        private int pressedColumn = -1;
        internal int TitleIdentityPauses;
        internal bool Invalid, Ready, Pending, Complete;
        internal int BaselineFrames, FeedbackFrames, DismissedFrames, SelectedIndex = -1;
        internal long ClickedAt;
        internal double[] LastDelta = new double[3];
        internal bool Pressed { get { return pressedColumn >= 0 && !Pending; } }
        internal bool CanArm(long capturedAt)
        {
            return invalidatedAt == 0 ? capturedAt > 0 : capturedAt >= invalidatedAt + 2000 && capturedAt == acceptedCapture;
        }
        internal bool ConsiderCapture(long capturedAt, string identity)
        {
            if (invalidatedAt == 0) { witnessState = "unfenced"; return capturedAt > 0; }
            if (capturedAt < invalidatedAt + 2000) { witnessState = "before-settle-fence"; return false; }
            if (capturedAt <= witnessCapture) { witnessState = "capture-not-newer"; return false; }
            if (witnessIdentity != identity)
            {
                witnessIdentity = identity; witnessCapture = capturedAt;
                witnessState = "first-witness";
                return false;
            }
            if (capturedAt - witnessCapture < 300) { witnessState = "witness-too-close"; return false; }
            acceptedCapture = capturedAt;
            witnessState = "accepted";
            return true;
        }
        internal void Invalidate(long now)
        {
            EndReady(now);
            if (now > invalidatedAt)
            {
                invalidatedAt = now; witnessCapture = acceptedCapture = 0; witnessIdentity = null;
                invalidations = Math.Min(1000000, invalidations + 1);
                witnessState = "invalidated";
            }
            Invalid = true;
        }
        internal Dictionary<string, object> DiagnosticState(long now)
        {
            return new Dictionary<string, object> {
                { "invalid", Invalid }, { "invalidations", invalidations },
                { "invalidationAgeMs", ScreenSelectionWatcher.Age(now, invalidatedAt) },
                { "fenceRemainingMs", invalidatedAt <= 0 ? 0 : Math.Max(0, Math.Min(2000, invalidatedAt + 2000 - now)) },
                { "witnessCount", acceptedCapture > 0 ? 2 : witnessCapture > 0 ? 1 : 0 },
                { "witnessCaptureAgeMs", ScreenSelectionWatcher.Age(now, witnessCapture) },
                { "witnessState", witnessState },
                { "referenceAgeMs", ScreenSelectionWatcher.Age(now, referenceCapturedAt) },
                { "pressed", Pressed }, { "edgeDown", lastEdgeDown }, { "edgeColumn", lastEdgeColumn },
                { "holdAgeMs", !Pressed ? 0 : BoundedDuration(now, pressedAt, 2500) },
                { "frameGapMs", frameGapMs }, { "readyAgeMs", Ready && !Invalid ? BoundedDuration(now, readySince, 60000) : 0 },
                { "lastReadyMs", lastReadyMs }, { "longestReadyMs", Math.Max(longestReadyMs, Ready && !Invalid ? BoundedDuration(now, readySince, 60000) : 0) },
                { "titleIdentityPauses", TitleIdentityPauses },
                { "lastRejectAgeMs", ScreenSelectionWatcher.Age(now, lastRejectAt) },
                { "lastReject", lastReject == null ? null : CopyReject(lastReject) }
            };
        }
        internal void Reset() { Reset(lastDecisionAt); }
        internal void Reset(long now)
        {
            EndReady(now);
            Invalid = Ready = Pending = Complete = false;
            BaselineFrames = FeedbackFrames = DismissedFrames = 0;
            pressedColumn = SelectedIndex = -1; pressedAt = lastFrameAt = ClickedAt = 0;
            preClick = null; LastDelta = new double[3];
            downImage = null; DirectComplete = directEligible = false;
            baselineFirstAt = baselineLastAt = directBaselineFirstAt = directBaselineLastAt = 0;
            directLastSampleAt = directFirstTransitionAt = 0; directFrames = directMaxGap = 0;
            referenceCapturedAt = lastObservedFrameAt = 0;
            metricsAvailable = false; maeFailureMask = closeFailureMask = frameGapMs = 0;
            closeCells = new int[3];
            lastEdgeDown = false; lastEdgeColumn = -1;
        }
        internal void Arm(long capturedAt) { Arm(capturedAt, Math.Max(capturedAt, lastDecisionAt)); }
        internal void Arm(long capturedAt, long observedAt)
        {
            Reset(observedAt);
            referenceCapturedAt = capturedAt;
            if (!CanArm(capturedAt)) Reject("arm-reference-ineligible", observedAt);
        }
        internal void RefreshReference(long capturedAt)
        {
            if (capturedAt > referenceCapturedAt) referenceCapturedAt = capturedAt;
        }

        internal void Pointer(bool down, int column, bool onGame, long now, int[][] edgeFrame, int[][] baseline)
        { PointerCore(down, column, onGame, now, edgeFrame, baseline, false, false); }

        internal void PointerWithTitleIdentity(bool down, int column, bool onGame, long now, int[][] edgeFrame, int[][] baseline, bool titlesMatch)
        { PointerCore(down, column, onGame, now, edgeFrame, baseline, true, titlesMatch); }

        private void PointerCore(bool down, int column, bool onGame, long now, int[][] edgeFrame, int[][] baseline, bool titleMode, bool titlesMatch)
        {
            if (Invalid || Complete) return;
            NoteDecision(now, false);
            lastEdgeDown = down;
            lastEdgeColumn = column >= 0 && column <= 2 ? column : -1;
            if (!onGame) { Reject("pointer-not-game", now); return; }
            if (column < 0 || column > 2) { Reject("pointer-column-invalid", now); return; }
            if (!Valid(edgeFrame)) { Reject("pointer-invalid-current", now); return; }
            if (!Valid(baseline)) { Reject("pointer-invalid-reference", now); return; }
            // In title mode the card's body/border is permitted to animate or
            // change hue on hover. A real down edge must still identify all
            // three exact title anchors. The release may already show a closing
            // card, but must be over the same verified game/card and within the
            // original press deadline. No hover alone produces a click lease.
            if (titleMode)
            {
                if (down && !titlesMatch) { Reject("pointer-title-unverified", now); return; }
            }
            else if (!MeasurePanel(edgeFrame, baseline)) { Reject(PanelRejection("pointer-panel"), now); return; }
            if (down)
            {
                if (Pending) { Reject("pointer-down-pending", now); return; }
                if (!Ready) { Reject("pointer-down-not-ready", now); return; }
                if (preClick == null) { Reject("pointer-down-missing-frame", now); return; }
                if (now - lastFrameAt > 180) { Reject("pointer-down-stale-frame", now); return; }
                EndReady(now);
                pressedColumn = column; pressedAt = now; Ready = false;
                directBaselineFirstAt = baselineFirstAt; directBaselineLastAt = baselineLastAt;
                directEligible = titleMode && titlesMatch && baselineFirstAt > 0
                    && baselineFirstAt >= referenceCapturedAt && baselineLastAt - baselineFirstAt >= 40
                    && now > baselineLastAt && now - baselineLastAt <= 180;
                directLastSampleAt = baselineLastAt;
                directMaxGap = (int)Math.Max(0, Math.Min(180, baselineLastAt - baselineFirstAt));
                TrackDirectSample(now);
                downImage = Clone(edgeFrame);
            }
            else
            {
                if (pressedColumn != column) { Reject("pointer-up-column-mismatch", now); return; }
                if (now - pressedAt > 1500) { Reject("pointer-up-hold-timeout", now); return; }
                if (now <= pressedAt) { Reject("pointer-up-time-backward", now); return; }
                SelectedIndex = column; ClickedAt = now; Pending = true;
                TrackDirectSample(now);
                if (now - pressedAt > 500) directEligible = false;
            }
            // This is the frame captured at this actual button edge, not the
            // preceding timer frame. Release refresh also excludes held-hover FX.
            preClick = Clone(edgeFrame);
            lastFrameAt = now;
        }

        internal void Frame(int[][] current, int[][] baseline, long now)
        { FrameCore(current, baseline, now, false, 0); }

        internal void FrameWithTitleIdentity(int[][] current, int[][] baseline, long now, bool titlesMatch)
        { FrameCore(current, baseline, now, true, titlesMatch ? 7 : 0); }

        internal void FrameWithTitleIdentity(int[][] current, int[][] baseline, long now, int titleMask)
        { FrameCore(current, baseline, now, true, titleMask); }

        private void FrameCore(int[][] current, int[][] baseline, long now, bool titleMode, int titleMask)
        {
            if (Invalid || Complete) return;
            NoteDecision(now, true);
            if (!Valid(current)) { Reject("frame-invalid-current", now); return; }
            if (!Valid(baseline)) { Reject("frame-invalid-reference", now); return; }
            if (titleMode && (titleMask < 0 || titleMask > 7)) { Reject("frame-title-mask-invalid", now); return; }
            bool panelMatches = MeasurePanel(current, baseline);
            if (pressedColumn >= 0) TrackDirectSample(now);
            if (!Pending)
            {
                if (pressedColumn >= 0) { if (now - pressedAt > 1500) Reject("frame-hold-timeout", now); return; }
                if (titleMode && titleMask != 7)
                {
                    // A transient obstruction or title effect pauses input
                    // eligibility. It does not discard the offer or restart
                    // the expensive two-OCR settling sequence.
                    EndReady(now); Ready = false; BaselineFrames = 0;
                    preClick = null; lastFrameAt = 0;
                    baselineFirstAt = baselineLastAt = 0;
                    TitleIdentityPauses = Math.Min(1000000, TitleIdentityPauses + 1);
                    return;
                }
                if (!titleMode && !panelMatches) { Reject(PanelRejection("frame-preclick"), now); return; }
                BaselineFrames = Math.Min(1000, BaselineFrames + 1);
                if (titleMode)
                {
                    baselineFirstAt = baselineLastAt > 0 && now > baselineLastAt && now - baselineLastAt <= 180 ? baselineLastAt : 0;
                    baselineLastAt = now;
                }
                if (!Ready && BaselineFrames >= 2) readySince = now;
                Ready = BaselineFrames >= 2;
                preClick = Clone(current); lastFrameAt = now;
                return;
            }
            if (now < ClickedAt) { Reject("frame-pending-time-backward", now); return; }
            if (now - ClickedAt > 2500) { Reject("frame-pending-timeout", now); return; }
            if (now - ClickedAt <= 950 && UniqueFeedback(current, preClick, SelectedIndex)) FeedbackFrames = Math.Min(1000, FeedbackFrames + 1);
            // Body differences that were already present before the click
            // (hover, glow, refreshed OCR lighting) cannot mean dismissal.
            // In title mode every title must have disappeared, and all three
            // bodies must change relative to the actual release image.
            int[][] dismissalReference = titleMode ? preClick : baseline;
            bool gone = !titleMode || titleMask == 0;
            for (int index = 0; index < 3; index++)
                gone &= Difference(current[index], dismissalReference[index]) >= 18 && CloseFraction(current[index], dismissalReference[index]) <= .45;
            DismissedFrames = gone ? Math.Min(1000, DismissedFrames + 1) : 0;
            // Separate proof: an anchored physical card activation followed by
            // a continuous all-card transition. Mask zero alone is NOT absence
            // classification. Keep FX relative to release; compare this path
            // to down because the cards may already have closed at release.
            bool transitioned = titleMode && titleMask == 0 && downImage != null;
            for (int index = 0; transitioned && index < 3; index++)
                transitioned &= Difference(current[index], downImage[index]) >= 18
                    && CloseFraction(current[index], downImage[index]) <= .45;
            if (directEligible)
            {
                if (transitioned)
                {
                    if (directFirstTransitionAt == 0)
                    {
                        if (now - ClickedAt > 500) directEligible = false;
                        else directFirstTransitionAt = now;
                    }
                    directFrames++;
                }
                else if (directFirstTransitionAt > 0 || now - ClickedAt > 500) directEligible = false;
            }
            DirectComplete = directEligible && directFrames >= 5 && now - directFirstTransitionAt >= 350;
            Complete = FeedbackFrames > 0 && DismissedFrames >= 3 || DirectComplete;
        }

        private void TrackDirectSample(long now)
        {
            if (!directEligible) return;
            long gap = now - directLastSampleAt;
            if (gap <= 0 || gap > 180) directEligible = false;
            else { directMaxGap = Math.Max(directMaxGap, (int)gap); directLastSampleAt = now; }
        }

        internal Dictionary<string, object> DirectEvidence()
        {
            return new Dictionary<string, object> {
                { "version", 2 }, { "kind", "verified-click-transition" }, { "click", true },
                { "titleIdentity", true }, { "cardsTransitioned", true },
                { "baselineStartedAt", directBaselineFirstAt }, { "lastBaselineAt", directBaselineLastAt },
                { "pressedAt", pressedAt }, { "firstTransitionAt", directFirstTransitionAt },
                { "stableFrames", directFrames }, { "maxFrameGapMs", directMaxGap }
            };
        }

        internal static int ValidateDirectFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool value, string message) {
                checks++; if (!value) throw new InvalidOperationException("Verified card transition: " + message);
            };
            var before = new int[3][]; var after = new int[3][];
            for (int c = 0; c < 3; c++)
            {
                before[c] = new int[192]; after[c] = new int[192];
                for (int i = 0; i < 192; i++) { before[c][i] = 25; after[c][i] = 100; }
            }
            Func<bool, ScreenSelectionDecision> clicked = delegate(bool closedAtRelease) {
                var d = new ScreenSelectionDecision(); d.Arm(950);
                d.FrameWithTitleIdentity(before, before, 1000, 7);
                d.FrameWithTitleIdentity(before, before, 1070, 7);
                d.PointerWithTitleIdentity(true, 1, true, 1100, before, before, true);
                d.PointerWithTitleIdentity(false, 1, true, 1178, closedAtRelease ? after : before, before, !closedAtRelease);
                return d;
            };
            foreach (bool closed in new[] { false, true })
            {
                var d = clicked(closed);
                for (long at = 1240; at <= 1590; at += 70) d.FrameWithTitleIdentity(after, before, at, 0);
                check(d.Complete && d.DirectComplete && d.FeedbackFrames == 0, "no-FX activation/release transition did not complete");
                var proof = d.DirectEvidence();
                check((long)proof["pressedAt"] == 1100 && (long)proof["firstTransitionAt"] == 1240
                    && (int)proof["stableFrames"] == 6 && !proof.ContainsKey("uniqueFeedback"), "new proof manufactured FX or lost timing");
            }
            foreach (string fault in new[] { "duplicate", "backward", "gap", "title-return", "short", "late-onset", "body-present" })
            {
                var d = clicked(false);
                d.FrameWithTitleIdentity(after, before, 1240, 0);
                if (fault == "duplicate") d.FrameWithTitleIdentity(after, before, 1240, 0);
                if (fault == "backward") d.FrameWithTitleIdentity(after, before, 1230, 0);
                if (fault == "gap") d.FrameWithTitleIdentity(after, before, 1421, 0);
                if (fault == "title-return") d.FrameWithTitleIdentity(after, before, 1310, 1);
                if (fault == "short") d.FrameWithTitleIdentity(after, before, 1310, 0);
                if (fault == "late-onset" || fault == "body-present")
                {
                    d = clicked(false);
                    for (long at = 1240; at <= 1730; at += 70)
                        d.FrameWithTitleIdentity(fault == "body-present" ? before : after, before, at, fault == "late-onset" ? 7 : 0);
                }
                for (long at = fault == "gap" ? 1491 : fault == "late-onset" || fault == "body-present" ? 1800 : 1380;
                    at <= (fault == "short" ? 1520 : 2220); at += 70) d.FrameWithTitleIdentity(after, before, at, 0);
                check(!d.Complete, "unsafe transition accepted: " + fault);
            }
            var tooFew = clicked(false);
            foreach (long at in new long[] { 1240, 1360, 1480, 1590 }) tooFew.FrameWithTitleIdentity(after, before, at, 0);
            check(!tooFew.Complete, "four frames spanning 350ms bypassed minimum independent count");
            foreach (string fault in new[] { "unanchored", "baseline-gap", "baseline-duplicate", "down-gap", "up-gap", "long-hold", "wrong-release" })
            {
                var d = new ScreenSelectionDecision(); d.Arm(950);
                if (fault == "unanchored") { d.Frame(before, before, 1000); d.Frame(before, before, 1070); }
                else { d.FrameWithTitleIdentity(before, before, fault == "baseline-gap" ? 800 : 1000, 7);
                    d.FrameWithTitleIdentity(before, before, fault == "baseline-duplicate" ? 1000 : 1070, 7); }
                long down = fault == "down-gap" ? 1251 : 1100;
                d.PointerWithTitleIdentity(true, 1, true, down, before, before, true);
                if (fault == "long-hold") for (long at = 1170; at < 1601; at += 70) d.FrameWithTitleIdentity(before, before, at, 7);
                long up = fault == "up-gap" ? 1281 : fault == "long-hold" ? 1601 : down + 78;
                d.PointerWithTitleIdentity(false, fault == "wrong-release" ? 2 : 1, true, up, before, before, true);
                for (long at = up + 70; at <= up + 490; at += 70) d.FrameWithTitleIdentity(after, before, at, 0);
                check(!d.Complete, "invalid activation chain accepted: " + fault);
            }
            return checks;
        }

        private static long BoundedDuration(long now, long start, long maximum)
        {
            return start <= 0 ? 0 : Math.Max(0, Math.Min(maximum, now - start));
        }

        private void EndReady(long now)
        {
            if (readySince <= 0) return;
            lastReadyMs = BoundedDuration(now, readySince, 60000);
            longestReadyMs = Math.Max(longestReadyMs, lastReadyMs);
            readySince = 0;
        }

        private void NoteDecision(long now, bool frame)
        {
            lastDecisionAt = now;
            frameGapMs = (int)BoundedDuration(now, lastObservedFrameAt, 2500);
            if (frame) lastObservedFrameAt = now;
            metricsAvailable = false;
            maeFailureMask = closeFailureMask = 0;
            closeCells = new int[3];
        }

        private bool MeasurePanel(int[][] current, int[][] baseline)
        {
            metricsAvailable = true;
            for (int index = 0; index < 3; index++)
            {
                LastDelta[index] = Difference(current[index], baseline[index]);
                closeCells[index] = CloseCount(current[index], baseline[index]);
                if (LastDelta[index] > 10) maeFailureMask |= 1 << index;
                if (closeCells[index] / 64.0 < .78) closeFailureMask |= 1 << index;
            }
            return maeFailureMask == 0 && closeFailureMask == 0;
        }

        private string PanelRejection(string prefix)
        {
            return prefix + (maeFailureMask != 0 && closeFailureMask != 0 ? "-mae-close" : maeFailureMask != 0 ? "-mae" : "-close");
        }

        private void Reject(string code, long now)
        {
            lastRejectAt = now;
            lastReject = new Dictionary<string, object> {
                { "code", RejectionCode(code) }, { "referenceAgeMs", ScreenSelectionWatcher.Age(now, referenceCapturedAt) },
                { "frameGapMs", frameGapMs }, { "pressed", Pressed }, { "edgeDown", lastEdgeDown },
                { "edgeColumn", lastEdgeColumn }, { "holdAgeMs", !Pressed ? 0 : BoundedDuration(now, pressedAt, 2500) },
                { "pending", Pending }, { "ready", Ready }, { "readyAgeMs", BoundedDuration(now, readySince, 60000) },
                { "baselineFrames", BaselineFrames }, { "feedbackFrames", FeedbackFrames }, { "dismissedFrames", DismissedFrames },
                { "metricsAvailable", metricsAvailable }, { "maeFailureMask", maeFailureMask }, { "closeFailureMask", closeFailureMask },
                { "closeCells", (int[])closeCells.Clone() }
            };
            Invalidate(now);
        }

        private static string RejectionCode(string code)
        {
            switch (code)
            {
                case "arm-reference-ineligible":
                case "frame-invalid-current": case "frame-invalid-reference":
                case "frame-title-mask-invalid":
                case "frame-preclick-mae": case "frame-preclick-close": case "frame-preclick-mae-close":
                case "frame-hold-timeout": case "frame-pending-time-backward": case "frame-pending-timeout":
                case "pointer-not-game": case "pointer-column-invalid":
                case "pointer-invalid-current": case "pointer-invalid-reference":
                case "pointer-title-unverified":
                case "pointer-panel-mae": case "pointer-panel-close": case "pointer-panel-mae-close":
                case "pointer-down-pending": case "pointer-down-not-ready": case "pointer-down-missing-frame": case "pointer-down-stale-frame":
                case "pointer-up-column-mismatch": case "pointer-up-hold-timeout": case "pointer-up-time-backward": return code;
                default: return "decision-invalid";
            }
        }

        private static Dictionary<string, object> CopyReject(Dictionary<string, object> value)
        {
            var result = new Dictionary<string, object>(value);
            result["closeCells"] = ((int[])value["closeCells"]).Clone();
            return result;
        }

        // Size-bound fixture only. Each diagnostic field is filled to its
        // documented range; this is not claimed to be a possible game state.
        internal void PrepareMaximumDiagnosticFixture()
        {
            referenceCapturedAt = pressedAt = readySince = 1;
            lastEdgeColumn = pressedColumn = 2;
            lastEdgeDown = true; metricsAvailable = true;
            maeFailureMask = closeFailureMask = 7;
            closeCells = new[] { 64, 64, 64 };
            frameGapMs = 2500;
            BaselineFrames = FeedbackFrames = DismissedFrames = 1000;
            Ready = true; Pending = false;
            Reject("frame-pending-time-backward", 1000000);
            invalidations = 1000000; invalidatedAt = witnessCapture = acceptedCapture = 1;
            witnessIdentity = "synthetic-private-identity"; witnessState = "before-settle-fence";
            lastRejectAt = 1;
            lastReadyMs = longestReadyMs = 60000;
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
        private static int[][] Clone(int[][] source) { return new[] { (int[])source[0].Clone(), (int[])source[1].Clone(), (int[])source[2].Clone() }; }
        private static double Difference(int[] left, int[] right)
        {
            double sum = 0; for (int index = 0; index < 192; index++) sum += Math.Abs(left[index] - right[index]); return sum / 192;
        }
        private static double CloseFraction(int[] left, int[] right)
        {
            return CloseCount(left, right) / 64.0;
        }
        private static int CloseCount(int[] left, int[] right)
        {
            int close = 0;
            for (int cell = 0; cell < 64; cell++)
            {
                int offset = cell * 3;
                double delta = (Math.Abs(left[offset] - right[offset]) + Math.Abs(left[offset + 1] - right[offset + 1]) + Math.Abs(left[offset + 2] - right[offset + 2])) / 3.0;
                if (delta <= 12) close++;
            }
            return close;
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

        internal static int ValidateTitleIdentityFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool value, string message) { checks++; if (!value) throw new InvalidOperationException(message); };
            var baseline = new int[3][]; var hover = new int[3][]; var gone = new int[3][];
            for (int column = 0; column < 3; column++)
            {
                baseline[column] = new int[192]; hover[column] = new int[192]; gone[column] = new int[192];
                for (int cell = 0; cell < 192; cell++)
                {
                    baseline[column][cell] = 45 + column * 25;
                    hover[column][cell] = 110 + column * 25;
                    gone[column][cell] = 220;
                }
            }
            Func<ScreenSelectionDecision> armed = delegate {
                var state = new ScreenSelectionDecision(); state.Arm(1000);
                state.FrameWithTitleIdentity(baseline, baseline, 1100, true);
                state.FrameWithTitleIdentity(baseline, baseline, 1170, true);
                return state;
            };
            var legacy = new ScreenSelectionDecision(); legacy.Arm(1000); legacy.Frame(hover, baseline, 1100);
            check(legacy.Invalid, "Hover regression fixture does not exercise the old whole-card rejection.");
            var title = armed();
            title.FrameWithTitleIdentity(hover, baseline, 1240, true);
            check(title.Ready && !title.Invalid, "Body hover cancelled a valid title identity.");
            check(!title.Pending && !title.Complete, "Hover alone generated a synthetic selection.");
            title.PointerWithTitleIdentity(true, 1, true, 1260, hover, baseline, true);
            check(title.Pressed && !title.Invalid, "A verified title/card down edge was blocked by body hover.");
            title.PointerWithTitleIdentity(false, 1, true, 1300, hover, baseline, true);
            check(title.Pending && title.SelectedIndex == 1 && !title.Invalid, "Body hover blocked the same-column release.");
            title.FrameWithTitleIdentity(gone, baseline, 1370, false);
            title.FrameWithTitleIdentity(gone, baseline, 1440, false);
            title.FrameWithTitleIdentity(gone, baseline, 1510, false);
            check(!title.Complete, "Click and card disappearance bypassed independent confirmation evidence.");
            var hovering = armed();
            hovering.FrameWithTitleIdentity(hover, baseline, 1210, true);
            hovering.PointerWithTitleIdentity(true, 1, true, 1230, hover, baseline, true);
            hovering.PointerWithTitleIdentity(false, 1, true, 1280, hover, baseline, true);
            var briefLight = Clone(hover);
            for (int cell = 0; cell < 8 * 3; cell++) briefLight[1][cell] += 40;
            hovering.FrameWithTitleIdentity(briefLight, baseline, 1350, 7);
            hovering.FrameWithTitleIdentity(briefLight, baseline, 1420, 7);
            hovering.FrameWithTitleIdentity(briefLight, baseline, 1490, 7);
            check(hovering.FeedbackFrames > 0 && !hovering.Complete && hovering.DismissedFrames == 0,
                "Existing hover/body differences were mistaken for dismissal while titles remained visible.");
            hovering.FrameWithTitleIdentity(gone, baseline, 1560, 1);
            hovering.FrameWithTitleIdentity(gone, baseline, 1630, 1);
            hovering.FrameWithTitleIdentity(gone, baseline, 1700, 1);
            check(!hovering.Complete && hovering.DismissedFrames == 0, "A remaining visible title was mistaken for three dismissed cards.");
            hovering.FrameWithTitleIdentity(gone, baseline, 1770, 0);
            hovering.FrameWithTitleIdentity(gone, baseline, 1840, 0);
            hovering.FrameWithTitleIdentity(gone, baseline, 1910, 0);
            check(hovering.Complete, "Verified click/feedback and three independent fully-dismissed title frames did not complete.");
            var pause = armed();
            pause.FrameWithTitleIdentity(hover, baseline, 1240, false);
            check(!pause.Ready && !pause.Invalid && pause.TitleIdentityPauses == 1, "A temporary unreadable title hard-invalidated the offer.");
            check(Convert.ToInt32(pause.DiagnosticState(1250)["invalidations"]) == 0, "A temporary title obstruction restarted the OCR settling fence.");
            pause.FrameWithTitleIdentity(hover, baseline, 1310, true);
            check(!pause.Ready, "One independent recovered frame prematurely restored readiness.");
            pause.FrameWithTitleIdentity(hover, baseline, 1380, true);
            check(pause.Ready && !pause.Invalid, "Two recovered title frames failed to restore readiness.");
            var changed = armed(); changed.PointerWithTitleIdentity(true, 1, true, 1210, hover, baseline, false);
            check(changed.Invalid && !changed.Pending, "Changed/unverified title allowed a click lease.");
            var wrong = armed(); wrong.PointerWithTitleIdentity(true, 0, true, 1210, hover, baseline, true);
            wrong.PointerWithTitleIdentity(false, 2, true, 1250, hover, baseline, true);
            check(wrong.Invalid, "Cross-card drag was accepted by title mode.");
            var outside = armed(); outside.PointerWithTitleIdentity(true, 1, false, 1210, hover, baseline, true);
            check(outside.Invalid, "Another application's click was accepted by title mode.");
            var expired = armed(); expired.PointerWithTitleIdentity(true, 1, true, 1500, hover, baseline, true);
            check(expired.Invalid, "A stale native frame was accepted by title mode.");
            return checks;
        }

        private static int ValidateDecisionDiagnosticFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool pass, string message) { if (!pass) throw new InvalidOperationException(message); checks++; };
            Func<int, int[][]> flat = delegate(int value) {
                var rows = new[] { new int[192], new int[192], new int[192] };
                foreach (var row in rows) for (int i = 0; i < row.Length; i++) row[i] = value;
                return rows;
            };
            int[][] baseline = flat(25), bad = new[] { new int[1], new int[192], new int[192] };
            Func<ScreenSelectionDecision> ready = delegate {
                var state = new ScreenSelectionDecision(); state.Arm(1000); state.Frame(baseline, baseline, 1100); state.Frame(baseline, baseline, 1170); return state;
            };
            Action<ScreenSelectionDecision, string> rejected = delegate(ScreenSelectionDecision state, string code) {
                var failure = ModelValue.Object(state.DiagnosticState(5000), "lastReject");
                check(state.Invalid && ModelValue.Text(failure, "code") == code, "Decision rejection did not retain its exact fixed branch: " + code);
            };
            var maeImage = flat(25);
            for (int cell = 0; cell < 5; cell++) for (int channel = 0; channel < 3; channel++) maeImage[0][cell * 3 + channel] = 185;
            var mae = ready(); mae.Frame(maeImage, baseline, 1250); rejected(mae, "frame-preclick-mae");
            var maeFailure = ModelValue.Object(mae.DiagnosticState(1250), "lastReject");
            check((int)maeFailure["maeFailureMask"] == 1 && (int)maeFailure["closeFailureMask"] == 0
                && ((int[])maeFailure["closeCells"])[0] == 59 && Convert.ToInt64(maeFailure["referenceAgeMs"]) == 250
                && Convert.ToInt64(maeFailure["readyAgeMs"]) == 80 && !(bool)maeFailure["pressed"],
                "MAE-only failure did not retain bounded card counts and the actual reference/ready ages.");
            mae.RefreshReference(1300);
            check(mae.Invalid && ModelValue.Text(ModelValue.Object(mae.DiagnosticState(1350), "lastReject"), "code") == "frame-preclick-mae",
                "A reference update cleared a previous visual error.");
            ((int[])maeFailure["closeCells"])[0] = 0;
            mae.Reset(1400); mae.ConsiderCapture(3300, "same-private-context"); mae.ConsiderCapture(3700, "same-private-context");
            mae.Arm(3700, 3800); mae.Frame(baseline, baseline, 3900);
            var retained = ModelValue.Object(mae.DiagnosticState(3900), "lastReject");
            check(((int[])retained["closeCells"])[0] == 59 && Convert.ToInt64(retained["referenceAgeMs"]) == 250
                && ModelValue.Text(retained, "code") == "frame-preclick-mae",
                "Reset, a later valid frame, or mutation of an exported snapshot changed the frozen failure.");

            var closeImage = flat(25);
            var bothImage = flat(25);
            for (int cell = 0; cell < 15; cell++) for (int channel = 0; channel < 3; channel++) closeImage[0][cell * 3 + channel] = 38;
            for (int cell = 0; cell < 16; cell++) for (int channel = 0; channel < 3; channel++) bothImage[0][cell * 3 + channel] = 105;
            var close = ready(); close.Frame(closeImage, baseline, 1250); rejected(close, "frame-preclick-close");
            var both = ready(); both.Frame(bothImage, baseline, 1250); rejected(both, "frame-preclick-mae-close");
            var badCurrent = ready(); badCurrent.Frame(bad, baseline, 1250); rejected(badCurrent, "frame-invalid-current");
            var badReference = ready(); badReference.Frame(baseline, bad, 1250); rejected(badReference, "frame-invalid-reference");
            check(!(bool)ModelValue.Object(badReference.DiagnosticState(1300), "lastReject")["metricsAvailable"],
                "Malformed visual data reused metrics from an older valid frame.");
            var held = ready(); held.Pointer(true, 1, true, 1200, baseline, baseline); held.Frame(baseline, baseline, 2801); rejected(held, "frame-hold-timeout");
            var holdFailure = ModelValue.Object(held.DiagnosticState(2900), "lastReject");
            check((bool)holdFailure["pressed"] && (bool)holdFailure["edgeDown"] && (int)holdFailure["edgeColumn"] == 1
                && Convert.ToInt64(holdFailure["holdAgeMs"]) == 1601, "A held-button rejection lost its actual edge state.");
            var backward = ready(); backward.Pointer(true, 1, true, 1200, baseline, baseline); backward.Pointer(false, 1, true, 1250, baseline, baseline);
            backward.Frame(baseline, baseline, 1249); rejected(backward, "frame-pending-time-backward");
            var timeout = ready(); timeout.Pointer(true, 1, true, 1200, baseline, baseline); timeout.Pointer(false, 1, true, 1250, baseline, baseline);
            timeout.Frame(baseline, baseline, 3751); rejected(timeout, "frame-pending-timeout");
            check(!(bool)ModelValue.Object(timeout.DiagnosticState(3800), "lastReject")["pressed"], "Released mouse input was still reported as held during pending feedback.");

            var notGame = ready(); notGame.Pointer(true, 1, false, 1200, baseline, baseline); rejected(notGame, "pointer-not-game");
            var wrongColumn = ready(); wrongColumn.Pointer(true, 99, true, 1200, baseline, baseline); rejected(wrongColumn, "pointer-column-invalid");
            check((int)ModelValue.Object(wrongColumn.DiagnosticState(1300), "lastReject")["edgeColumn"] == -1, "A diagnostic column escaped its fixed range.");
            var pointerCurrent = ready(); pointerCurrent.Pointer(true, 1, true, 1200, bad, baseline); rejected(pointerCurrent, "pointer-invalid-current");
            var pointerReference = ready(); pointerReference.Pointer(true, 1, true, 1200, baseline, bad); rejected(pointerReference, "pointer-invalid-reference");
            var pointerMae = ready(); pointerMae.Pointer(true, 1, true, 1200, maeImage, baseline); rejected(pointerMae, "pointer-panel-mae");
            var pointerClose = ready(); pointerClose.Pointer(true, 1, true, 1200, closeImage, baseline); rejected(pointerClose, "pointer-panel-close");
            var pointerBoth = ready(); pointerBoth.Pointer(true, 1, true, 1200, bothImage, baseline); rejected(pointerBoth, "pointer-panel-mae-close");
            var pendingDown = ready(); pendingDown.Pointer(true, 1, true, 1200, baseline, baseline); pendingDown.Pointer(false, 1, true, 1250, baseline, baseline);
            pendingDown.Pointer(true, 1, true, 1300, baseline, baseline); rejected(pendingDown, "pointer-down-pending");
            var early = new ScreenSelectionDecision(); early.Arm(1000); early.Frame(baseline, baseline, 1100); early.Pointer(true, 1, true, 1150, baseline, baseline); rejected(early, "pointer-down-not-ready");
            var missing = ready(); missing.preClick = null; missing.Pointer(true, 1, true, 1200, baseline, baseline); rejected(missing, "pointer-down-missing-frame");
            var stale = ready(); stale.Pointer(true, 1, true, 1400, baseline, baseline); rejected(stale, "pointer-down-stale-frame");
            var crossed = ready(); crossed.Pointer(true, 0, true, 1200, baseline, baseline); crossed.Pointer(false, 1, true, 1250, baseline, baseline); rejected(crossed, "pointer-up-column-mismatch");
            var longUp = ready(); longUp.Pointer(true, 1, true, 1200, baseline, baseline); longUp.Pointer(false, 1, true, 2701, baseline, baseline); rejected(longUp, "pointer-up-hold-timeout");
            var backwardsUp = ready(); backwardsUp.Pointer(true, 1, true, 1200, baseline, baseline); backwardsUp.Pointer(false, 1, true, 1200, baseline, baseline); rejected(backwardsUp, "pointer-up-time-backward");

            var duration = ready(); duration.RefreshReference(1150);
            check(duration.Ready && Convert.ToInt64(duration.DiagnosticState(1300)["readyAgeMs"]) == 130, "Updating the reference restarted the continuous ready duration.");
            duration.Reset(1400);
            check(Convert.ToInt64(duration.DiagnosticState(1500)["lastReadyMs"]) == 230, "A reset lost the completed ready interval.");
            duration.Arm(1500, 1500); duration.Frame(baseline, baseline, 1600); duration.Frame(baseline, baseline, 1670);
            duration.Frame(baseline, baseline, 2050); duration.Pointer(true, 1, true, 2100, baseline, baseline);
            check(Convert.ToInt64(duration.DiagnosticState(2200)["longestReadyMs"]) == 430, "Ready intervals were added together or did not end at mouse-down.");
            check(!retained.ContainsKey("delta") && !retained.ContainsKey("signature") && !retained.ContainsKey("ids") && !retained.ContainsKey("reference"),
                "A rejection snapshot exposed image or identity data.");
            return checks;
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
            string occlusionCode;
            check(!ScreenSelectionWatcher.BlocksRelevantWindow(false, false, false, out occlusionCode) && occlusionCode == "captured",
                "DWM metadata failure for a nonoverlapping window blocked the cards.");
            check(ScreenSelectionWatcher.BlocksRelevantWindow(true, false, false, out occlusionCode) && occlusionCode == "occlusion-state-unavailable",
                "Unknown visibility for an overlapping window was treated as unoccluded.");
            check(ScreenSelectionWatcher.BlocksRelevantWindow(true, true, false, out occlusionCode) && occlusionCode == "card-occluded"
                && !ScreenSelectionWatcher.BlocksRelevantWindow(true, true, true, out occlusionCode),
                "Visible or cloaked overlapping windows were classified incorrectly.");
            var diagnosticDecision = new ScreenSelectionDecision(); diagnosticDecision.Invalidate(5000);
            diagnosticDecision.ConsiderCapture(7200, "sensitive-identity-must-not-be-exported"); diagnosticDecision.Reset();
            var fenceDiagnostics = diagnosticDecision.DiagnosticState(7300);
            check(Convert.ToInt32(fenceDiagnostics["witnessCount"]) == 1 && (string)fenceDiagnostics["witnessState"] == "first-witness"
                && Convert.ToInt64(fenceDiagnostics["witnessCaptureAgeMs"]) == 100,
                "Reset erased the first OCR witness or exported an incorrect witness age.");
            diagnosticDecision.ConsiderCapture(7600, "sensitive-identity-must-not-be-exported");
            check(Convert.ToInt32(diagnosticDecision.DiagnosticState(7700)["witnessCount"]) == 2
                && Convert.ToInt64(diagnosticDecision.DiagnosticState(1000000)["invalidationAgeMs"]) == 60000,
                "Two-capture readiness or bounded diagnostic age was reported incorrectly.");
            var safeBackend = ScreenSelectionWatcher.BackendDiagnostics(new Dictionary<string, object> {
                { "metadataStatus", "untrusted-sensitive-text" }, { "captureAgeMs", long.MaxValue },
                { "lastScanAgeMs", -2L }, { "backendArmed", "true" }, { "ids", new[] { "secret-id" } }
            });
            check(safeBackend.Count == 5 && (string)safeBackend["metadataStatus"] == "not-scanned"
                && (string)safeBackend["scanCode"] == "not-scanned"
                && Convert.ToInt64(safeBackend["captureAgeMs"]) == 60000 && safeBackend["lastScanAgeMs"] == null
                && !(bool)safeBackend["backendArmed"] && !safeBackend.ContainsKey("ids"),
                "Backend diagnostics copied unknown text, identity, unbounded ages, or nonboolean values.");
            using (var diagnosticWatcher = new ScreenSelectionWatcher())
            {
                diagnosticWatcher.RecordCaptureResult(false, "card-occluded", 1000);
                diagnosticWatcher.CancelForLocalAction();
                diagnosticWatcher.RecordCaptureResult(true, "ignored-private-text", 2000);
                var retained = diagnosticWatcher.Diagnostics();
                check((string)retained["lastFailureCode"] == "card-occluded" && (string)retained["lastCaptureCode"] == "captured"
                    && Convert.ToInt32(retained["captureFailures"]) == 1 && !retained.ContainsKey("delta")
                    && !retained.ContainsKey("ids") && !retained.ContainsKey("windowHandle") && !retained.ContainsKey("capture"),
                    "Reset or a later successful capture erased the last failure or exposed visual/identity metadata.");
                diagnosticWatcher.RecordCaptureResult(false, "untrusted-private-failure", 3000);
                check((string)diagnosticWatcher.Diagnostics()["lastFailureCode"] == "capture-exception",
                    "Unbounded failure text entered the diagnostic snapshot.");
            }
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
            var identityCards = new object[3];
            for (int index = 0; index < 3; index++)
            {
                var titleFeature = new int[128];
                for (int cell = 0; cell < 128; cell++) titleFeature[cell] = cell % 2 == 0 ? 0 : 8;
                identityCards[index] = new Dictionary<string, object> { { "column", index }, { "anchors", new object[] {
                    new Dictionary<string, object> { { "box", new Dictionary<string, object> {
                        { "x", 430 + index * 384 }, { "y", 350 }, { "width", 180 }, { "height", 30 }
                    } }, { "feature", new ArrayList(titleFeature) } }
                } } };
            }
            ModelValue.Object(metadata, "capture")["identityAnchors"] = new Dictionary<string, object> {
                { "version", 1 }, { "algorithm", CardTitleIdentity.Algorithm }, { "frameId", "synthetic-only" },
                { "pass", "card-titles-color" }, { "cards", identityCards }
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
            metadata["status"] = "leased"; metadata["suspendedAt"] = 1300L; metadata["expiresAt"] = 16000L;
            check(ScreenSelectionObservation.TryReadContinuation(metadata, 1400, 1250, out parsed), "An already released click could not continue across an unreadable OCR result.");
            check(!ScreenSelectionObservation.TryRead(metadata, 1400, out parsed), "A suspended result lease was re-armed for a new click.");
            check(!ScreenSelectionObservation.TryReadContinuation(metadata, 1400, 1301, out parsed), "A click after suspension used a continuation lease.");
            check(!ScreenSelectionObservation.TryReadContinuation(metadata, 3900, 1250, out parsed), "Expired pending-animation continuation was accepted.");
            return checks + ValidateDecisionDiagnosticFixtures();
        }
    }
}
