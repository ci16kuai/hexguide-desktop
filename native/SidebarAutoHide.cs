using System;
using System.Drawing;
using System.Collections.Generic;
using System.Globalization;

namespace HexGuide.Desktop
{
    // This state decides only whether an already allowed sidebar is compact.
    // The existing visibility policy still owns manual close, game exposure,
    // foreground scope and pinning. No model, mouse, window or wall clock is read.
    internal sealed class SidebarIdleState
    {
        internal const int DefaultDelaySeconds = 10, MinimumDelaySeconds = 5, MaximumDelaySeconds = 300;
        internal long DelayMilliseconds { get; private set; }
        private bool clockKnown, wasVisible;
        private long lastNow, lastAttention;
        internal bool Collapsed { get; private set; }

        internal SidebarIdleState(int delaySeconds = DefaultDelaySeconds)
        {
            ValidateDelay(delaySeconds);
            DelayMilliseconds = delaySeconds * 1000L;
        }

        internal bool SetDelaySeconds(int delaySeconds, long monotonicMs)
        {
            ValidateDelay(delaySeconds);
            if (DelayMilliseconds == delaySeconds * 1000L) return false;
            DelayMilliseconds = delaySeconds * 1000L;
            // A saved change grants the new full interval. Repeated model polls
            // with the same setting must not restart the countdown.
            Reveal(monotonicMs);
            return true;
        }

        private static void ValidateDelay(int seconds)
        {
            if (seconds < MinimumDelaySeconds || seconds > MaximumDelaySeconds)
                throw new ArgumentOutOfRangeException("seconds");
        }

        internal bool Observe(long monotonicMs, bool visible, bool pointerInside, bool interactionBusy, bool choosing)
        {
            if (!clockKnown || monotonicMs < 0 || monotonicMs < lastNow)
            {
                Begin(monotonicMs, visible);
                return false;
            }
            lastNow = monotonicMs;
            if (!visible)
            {
                // A covered game/manual hide does not accrue a hidden timeout.
                // Returning to an allowed surface gets a full readable interval.
                wasVisible = false;
                lastAttention = monotonicMs;
                Collapsed = false;
                return false;
            }
            if (!wasVisible)
            {
                wasVisible = true;
                lastAttention = monotonicMs;
                Collapsed = false;
            }
            if (pointerInside || interactionBusy || choosing)
            {
                lastAttention = monotonicMs;
                Collapsed = false;
                return false;
            }
            // Values are nonnegative and ordered, so subtraction cannot overflow.
            if (monotonicMs - lastAttention >= DelayMilliseconds) Collapsed = true;
            return Collapsed;
        }

        internal void Reveal(long monotonicMs)
        {
            // Explicit reveal is attention, not a new persistent visibility intent.
            // If the sidebar is hidden, the next actual visible tick rearms it.
            if (!clockKnown || monotonicMs < 0 || monotonicMs < lastNow)
            {
                Begin(monotonicMs, wasVisible);
                return;
            }
            lastNow = lastAttention = monotonicMs;
            Collapsed = false;
        }

        internal void Reset(long monotonicMs)
        {
            Begin(monotonicMs, false);
        }

        private void Begin(long monotonicMs, bool visible)
        {
            clockKnown = monotonicMs >= 0;
            lastNow = lastAttention = Math.Max(0, monotonicMs);
            wasVisible = visible;
            Collapsed = false;
        }

        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { if (!condition) throw new InvalidOperationException(message); checks++; };

            var idle = new SidebarIdleState(30);
            check(!idle.Observe(1000, true, false, false, false), "Sidebar collapsed on its first visible tick.");
            check(!idle.Observe(30999, true, false, false, false), "Sidebar collapsed before thirty seconds of pointer absence.");
            check(idle.Observe(31000, true, false, false, false), "Thirty seconds of pointer absence did not compact the sidebar.");
            check(idle.Observe(32000, true, false, false, false), "Normal polling expanded an idle sidebar.");
            check(!idle.Observe(32001, true, true, false, false), "Hovering the edge strip did not restore the sidebar.");
            check(!idle.Observe(62000, true, false, false, false), "Hover restoration did not restart the full idle interval.");
            check(idle.Observe(62001, true, false, false, false), "The restored sidebar never returned to idle.");

            var hover = new SidebarIdleState(30);
            for (long time = 0; time <= 120000; time += 5000)
                check(!hover.Observe(time, true, true, false, false), "A continuously hovered sidebar became compact.");
            check(!hover.Observe(149999, true, false, false, false), "Pointer departure used startup rather than latest hover time.");
            check(hover.Observe(150000, true, false, false, false), "Pointer departure did not start an idle interval.");

            var choosing = new SidebarIdleState(30);
            choosing.Observe(0, true, false, false, false);
            check(choosing.Observe(30000, true, false, false, false), "Choice fixture failed to enter compact state.");
            check(!choosing.Observe(30001, true, false, false, true), "A genuine active choice did not restore the sidebar.");
            check(!choosing.Observe(120000, true, false, false, true), "The sidebar compacted during a genuine active choice.");
            check(!choosing.Observe(149999, true, false, false, false), "Choice completion did not grant a fresh idle interval.");
            check(choosing.Observe(150000, true, false, false, false), "Resolved choice attention kept the sidebar open indefinitely.");

            var busy = new SidebarIdleState(30);
            busy.Observe(0, true, false, false, false);
            check(!busy.Observe(30000, true, false, true, false), "A drag or active interaction was interrupted by idle compaction.");
            check(!busy.Observe(59999, true, false, false, false), "Interaction completion lost its new idle interval.");
            check(busy.Observe(60000, true, false, false, false), "The sidebar never compacted after an interaction ended.");
            busy.Reveal(61000);
            check(!busy.Collapsed, "Explicit reveal left the sidebar compact.");
            check(!busy.Observe(90999, true, false, false, false), "Explicit reveal did not restart the idle interval.");
            check(busy.Observe(91000, true, false, false, false), "Explicit reveal disabled future idle behavior.");

            var hidden = new SidebarIdleState(30);
            hidden.Observe(0, true, false, false, false);
            check(hidden.Observe(30000, true, false, false, false), "Hidden fixture did not compact.");
            check(!hidden.Observe(30001, false, false, false, true), "A hidden sidebar kept a compact/reopen demand.");
            check(!hidden.Observe(900000, false, true, true, true), "Attention over a hidden surface produced a compact state.");
            check(!hidden.Observe(900001, true, false, false, false), "Returning from game occlusion inherited the hidden timeout.");
            check(!hidden.Observe(930000, true, false, false, false), "Returning visibility did not restart thirty seconds.");
            check(hidden.Observe(930001, true, false, false, false), "Returning visibility permanently disabled idle compaction.");
            hidden.Reset(940000);
            check(!hidden.Collapsed && !hidden.Observe(1000000, true, false, false, false), "Session reset retained a stale idle timeout.");
            check(hidden.Observe(1030000, true, false, false, false), "Reset sidebar could not start a fresh idle interval.");

            var clock = new SidebarIdleState(30);
            clock.Observe(100000, true, false, false, false);
            check(clock.Observe(130000, true, false, false, false), "Clock fixture did not compact.");
            check(!clock.Observe(500, true, false, false, false), "A backwards clock kept stale compact state.");
            check(!clock.Observe(30499, true, false, false, false), "A backwards clock produced an early timeout.");
            check(clock.Observe(30500, true, false, false, false), "Clock rollback did not recover a normal idle interval.");
            check(!clock.Observe(-1, true, false, false, false), "A negative clock compacted the sidebar.");
            check(!clock.Observe(-2, true, false, false, false), "Repeated invalid clocks compacted the sidebar.");
            check(!clock.Observe(1000, true, false, false, false), "Invalid clock recovery inherited an old deadline.");
            check(clock.Observe(31000, true, false, false, false), "Invalid clock recovery never compacted.");
            clock.Reveal(-1);
            check(!clock.Collapsed && !clock.Observe(50000, true, false, false, false), "Invalid explicit reveal retained stale state.");
            clock.Reset(long.MaxValue - 30000);
            check(!clock.Observe(long.MaxValue - 30000, true, false, false, false), "Large monotonic value compacted immediately.");
            check(clock.Observe(long.MaxValue, true, false, false, false), "Large monotonic value broke elapsed-time arithmetic.");
            var configurable = new SidebarIdleState();
            check(configurable.DelayMilliseconds == 10000, "The default idle timeout is not ten seconds.");
            configurable.Observe(0, true, false, false, false);
            check(!configurable.Observe(9999, true, false, false, false), "Default timeout fired before ten seconds.");
            check(configurable.Observe(10000, true, false, false, false), "Default timeout did not fire at ten seconds.");
            check(configurable.SetDelaySeconds(5, 11000) && !configurable.Collapsed, "A saved timeout did not restart the full interval.");
            check(!configurable.SetDelaySeconds(5, 15000), "Polling reapplied an unchanged timeout.");
            check(!configurable.Observe(15999, true, false, false, false), "The minimum timeout fired early.");
            check(configurable.Observe(16000, true, false, false, false), "Polling prolonged the configured timeout.");
            configurable.SetDelaySeconds(300, 17000);
            check(!configurable.Observe(316999, true, false, false, false), "The maximum timeout fired early.");
            check(configurable.Observe(317000, true, false, false, false), "The maximum timeout was ignored.");
            check(!configurable.Observe(317001, false, false, false, false), "Hiding retained compact intent.");
            configurable.SetDelaySeconds(10, 318000);
            check(!configurable.Observe(500000, true, false, false, false), "Changing settings while hidden consumed the next visible interval.");
            check(configurable.Observe(510000, true, false, false, false), "The saved delay was lost after reappearance.");
            foreach (int invalid in new[] { -1, 0, 4, 301, int.MaxValue })
            {
                bool rejected = false;
                try { configurable.SetDelaySeconds(invalid, 510001); } catch (ArgumentOutOfRangeException) { rejected = true; }
                check(rejected && configurable.DelayMilliseconds == 10000, "Invalid timeout changed the last accepted setting.");
            }
            return checks + SidebarIdleGeometry.ValidateFixtures();
        }
    }

    internal static class SidebarOfferAttention
    {
        // Only the backend's short-lived validated-card lease can hold the
        // sidebar open. Stored pending cards and life/death alone never do so.
        internal static long RemainingMilliseconds(Dictionary<string, object> model, DateTime utcNow)
        {
            var attention = ModelValue.Object(model, "offerAttention");
            long epoch, revision;
            if (!ModelValue.Boolean(attention, "active") || ModelValue.Text(attention, "pendingId").Length == 0
                || ModelValue.Text(model, "gameId").Length == 0 || ModelValue.Text(model, "phase") != "InProgress"
                || ModelValue.Text(model, "stage") != "live" || ModelValue.Text(ModelValue.Object(model, "connection"), "status") != "connected"
                || !ModelValue.Boolean(ModelValue.Object(model, "mode"), "known") || !ModelValue.Boolean(ModelValue.Object(model, "mode"), "isMayhem")
                || !ModelValue.Integer(model, "gameEpoch", out epoch) || epoch < 0
                || !ModelValue.Integer(model, "sessionRevision", out revision) || revision < 0) return 0;
            DateTimeOffset captured, expires;
            if (!DateTimeOffset.TryParse(ModelValue.Text(attention, "capturedAt"), CultureInfo.InvariantCulture, DateTimeStyles.None, out captured)
                || !DateTimeOffset.TryParse(ModelValue.Text(attention, "expiresAt"), CultureInfo.InvariantCulture, DateTimeStyles.None, out expires)) return 0;
            double age = (utcNow - captured.UtcDateTime).TotalMilliseconds;
            double duration = (expires - captured).TotalMilliseconds;
            double remaining = (expires.UtcDateTime - utcNow).TotalMilliseconds;
            if (age < -1000 || age >= 8000 || duration <= 0 || duration > 8000 || remaining <= 0) return 0;
            return (long)Math.Min(8000, remaining);
        }
    }

    internal static class SidebarIdleGeometry
    {
        // A narrow edge affordance, scaled by display DPI rather than text size.
        // Caller converts this with display DPI, independently of text/UI scale.
        internal const int EdgeWidthDip = 12;

        internal static Rectangle CompactBounds(Rectangle expanded, Rectangle area, bool rightSide, int edgeWidth)
        {
            if (area.Width <= 0 || area.Height <= 0) return Rectangle.Empty;
            int width = Math.Min(area.Width, Math.Max(1, edgeWidth));
            int height = Math.Min(area.Height, Math.Max(1, expanded.Height));
            long right = (long)area.X + area.Width;
            long bottom = (long)area.Y + area.Height;
            long x = rightSide ? right - width : area.X;
            long y = Math.Max((long)area.Y, Math.Min((long)expanded.Y, bottom - height));
            // Real monitor coordinates fit int; malformed synthetic areas fail
            // closed rather than wrapping the window to another display.
            if (x < int.MinValue || x > int.MaxValue || y < int.MinValue || y > int.MaxValue)
                return Rectangle.Empty;
            return new Rectangle((int)x, (int)y, width, height);
        }

        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { if (!condition) throw new InvalidOperationException(message); checks++; };
            var area = new Rectangle(-1920, 40, 1920, 1040);
            var expanded = new Rectangle(-1800, 240, 324, 720);
            check(CompactBounds(expanded, area, false, 38) == new Rectangle(-1920, 240, 38, 720), "Left edge compact bounds ignored the placement area.");
            check(CompactBounds(expanded, area, true, 38) == new Rectangle(-38, 240, 38, 720), "Right edge compact bounds leaked to another monitor.");
            check(CompactBounds(expanded, area, false, 76).Width == 76, "Display-scaled edge width was ignored.");
            check(CompactBounds(new Rectangle(0, -200, 324, 720), area, false, 38).Top == 40, "Compact bounds escaped above the working area.");
            check(CompactBounds(new Rectangle(0, 1000, 324, 720), area, true, 38).Bottom == 1080, "Compact bounds escaped below the working area.");
            check(CompactBounds(expanded, new Rectangle(0, 0, 20, 10), true, 38) == new Rectangle(0, 0, 20, 10), "Small working area was not clamped.");
            check(CompactBounds(expanded, area, false, 0).Width == 1, "Invalid edge width produced an unreachable handle.");
            check(CompactBounds(expanded, Rectangle.Empty, false, 38) == Rectangle.Empty, "Empty placement area produced geometry.");
            return checks;
        }
    }
}
