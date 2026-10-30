using System;
using System.Drawing;

namespace HexGuide.Desktop
{
    internal sealed partial class ScreenSelectionWatcher
    {
        private readonly SelectionFrameSynchronizer windowInput = new SelectionFrameSynchronizer();
        private WindowSelectionSource windowSource = new WindowSelectionSource();
        private long windowFrameTimestamp, windowFallbackUntil, windowWaitingSince;
        private string windowScope;
        private Rectangle windowClient;
        private IntPtr windowHandle;
        private bool windowTransportActive;

        private void ResetWindowSelection()
        {
            windowFrameTimestamp = windowSource.QpcTicks();
            windowInput.Reset(windowFrameTimestamp);
            windowWaitingSince = 0;
        }

        // The window surface is independent of desktop overlays. Every input
        // edge still needs a distinct, newer pixel witness and the original
        // title/transition proof; no cached frame becomes a fresh observation.
        private bool PollWindowSelection(IntPtr foreground, long now)
        {
            if (now < windowFallbackUntil) return false;
            Rectangle bounds;
            if (!windowSource.ClientBounds(foreground, out bounds))
            { CancelEarly("capture-unavailable", now, "client-unavailable"); return true; }
            if (windowScope != early.ScopeIdentity || windowHandle != foreground || windowClient != bounds)
            {
                bool hadGeometry = windowHandle != IntPtr.Zero;
                windowScope = early.ScopeIdentity; windowHandle = foreground; windowClient = bounds;
                windowTransportActive = false;
                ResetWindowSelection();
                if (hadGeometry && early.FrameCount > 0) CancelEarly("geometry-changed", now);
                earlyButtonKnown = false;
            }
            if (!early.NeedsFrames) { PublishEarly(now); return true; }
            var geometry = EarlySelectionReplay.Geometry(foreground, bounds);
            if (!windowTransportActive)
            {
                // Keep the established synchronous path when the game pixels
                // are clear. Window capture is the overlay compatibility path.
                string obstruction;
                if (!earlyCaptureRetry.Due(now, false) || windowSource.Unoccluded(geometry, out obstruction)) return false;
                windowTransportActive = true;
                if (early.RestartCaptureSource(geometry, now))
                { ResetWindowSelection(); ApplyEarlyCaptureCadence(now); SetStatus(EarlyWatcherStatus); }
                else CancelEarly("capture-unavailable", now, obstruction);
                earlyButtonKnown = false;
            }
            long inputTimestamp = windowSource.QpcTicks();
            bool down = windowSource.ButtonDown();
            bool released = !down && (early.ClickedAt > 0 || windowInput.HasReleasedPhysical);
            if ((down || early.HasInteraction || windowInput.HasPressedPhysical)
                && SelectionInterrupted(windowSource.KeyDown, released))
            { CancelEarly("interaction-interrupted", now); earlyButtonKnown = false; return true; }
            if (!earlyButtonKnown)
            {
                earlyButtonKnown = true; earlyLastDown = down;
                if (down) { CancelEarly("held-before-observation", now); return true; }
            }
            bool edge = down != earlyLastDown;
            earlyLastDown = down;
            string failure;
            if (edge)
            {
                int column = windowSource.CursorColumn(foreground, geometry);
                if (column < 0)
                { CancelEarly("outside-click", now); return true; }
                if (!windowInput.EnqueueEdge(down, column, now, inputTimestamp, out failure))
                { CancelEarly("interaction-interrupted", now, "visual-evidence-incomplete"); return true; }
            }
            if (!windowInput.CheckDeadline(inputTimestamp, out failure))
            { CancelEarly("visual-evidence-incomplete", now); return true; }
            if (!early.WantsFrame(now)) { PublishEarly(now); return true; }
            if (!earlyCaptureRetry.Due(now, edge || windowInput.HasPendingEdges))
            { PublishEarly(now); return true; }

            GameWindowCaptureFrame captured;
            if (!windowSource.TryRead(foreground, bounds, geometry.Regions, windowFrameTimestamp,
                out captured, out failure))
            {
                if (GameWindowCapture.IsWaiting(failure))
                {
                    if (windowWaitingSince == 0) windowWaitingSince = now;
                    if (now >= windowWaitingSince && now - windowWaitingSince < 2000)
                    { PublishEarly(now); return true; }
                    failure = "window-capture-unavailable";
                }
                RecordCaptureResult(false, CaptureFailureCode(failure), now);
                earlyCaptureRetry.Completed(false, failure, now, now);
                CancelEarly("capture-unavailable", now, CaptureFailureCode(failure));
                if (GameWindowCapture.CanUseDesktopFallback(failure))
                {
                    windowFallbackUntil = now + 5000;
                    windowTransportActive = false;
                    earlyButtonKnown = false;
                    return false; // Existing desktop path retains all occlusion checks.
                }
                return true;
            }
            using (captured)
            {
                windowWaitingSince = 0;
                long completed = windowSource.CompletedAt();
                windowFrameTimestamp = captured.FrameTimestamp;
                SelectionFrameMatch match;
                SelectionFrameMatchKind kind = windowInput.MatchFrame(captured.FrameTimestamp,
                    captured.CapturedAtUtcMs, windowSource.QpcTicks(), out match, out failure);
                if (kind == SelectionFrameMatchKind.Failed)
                { CancelEarly("visual-evidence-incomplete", completed); return true; }
                if (kind == SelectionFrameMatchKind.Ignored) { PublishEarly(completed); return true; }
                var frame = EarlySelectionFrame.Create(geometry);
                try
                {
                    frame.At = captured.CapturedAtUtcMs;
                    frame.PointerAt = match.PointerAt;
                    for (int i = 0; i < 3; i++) frame.ReadCard(captured.Regions[i], i);
                }
                catch { frame.Dispose(); throw; }
                RecordCaptureResult(true, "captured", completed);
                earlyCaptureRetry.Completed(true, "captured", now, completed);
                int frameKind = kind == SelectionFrameMatchKind.PointerDown ? 1
                    : kind == SelectionFrameMatchKind.PointerUp ? 2 : 0;
                bool wasInteracting = early.HasInteraction;
                if (!early.Add(frame, frameKind, match.Column, completed)) ResetWindowSelection();
                PublishEarly(completed);
                if ((wasInteracting || frameKind != 0) && !early.HasInteraction) ResetWindowSelection();
            }
            return true;
        }

        // External observations only. The caller above owns all ordering,
        // cancellation and frame/input joining; offline fixtures replace these
        // reads without reimplementing that selection pipeline.
        private class WindowSelectionSource
        {
            internal virtual long QpcTicks() { return GameWindowCapture.QpcTicks(); }
            internal virtual long CompletedAt() { return Now(); }
            internal virtual bool ClientBounds(IntPtr window, out Rectangle bounds)
            { return ScreenSelectionWatcher.ClientBounds(window, out bounds); }
            internal virtual bool ButtonDown() { return ScreenSelectionWatcher.ButtonDown(); }
            internal virtual bool KeyDown(int key) { return ScreenSelectionWatcher.KeyDown(key); }
            internal virtual bool Unoccluded(ScreenSelectionObservation geometry, out string obstruction)
            { return ScreenSelectionWatcher.Unoccluded(geometry, out obstruction); }
            internal virtual int CursorColumn(IntPtr foreground, ScreenSelectionObservation geometry)
            {
                PhysicalPoint point;
                bool onGame = GetPhysicalCursorPos(out point) && RootWindow(WindowFromPhysicalPoint(point)) == foreground;
                return onGame ? geometry.ColumnAt(point.X, point.Y) : -1;
            }
            internal virtual bool TryRead(IntPtr window, Rectangle bounds, Rectangle[] regions, long after,
                out GameWindowCaptureFrame frame, out string failure)
            { return GameWindowCapture.Shared.TryRead(window, bounds, regions, after, out frame, out failure); }
        }

        private static string CaptureFailureCode(string code)
        {
            switch (code)
            {
                case "game-not-foreground": case "game-not-visible": case "game-unverified":
                case "client-changed": case "client-unavailable": case "region-too-large": return code;
                default: return "capture-exception";
            }
        }

        private sealed class WindowSelectionFixtureSource : WindowSelectionSource
        {
            internal long At, PixelAt, GoneAt = long.MaxValue;
            internal bool Down, Clear;
            internal string Failure;
            internal int Reads;
            internal System.Collections.Generic.Dictionary<string, object> Scope = RetryFixtureScope();
            internal override long QpcTicks() { return At * TimeSpan.TicksPerMillisecond; }
            internal override long CompletedAt() { return At; }
            internal override bool ClientBounds(IntPtr window, out Rectangle bounds)
            { bounds = new Rectangle(0, 0, 800, 600); return true; }
            internal override bool ButtonDown() { return Down; }
            internal override bool KeyDown(int key) { return false; }
            internal override bool Unoccluded(ScreenSelectionObservation geometry, out string obstruction)
            { obstruction = Clear ? "captured" : "card-occluded"; return Clear; }
            internal override int CursorColumn(IntPtr foreground, ScreenSelectionObservation geometry) { return 1; }
            internal override bool TryRead(IntPtr window, Rectangle bounds, Rectangle[] regions, long after,
                out GameWindowCaptureFrame frame, out string failure)
            {
                Reads++; frame = null; failure = Failure ?? "window-frame-pending";
                long timestamp = PixelAt * TimeSpan.TicksPerMillisecond;
                if (Failure != null || PixelAt <= 0 || timestamp <= after) return false;
                bool visible = PixelAt < GoneAt;
                frame = new GameWindowCaptureFrame(null, timestamp, PixelAt, 1, Reads, 3);
                using (var generated = RetryBurstFixtureFrame(visible))
                {
                    for (int column = 0; column < 3; column++)
                    {
                        Rectangle region = generated.Geometry.Regions[column];
                        var bitmap = new Bitmap(region.Width, region.Height);
                        frame.Regions[column] = bitmap;
                        using (var graphics = Graphics.FromImage(bitmap))
                        {
                            graphics.Clear(visible ? Color.Black : Color.FromArgb(100, 100, 100));
                            graphics.DrawImageUnscaled(generated.TitleBands[column],
                                generated.TitleBoxes[column].X - region.X, generated.TitleBoxes[column].Y - region.Y);
                        }
                    }
                }
                failure = "captured"; return true;
            }
            internal bool Poll(ScreenSelectionWatcher watcher, long now, bool down = false, long pixelAt = 0)
            {
                At = now; Down = down; PixelAt = pixelAt;
                watcher.UpdateEarlyObservationScope(Scope, now, now, false);
                return watcher.PollWindowSelection(new IntPtr(42), now);
            }
        }

        // Drive the production window caller, including its real ReadCard,
        // synchronizer, reference binding and proof publication. Only native
        // observations are replaced; no user window or pixels are inspected.
        private static int ValidateQueuedWindowReferenceFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { checks++; if (!condition) throw new InvalidOperationException("Queued window reference: " + message); };
            Func<ScreenSelectionWatcher, bool, WindowSelectionFixtureSource> prepare = delegate(ScreenSelectionWatcher watcher, bool bindReference)
            {
                var source = new WindowSelectionFixtureSource(); watcher.windowSource = source;
                check(source.Poll(watcher, 1000), "occluded fixture did not enter window capture");
                watcher.CheckEarlyFocus(true, 1000);
                if (bindReference) watcher.BindEarlyReference(RetryBurstFixtureReference(1000), 1000, false);
                source.Poll(watcher, 1025, false, 1020);
                source.Poll(watcher, 1100, false, 1090);
                source.Poll(watcher, 1125, true);
                check(watcher.windowInput.HasPressedPhysical && watcher.windowInput.PressedAt == 1125
                    && watcher.windowInput.HasPendingEdges && !watcher.early.HasInteraction,
                    "fixture did not queue a physical press ahead of its pixel witness");
                return source;
            };

            foreach (string refresh in new[] { "none", "post-press", "pre-press" })
            foreach (bool mayStartFast in new[] { false, true })
            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = prepare(watcher, true); source.GoneAt = 1180;
                int proofs = 0; long emittedAt = 0;
                watcher.SelectionObserved += delegate { proofs++; emittedAt = source.At; };
                if (refresh != "none") watcher.BindEarlyReference(
                    RetryBurstFixtureReference(refresh == "post-press" ? 1130 : 1010), 1140, mayStartFast);
                long expectedReference = refresh == "pre-press" ? 1010 : 1000;
                check(watcher.early.ReferenceCapturedAt == expectedReference,
                    refresh + " OCR replaced or blocked the pre-press reference while down pixels were pending");
                source.Poll(watcher, 1150, true, 1145);
                check(watcher.early.HasInteraction && watcher.early.ReferenceCapturedAt == expectedReference
                    && !watcher.windowInput.HasPendingEdges && proofs == 0,
                    "delayed down witness lost the valid interaction after an OCR refresh");
                source.Poll(watcher, 1175, false);
                source.Poll(watcher, 1200, false, 1180);
                for (long now = 1275; now <= 1725; now += 75) source.Poll(watcher, now, false, now - 10);
                check(proofs == 1 && emittedAt >= 1625,
                    refresh + " OCR did not produce exactly one proof after the full dismissal window");
            }

            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = prepare(watcher, false);
                watcher.BindEarlyReference(RetryBurstFixtureReference(1010), 1140, true);
                check(watcher.early.ReferenceCapturedAt == 1010,
                    "a late-delivered pre-press OCR reference was blocked");
                source.Poll(watcher, 1150, true, 1145);
                check(watcher.early.HasInteraction && watcher.early.ReferenceCapturedAt == 1010,
                    "late pre-press OCR could not establish the queued interaction");
            }

            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = prepare(watcher, true);
                source.Scope = RetryFixtureScope(); source.Scope["revision"] = 4;
                source.Scope["captureRevision"] = 6; source.Scope["notBefore"] = 1130;
                watcher.UpdateEarlyObservationScope(source.Scope, 1140, 1140, false);
                check(watcher.windowScope != watcher.early.ScopeIdentity && watcher.windowInput.HasPendingEdges,
                    "fixture did not retain an old-scope edge before the next window poll");
                var reference = RetryBurstFixtureReference(1135); reference.Revision = 4;
                watcher.BindEarlyReference(reference, 1140, true);
                check(watcher.early.ReferenceCapturedAt == 1135 && !watcher.early.HasInteraction,
                    "an old-scope queued press blocked the new scope's reference");
                source.Poll(watcher, 1150);
                check(!watcher.windowInput.HasPressedPhysical && !watcher.windowInput.HasPendingEdges,
                    "new-scope window poll retained the previous scope's physical input");
            }

            foreach (bool localAction in new[] { false, true })
            using (var watcher = new ScreenSelectionWatcher())
            {
                prepare(watcher, true);
                long now = 1140;
                if (localAction) { watcher.CancelForLocalAction(); now = Now(); }
                else watcher.CheckEarlyFocus(false, now);
                check(!watcher.windowInput.HasPendingEdges && !watcher.windowInput.HasPressedPhysical
                    && watcher.windowInput.PressedAt == 0 && !watcher.early.HasInteraction,
                    (localAction ? "manual action" : "focus loss") + " retained the pending physical-press fence");
                watcher.BindEarlyReference(RetryBurstFixtureReference(1130), now, false);
                check(watcher.early.ReferenceCapturedAt == 0, "reset accepted an OCR reference captured before cancellation");
                watcher.UpdateEarlyObservationScope(RetryFixtureScope(), now, now, false);
                watcher.BindEarlyReference(RetryBurstFixtureReference(now), now, true);
                check(watcher.early.ReferenceCapturedAt == now,
                    "reset physical-press fence blocked a fresh reference");
            }

            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = new WindowSelectionFixtureSource { Clear = true }; watcher.windowSource = source;
                check(!source.Poll(watcher, 1000) && !watcher.windowTransportActive && source.Reads == 0,
                    "clear desktop unnecessarily started window capture");
            }
            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = prepare(watcher, true);
                source.Clear = true;
                source.Poll(watcher, 1150, true, 1145);
                check(watcher.windowTransportActive && watcher.early.HasInteraction,
                    "clearing an overlay discarded the current window-capture proof");
                source.Failure = "window-capture-unavailable";
                check(!source.Poll(watcher, 1225, true) && !watcher.windowTransportActive
                    && watcher.windowFallbackUntil == 6225 && !watcher.windowInput.HasPressedPhysical,
                    "capture failure did not clear pending input before desktop fallback");
            }
            return checks + ValidateWindowActivationFixtures();
        }

        private static int ValidateWindowActivationFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { checks++; if (!condition) throw new InvalidOperationException("Window capture activation: " + message); };
            Action<ScreenSelectionWatcher, long, int> buffer = delegate(ScreenSelectionWatcher watcher, long at, int kind)
            {
                var frame = RetryBurstFixtureFrame(); frame.At = at;
                check(watcher.early.Add(frame, kind, kind == 0 ? -1 : 1, at), "pre-activation witness was not buffered");
            };
            foreach (bool bindBeforeActivation in new[] { true, false })
            foreach (bool oldBaseline in new[] { false, true })
            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = new WindowSelectionFixtureSource { GoneAt = 1180 }; watcher.windowSource = source;
                watcher.UpdateEarlyObservationScope(source.Scope, 950, 950, false);
                if (bindBeforeActivation) watcher.BindEarlyReference(RetryBurstFixtureReference(950), 990, false);
                if (oldBaseline) { buffer(watcher, 960, 0); buffer(watcher, 985, 0); }
                int proofs = 0; long emittedAt = 0;
                watcher.SelectionObserved += delegate { proofs++; emittedAt = source.At; };
                source.Poll(watcher, 1000);
                check(watcher.early.FrameCount == 0 && !watcher.early.HasInteraction,
                    "switching capture source retained the previous source's baseline");
                if (!bindBeforeActivation) watcher.BindEarlyReference(RetryBurstFixtureReference(950), 1010, true);
                check(watcher.early.ReferenceCapturedAt == 950,
                    "idle source activation discarded or fenced a valid pre-activation OCR reference");
                source.Poll(watcher, 1025, false, 1020);
                source.Poll(watcher, 1100, false, 1090);
                source.Poll(watcher, 1125, true);
                source.Poll(watcher, 1150, true, 1145);
                source.Poll(watcher, 1175, false);
                source.Poll(watcher, 1200, false, 1180);
                for (long now = 1275; now <= 1725; now += 75) source.Poll(watcher, now, false, now - 10);
                check(proofs == 1 && emittedAt >= 1625,
                    "pre-activation OCR could not prove a complete click using fresh window frames");
                watcher.windowTransportActive = false;
                source.Poll(watcher, 1800);
                check(watcher.early.WatcherStatus == "observed" && proofs == 1,
                    "capture-source activation rearmed an already emitted selection");
            }

            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = new WindowSelectionFixtureSource(); watcher.windowSource = source;
                watcher.UpdateEarlyObservationScope(source.Scope, 1000, 1000, false);
                watcher.BindEarlyReference(RetryBurstFixtureReference(950), 1000, false);
                buffer(watcher, 1020, 0); buffer(watcher, 1090, 0); buffer(watcher, 1125, 1);
                source.Poll(watcher, 1130, true);
                watcher.BindEarlyReference(RetryBurstFixtureReference(950), 1140, false);
                check(!watcher.early.HasInteraction && watcher.early.ReferenceCapturedAt == 0,
                    "source activation resumed an interaction from the previous capture source");
            }

            foreach (string reset in new[] { "focus", "manual", "scope" })
            using (var watcher = new ScreenSelectionWatcher())
            {
                long now = reset == "manual" ? Now() : 1000;
                var source = new WindowSelectionFixtureSource { At = now }; watcher.windowSource = source;
                watcher.UpdateEarlyObservationScope(source.Scope, now, now, false);
                var reference = RetryBurstFixtureReference(now - 10);
                watcher.BindEarlyReference(reference, now, false);
                if (reset == "manual") { watcher.CancelForLocalAction(); now = Now(); }
                else if (reset == "focus") { watcher.CheckEarlyFocus(true, now); watcher.CheckEarlyFocus(false, now); }
                else { source.Scope["revision"] = 4; source.Scope["captureRevision"] = 6; }
                source.Poll(watcher, now + 1);
                watcher.BindEarlyReference(reference, now + 2, false);
                check(watcher.early.ReferenceCapturedAt == 0 && !watcher.early.HasInteraction,
                    reset + " cancellation was bypassed during idle source activation");
            }
            foreach (string invalid in new[] { "geometry", "reference-expired", "scope-expired" })
            using (var watcher = new ScreenSelectionWatcher())
            {
                var source = new WindowSelectionFixtureSource(); watcher.windowSource = source;
                watcher.UpdateEarlyObservationScope(source.Scope, 1000, 1000, false);
                var reference = RetryBurstFixtureReference(1000);
                if (invalid == "geometry") reference.Window = new IntPtr(43);
                watcher.BindEarlyReference(reference, 1000, false);
                check(watcher.early.ReferenceCapturedAt == 1000, "invalid-activation control never bound its initial reference");
                long activationAt = invalid == "geometry" ? 1100 : 2101;
                if (invalid == "reference-expired")
                {
                    // Keep the scope lease alive independently of OCR, so this
                    // control tests reference age rather than scope expiry.
                    for (long now = 1500; now <= 6000; now += 500)
                        watcher.UpdateEarlyObservationScope(source.Scope, now, now, false);
                    activationAt = 6001;
                }
                source.Poll(watcher, activationAt);
                check(watcher.early.ReferenceCapturedAt == 0 && !watcher.early.HasInteraction,
                    invalid + " reference survived capture-source activation");
            }
            return checks;
        }
    }
}
