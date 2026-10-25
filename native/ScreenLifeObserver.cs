using System;
using System.Collections.Generic;
using System.Drawing;

namespace HexGuide.Desktop
{
    // Experimental fallback only. The caller owns scheduling, source priority,
    // scope and capture; this class never reads a screen, opens a window or
    // sends input. Do not enable an unreviewed/default HUD calibration.
    public sealed class ScreenLifeFrame
    {
        public long CapturedAtMs, GameEpoch, WindowHandle;
        public Rectangle ClientBounds;
        public int Dpi;
        public bool InterfaceLifeUnknown, ForegroundGameVerified, Unoccluded, Calibrated;
        public bool SceneGray, SceneColorRestored, TimerOcrAttempted, TimerOcrComplete;
        public int? CountdownSeconds;
    }

    public sealed class ScreenLifeResult
    {
        public string State, Code;
        public bool RequestTimerOcr, Respawned;
        public int StableFrames;
        public int? CountdownSeconds;
    }

    public sealed class ScreenLifeObserver
    {
        // A genuine respawn requires uninterrupted observation of death and
        // recovery in the same verified foreground game and physical geometry.
        // Accepted proofs still have a separate 2.5s age limit. This bounded
        // capture-to-capture gap also allows the one-shot OCR child startup and
        // the application's existing timer, without accepting arbitrary gaps.
        public const int MinimumSpacingMs = 300, MaximumGapMs = 6000;
        public const int RequiredFrames = 3, MinimumStableMs = 1000;
        private long lastAt, epoch, window, deadSince, deadFirstAt, recoveryFirstAt;
        private Rectangle bounds;
        private int dpi, deadFrames, recoveryFrames, grayFrames, firstSeconds, lastSeconds;
        private bool scoped, dead;

        // Cheap sampler calls this before scheduling a one-shot local timer
        // OCR. It does not consume a frame or advance life evidence. A caller
        // may debounce gray pixels independently; only Observe can prove life.
        public bool ShouldReadTimer(ScreenLifeFrame frame)
        {
            return frame != null && frame.InterfaceLifeUnknown && frame.Calibrated
                && frame.ForegroundGameVerified && frame.Unoccluded && (dead || frame.SceneGray);
        }

        public ScreenLifeResult Reset(string code)
        {
            scoped = dead = false; lastAt = deadSince = deadFirstAt = recoveryFirstAt = 0;
            deadFrames = recoveryFrames = grayFrames = firstSeconds = lastSeconds = 0;
            return Result("unknown", SafeCode(code), false, false, 0, null);
        }

        public ScreenLifeResult Observe(ScreenLifeFrame frame)
        {
            if (frame == null) return Reset("frame-unavailable");
            if (!frame.InterfaceLifeUnknown) return Reset("interface-authoritative");
            if (!frame.Calibrated) return Reset("experimental-calibration-required");
            if (!frame.ForegroundGameVerified) return Reset("game-not-foreground");
            if (!frame.Unoccluded) return Reset("region-occluded");
            if (frame.GameEpoch < 0 || frame.WindowHandle == 0 || frame.CapturedAtMs < 1 || frame.Dpi < 72 || frame.Dpi > 768
                || frame.ClientBounds.Width < 640 || frame.ClientBounds.Height < 360
                || frame.ClientBounds.Width > 8192 || frame.ClientBounds.Height > 8192
                || (frame.SceneGray && frame.SceneColorRestored)) return Reset("frame-invalid");
            if (scoped && (epoch != frame.GameEpoch || window != frame.WindowHandle || bounds != frame.ClientBounds || dpi != frame.Dpi))
            {
                Reset("context-changed");
                Scope(frame); // The new frame may seed evidence, never finish an old sequence.
                return Result("unknown", "context-changed", frame.SceneGray, false, 0, null);
            }
            if (!scoped) Scope(frame);
            if (lastAt > 0 && frame.CapturedAtMs <= lastAt)
                return Result(dead ? "dead" : "unknown", "frame-not-newer", dead || frame.SceneGray, false, 0, null);
            if (lastAt > 0 && frame.CapturedAtMs - lastAt > MaximumGapMs)
            {
                Reset("observation-gap"); Scope(frame); lastAt = frame.CapturedAtMs;
                return Result("unknown", "observation-gap", frame.SceneGray, false, 0, null);
            }
            if (lastAt > 0 && frame.CapturedAtMs - lastAt < MinimumSpacingMs)
                return Result(dead ? "dead" : "unknown", "frame-too-close", dead || frame.SceneGray, false, 0, null);
            long frameSpacing = lastAt > 0 ? frame.CapturedAtMs - lastAt : 0;
            lastAt = frame.CapturedAtMs;
            grayFrames = frame.SceneGray ? Math.Min(1000, grayFrames + 1) : 0;
            bool wantsOcr = dead || grayFrames >= 2;
            bool timer = frame.TimerOcrAttempted && frame.TimerOcrComplete
                && frame.CountdownSeconds.HasValue && frame.CountdownSeconds.Value >= 1 && frame.CountdownSeconds.Value <= 180;
            bool absent = frame.TimerOcrAttempted && frame.TimerOcrComplete && !frame.CountdownSeconds.HasValue;

            if (!dead)
            {
                if (!frame.SceneGray || !timer)
                {
                    ClearDeathEvidence();
                    return Result("unknown", frame.SceneGray ? "waiting-timer-evidence" : "waiting-death-evidence", wantsOcr, false, 0, null);
                }
                int seconds = frame.CountdownSeconds.Value;
                if (deadFrames > 0 && (seconds > lastSeconds || lastSeconds - seconds > Math.Ceiling(frameSpacing / 1000.0) + 2)) ClearDeathEvidence();
                if (deadFrames == 0) { deadFirstAt = frame.CapturedAtMs; firstSeconds = seconds; }
                lastSeconds = seconds; deadFrames++;
                long elapsed = frame.CapturedAtMs - deadFirstAt;
                // Digit-only static HUD values (levels/gold) cannot satisfy a
                // real countdown. Its decline must also fit elapsed time.
                int decline = firstSeconds - seconds;
                if (decline > 0 && Math.Abs(decline - elapsed / 1000.0) > 2.0)
                {
                    ClearDeathEvidence();
                    return Result("unknown", "timer-inconsistent", true, false, 0, null);
                }
                if (deadFrames >= RequiredFrames && elapsed >= MinimumStableMs && decline >= 1)
                {
                    dead = true; deadSince = frame.CapturedAtMs;
                    return Result("dead", "death-verified-experimental", true, false, deadFrames, seconds);
                }
                return Result("unknown", "verifying-death", true, false, deadFrames, seconds);
            }

            // Require both color restoration and a completed local OCR pass
            // with no digits. Unknown/failed OCR and gray+no timer never mean
            // alive. A partial recovery cannot fire an event.
            if (frame.SceneColorRestored && absent)
            {
                if (recoveryFrames == 0) recoveryFirstAt = frame.CapturedAtMs;
                recoveryFrames++;
                if (recoveryFrames >= RequiredFrames && frame.CapturedAtMs - recoveryFirstAt >= MinimumStableMs)
                {
                    int stable = recoveryFrames;
                    Reset("respawn-verified-experimental"); Scope(frame); lastAt = frame.CapturedAtMs;
                    return Result("alive", "respawn-verified-experimental", false, true, stable, null);
                }
                return Result("dead", "verifying-recovery", true, false, recoveryFrames, null);
            }
            recoveryFrames = 0; recoveryFirstAt = 0;
            // Do not retain a dead decision indefinitely through ambiguous HUD
            // changes. Missing/failing timer readings cannot create a respawn.
            if (!frame.SceneGray || !timer)
            {
                if (frame.CapturedAtMs - deadSince > MaximumGapMs) return Reset("death-evidence-lost");
                return Result("dead", "waiting-recovery-evidence", true, false, 0, null);
            }
            deadSince = frame.CapturedAtMs;
            return Result("dead", "death-verified-experimental", true, false, Math.Max(RequiredFrames, deadFrames), frame.CountdownSeconds);
        }

        private void Scope(ScreenLifeFrame frame)
        { scoped = true; epoch = frame.GameEpoch; window = frame.WindowHandle; bounds = frame.ClientBounds; dpi = frame.Dpi; }
        private void ClearDeathEvidence() { deadFrames = 0; deadFirstAt = 0; firstSeconds = lastSeconds = 0; }
        private static ScreenLifeResult Result(string state, string code, bool ocr, bool respawned, int stable, int? seconds)
        { return new ScreenLifeResult { State = state, Code = code, RequestTimerOcr = ocr, Respawned = respawned, StableFrames = stable, CountdownSeconds = seconds }; }
        private static string SafeCode(string code)
        {
            switch (code)
            {
                case "interface-authoritative": case "experimental-calibration-required": case "game-not-foreground":
                case "region-occluded": case "frame-invalid": case "frame-unavailable": case "context-changed":
                case "observation-gap": case "death-evidence-lost": case "respawn-verified-experimental": return code;
                default: return "reset";
            }
        }

        public static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool value, string message) { checks++; if (!value) throw new InvalidOperationException(message); };
            Func<long, bool, int?, ScreenLifeFrame> frame = delegate(long at, bool gray, int? seconds)
            { return new ScreenLifeFrame { CapturedAtMs = at, GameEpoch = 1, WindowHandle = 42, ClientBounds = new Rectangle(0, 0, 1920, 1080), Dpi = 96,
                InterfaceLifeUnknown = true, ForegroundGameVerified = true, Unoccluded = true, Calibrated = true,
                SceneGray = gray, SceneColorRestored = !gray, TimerOcrAttempted = true, TimerOcrComplete = true, CountdownSeconds = seconds }; };
            var observer = new ScreenLifeObserver();
            var unavailable = frame(1000, true, 10); unavailable.Calibrated = false;
            check(observer.Observe(unavailable).Code == "experimental-calibration-required", "Uncalibrated screen produced life evidence.");
            var authoritative = frame(1000, true, 10); authoritative.InterfaceLifeUnknown = false;
            check(observer.Observe(authoritative).Code == "interface-authoritative", "Fallback overrode interface life.");
            for (int i = 0; i < 5; i++) check(!observer.Observe(frame(1000 + 500 * i, false, null)).Respawned, "Color at startup was a respawn.");
            observer.Reset("reset");
            for (int i = 0; i < 6; i++) check(observer.Observe(frame(1000 + 500 * i, true, null)).State == "unknown", "Gray alone proved death.");
            observer.Reset("reset");
            for (int i = 0; i < 6; i++) check(observer.Observe(frame(1000 + 500 * i, true, 7)).State == "unknown", "A static number proved death.");
            observer.Reset("reset");
            check(observer.Observe(frame(1000, true, 10)).State == "unknown", "One frame proved death.");
            check(observer.Observe(frame(1500, true, 10)).State == "unknown", "Two frames proved death.");
            check(observer.Observe(frame(2000, true, 9)).State == "dead", "Stable gray and decreasing countdown did not prove death.");
            check(observer.Observe(frame(2500, false, null)).State == "dead", "One color frame proved respawn.");
            check(observer.Observe(frame(3000, false, null)).State == "dead", "Two color frames proved respawn.");
            var recovered = observer.Observe(frame(3500, false, null));
            check(recovered.Respawned && recovered.State == "alive", "Stable color plus absent timer did not prove respawn.");
            check(!observer.Observe(frame(4000, false, null)).Respawned, "Respawn event repeated.");
            Action<ScreenLifeObserver> arm = delegate(ScreenLifeObserver o) { o.Observe(frame(1000, true, 10)); o.Observe(frame(1500, true, 10)); o.Observe(frame(2000, true, 9)); };
            observer = new ScreenLifeObserver(); arm(observer);
            var focus = frame(2500, false, null); focus.ForegroundGameVerified = false;
            check(observer.Observe(focus).Code == "game-not-foreground", "Focus loss retained a life decision.");
            for (int i = 0; i < 3; i++) check(!observer.Observe(frame(3000 + i * 500, false, null)).Respawned, "Alt-tab was treated as respawn.");
            observer = new ScreenLifeObserver(); arm(observer);
            var geometry = frame(2500, false, null); geometry.ClientBounds = new Rectangle(0, 0, 1280, 720);
            check(observer.Observe(geometry).Code == "context-changed", "Geometry change continued death evidence.");
            observer = new ScreenLifeObserver(); arm(observer);
            var otherGame = frame(2500, false, null); otherGame.GameEpoch = 2;
            check(observer.Observe(otherGame).Code == "context-changed", "New game continued death evidence.");
            observer = new ScreenLifeObserver(); arm(observer);
            check(observer.Observe(frame(9000, false, null)).Code == "observation-gap", "An observation gap proved respawn.");
            observer = new ScreenLifeObserver(); arm(observer);
            for (int i = 0; i < 5; i++) { var ambiguous = frame(2500 + 500 * i, false, null); ambiguous.TimerOcrComplete = false; check(!observer.Observe(ambiguous).Respawned, "OCR failure was timer absence."); }
            observer = new ScreenLifeObserver(); arm(observer);
            var transient = frame(2500, true, null); transient.TimerOcrComplete = false;
            check(observer.Observe(transient).State == "dead", "One uncertain timer erased an otherwise continuous death chain.");
            observer.Observe(frame(3000, false, null)); observer.Observe(frame(3500, false, null));
            check(observer.Observe(frame(4000, false, null)).Respawned, "A transient unknown timer prevented later independent recovery evidence.");
            observer = new ScreenLifeObserver(); arm(observer);
            var covered = frame(2500, false, null); covered.Unoccluded = false;
            check(observer.Observe(covered).Code == "region-occluded", "Occluded HUD retained evidence.");
            observer = new ScreenLifeObserver(); observer.Observe(frame(1000, true, 10));
            check(observer.Observe(frame(1000, true, 9)).Code == "frame-not-newer", "Duplicate frame counted as independent.");
            check(observer.Observe(frame(1100, true, 9)).Code == "frame-too-close", "Too-close frame counted as independent.");
            observer = new ScreenLifeObserver(); observer.Observe(frame(1000, true, 10)); observer.Observe(frame(1500, true, 9));
            check(observer.Observe(frame(2000, true, 12)).State == "unknown", "Increasing countdown proved death.");
            return checks;
        }
    }

    public sealed class ScreenLifePixelSummary
    {
        public double MeanSaturation, MeanLuminance, NonBlackRatio;
        public int Samples;
    }

    public static class ScreenLifePixels
    {
        // No image or RGB array is returned. The input must be an already
        // authorized in-memory game ROI; no capture occurs in this helper.
        public static ScreenLifePixelSummary Measure(Bitmap bitmap)
        {
            if (bitmap == null || bitmap.Width < 8 || bitmap.Height < 8 || bitmap.Width > 1024 || bitmap.Height > 1024)
                throw new ArgumentException("Invalid numeric sampling region.");
            var result = new ScreenLifePixelSummary();
            int nonBlack = 0;
            for (int row = 0; row < 8; row++) for (int column = 0; column < 12; column++)
            {
                int x = Math.Min(bitmap.Width - 1, (int)((column + .5) * bitmap.Width / 12));
                int y = Math.Min(bitmap.Height - 1, (int)((row + .5) * bitmap.Height / 8));
                Color pixel = bitmap.GetPixel(x, y);
                int max = Math.Max(pixel.R, Math.Max(pixel.G, pixel.B)), min = Math.Min(pixel.R, Math.Min(pixel.G, pixel.B));
                double luminance = (.2126 * pixel.R + .7152 * pixel.G + .0722 * pixel.B) / 255;
                if (luminance > .04) { nonBlack++; result.MeanSaturation += max == 0 ? 0 : (max - min) / (double)max; }
                result.MeanLuminance += luminance; result.Samples++;
            }
            result.MeanSaturation /= Math.Max(1, nonBlack); result.MeanLuminance /= result.Samples;
            result.NonBlackRatio = nonBlack / (double)result.Samples;
            return result;
        }
    }
}
