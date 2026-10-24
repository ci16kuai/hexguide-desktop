using System;
using System.Collections.Generic;

namespace HexGuide.Desktop
{
    // Pure, provisional evidence verifier. The caller must locate and verify the
    // game's own result panel and extract comparable shape descriptors. This
    // class captures no pixels, installs no hooks, sends no input, and owns no
    // session/owned-augment state. It must be called on one serialized thread.
    internal sealed class OwnedVerificationScope
    {
        internal readonly string GameKey, RoundKey, OfferToken, GeometryKey;
        internal readonly long ManualRevision;

        internal OwnedVerificationScope(string gameKey, string roundKey, string offerToken, long manualRevision, string geometryKey)
        {
            GameKey = gameKey; RoundKey = roundKey; OfferToken = offerToken;
            ManualRevision = manualRevision; GeometryKey = geometryKey;
        }

        internal bool IsValid
        {
            get { return ValidKey(GameKey) && ValidKey(RoundKey) && ValidKey(OfferToken) && ValidKey(GeometryKey) && ManualRevision >= 0; }
        }

        private static bool ValidKey(string value) { return !String.IsNullOrWhiteSpace(value) && value.Length <= 160; }

        internal bool SameAs(OwnedVerificationScope other)
        {
            return other != null && GameKey == other.GameKey && RoundKey == other.RoundKey &&
                OfferToken == other.OfferToken && ManualRevision == other.ManualRevision && GeometryKey == other.GeometryKey;
        }
    }

    internal sealed class OwnedCandidateShape
    {
        // Quality/color is deliberately absent: it cannot resolve a same-glyph
        // collision between normal augments or between an augment and a skill.
        internal readonly string Id;
        internal readonly double[] Shape;
        internal OwnedCandidateShape(string id, double[] shape) { Id = id; Shape = shape == null ? null : (double[])shape.Clone(); }
    }

    internal sealed class OwnedExcludedShape
    {
        // Known extra-skill/other non-owned icons, supplied by an audited source.
        // This is not a claim that the exclusion catalogue covers unknown icons.
        internal readonly string Id;
        internal readonly double[] Shape;
        internal OwnedExcludedShape(string id, double[] shape) { Id = id; Shape = shape == null ? null : (double[])shape.Clone(); }
    }

    internal sealed class OwnedSelectionLease
    {
        // The caller must create this only from the same offer's verified game
        // card down/up observation, not from a mouse hover, OCR rank or label.
        // Those input observations are outside this pure visual evidence core.
        internal readonly OwnedVerificationScope Scope;
        internal readonly int SelectedIndex;
        internal readonly long DownAtMs, UpAtMs;
        internal readonly bool VerifiedGameCardDownUp;
        internal OwnedSelectionLease(OwnedVerificationScope scope, int selectedIndex, long downAtMs, long upAtMs, bool verifiedGameCardDownUp)
        {
            Scope = scope; SelectedIndex = selectedIndex; DownAtMs = downAtMs; UpAtMs = upAtMs;
            VerifiedGameCardDownUp = verifiedGameCardDownUp;
        }
    }

    internal sealed class OwnedPanelSlot
    {
        // Key describes the observed result-panel location, not a fixed ordinal
        // or a claim that the slot is a normal augment rather than a skill boost.
        internal readonly string Key;
        internal readonly double[] Shape;
        internal OwnedPanelSlot(string key, double[] shape) { Key = key; Shape = shape == null ? null : (double[])shape.Clone(); }
    }

    internal sealed class OwnedPanelFrame
    {
        // CaptureId must identify an actual, distinct capture. A caller must not
        // re-label a cached image as another capture to manufacture stability.
        // CapturedAtMs uses one monotonic clock shared with the baseline.
        internal readonly long CaptureId, CapturedAtMs;
        internal readonly bool PanelVisible, PanelComplete, GameSurfaceVerified, SelectionUiVisible;
        internal readonly OwnedPanelSlot[] Slots;

        internal OwnedPanelFrame(long captureId, long capturedAtMs, bool panelVisible, bool panelComplete,
            bool gameSurfaceVerified, bool selectionUiVisible, OwnedPanelSlot[] slots)
        {
            CaptureId = captureId; CapturedAtMs = capturedAtMs;
            PanelVisible = panelVisible; PanelComplete = panelComplete;
            GameSurfaceVerified = gameSurfaceVerified; SelectionUiVisible = selectionUiVisible;
            Slots = slots == null ? null : (OwnedPanelSlot[])slots.Clone();
        }
    }

    internal sealed class OwnedVerificationPolicy
    {
        // Explicit experimental defaults, not calibrated/live-verified accuracy.
        internal const bool Provisional = true;
        internal const bool LiveVerified = false;
        internal double MatchSimilarity = 0.94;
        internal double UnknownAmbiguitySimilarity = 0.88;
        internal double CandidateMargin = 0.05;
        internal double CandidateCollisionSimilarity = 0.90;
        internal double OldSlotSimilarity = 0.94;
        internal int RequiredIndependentFrames = 3;
        internal long MinimumFrameSpacingMs = 100;
        internal long MinimumStableDurationMs = 250;
        internal long MaximumFrameGapMs = 2000;
        internal long MaximumRoundAgeMs = 60000;
        internal long MaximumSelectionDurationMs = 2000;
        internal long MaximumSelectionLeaseAgeMs = 8000;
        internal int MaximumSlots = 64;
        internal int MaximumDescriptorLength = 512;

        internal OwnedVerificationPolicy Copy() { return (OwnedVerificationPolicy)MemberwiseClone(); }

        internal bool IsValid
        {
            get
            {
                return Unit(MatchSimilarity) && Unit(UnknownAmbiguitySimilarity) && Unit(CandidateMargin) &&
                    Unit(CandidateCollisionSimilarity) && Unit(OldSlotSimilarity) &&
                    UnknownAmbiguitySimilarity < MatchSimilarity && CandidateMargin > 0 &&
                    RequiredIndependentFrames >= 3 && RequiredIndependentFrames <= 16 &&
                    MinimumFrameSpacingMs >= 1 && MinimumStableDurationMs >= MinimumFrameSpacingMs &&
                    MaximumFrameGapMs >= MinimumFrameSpacingMs && MaximumRoundAgeMs >= MaximumFrameGapMs &&
                    MaximumSelectionDurationMs >= 1 && MaximumSelectionLeaseAgeMs >= MaximumFrameGapMs &&
                    MaximumSlots >= 1 && MaximumSlots <= 256 && MaximumDescriptorLength >= 3 && MaximumDescriptorLength <= 4096;
            }
        }

        private static bool Unit(double value) { return !Double.IsNaN(value) && !Double.IsInfinity(value) && value >= 0 && value <= 1; }
    }

    internal enum OwnedVerificationStatus { Pending, Observed, VerifiedCandidate, Rejected }

    internal sealed class OwnedVerificationResult
    {
        internal readonly OwnedVerificationStatus Status;
        // VerifiedCandidate remains visual evidence joined to an independent
        // input lease. It is not a game-state event or a session mutation.
        internal readonly string Reason, ObservedCandidateId, VerifiedCandidateId;
        internal readonly OwnedVerificationScope Scope;
        internal readonly int StableFrames, UnrelatedNewSlots;
        internal readonly long[] EvidenceCaptureIds;
        internal readonly double MinimumSimilarity;
        internal bool Provisional { get { return OwnedVerificationPolicy.Provisional; } }
        internal bool LiveVerified { get { return OwnedVerificationPolicy.LiveVerified; } }
        internal const string Limitation = "shape-only-cannot-distinguish-unseen-identical-icons";
        internal bool RequiresSessionBoundaryValidation { get { return true; } }

        internal OwnedVerificationResult(OwnedVerificationStatus status, string reason, string observedCandidateId, string verifiedCandidateId,
            OwnedVerificationScope scope, int stableFrames, int unrelatedNewSlots, long[] evidenceCaptureIds, double minimumSimilarity)
        {
            Status = status; Reason = reason; ObservedCandidateId = observedCandidateId; VerifiedCandidateId = verifiedCandidateId; Scope = scope;
            StableFrames = stableFrames; UnrelatedNewSlots = unrelatedNewSlots;
            EvidenceCaptureIds = (long[])evidenceCaptureIds.Clone(); MinimumSimilarity = minimumSimilarity;
        }
    }

    internal sealed class OwnedAugmentVerifier
    {
        private sealed class NormalSlot
        {
            internal string Key;
            internal double[] Shape;
        }

        private readonly OwnedVerificationPolicy policy;
        private OwnedVerificationScope scope;
        private string[] candidateIds;
        private double[][] candidates;
        private double[][] excludedShapes;
        private NormalSlot[] baseline;
        private bool armed, emitted;
        private long baselineAt, lastCaptureId, lastCaptureAt, firstEvidenceAt, lastEvidenceAt;
        private string stableId, stableSlot;
        private double minimumSimilarity;
        private readonly List<long> evidence = new List<long>();

        internal OwnedAugmentVerifier(OwnedVerificationPolicy configuration)
        {
            policy = (configuration ?? new OwnedVerificationPolicy()).Copy();
        }

        internal void Reset()
        {
            armed = false; emitted = false; scope = null; candidateIds = null; candidates = null; excludedShapes = null; baseline = null;
            baselineAt = 0; lastCaptureId = 0; lastCaptureAt = 0; ClearEvidence();
        }

        internal OwnedVerificationResult BeginRound(OwnedVerificationScope nextScope, OwnedCandidateShape[] offered, OwnedPanelFrame before)
        {
            return BeginRound(nextScope, offered, before, null);
        }

        internal OwnedVerificationResult BeginRound(OwnedVerificationScope nextScope, OwnedCandidateShape[] offered,
            OwnedPanelFrame before, OwnedExcludedShape[] exclusions)
        {
            Reset(); scope = nextScope;
            if (!policy.IsValid) return Reject("invalid-policy", true);
            if (scope == null || !scope.IsValid) return Reject("invalid-scope", true);
            if (offered == null || offered.Length != 3) return Reject("three-candidates-required", true);
            candidateIds = new string[3]; candidates = new double[3][];
            var ids = new HashSet<string>(StringComparer.Ordinal);
            int dimension = 0;
            for (int i = 0; i < offered.Length; i++)
            {
                if (offered[i] == null || String.IsNullOrWhiteSpace(offered[i].Id) || offered[i].Id.Length > 160 || !ids.Add(offered[i].Id))
                    return Reject("invalid-candidate-id", true);
                candidates[i] = Normalize(offered[i].Shape, dimension);
                if (candidates[i] == null) return Reject("invalid-candidate-shape", true);
                dimension = candidates[i].Length; candidateIds[i] = offered[i].Id;
            }
            for (int i = 0; i < 3; i++) for (int j = i + 1; j < 3; j++)
                if (Similarity(candidates[i], candidates[j]) >= policy.CandidateCollisionSimilarity)
                    return Reject("candidate-shape-collision", true);
            if (exclusions != null && exclusions.Length > 256) return Reject("too-many-excluded-shapes", true);
            excludedShapes = new double[exclusions == null ? 0 : exclusions.Length][];
            var excludedIds = new HashSet<string>(StringComparer.Ordinal);
            for (int e = 0; e < excludedShapes.Length; e++)
            {
                if (exclusions[e] == null || String.IsNullOrWhiteSpace(exclusions[e].Id) || exclusions[e].Id.Length > 160 || !excludedIds.Add(exclusions[e].Id))
                    return Reject("invalid-excluded-id", true);
                excludedShapes[e] = Normalize(exclusions[e].Shape, dimension);
                if (excludedShapes[e] == null) return Reject("invalid-excluded-shape", true);
                for (int c = 0; c < candidates.Length; c++)
                    if (Similarity(candidates[c], excludedShapes[e]) >= policy.CandidateCollisionSimilarity)
                        return Reject("candidate-excluded-shape-collision", true);
            }

            armed = true;
            if (before == null) return Result(OwnedVerificationStatus.Pending, "missing-baseline", null, 0);
            if (before.CaptureId < 1 || before.CapturedAtMs < 0) return Reject("invalid-baseline-time", true);
            string error;
            baseline = ReadSlots(before, out error);
            if (baseline == null) return Reject("baseline-" + error, true);
            baselineAt = before.CapturedAtMs; lastCaptureAt = baselineAt; lastCaptureId = before.CaptureId;
            return Result(OwnedVerificationStatus.Pending, "baseline-ready", null, 0);
        }

        internal OwnedVerificationResult Observe(OwnedVerificationScope currentScope, OwnedPanelFrame frame)
        {
            return Observe(currentScope, frame, null);
        }

        internal OwnedVerificationResult Observe(OwnedVerificationScope currentScope, OwnedPanelFrame frame, OwnedSelectionLease selectionLease)
        {
            if (!armed) return Reject("round-not-armed", false);
            if (!scope.SameAs(currentScope)) return Reject("scope-changed", true);
            if (emitted) return Result(OwnedVerificationStatus.Pending, "already-emitted", null, 0);
            if (baseline == null) return Result(OwnedVerificationStatus.Pending, "missing-baseline", null, 0);
            if (frame == null) return Reject("missing-frame", false);
            if (frame.CaptureId <= lastCaptureId || frame.CapturedAtMs <= lastCaptureAt)
                return Reject("duplicate-or-out-of-order-frame", false);
            long gap = frame.CapturedAtMs - lastCaptureAt;
            lastCaptureId = frame.CaptureId; lastCaptureAt = frame.CapturedAtMs;
            if (frame.CapturedAtMs - baselineAt > policy.MaximumRoundAgeMs) return Reject("round-evidence-expired", true);
            if (gap > policy.MaximumFrameGapMs) return Reject("capture-gap", false);
            string error;
            NormalSlot[] slots = ReadSlots(frame, out error);
            if (slots == null) return Reject(error, false);
            if (frame.SelectionUiVisible) return PendingReset("selection-still-visible");
            if (!ExplainBaseline(slots)) return Reject("previous-slot-unexplained", false);

            int novelCandidate = -1, unrelatedNewSlots = 0;
            string novelSlot = null;
            double novelScore = 0;
            for (int s = 0; s < slots.Length; s++)
            {
                int best = -1; double bestScore = -2, secondScore = -2;
                for (int c = 0; c < candidates.Length; c++)
                {
                    double score = Similarity(slots[s].Shape, candidates[c]);
                    if (score > bestScore) { secondScore = bestScore; bestScore = score; best = c; }
                    else if (score > secondScore) secondScore = score;
                }
                bool old = IsExplainedOld(slots[s].Shape);
                bool excluded = false;
                foreach (double[] excludedShape in excludedShapes)
                    if (Similarity(slots[s].Shape, excludedShape) >= policy.MatchSimilarity) { excluded = true; break; }
                if (excluded && bestScore >= policy.UnknownAmbiguitySimilarity)
                    return Reject("known-excluded-or-candidate-shape-ambiguous", false);
                if (bestScore >= policy.MatchSimilarity && bestScore - secondScore >= policy.CandidateMargin)
                {
                    if (old) continue;
                    if (novelCandidate >= 0) return Reject(best == novelCandidate ? "duplicate-candidate-shape" : "multiple-new-candidates", false);
                    novelCandidate = best; novelSlot = slots[s].Key; novelScore = bestScore;
                }
                else if (bestScore >= policy.UnknownAmbiguitySimilarity)
                {
                    // A near-candidate skill/unknown icon is not silently dropped.
                    return Reject("unknown-or-candidate-shape-ambiguous", false);
                }
                else if (!old) unrelatedNewSlots++;
            }
            if (novelCandidate < 0) return PendingReset("no-new-candidate");

            string id = candidateIds[novelCandidate];
            if (stableId != id || stableSlot != novelSlot) ClearEvidence();
            if (evidence.Count > 0 && frame.CapturedAtMs - lastEvidenceAt < policy.MinimumFrameSpacingMs)
                return Result(OwnedVerificationStatus.Pending, "capture-too-close-for-independent-evidence", null, unrelatedNewSlots);
            if (evidence.Count == 0)
            {
                stableId = id; stableSlot = novelSlot; firstEvidenceAt = frame.CapturedAtMs; minimumSimilarity = novelScore;
            }
            evidence.Add(frame.CaptureId); lastEvidenceAt = frame.CapturedAtMs;
            minimumSimilarity = Math.Min(minimumSimilarity, novelScore);
            if (evidence.Count >= policy.RequiredIndependentFrames && frame.CapturedAtMs - firstEvidenceAt >= policy.MinimumStableDurationMs)
            {
                if (selectionLease == null || !selectionLease.VerifiedGameCardDownUp)
                    return Observed("real-game-selection-lease-required", id, unrelatedNewSlots);
                if (!scope.SameAs(selectionLease.Scope)) return Reject("selection-lease-scope-mismatch", false);
                if (selectionLease.SelectedIndex < 0 || selectionLease.SelectedIndex >= 3)
                    return Reject("selection-lease-index-invalid", false);
                if (selectionLease.DownAtMs < baselineAt || selectionLease.UpAtMs <= selectionLease.DownAtMs ||
                    selectionLease.UpAtMs > frame.CapturedAtMs || selectionLease.UpAtMs - selectionLease.DownAtMs > policy.MaximumSelectionDurationMs ||
                    frame.CapturedAtMs - selectionLease.UpAtMs > policy.MaximumSelectionLeaseAgeMs)
                    return Reject("selection-lease-time-invalid-or-expired", false);
                if (firstEvidenceAt < selectionLease.UpAtMs) return Reject("evidence-predates-selection-lease", false);
                if (selectionLease.SelectedIndex != novelCandidate) return Reject("selection-lease-candidate-mismatch", false);
                emitted = true;
                return Result(OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease", id, unrelatedNewSlots);
            }
            // Bound evidence even if a caller configures a long stable duration.
            if (evidence.Count > policy.RequiredIndependentFrames) evidence.RemoveAt(1);
            return Result(OwnedVerificationStatus.Pending, "awaiting-independent-frames", null, unrelatedNewSlots);
        }

        private NormalSlot[] ReadSlots(OwnedPanelFrame frame, out string error)
        {
            error = null;
            if (!frame.GameSurfaceVerified) error = "unverified-game-surface";
            else if (!frame.PanelVisible) error = "panel-hidden-or-occluded";
            else if (!frame.PanelComplete) error = "panel-incomplete";
            else if (frame.Slots == null || frame.Slots.Length > policy.MaximumSlots) error = "invalid-slot-count";
            if (error != null) return null;
            var slots = new NormalSlot[frame.Slots.Length];
            var keys = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < slots.Length; i++)
            {
                OwnedPanelSlot slot = frame.Slots[i];
                if (slot == null || String.IsNullOrWhiteSpace(slot.Key) || slot.Key.Length > 160 || !keys.Add(slot.Key))
                { error = "invalid-or-duplicate-slot-key"; return null; }
                double[] shape = Normalize(slot.Shape, candidates[0].Length);
                if (shape == null) { error = "invalid-slot-shape"; return null; }
                slots[i] = new NormalSlot { Key = slot.Key, Shape = shape };
            }
            return slots;
        }

        private double[] Normalize(double[] shape, int expectedLength)
        {
            if (shape == null || shape.Length < 3 || shape.Length > policy.MaximumDescriptorLength ||
                (expectedLength != 0 && expectedLength != shape.Length)) return null;
            double maximum = 0;
            for (int i = 0; i < shape.Length; i++)
            {
                if (Double.IsNaN(shape[i]) || Double.IsInfinity(shape[i])) return null;
                maximum = Math.Max(maximum, Math.Abs(shape[i]));
            }
            if (maximum < 1e-12) return null;
            var normalized = new double[shape.Length]; double squared = 0;
            for (int i = 0; i < shape.Length; i++) { normalized[i] = shape[i] / maximum; squared += normalized[i] * normalized[i]; }
            double length = Math.Sqrt(squared);
            for (int i = 0; i < shape.Length; i++) normalized[i] /= length;
            return normalized;
        }

        private static double Similarity(double[] left, double[] right)
        {
            double value = 0;
            for (int i = 0; i < left.Length; i++) value += left[i] * right[i];
            return Math.Max(-1, Math.Min(1, value));
        }

        private bool IsExplainedOld(double[] shape)
        {
            foreach (NormalSlot old in baseline) if (Similarity(old.Shape, shape) >= policy.OldSlotSimilarity) return true;
            return false;
        }

        // Maximum bipartite matching: duplicate/reordered old icons still need
        // distinct current slots, rather than reusing one slot as an explanation.
        private bool ExplainBaseline(NormalSlot[] slots)
        {
            if (slots.Length < baseline.Length) return false;
            var assigned = new int[slots.Length];
            for (int i = 0; i < assigned.Length; i++) assigned[i] = -1;
            for (int old = 0; old < baseline.Length; old++)
                if (!AssignOld(old, slots, assigned, new bool[slots.Length])) return false;
            return true;
        }

        private bool AssignOld(int old, NormalSlot[] slots, int[] assigned, bool[] visited)
        {
            for (int s = 0; s < slots.Length; s++)
            {
                if (visited[s] || Similarity(baseline[old].Shape, slots[s].Shape) < policy.OldSlotSimilarity) continue;
                visited[s] = true;
                if (assigned[s] < 0 || AssignOld(assigned[s], slots, assigned, visited)) { assigned[s] = old; return true; }
            }
            return false;
        }

        private void ClearEvidence()
        {
            stableId = null; stableSlot = null; evidence.Clear(); firstEvidenceAt = 0; lastEvidenceAt = 0; minimumSimilarity = 0;
        }

        private OwnedVerificationResult PendingReset(string reason) { ClearEvidence(); return Result(OwnedVerificationStatus.Pending, reason, null, 0); }

        private OwnedVerificationResult Reject(string reason, bool disarm)
        {
            ClearEvidence(); if (disarm) armed = false;
            return Result(OwnedVerificationStatus.Rejected, reason, null, 0);
        }

        private OwnedVerificationResult Result(OwnedVerificationStatus status, string reason, string id, int unrelated)
        {
            return new OwnedVerificationResult(status, reason, status == OwnedVerificationStatus.VerifiedCandidate ? id : null,
                status == OwnedVerificationStatus.VerifiedCandidate ? id : null,
                scope, evidence.Count, unrelated, evidence.ToArray(), minimumSimilarity);
        }

        private OwnedVerificationResult Observed(string reason, string id, int unrelated)
        {
            // Keep only a bounded witness set while awaiting a separate lease.
            while (evidence.Count > policy.RequiredIndependentFrames) evidence.RemoveAt(1);
            return new OwnedVerificationResult(OwnedVerificationStatus.Observed, reason, id, null,
                scope, evidence.Count, unrelated, evidence.ToArray(), minimumSimilarity);
        }
    }

    // Synthetic descriptor fixtures only. No screen capture, native input, UI,
    // player data or live accuracy claim is involved in these contract tests.
    internal static class OwnedAugmentVerificationFixtures
    {
        private static int checks;
        private static double[] Shape(int index) { var values = new double[12]; values[index] = 1; return values; }
        private static OwnedPanelSlot Slot(string key, int shape) { return new OwnedPanelSlot(key, Shape(shape)); }
        private static OwnedVerificationScope Scope(string game, string round, string token, long revision, string geometry)
        { return new OwnedVerificationScope(game, round, token, revision, geometry); }
        private static OwnedVerificationScope StandardScope() { return Scope("fixture-game", "round-2", "offer-v1", 7, "geometry-a"); }
        private static OwnedSelectionLease Lease(int selectedIndex)
        { return new OwnedSelectionLease(StandardScope(), selectedIndex, 1025, 1075, true); }
        private static OwnedCandidateShape[] Candidates()
        { return new[] { new OwnedCandidateShape("left", Shape(0)), new OwnedCandidateShape("middle", Shape(1)), new OwnedCandidateShape("right", Shape(2)) }; }
        private static OwnedPanelFrame Frame(long id, long time, params OwnedPanelSlot[] slots)
        { return new OwnedPanelFrame(id, time, true, true, true, false, slots); }
        private static OwnedAugmentVerifier Ready(OwnedPanelSlot[] old)
        {
            var verifier = new OwnedAugmentVerifier(null);
            Check(verifier.BeginRound(StandardScope(), Candidates(), Frame(1, 1000, old)).Reason == "baseline-ready", "baseline");
            return verifier;
        }
        private static void Check(bool condition, string name) { checks++; if (!condition) throw new InvalidOperationException("Owned verification fixture failed: " + name); }
        private static void Is(OwnedVerificationResult result, OwnedVerificationStatus status, string reason)
        { Check(result.Status == status && result.Reason == reason, reason + " (actual " + result.Status + ":" + result.Reason + ")"); Check(status == OwnedVerificationStatus.VerifiedCandidate || result.VerifiedCandidateId == null, "no speculative verified id"); }
        private static OwnedVerificationResult Settle(OwnedAugmentVerifier verifier, int selectedIndex, params OwnedPanelSlot[] slots)
        {
            return SettleWithLease(verifier, Lease(selectedIndex), slots);
        }
        private static OwnedVerificationResult SettleWithLease(OwnedAugmentVerifier verifier, OwnedSelectionLease lease, params OwnedPanelSlot[] slots)
        {
            Is(verifier.Observe(StandardScope(), Frame(2, 1100, slots)), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            Is(verifier.Observe(StandardScope(), Frame(3, 1250, slots)), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            return verifier.Observe(StandardScope(), Frame(4, 1400, slots), lease);
        }

        internal static Dictionary<string, object> Run()
        {
            checks = 0;
            var empty = new OwnedPanelSlot[0];
            var old = new[] { Slot("old-a", 3), Slot("old-b", 4) };
            var v = Ready(empty);
            var result = Settle(v, 1, Slot("chosen", 1));
            Is(result, OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease");
            Check(result.VerifiedCandidateId == "middle" && result.StableFrames == 3 && result.EvidenceCaptureIds.Length == 3, "unique candidate evidence plus independent selection lease");
            Check(result.Provisional && !result.LiveVerified, "no live accuracy claim");
            Check(result.RequiresSessionBoundaryValidation, "never commits session state");
            Is(v.Observe(StandardScope(), Frame(5, 1550, Slot("chosen", 1))), OwnedVerificationStatus.Pending, "already-emitted");

            // No skill boost / a skill already present / one or several unrelated
            // boosts added later. No special slot number or count is assumed.
            v = Ready(old);
            result = Settle(v, 2, Slot("reordered-b", 4), Slot("unknown-new-1", 6), Slot("chosen", 2), Slot("reordered-a", 3), Slot("unknown-new-2", 7));
            Is(result, OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease");
            Check(result.VerifiedCandidateId == "right" && result.UnrelatedNewSlots == 2, "unrelated additions never become owned");
            v = Ready(empty);
            for (int i = 0; i < 3; i++)
                Is(v.Observe(StandardScope(), Frame(2 + i, 1100 + 150 * i, Slot("skill-only", 6), Slot("skill-only-2", 7))),
                    OwnedVerificationStatus.Pending, "no-new-candidate");

            v = Ready(old);
            Is(v.Observe(StandardScope(), Frame(2, 1100, Slot("chosen", 0), Slot("old-a", 3))), OwnedVerificationStatus.Rejected, "previous-slot-unexplained");
            v = Ready(new[] { Slot("same-a", 3), Slot("same-b", 3) });
            Is(v.Observe(StandardScope(), Frame(2, 1100, Slot("only-one-old", 3), Slot("chosen", 0))), OwnedVerificationStatus.Rejected, "previous-slot-unexplained");
            v = Ready(new[] { Slot("already-there", 0) });
            Is(v.Observe(StandardScope(), Frame(2, 1100, Slot("already-there", 0))), OwnedVerificationStatus.Pending, "no-new-candidate");

            v = Ready(empty);
            Is(v.Observe(StandardScope(), Frame(2, 1100, Slot("one", 0), Slot("two", 1))), OwnedVerificationStatus.Rejected, "multiple-new-candidates");
            Is(v.Observe(StandardScope(), Frame(3, 1250, Slot("one", 0), Slot("copy", 0))), OwnedVerificationStatus.Rejected, "duplicate-candidate-shape");
            var near = Shape(0); near[0] = 0.90; near[8] = Math.Sqrt(1 - 0.90 * 0.90);
            Is(v.Observe(StandardScope(), Frame(4, 1400, Slot("real-choice", 2), new OwnedPanelSlot("skill-near-candidate", near))),
                OwnedVerificationStatus.Rejected, "unknown-or-candidate-shape-ambiguous");

            var sameShapes = Candidates(); sameShapes[1] = new OwnedCandidateShape("middle", Shape(0));
            v = new OwnedAugmentVerifier(null);
            Is(v.BeginRound(StandardScope(), sameShapes, Frame(1, 1000)), OwnedVerificationStatus.Rejected, "candidate-shape-collision");
            sameShapes = Candidates(); var close = Shape(0); close[1] = 0.1;
            sameShapes[1] = new OwnedCandidateShape("middle", close);
            Is(v.BeginRound(StandardScope(), sameShapes, Frame(1, 1000)), OwnedVerificationStatus.Rejected, "candidate-shape-collision");

            // A glyph by itself cannot establish whether an unseen, additional
            // skill boost reused exactly the same shape as a normal candidate.
            // With no independent real-choice lease this remains Observed only.
            v = Ready(empty);
            var unknownIdenticalGlyph = new OwnedPanelSlot("unknown-source-glyph", Shape(0));
            result = SettleWithLease(v, null, unknownIdenticalGlyph);
            Is(result, OwnedVerificationStatus.Observed, "real-game-selection-lease-required");
            Check(result.ObservedCandidateId == "left" && result.VerifiedCandidateId == null &&
                OwnedVerificationResult.Limitation == "shape-only-cannot-distinguish-unseen-identical-icons", "unknown identical glyph limitation is explicit");
            v = Ready(empty);
            Is(SettleWithLease(v, Lease(2), unknownIdenticalGlyph), OwnedVerificationStatus.Rejected, "selection-lease-candidate-mismatch");
            v = Ready(empty);
            Is(SettleWithLease(v, new OwnedSelectionLease(StandardScope(), 0, 1025, 1075, false), Slot("chosen", 0)),
                OwnedVerificationStatus.Observed, "real-game-selection-lease-required");
            v = Ready(empty);
            Is(SettleWithLease(v, new OwnedSelectionLease(Scope("other-game", "round-2", "offer-v1", 7, "geometry-a"), 0, 1025, 1075, true), Slot("chosen", 0)),
                OwnedVerificationStatus.Rejected, "selection-lease-scope-mismatch");
            v = Ready(empty);
            Is(SettleWithLease(v, Lease(-1), Slot("chosen", 0)), OwnedVerificationStatus.Rejected, "selection-lease-index-invalid");
            foreach (OwnedSelectionLease invalidLease in new[] { new OwnedSelectionLease(StandardScope(), 0, 900, 1075, true),
                new OwnedSelectionLease(StandardScope(), 0, 1075, 1025, true), new OwnedSelectionLease(StandardScope(), 0, 1025, 1500, true) })
            {
                v = Ready(empty);
                Is(SettleWithLease(v, invalidLease, Slot("chosen", 0)), OwnedVerificationStatus.Rejected, "selection-lease-time-invalid-or-expired");
            }
            v = Ready(empty);
            Is(SettleWithLease(v, new OwnedSelectionLease(StandardScope(), 0, 1125, 1200, true), Slot("chosen", 0)),
                OwnedVerificationStatus.Rejected, "evidence-predates-selection-lease");
            var shortLeasePolicy = new OwnedVerificationPolicy(); shortLeasePolicy.MaximumSelectionLeaseAgeMs = 2000;
            v = new OwnedAugmentVerifier(shortLeasePolicy); v.BeginRound(StandardScope(), Candidates(), Frame(1, 1000));
            v.Observe(StandardScope(), Frame(2, 2900, Slot("chosen", 0))); v.Observe(StandardScope(), Frame(3, 3050, Slot("chosen", 0)));
            Is(v.Observe(StandardScope(), Frame(4, 3200, Slot("chosen", 0)), Lease(0)), OwnedVerificationStatus.Rejected, "selection-lease-time-invalid-or-expired");

            v = new OwnedAugmentVerifier(null);
            Is(v.BeginRound(StandardScope(), Candidates(), Frame(1, 1000), new[] { new OwnedExcludedShape("known-skill", Shape(0)) }),
                OwnedVerificationStatus.Rejected, "candidate-excluded-shape-collision");
            var excluded = Shape(0); excluded[0] = 0.85; excluded[8] = Math.Sqrt(1 - 0.85 * 0.85);
            v = new OwnedAugmentVerifier(null);
            Is(v.BeginRound(StandardScope(), Candidates(), Frame(1, 1000), new[] { new OwnedExcludedShape("known-skill", excluded) }),
                OwnedVerificationStatus.Pending, "baseline-ready");
            var mixed = (double[])excluded.Clone(); mixed[0] += 1;
            Is(v.Observe(StandardScope(), Frame(2, 1100, new OwnedPanelSlot("mixed-known-skill-and-candidate", mixed))),
                OwnedVerificationStatus.Rejected, "known-excluded-or-candidate-shape-ambiguous");
            v = new OwnedAugmentVerifier(null);
            v.BeginRound(StandardScope(), Candidates(), Frame(1, 1000), new[] { new OwnedExcludedShape("known-skill", Shape(8)) });
            Is(Settle(v, 0, Slot("known-extra-skill", 8), Slot("chosen", 0)), OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease");

            v = new OwnedAugmentVerifier(null);
            Is(v.BeginRound(StandardScope(), Candidates(), null), OwnedVerificationStatus.Pending, "missing-baseline");
            Is(v.Observe(StandardScope(), Frame(2, 1100, Slot("chosen", 1))), OwnedVerificationStatus.Pending, "missing-baseline");

            foreach (OwnedVerificationScope changed in new[] { Scope("next-game", "round-2", "offer-v1", 7, "geometry-a"),
                Scope("fixture-game", "round-3", "offer-v1", 7, "geometry-a"), Scope("fixture-game", "round-2", "offer-v2", 7, "geometry-a"),
                Scope("fixture-game", "round-2", "offer-v1", 8, "geometry-a"), Scope("fixture-game", "round-2", "offer-v1", 7, "geometry-b") })
            {
                v = Ready(empty);
                Is(v.Observe(changed, Frame(2, 1100, Slot("chosen", 1))), OwnedVerificationStatus.Rejected, "scope-changed");
                Is(v.Observe(StandardScope(), Frame(3, 1250, Slot("chosen", 1))), OwnedVerificationStatus.Rejected, "round-not-armed");
            }

            v = Ready(empty);
            Is(v.Observe(StandardScope(), Frame(2, 1100, Slot("chosen", 1))), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            Is(v.Observe(StandardScope(), Frame(2, 1250, Slot("chosen", 1))), OwnedVerificationStatus.Rejected, "duplicate-or-out-of-order-frame");
            Is(v.Observe(StandardScope(), Frame(3, 1300, Slot("chosen", 1))), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            Is(v.Observe(StandardScope(), Frame(4, 1325, Slot("chosen", 1))), OwnedVerificationStatus.Pending, "capture-too-close-for-independent-evidence");
            Is(v.Observe(StandardScope(), Frame(5, 1450, Slot("chosen", 1))), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            Is(v.Observe(StandardScope(), Frame(6, 1600, Slot("chosen", 1)), Lease(1)), OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease");

            v = Ready(empty);
            Is(v.Observe(StandardScope(), Frame(2, 1100, Slot("chosen", 0))), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            Is(v.Observe(StandardScope(), Frame(3, 1200, Slot("chosen", 0))), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            Is(v.Observe(StandardScope(), Frame(4, 1300, Slot("chosen", 0))), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            Is(v.Observe(StandardScope(), Frame(5, 1400, Slot("chosen", 0)), Lease(0)), OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease");
            v = Ready(empty);
            v.Observe(StandardScope(), Frame(2, 1100, Slot("chosen", 0)));
            v.Observe(StandardScope(), Frame(3, 1250, Slot("chosen", 1)));
            Check(v.Observe(StandardScope(), Frame(4, 1400, Slot("chosen", 0))).StableFrames == 1, "candidate change interrupts stability");
            Check(v.Observe(StandardScope(), Frame(5, 1550, Slot("moved-choice", 0))).StableFrames == 1, "location change interrupts stability");
            Is(v.Observe(StandardScope(), Frame(6, 1500, Slot("moved-choice", 0))), OwnedVerificationStatus.Rejected, "duplicate-or-out-of-order-frame");

            foreach (string gate in new[] { "panel-hidden-or-occluded", "panel-incomplete", "unverified-game-surface", "selection-still-visible" })
            {
                v = Ready(empty); v.Observe(StandardScope(), Frame(2, 1100, Slot("chosen", 0)));
                result = v.Observe(StandardScope(), new OwnedPanelFrame(3, 1250, gate != "panel-hidden-or-occluded", gate != "panel-incomplete",
                    gate != "unverified-game-surface", gate == "selection-still-visible", new[] { Slot("chosen", 0) }));
                Is(result, gate == "selection-still-visible" ? OwnedVerificationStatus.Pending : OwnedVerificationStatus.Rejected, gate);
                Check(result.StableFrames == 0, "invalid frame interrupts stability");
                Is(v.Observe(StandardScope(), Frame(4, 1400, Slot("chosen", 0))), OwnedVerificationStatus.Pending, "awaiting-independent-frames");
            }
            v = Ready(empty);
            Is(v.Observe(StandardScope(), null), OwnedVerificationStatus.Rejected, "missing-frame");
            Is(v.Observe(StandardScope(), Frame(2, 4001, Slot("chosen", 0))), OwnedVerificationStatus.Rejected, "capture-gap");
            Is(v.Observe(StandardScope(), Frame(3, 62000, Slot("chosen", 0))), OwnedVerificationStatus.Rejected, "round-evidence-expired");

            v = Ready(empty);
            var invalid = Shape(0); invalid[5] = Double.NaN;
            Is(v.Observe(StandardScope(), Frame(2, 1100, new OwnedPanelSlot("bad", invalid))), OwnedVerificationStatus.Rejected, "invalid-slot-shape");
            Is(v.Observe(StandardScope(), Frame(3, 1250, new OwnedPanelSlot("bad", new double[12]))), OwnedVerificationStatus.Rejected, "invalid-slot-shape");
            Is(v.Observe(StandardScope(), Frame(4, 1400, Slot("duplicate-key", 0), Slot("duplicate-key", 7))), OwnedVerificationStatus.Rejected, "invalid-or-duplicate-slot-key");
            v.Reset();
            Is(v.Observe(StandardScope(), Frame(5, 1550, Slot("chosen", 0))), OwnedVerificationStatus.Rejected, "round-not-armed");

            var configuration = new OwnedVerificationPolicy();
            v = new OwnedAugmentVerifier(configuration); configuration.MatchSimilarity = 0;
            Is(v.BeginRound(StandardScope(), Candidates(), Frame(1, 1000)), OwnedVerificationStatus.Pending, "baseline-ready");
            var candidateInput = Candidates(); v.BeginRound(StandardScope(), candidateInput, Frame(1, 1000)); candidateInput[0].Shape[0] = 0;
            Is(Settle(v, 0, Slot("chosen", 0)), OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease");
            var baselineInput = Slot("old", 3); v.BeginRound(StandardScope(), Candidates(), Frame(1, 1000, baselineInput)); baselineInput.Shape[3] = 0;
            Is(Settle(v, 1, Slot("old", 3), Slot("chosen", 1)), OwnedVerificationStatus.VerifiedCandidate, "visual-candidate-matches-selection-lease");
            var invalidCandidates = Candidates(); invalidCandidates[0] = new OwnedCandidateShape("left", new[] { Double.NaN, 0.0, 1.0 });
            Is(v.BeginRound(StandardScope(), invalidCandidates, Frame(1, 1000)), OwnedVerificationStatus.Rejected, "invalid-candidate-shape");
            var badPolicy = new OwnedVerificationPolicy(); badPolicy.RequiredIndependentFrames = 1;
            Is(new OwnedAugmentVerifier(badPolicy).BeginRound(StandardScope(), Candidates(), Frame(1, 1000)), OwnedVerificationStatus.Rejected, "invalid-policy");
            return new Dictionary<string, object> { { "mode", "offline-no-ui" }, { "liveGameVerified", false }, { "provisional", true },
                { "checks", checks }, { "feature", "owned-augment-visual-evidence-core" }, { "runtimePanelLocatorImplemented", false },
                { "actualSelectionConfirmed", false }, { "limitation", OwnedVerificationResult.Limitation } };
        }
    }
}
