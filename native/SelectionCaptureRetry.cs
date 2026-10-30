using System;

namespace HexGuide.Desktop
{
    // Timing only. This policy never owns pixels, input edges or selection
    // evidence; an immediate edge still goes through the normal capture guards.
    internal sealed class SelectionCaptureRetry
    {
        // Existing direct confirmation needs two baseline frames >=40ms apart.
        private const int FrameIntervalMs = 65, FastFrameIntervalMs = 40, FailureIntervalMs = 500;
        private const int BurstWindowMs = 20000;
        private long lastStartedAt, lastCompletedAt, nextFrameAt, burstStartedAt, burstDeadline, burstLastSeenAt;
        private string spentBurstKey;
        private bool lastSucceeded;
        private int consecutiveFailures;
        internal string WaitingStatus { get; private set; }

        internal bool Due(long now, bool edge)
        {
            if (edge) return true;
            // A wall-clock correction must not create an unbounded delay. The
            // replay's independent timestamp/lease fences still reject old data.
            if (now < lastCompletedAt) nextFrameAt = now;
            else if (lastSucceeded) nextFrameAt = Add(lastStartedAt, BurstActive(now) ? FastFrameIntervalMs : FrameIntervalMs);
            return now >= nextFrameAt;
        }

        // The owner calls this only after its validated complete reference was
        // accepted by the replay. OCR refresh timestamps never extend a budget.
        internal void Recognized(string key, long now)
        {
            if (string.IsNullOrEmpty(key) || key == spentBurstKey) return;
            spentBurstKey = key;
            burstStartedAt = burstLastSeenAt = now; burstDeadline = Add(now, BurstWindowMs);
        }

        internal bool BurstActive(long now)
        {
            if (burstDeadline == 0) return false;
            if (now < burstStartedAt || now < burstLastSeenAt || now >= burstDeadline) { StopBurst(); return false; }
            burstLastSeenAt = now;
            return WaitingStatus == null;
        }

        internal int InputInterval(long now) { return BurstActive(now) ? 16 : 25; }

        internal void StopBurst() { burstStartedAt = burstDeadline = burstLastSeenAt = 0; }

        internal void Completed(bool success, string code, long startedAt, long completedAt)
        {
            lastStartedAt = startedAt; lastCompletedAt = completedAt; lastSucceeded = success;
            consecutiveFailures = success ? 0 : Math.Min(consecutiveFailures + 1, 5);
            long stamp = success ? startedAt : Math.Max(startedAt, completedAt);
            // Two short recovery probes leave time for fresh baseline frames
            // after a transient obstruction. Persistent failures back off to
            // 500ms after a fixed 65/65/130/250ms onset budget; model refreshes
            // and fast-reference bindings cannot replenish that budget.
            int failureInterval = consecutiveFailures <= 2 ? FrameIntervalMs : consecutiveFailures == 3 ? 130
                : consecutiveFailures == 4 ? 250 : FailureIntervalMs;
            int interval = success ? (BurstActive(startedAt) ? FastFrameIntervalMs : FrameIntervalMs) : failureInterval;
            nextFrameAt = Add(stamp, interval);
            WaitingStatus = success ? null : Occluded(code) ? "capture-blocked" : "capture-unavailable";
            if (!success) StopBurst();
        }

        internal void Reset()
        { lastStartedAt = lastCompletedAt = nextFrameAt = 0; consecutiveFailures = 0; lastSucceeded = false; WaitingStatus = null; StopBurst(); }

        private static long Add(long stamp, int interval)
        { return stamp > long.MaxValue - interval ? long.MaxValue : stamp + interval; }

        private static bool Occluded(string code)
        {
            return code == "card-occluded" || code == "occlusion-state-unavailable"
                || code == "occlusion-bounds-unavailable" || code == "occlusion-enumeration-incomplete";
        }
    }
}
