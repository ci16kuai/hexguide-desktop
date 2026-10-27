using System;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;

namespace HexGuide.Desktop
{
    // Fixed technical events only. The ring outlives the transient pixel/replay
    // state, so a later baseline cannot erase why an actual click was rejected.
    // No caller-supplied text, IDs, positions, handles or image data is retained.
    internal sealed class RecognitionTrace
    {
        internal const int MaximumEvents = 16;
        internal const int MaximumBytes = 1800;
        private const long MaximumSequence = 2000000000;
        private readonly object sync = new object();
        private readonly List<object[]> events = new List<object[]>();
        private readonly Dictionary<string, int> counts = new Dictionary<string, int>();
        private long sequence;
        private static readonly string[] EventCodes = {
            "baseline", "reference", "reference-rejected", "down", "up", "feedback", "cancelled", "proof",
            "queue", "submit-start", "submit-accepted", "submit-rejected", "submit-failed", "submit-expired", "client-update-failed"
        };
        private static readonly HashSet<string> AllowedEvents = new HashSet<string>(EventCodes, StringComparer.Ordinal);
        private static readonly HashSet<string> AllowedReasons = new HashSet<string>(new[] {
            "none", "other", "buffered", "titles-ready", "bound", "unique-feedback", "full-proof",
            "screen", "panel", "busy", "stale-context", "invalid-proof", "http-error", "transport-error", "closing", "client-state-error",
            "scope-ineligible", "scope-expired", "scope-changed", "interaction-expired", "local-action",
            "focus-changed", "held-before-observation", "outside-click", "capture-unavailable",
            "dpi-unavailable", "game-unverified", "game-not-foreground", "game-not-visible", "client-unavailable",
            "client-changed", "region-too-large", "occlusion-enumeration-incomplete", "occlusion-bounds-unavailable",
            "occlusion-state-unavailable", "card-occluded", "capture-exception",
            "reference-context-mismatch", "reference-before-scope", "reference-before-fence", "reference-in-future",
            "reference-too-old", "reference-geometry-changed", "reference-after-click", "offer-changed",
            "frame-time-invalid", "geometry-changed", "extra-click", "missing-baseline", "release-unpaired", "buffer-limit",
            "reference-scope-invalid", "reference-expired", "proof-rejected", "evidence-expired",
            "arm-reference-ineligible", "frame-invalid-current", "frame-invalid-reference", "frame-title-mask-invalid",
            "frame-preclick-mae", "frame-preclick-close", "frame-preclick-mae-close", "frame-hold-timeout",
            "frame-pending-time-backward", "frame-pending-timeout", "pointer-not-game", "pointer-column-invalid",
            "pointer-invalid-current", "pointer-invalid-reference", "pointer-title-unverified", "pointer-panel-mae",
            "pointer-panel-close", "pointer-panel-mae-close", "pointer-down-pending", "pointer-down-not-ready",
            "pointer-down-missing-frame", "pointer-down-stale-frame", "pointer-up-column-mismatch",
            "pointer-up-hold-timeout", "pointer-up-time-backward", "decision-invalid"
        }, StringComparer.Ordinal);

        internal bool Record(string eventCode, string reasonCode, long atEpochMs, int baselineFrames = 0,
            int feedbackFrames = 0, int dismissedFrames = 0, int httpStatus = 0, int durationMs = 0)
        {
            if (eventCode == null || !AllowedEvents.Contains(eventCode)) return false;
            string reason = reasonCode != null && AllowedReasons.Contains(reasonCode) ? reasonCode : "other";
            lock (sync)
            {
                sequence = Math.Min(MaximumSequence, sequence + 1);
                int count;
                counts.TryGetValue(eventCode, out count);
                counts[eventCode] = Math.Min(1000000, count + 1);
                events.Add(new object[] { sequence, Math.Max(0, Math.Min(8640000000000000L, atEpochMs)), eventCode, reason,
                    Bound(baselineFrames, 1000), Bound(feedbackFrames, 1000), Bound(dismissedFrames, 1000),
                    httpStatus >= 100 && httpStatus <= 599 ? httpStatus : 0, Bound(durationMs, 60000) });
                if (events.Count > MaximumEvents) events.RemoveAt(0);
            }
            return true;
        }

        private static int Bound(int value, int maximum) { return Math.Max(0, Math.Min(maximum, value)); }

        internal Dictionary<string, object> Snapshot()
        {
            lock (sync)
            {
                var rows = new List<object[]>();
                foreach (object[] row in events) rows.Add((object[])row.Clone());
                var snapshot = new Dictionary<string, object> {
                    { "version", 1 }, { "sequence", sequence }, { "omitted", Math.Max(0, sequence - rows.Count) },
                    { "counts", new Dictionary<string, int>(counts) },
                    { "columns", new[] { "sequence", "at", "event", "reason", "baselineFrames", "feedbackFrames", "dismissedFrames", "httpStatus", "durationMs" } },
                    { "events", rows }
                };
                var serializer = new JavaScriptSerializer();
                // Extreme values/codes may fill more than the usual 16-row
                // budget. Keep the newest complete rows and every counter.
                while (Encoding.UTF8.GetByteCount(serializer.Serialize(snapshot)) > MaximumBytes && rows.Count > 0)
                {
                    rows.RemoveAt(0);
                    snapshot["omitted"] = Math.Max(0, sequence - rows.Count);
                }
                return snapshot;
            }
        }

        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string reason) {
                checks++; if (!condition) throw new InvalidOperationException("Recognition trace fixture: " + reason);
            };
            var trace = new RecognitionTrace();
            check(!trace.Record("PRIVATE-TOKEN", "C:\\private\\player", long.MaxValue), "unknown event was accepted");
            check((long)trace.Snapshot()["sequence"] == 0, "rejected event changed counters");
            trace.Record("down", "PRIVATE-TOKEN", 1200, -1, int.MaxValue, int.MaxValue, int.MaxValue, int.MaxValue);
            var first = trace.Snapshot();
            var firstRows = (List<object[]>)first["events"];
            check((string)firstRows[0][3] == "other" && (int)firstRows[0][4] == 0 && (int)firstRows[0][5] == 1000,
                "untrusted reason or out-of-range evidence escaped");
            check((int)firstRows[0][7] == 0 && (int)firstRows[0][8] == 60000, "submission metrics escaped fixed bounds");
            firstRows[0][3] = "PRIVATE-MUTATION";
            check((string)((List<object[]>)trace.Snapshot()["events"])[0][3] == "other", "snapshot exposed mutable ring storage");
            for (int i = 0; i < 100; i++) trace.Record("cancelled", "pointer-down-missing-frame", long.MaxValue, int.MaxValue, int.MaxValue, int.MaxValue, 599, int.MaxValue);
            var filled = trace.Snapshot();
            var rows = (List<object[]>)filled["events"];
            check(rows.Count > 0 && rows.Count <= MaximumEvents, "ring did not retain a bounded newest history");
            check((long)rows[rows.Count - 1][0] == 101 && (long)filled["omitted"] == 101 - rows.Count,
                "overflow lost the newest event or its omission count");
            check(((Dictionary<string, int>)filled["counts"])["down"] == 1
                && ((Dictionary<string, int>)filled["counts"])["cancelled"] == 100, "history trimming erased counters");
            string json = new JavaScriptSerializer().Serialize(filled);
            check(Encoding.UTF8.GetByteCount(json) <= MaximumBytes && !json.Contains("PRIVATE") && !json.Contains("player"),
                "snapshot exceeded its byte/privacy contract");
            foreach (string code in EventCodes) trace.Record(code, "transport-error", long.MaxValue, 1000, 1000, 1000, 599, 60000);
            check(Encoding.UTF8.GetByteCount(new JavaScriptSerializer().Serialize(trace.Snapshot())) <= MaximumBytes,
                "every event counter plus maximum rows exceeded the byte cap");
            trace.sequence = MaximumSequence - 1;
            foreach (string code in EventCodes) trace.counts[code] = 999999;
            trace.Record("submit-failed", "pointer-down-missing-frame", long.MaxValue, 1000, 1000, 1000, 599, 60000);
            trace.Record("submit-failed", "pointer-down-missing-frame", long.MaxValue, 1000, 1000, 1000, 599, 60000);
            check((long)trace.Snapshot()["sequence"] == MaximumSequence
                && ((Dictionary<string, int>)trace.Snapshot()["counts"])["submit-failed"] == 1000000,
                "numeric counters wrapped instead of saturating monotonically");
            check(Encoding.UTF8.GetByteCount(new JavaScriptSerializer().Serialize(trace.Snapshot())) <= MaximumBytes,
                "maximum counter widths exceeded the snapshot cap");
            return checks;
        }
    }
}
