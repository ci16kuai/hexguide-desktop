using System;
using System.Collections.Generic;

namespace HexGuide.Desktop
{
    internal enum SelectionFrameMatchKind
    {
        Ignored,
        Independent,
        PointerDown,
        PointerUp,
        Failed
    }

    internal sealed class SelectionFrameMatch
    {
        internal SelectionFrameMatchKind Kind;
        internal long FrameTimestamp, CapturedAt, PointerAt;
        internal int Column = -1;
    }

    // Pure input/frame join. All *Timestamp values use WGC SystemRelativeTime's
    // 100 ns QPC units, not Stopwatch counter units or wall-clock milliseconds.
    // Pixel timestamps are never replaced with input or delivery timestamps.
    // The caller keeps sampling physical input while waiting for a frame, and
    // resets this join with a new QPC fence on every scope/focus/geometry loss.
    internal sealed class SelectionFrameSynchronizer
    {
        internal const int MaximumEdgeDelayMs = 100;
        private const long MaximumEdgeDelayTicks = MaximumEdgeDelayMs * TimeSpan.TicksPerMillisecond;
        private sealed class Edge
        {
            internal bool Down;
            internal int Column;
            internal long At, Timestamp;
        }

        private readonly Queue<Edge> edges = new Queue<Edge>(2);
        private long notBeforeTimestamp, lastFrameTimestamp, lastPointerTimestamp, lastPointerAt, pressedAt;
        private int pressedColumn = -1;
        private bool pressedPhysical, releasedPhysical;
        private string failed;

        internal bool HasPendingEdges { get { return edges.Count != 0; } }
        internal int PendingCount { get { return edges.Count; } }
        internal bool HasPressedPhysical { get { return pressedPhysical; } }
        internal bool HasReleasedPhysical { get { return releasedPhysical; } }
        internal long PressedAt { get { return pressedAt; } }
        internal bool Failed { get { return failed != null; } }

        internal void Reset(long notBeforeFrameTimestamp)
        {
            edges.Clear();
            notBeforeTimestamp = Math.Max(0, notBeforeFrameTimestamp);
            lastFrameTimestamp = lastPointerTimestamp = lastPointerAt = pressedAt = 0;
            pressedColumn = -1; pressedPhysical = releasedPhysical = false; failed = null;
        }

        internal bool EnqueueEdge(bool down, int column, long pointerAtUtcMs, long pointerTimestamp, out string failure)
        {
            failure = failed;
            if (failed != null) return false;
            if (column < 0 || column > 2) return Reject("pointer-column-invalid", out failure);
            if (pointerAtUtcMs <= 0 || pointerTimestamp <= 0 || pointerTimestamp < notBeforeTimestamp
                || pointerTimestamp < lastFrameTimestamp || pointerTimestamp <= lastPointerTimestamp
                || pointerAtUtcMs <= lastPointerAt)
                return Reject("pointer-time-invalid", out failure);
            if (edges.Count >= 2) return Reject("pointer-queue-full", out failure);
            if (down && pressedPhysical) return Reject("extra-click", out failure);
            if (!down && (!pressedPhysical || releasedPhysical || column != pressedColumn))
                return Reject("release-unpaired", out failure);
            if (down) { pressedPhysical = true; pressedColumn = column; pressedAt = pointerAtUtcMs; }
            else releasedPhysical = true;
            edges.Enqueue(new Edge { Down = down, Column = column, At = pointerAtUtcMs, Timestamp = pointerTimestamp });
            lastPointerTimestamp = pointerTimestamp; lastPointerAt = pointerAtUtcMs;
            return true;
        }

        internal bool CheckDeadline(long nowTimestamp, out string failure)
        {
            failure = failed;
            if (failed != null) return false;
            if (edges.Count == 0) return true;
            long first = edges.Peek().Timestamp;
            if (nowTimestamp < first) return Reject("frame-clock-backward", out failure);
            if (nowTimestamp - first > MaximumEdgeDelayTicks) return Reject("edge-frame-timeout", out failure);
            return true;
        }

        internal SelectionFrameMatchKind MatchFrame(long frameTimestamp, long capturedAtUtcMs, long nowTimestamp,
            out SelectionFrameMatch match, out string failure)
        {
            match = null;
            if (!CheckDeadline(nowTimestamp, out failure)) return SelectionFrameMatchKind.Failed;
            if (frameTimestamp <= 0 || capturedAtUtcMs <= 0 || frameTimestamp > nowTimestamp)
            { Reject("frame-time-invalid", out failure); return SelectionFrameMatchKind.Failed; }
            if (frameTimestamp < notBeforeTimestamp)
            { failure = "frame-before-fence"; return SelectionFrameMatchKind.Ignored; }
            if (frameTimestamp <= lastFrameTimestamp)
            { failure = "frame-duplicate"; return SelectionFrameMatchKind.Ignored; }
            // Also consume frames that are too old for the pending edge. They
            // cannot later be counted as a baseline or another edge witness.
            lastFrameTimestamp = frameTimestamp;
            if (edges.Count == 0)
            {
                match = new SelectionFrameMatch { Kind = SelectionFrameMatchKind.Independent,
                    FrameTimestamp = frameTimestamp, CapturedAt = capturedAtUtcMs };
                return match.Kind;
            }
            Edge edge = edges.Peek();
            if (frameTimestamp < edge.Timestamp || capturedAtUtcMs < edge.At)
            { failure = "frame-before-edge"; return SelectionFrameMatchKind.Ignored; }
            if (frameTimestamp - edge.Timestamp > MaximumEdgeDelayTicks)
            { Reject("edge-frame-timeout", out failure); return SelectionFrameMatchKind.Failed; }
            if (edge.Down && edges.Count == 2)
            {
                Edge[] pending = edges.ToArray();
                // Once release has physically happened, a later image cannot
                // prove what was visible at press. Never assign one post-up
                // image to both input edges, even if its titles still match.
                if (frameTimestamp >= pending[1].Timestamp)
                { Reject("down-frame-after-release", out failure); return SelectionFrameMatchKind.Failed; }
            }
            edges.Dequeue();
            match = new SelectionFrameMatch { Kind = edge.Down ? SelectionFrameMatchKind.PointerDown : SelectionFrameMatchKind.PointerUp,
                FrameTimestamp = frameTimestamp, CapturedAt = capturedAtUtcMs, PointerAt = edge.At, Column = edge.Column };
            return match.Kind;
        }

        private bool Reject(string reason, out string failure)
        {
            failed = failure = reason;
            edges.Clear();
            return false;
        }
    }

    internal static class SelectionFrameSynchronizerFixtures
    {
        private static long Stamp(long milliseconds) { return milliseconds * TimeSpan.TicksPerMillisecond; }
        private static SelectionFrameSynchronizer Started()
        { var result = new SelectionFrameSynchronizer(); result.Reset(Stamp(900)); return result; }

        internal static int Run()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { checks++; if (!condition) throw new InvalidOperationException("Selection frame synchronizer: " + message); };
            SelectionFrameMatch match; string failure;
            var join = Started();
            check(join.MatchFrame(Stamp(890), 890, Stamp(1000), out match, out failure) == SelectionFrameMatchKind.Ignored
                && match == null && failure == "frame-before-fence", "old scope frame escaped fence");
            check(join.MatchFrame(Stamp(1000), 1000, Stamp(1001), out match, out failure) == SelectionFrameMatchKind.Independent
                && match.CapturedAt == 1000 && match.PointerAt == 0, "independent frame timestamp changed");
            check(join.MatchFrame(Stamp(1000), 1040, Stamp(1041), out match, out failure) == SelectionFrameMatchKind.Ignored,
                "same frame became independent after wall-clock restamp");
            check(join.MatchFrame(Stamp(999), 1040, Stamp(1041), out match, out failure) == SelectionFrameMatchKind.Ignored,
                "out-of-order frame became independent");
            check(join.MatchFrame(Stamp(1060), 1060, Stamp(1061), out match, out failure) == SelectionFrameMatchKind.Independent,
                "second fresh baseline was lost");
            check(join.EnqueueEdge(true, 1, 1100, Stamp(1100), out failure)
                && join.HasPressedPhysical && !join.HasReleasedPhysical && join.HasPendingEdges, "physical down was not queued");
            check(join.MatchFrame(Stamp(1090), 1090, Stamp(1101), out match, out failure) == SelectionFrameMatchKind.Ignored
                && join.PendingCount == 1, "pre-edge frame became down or baseline");
            check(join.MatchFrame(Stamp(1120), 1120, Stamp(1125), out match, out failure) == SelectionFrameMatchKind.PointerDown
                && match.PointerAt == 1100 && match.CapturedAt == 1120 && match.Column == 1
                && !join.HasPendingEdges, "down pointer/pixel timestamps were conflated");
            check(join.EnqueueEdge(false, 1, 1140, Stamp(1140), out failure)
                && join.HasReleasedPhysical && join.HasPendingEdges, "paired physical release was not visible before pixel delivery");
            check(join.MatchFrame(Stamp(1120), 1140, Stamp(1141), out match, out failure) == SelectionFrameMatchKind.Ignored
                && join.PendingCount == 1, "one source frame witnessed both edges");
            check(join.MatchFrame(Stamp(1160), 1160, Stamp(1165), out match, out failure) == SelectionFrameMatchKind.PointerUp
                && match.PointerAt == 1140 && match.CapturedAt == 1160 && join.HasReleasedPhysical
                && !join.HasPendingEdges, "release lost actual input time");
            check(join.MatchFrame(Stamp(1200), 1200, Stamp(1201), out match, out failure) == SelectionFrameMatchKind.Independent,
                "post-release independent frame was lost");
            check(!join.EnqueueEdge(true, 1, 1220, Stamp(1220), out failure) && join.Failed && failure == "extra-click",
                "second interaction joined the first proof");
            check(join.MatchFrame(Stamp(1240), 1240, Stamp(1241), out match, out failure) == SelectionFrameMatchKind.Failed,
                "failure did not remain latched");
            join.Reset(Stamp(1300));
            check(!join.HasPendingEdges && !join.HasPressedPhysical && !join.HasReleasedPhysical && !join.Failed,
                "reset retained physical input or failure");
            check(join.MatchFrame(Stamp(1299), 1400, Stamp(1400), out match, out failure) == SelectionFrameMatchKind.Ignored,
                "reset accepted an old cached frame with new UTC time");

            join = Started();
            check(join.EnqueueEdge(true, 0, 1000, Stamp(1000), out failure)
                && join.EnqueueEdge(false, 0, 1040, Stamp(1040), out failure) && join.PendingCount == 2,
                "quick release could not queue while down awaited pixels");
            check(join.MatchFrame(Stamp(1020), 1020, Stamp(1045), out match, out failure) == SelectionFrameMatchKind.PointerDown
                && match.PointerAt == 1000, "late-delivered pre-release down frame was lost");
            check(join.MatchFrame(Stamp(1060), 1060, Stamp(1065), out match, out failure) == SelectionFrameMatchKind.PointerUp,
                "queued release failed after down mapping");
            join = Started();
            join.EnqueueEdge(true, 0, 1000, Stamp(1000), out failure);
            join.EnqueueEdge(false, 0, 1040, Stamp(1040), out failure);
            check(join.MatchFrame(Stamp(1040), 1040, Stamp(1045), out match, out failure) == SelectionFrameMatchKind.Failed
                && failure == "down-frame-after-release", "frame at release incorrectly proved down");
            join = Started();
            join.EnqueueEdge(true, 0, 1000, Stamp(1000), out failure);
            join.EnqueueEdge(false, 0, 1040, Stamp(1040), out failure);
            check(join.MatchFrame(Stamp(1060), 1060, Stamp(1065), out match, out failure) == SelectionFrameMatchKind.Failed,
                "post-release frame incorrectly proved down");

            join = Started(); join.EnqueueEdge(true, 2, 1000, Stamp(1000), out failure);
            check(join.CheckDeadline(Stamp(1100), out failure), "inclusive 100 ms deadline rejected");
            check(join.MatchFrame(Stamp(1100), 1100, Stamp(1100), out match, out failure) == SelectionFrameMatchKind.PointerDown,
                "frame on inclusive deadline rejected");
            join = Started(); join.EnqueueEdge(true, 2, 1000, Stamp(1000), out failure);
            check(!join.CheckDeadline(Stamp(1100) + 1, out failure) && failure == "edge-frame-timeout",
                "waiting without a frame escaped deadline");
            join = Started(); join.EnqueueEdge(true, 2, 1000, Stamp(1000), out failure);
            check(join.MatchFrame(Stamp(1050), 1050, Stamp(1101), out match, out failure) == SelectionFrameMatchKind.Failed,
                "late delivery of old source frame escaped deadline");
            join = Started(); join.EnqueueEdge(true, 2, 1000, Stamp(1000), out failure);
            check(join.MatchFrame(Stamp(1010), 999, Stamp(1015), out match, out failure) == SelectionFrameMatchKind.Ignored,
                "edge accepted a UTC time before the input");
            check(join.MatchFrame(Stamp(1010), 1010, Stamp(1015), out match, out failure) == SelectionFrameMatchKind.Ignored,
                "ignored frame was reconsidered after restamp");
            join = Started(); join.EnqueueEdge(true, 2, 1000, Stamp(1000), out failure);
            check(!join.CheckDeadline(Stamp(999), out failure) && failure == "frame-clock-backward", "QPC reversal accepted");

            join = Started();
            check(!join.EnqueueEdge(false, 0, 1000, Stamp(1000), out failure) && !join.HasReleasedPhysical,
                "unpaired up manufactured a physical release");
            join = Started(); join.EnqueueEdge(true, 0, 1000, Stamp(1000), out failure);
            check(!join.EnqueueEdge(false, 1, 1040, Stamp(1040), out failure) && !join.HasReleasedPhysical,
                "different-card up manufactured a physical release");
            join = Started(); join.EnqueueEdge(true, 0, 1000, Stamp(1000), out failure);
            check(!join.EnqueueEdge(false, 0, 1000, Stamp(1001), out failure), "same wall-time up accepted");
            join = Started(); join.EnqueueEdge(true, 0, 1000, Stamp(1000), out failure);
            check(!join.EnqueueEdge(false, 0, 1040, Stamp(1000), out failure), "same QPC up accepted");
            join = Started();
            check(!join.EnqueueEdge(true, -1, 1000, Stamp(1000), out failure), "outside pointer queued");
            join = Started();
            check(!join.EnqueueEdge(true, 3, 1000, Stamp(1000), out failure), "invalid card queued");
            join = Started();
            check(!join.EnqueueEdge(true, 0, 899, Stamp(899), out failure), "old-scope edge queued");
            join = Started();
            check(join.MatchFrame(Stamp(1001), 1001, Stamp(1000), out match, out failure) == SelectionFrameMatchKind.Failed,
                "future compositor frame accepted");
            join = Started();
            check(join.MatchFrame(0, 1000, Stamp(1000), out match, out failure) == SelectionFrameMatchKind.Failed,
                "missing compositor timestamp accepted");
            join = Started();
            check(join.MatchFrame(Stamp(1000), 0, Stamp(1000), out match, out failure) == SelectionFrameMatchKind.Failed,
                "missing UTC frame timestamp accepted");
            return checks;
        }
    }
}
