using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Point = System.Drawing.Point;
using Size = System.Drawing.Size;

namespace HexGuide.Desktop
{
    // One exact HWND, one worker, one immutable latest CPU surface. This transport
    // never reads a desktop/monitor, inspects another application's pixels, or
    // decides whether an augment was selected. The caller owns returned ROIs.
    internal sealed class GameWindowCapture : IDisposable
    {
        internal const int DemandMilliseconds = 800, IntervalMilliseconds = 40, MaximumAgeMilliseconds = 150;
        internal const long MaximumSurfaceBytes = 40L * 1024 * 1024, MaximumRegionBytes = 16L * 1024 * 1024;
        private readonly object gate = new object();
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private readonly Func<IntPtr, bool> verifyGame;
        private readonly bool requireForeground;
        private Thread worker;
        private bool disposed;
        private GameWindowCaptureTarget wanted;
        private long demandUntil, generation, sequence;
        private CachedFrame latest;
        private string lastCode = "window-capture-warming";

        private static class SharedInstance { internal static readonly GameWindowCapture Value = new GameWindowCapture(); }
        internal static GameWindowCapture Shared { get { return SharedInstance.Value; } }
        internal GameWindowCapture() : this(GameWindow.IsVerifiedGame, true) { }
        private GameWindowCapture(Func<IntPtr, bool> verify, bool foreground)
        { verifyGame = verify; requireForeground = foreground; }

#if GAME_WINDOW_CAPTURE_PROBE
        // Excluded from shipping builds. The harness accepts only HWNDs created
        // by its own process and uses no-activate windows on the current desktop.
        internal static GameWindowCapture CreateOwnedProbe(Func<IntPtr, bool> owned)
        { return new GameWindowCapture(owned, false); }
#endif

        internal bool TryRead(IntPtr window, Rectangle expectedClient, Rectangle[] regions,
            long afterFrameTimestamp, out GameWindowCaptureFrame result, out string failure)
        { return TryRead(window, expectedClient, regions, afterFrameTimestamp, 0, 0, out result, out failure); }

        internal bool TryRead(IntPtr window, Rectangle expectedClient, Rectangle[] regions,
            long afterFrameTimestamp, long minFrameTimestamp, out GameWindowCaptureFrame result, out string failure)
        { return TryRead(window, expectedClient, regions, afterFrameTimestamp, minFrameTimestamp, 0, out result, out failure); }

        // minCapturedAtUtcMs is an optional input-edge fence. A cached frame from
        // before the edge must not witness that edge. Not-ready is a retry, not a
        // fabricated observation; the caller retains its original pointer time.
        internal bool TryRead(IntPtr window, Rectangle expectedClient, Rectangle[] regions,
            long afterFrameTimestamp, long minFrameTimestamp, long minCapturedAtUtcMs, out GameWindowCaptureFrame result, out string failure)
        {
            result = null;
            GameWindowCaptureTarget target;
            if (!TryTarget(window, expectedClient, out target, out failure)) { Suspend(); return false; }
            if (!ValidRegions(expectedClient.Size, regions)) { failure = "region-too-large"; return false; }
            CachedFrame sample = null;
            lock (gate)
            {
                if (disposed) { failure = lastCode == "window-capture-unavailable" ? lastCode : "window-capture-stopped"; return false; }
                if (!GameWindowCaptureTarget.Same(wanted, target))
                {
                    wanted = target; generation++; ClearLatest(); lastCode = "window-capture-warming";
                }
                demandUntil = QpcTicks() + DemandMilliseconds * TimeSpan.TicksPerMillisecond;
                if (worker == null)
                {
                    worker = new Thread(Work) { IsBackground = true, Name = "HexGuide window capture" };
                    worker.SetApartmentState(ApartmentState.MTA); worker.Start();
                }
                wake.Set();
                failure = latest == null && lastCode == "captured" ? "window-capture-warming" : lastCode;
                if (latest != null && GameWindowCaptureTarget.Same(latest.Target, target))
                {
                    if (!Fresh(latest.Timestamp, QpcTicks(), afterFrameTimestamp))
                    { failure = latest.Timestamp <= afterFrameTimestamp ? "window-frame-duplicate" : "window-frame-stale"; return false; }
                    if (latest.Timestamp < minFrameTimestamp || latest.CapturedAtUtcMs < minCapturedAtUtcMs)
                    { failure = "window-frame-before-input"; return false; }
                    sample = latest; sample.AddReference();
                }
            }
            if (sample == null) return false;
            try
            {
                result = sample.Copy(regions);
                GameWindowCaptureTarget after;
                if (!TryTarget(window, expectedClient, out after, out failure)
                    || !GameWindowCaptureTarget.Same(target, after))
                { if (failure == null) failure = "client-changed"; Suspend(); return false; }
                lock (gate)
                {
                    if (disposed || sample.Generation != generation || !GameWindowCaptureTarget.Same(wanted, target))
                    { failure = "window-capture-changed"; return false; }
                }
                if (!Fresh(sample.Timestamp, QpcTicks(), afterFrameTimestamp)) { failure = "window-frame-stale"; return false; }
                failure = "captured";
                return true;
            }
            catch { failure = "window-capture-copy-failed"; return false; }
            finally
            {
                sample.Release();
                if (failure != "captured" && result != null) { result.Dispose(); result = null; }
            }
        }

        // Stops requests immediately. The worker owns/disposes its native session;
        // callers never block waiting for a driver or an asynchronous GPU copy.
        internal void Suspend()
        { lock (gate) { wanted = null; demandUntil = 0; generation++; ClearLatest(); if (!disposed) wake.Set(); } }
        public void Dispose()
        { lock (gate) { if (disposed) return; disposed = true; wanted = null; generation++; ClearLatest(); if (worker == null) wake.Dispose(); else wake.Set(); } }
        private void ClearLatest() { if (latest != null) { latest.Release(); latest = null; } }

        private bool StillWanted(GameWindowCaptureTarget target, long currentGeneration)
        { lock (gate) return !disposed && generation == currentGeneration && QpcTicks() <= demandUntil && GameWindowCaptureTarget.Same(wanted, target); }

        private void Work()
        {
            NativeSession session = null;
            GameWindowCaptureTarget active = null;
            long activeGeneration = 0, lastSourceTimestamp = 0, nextCopy = 0, retryAt = 0;
            try
            {
                while (true)
                {
                    GameWindowCaptureTarget target; long currentGeneration;
                    lock (gate)
                    {
                        if (disposed) break;
                        target = QpcTicks() <= demandUntil ? wanted : null;
                        currentGeneration = generation;
                    }
                    string failure = null;
                    GameWindowCaptureTarget verified = null;
                    if (target != null && (!TryTarget(target.Window, target.ClientBounds, out verified, out failure)
                        || !GameWindowCaptureTarget.Same(target, verified))) target = null;
                    if (target == null || activeGeneration != currentGeneration || !GameWindowCaptureTarget.Same(active, target))
                    {
                        if (session != null) { session.Dispose(); session = null; }
                        active = null; lastSourceTimestamp = 0; nextCopy = 0;
                        lock (gate)
                        {
                            ClearLatest();
                            if (failure != null) { wanted = null; generation++; lastCode = failure; }
                        }
                        if (target == null) { wake.WaitOne(40); continue; }
                    }
                    if (QpcTicks() < retryAt) { wake.WaitOne(20); continue; }
                    try
                    {
                        if (session == null)
                        {
                            session = NativeSession.Create(target,
                                delegate { return StillWanted(target, currentGeneration) && MatchesNow(target); });
                            active = target; activeGeneration = currentGeneration;
                        }
                        if (QpcTicks() < nextCopy) { wake.WaitOne(8); continue; }
                        nextCopy = QpcTicks() + IntervalMilliseconds * TimeSpan.TicksPerMillisecond;
                        long timestamp;
                        SoftwareBitmap bitmap = session.Take(lastSourceTimestamp,
                            delegate { return StillWanted(target, currentGeneration) && MatchesNow(target); },
                            delegate { lock (gate) { ClearLatest(); lastCode = "window-capture-copy-timeout"; } }, out timestamp, out failure);
                        if (bitmap == null)
                        {
                            if (!IsWaiting(failure)) throw new CaptureFailure(failure);
                            lock (gate) { if (latest == null) lastCode = failure; }
                            continue;
                        }
                        CachedFrame candidate = null;
                        try
                        {
                            if (!StillWanted(target, currentGeneration) || !MatchesNow(target)
                                || !Fresh(timestamp, QpcTicks(), lastSourceTimestamp)) continue;
                            long ageTicks = Math.Max(0, QpcTicks() - timestamp);
                            long capturedAt = UtcMilliseconds() - (long)Math.Ceiling(ageTicks / (double)TimeSpan.TicksPerMillisecond);
                            candidate = new CachedFrame(bitmap, target, timestamp, capturedAt, currentGeneration, ++sequence);
                            bitmap = null;
                            lock (gate)
                            {
                                if (disposed || generation != currentGeneration || QpcTicks() > demandUntil) continue;
                                ClearLatest(); latest = candidate; candidate = null; lastCode = "captured";
                                lastSourceTimestamp = timestamp;
                            }
                        }
                        finally { if (bitmap != null) bitmap.Dispose(); if (candidate != null) candidate.Release(); }
                    }
                    catch (CaptureFailure error)
                    {
                        lock (gate) { ClearLatest(); lastCode = error.Code; }
                        if (session != null) { session.Dispose(); session = null; }
                        active = null; retryAt = QpcTicks() + 500 * TimeSpan.TicksPerMillisecond;
                    }
                    catch
                    {
                        lock (gate) { ClearLatest(); lastCode = "window-capture-unavailable"; }
                        if (session != null) { session.Dispose(); session = null; }
                        active = null; retryAt = QpcTicks() + 500 * TimeSpan.TicksPerMillisecond;
                    }
                }
            }
            catch
            {
                // No background exception may terminate the desktop app. A
                // permanently failed worker exposes only guarded fallback.
                lock (gate) { disposed = true; wanted = null; lastCode = "window-capture-unavailable"; }
            }
            finally { if (session != null) session.Dispose(); lock (gate) ClearLatest(); wake.Dispose(); }
        }

        private bool MatchesNow(GameWindowCaptureTarget target)
        { GameWindowCaptureTarget current; string ignored; return TryTarget(target.Window, target.ClientBounds, out current, out ignored) && GameWindowCaptureTarget.Same(target, current); }

        private bool TryTarget(IntPtr window, Rectangle expectedClient, out GameWindowCaptureTarget target, out string failure)
        {
            target = null; failure = "window-capture-unavailable"; IntPtr dpi = IntPtr.Zero;
            try
            {
                dpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
                if (dpi == IntPtr.Zero) dpi = SetThreadDpiAwarenessContext(new IntPtr(-3));
                if (dpi == IntPtr.Zero) { failure = "dpi-unavailable"; return false; }
                if (!verifyGame(window)) { failure = "game-unverified"; return false; }
                if (requireForeground && GetForegroundWindow() != window) { failure = "game-not-foreground"; return false; }
                if (!IsWindowVisible(window) || IsIconic(window) || GetAncestor(window, 2) != window)
                { failure = "game-not-visible"; return false; }
                var name = new StringBuilder(128); GetClassName(window, name, name.Capacity);
                if (requireForeground && name.ToString() != "RiotWindowClass") { failure = "game-unverified"; return false; }
                uint processId;
                if (GetWindowThreadProcessId(window, out processId) == 0 || processId == 0) return false;
                long started;
                using (var process = Process.GetProcessById((int)processId))
                { if (process.HasExited) return false; started = process.StartTime.ToUniversalTime().Ticks; }
                NativeRect client, frame; var origin = new NativePoint(); var end = new NativePoint(); int cloaked;
                if (DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int)) != 0 || cloaked != 0)
                { failure = "game-not-visible"; return false; }
                if (!GetClientRect(window, out client) || client.Left != 0 || client.Top != 0 || client.Right <= 0 || client.Bottom <= 0)
                { failure = "client-unavailable"; return false; }
                end.X = client.Right; end.Y = client.Bottom;
                if (!ClientToScreen(window, ref origin) || !ClientToScreen(window, ref end)
                    || end.X - origin.X != client.Right || end.Y - origin.Y != client.Bottom)
                { failure = "client-unavailable"; return false; }
                Rectangle bounds = new Rectangle(origin.X, origin.Y, client.Right, client.Bottom);
                if (bounds != expectedClient) { failure = "client-changed"; return false; }
                if (DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(NativeRect))) != 0)
                { failure = "window-geometry-unavailable"; return false; }
                Rectangle capture = Rectangle.FromLTRB(frame.Left, frame.Top, frame.Right, frame.Bottom);
                if (!ValidMapping(bounds, capture)) { failure = "window-geometry-unavailable"; return false; }
                uint finalProcessId;
                if (GetWindowThreadProcessId(window, out finalProcessId) == 0 || finalProcessId != processId
                    || requireForeground && GetForegroundWindow() != window)
                { failure = "game-not-foreground"; return false; }
                target = new GameWindowCaptureTarget(window, processId, started, bounds, capture);
                failure = null; return true;
            }
            catch { return false; }
            finally { if (dpi != IntPtr.Zero) { try { SetThreadDpiAwarenessContext(dpi); } catch { } } }
        }

        internal static bool Fresh(long timestamp, long nowQpcTicks, long afterTimestamp)
        { return timestamp > 0 && timestamp > afterTimestamp && timestamp <= nowQpcTicks && nowQpcTicks - timestamp <= MaximumAgeMilliseconds * TimeSpan.TicksPerMillisecond; }
        internal static bool IsPending(string code)
        { return code == "window-capture-warming" || code == "window-frame-pending" || code == "window-frame-duplicate" || code == "window-frame-stale" || code == "window-frame-before-input"; }
        internal static bool IsWaiting(string code) { return IsPending(code); }
        internal static bool CanUseDesktopFallback(string code)
        { return code == "window-capture-unsupported" || code == "window-capture-unavailable" || code == "window-content-size-mismatch" || code == "window-capture-copy-failed" || code == "window-capture-copy-timeout"; }
        internal static bool ValidMapping(Rectangle client, Rectangle capture)
        { return client.Width > 0 && client.Height > 0 && capture.Width > 0 && capture.Height > 0 && capture.Width <= 16384 && capture.Height <= 16384 && (long)capture.Width * capture.Height * 4 <= MaximumSurfaceBytes && capture.Contains(client); }
        internal static bool ValidRegions(Size client, Rectangle[] regions)
        {
            if (client.Width <= 0 || client.Height <= 0 || client.Width > 16384 || client.Height > 16384
                || regions == null || regions.Length < 1 || regions.Length > 40) return false;
            long bytes = 0; var bounds = new Rectangle(Point.Empty, client);
            foreach (Rectangle region in regions)
            { if (region.Width <= 0 || region.Height <= 0 || !bounds.Contains(region)) return false; bytes += (long)region.Width * region.Height * 4; if (bytes > MaximumRegionBytes) return false; }
            return true;
        }
        internal static long QpcTicks()
        { long stamp = Stopwatch.GetTimestamp(); return checked(stamp / Stopwatch.Frequency * TimeSpan.TicksPerSecond + stamp % Stopwatch.Frequency * TimeSpan.TicksPerSecond / Stopwatch.Frequency); }
        private static long UtcMilliseconds() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond; }

        // Pure capture-contract checks. No native capture/session/worker starts.
        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool passed, string reason)
            { checks++; if (!passed) throw new InvalidOperationException("Window capture contract: " + reason); };
            const long now = 10000000;
            check(Fresh(now, now, 0), "current frame rejected");
            check(Fresh(now - 1500000, now, 0), "freshness boundary rejected");
            check(!Fresh(now - 1500001, now, 0), "stale frame accepted");
            check(!Fresh(now + 1, now, 0), "future frame accepted");
            check(!Fresh(now, now, now), "cached frame became a new observation");
            check(!Fresh(0, now, 0), "missing timestamp accepted");
            check(!Fresh(now - 1, now, now), "out-of-order source accepted");
            var client = new Rectangle(20, 30, 640, 480);
            var frame = new Rectangle(12, 2, 656, 516);
            check(ValidMapping(client, frame), "physical nonclient offset rejected");
            check(ValidMapping(client, client), "borderless mapping rejected");
            check(!ValidMapping(client, new Rectangle(21, 30, 640, 480)), "clipped client accepted");
            check(!ValidMapping(client, new Rectangle(0, 0, 16384, 16384)), "surface budget exceeded");
            check(!ValidMapping(Rectangle.Empty, frame), "empty client accepted");
            var a = new GameWindowCaptureTarget(new IntPtr(1), 2, 3, client, frame);
            check(GameWindowCaptureTarget.Same(a, new GameWindowCaptureTarget(new IntPtr(1), 2, 3, client, frame)), "same target rejected");
            check(!GameWindowCaptureTarget.Same(a, new GameWindowCaptureTarget(new IntPtr(2), 2, 3, client, frame)), "HWND reuse boundary ignored");
            check(!GameWindowCaptureTarget.Same(a, new GameWindowCaptureTarget(new IntPtr(1), 4, 3, client, frame)), "PID change ignored");
            check(!GameWindowCaptureTarget.Same(a, new GameWindowCaptureTarget(new IntPtr(1), 2, 4, client, frame)), "process restart ignored");
            check(!GameWindowCaptureTarget.Same(a, new GameWindowCaptureTarget(new IntPtr(1), 2, 3, new Rectangle(21, 30, 640, 480), frame)), "client movement ignored");
            check(!GameWindowCaptureTarget.Same(a, new GameWindowCaptureTarget(new IntPtr(1), 2, 3, client, client)), "capture transform change ignored");
            check(!GameWindowCaptureTarget.Same(a, null), "missing target accepted");
            check(ValidRegions(client.Size, new[] { new Rectangle(0, 0, 640, 480) }), "complete client region rejected");
            check(!ValidRegions(client.Size, new[] { new Rectangle(-1, 0, 2, 2) }), "negative crop accepted");
            check(!ValidRegions(client.Size, new[] { new Rectangle(639, 479, 2, 2) }), "out-of-bounds crop accepted");
            check(!ValidRegions(client.Size, new[] { Rectangle.Empty }), "empty crop accepted");
            check(!ValidRegions(client.Size, new Rectangle[41]), "region count budget exceeded");
            check(!ValidRegions(new Size(4096, 4096), new[] { new Rectangle(0, 0, 4096, 4096) }), "ROI byte budget exceeded");
            foreach (string code in new[] { "window-capture-warming", "window-frame-pending", "window-frame-duplicate", "window-frame-stale", "window-frame-before-input" })
            { check(IsWaiting(code), "retry category lost"); check(!CanUseDesktopFallback(code), "pending frame fell back to another source"); }
            foreach (string code in new[] { "game-not-foreground", "game-unverified", "game-not-visible", "client-changed", "window-capture-changed", "dpi-unavailable", null })
            { check(!IsWaiting(code), "eligibility failure treated as pending"); check(!CanUseDesktopFallback(code), "eligibility failure bypassed capture boundary"); }
            check(CanUseDesktopFallback("window-capture-unsupported"), "unsupported fallback unavailable");
            check(CanUseDesktopFallback("window-content-size-mismatch"), "unsupported mapping fallback unavailable");
            using (var owned = new GameWindowCaptureFrame(a, 100, 200, 3, 4, 2))
            {
                owned.Regions[0] = new Bitmap(1, 1); owned.Regions[1] = new Bitmap(1, 1);
                check(owned.FrameTimestamp == 100 && owned.CapturedAtUtcMs == 200 && owned.Generation == 3 && owned.Sequence == 4, "source metadata changed");
                owned.Dispose(); check(owned.Regions[0] == null && owned.Regions[1] == null, "ROI ownership leaked");
            }
            using (var idle = new GameWindowCapture()) { check(idle.worker == null && idle.latest == null, "idle constructor started capture"); }
            return checks;
        }

        private sealed class CaptureFailure : Exception
        { internal readonly string Code; internal CaptureFailure(string code) { Code = code ?? "window-capture-unavailable"; } }

        private sealed class CachedFrame
        {
            internal readonly GameWindowCaptureTarget Target;
            internal readonly long Timestamp, CapturedAtUtcMs, Generation, Sequence;
            private readonly SoftwareBitmap bitmap;
            private int references = 1;
            internal CachedFrame(SoftwareBitmap image, GameWindowCaptureTarget target, long stamp, long utc, long generation, long sequence)
            { bitmap = image; Target = target; Timestamp = stamp; CapturedAtUtcMs = utc; Generation = generation; Sequence = sequence; }
            internal void AddReference() { Interlocked.Increment(ref references); }
            internal void Release() { if (Interlocked.Decrement(ref references) == 0) CloseQuietly(bitmap); }
            internal GameWindowCaptureFrame Copy(Rectangle[] regions)
            {
                var result = new GameWindowCaptureFrame(Target, Timestamp, CapturedAtUtcMs, Generation, Sequence, regions.Length);
                try
                {
                    using (BitmapBuffer buffer = bitmap.LockBuffer(BitmapBufferAccessMode.Read))
                    using (IMemoryBufferReference reference = buffer.CreateReference())
                    {
                        IntPtr memory; uint capacity;
                        ((IMemoryBufferByteAccess)reference).GetBuffer(out memory, out capacity);
                        BitmapPlaneDescription plane = buffer.GetPlaneDescription(0);
                        if (memory == IntPtr.Zero || plane.Stride < bitmap.PixelWidth * 4 || plane.StartIndex < 0)
                            throw new CaptureFailure("window-capture-copy-failed");
                        for (int index = 0; index < regions.Length; index++)
                        {
                            Rectangle roi = regions[index]; roi.Offset(Target.ClientBounds.Left - Target.CaptureBounds.Left, Target.ClientBounds.Top - Target.CaptureBounds.Top);
                            long end = (long)plane.StartIndex + (long)(roi.Bottom - 1) * plane.Stride + (long)roi.Right * 4;
                            if (end > capacity) throw new CaptureFailure("window-capture-copy-failed");
                            Bitmap cropped = new Bitmap(roi.Width, roi.Height, PixelFormat.Format32bppRgb);
                            result.Regions[index] = cropped;
                            BitmapData data = cropped.LockBits(new Rectangle(Point.Empty, cropped.Size), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                            try
                            {
                                // Copy only requested rows. No full-window byte[] or
                                // WinRT Buffer/DataReader allocation enters the GC heap.
                                for (int row = 0; row < roi.Height; row++)
                                    CopyMemory(IntPtr.Add(data.Scan0, row * data.Stride),
                                        IntPtr.Add(memory, checked(plane.StartIndex + (roi.Y + row) * plane.Stride + roi.X * 4)), new UIntPtr((uint)(roi.Width * 4)));
                            }
                            finally { cropped.UnlockBits(data); }
                        }
                    }
                    return result;
                }
                catch { result.Dispose(); throw; }
            }
        }

        private sealed class NativeSession : IDisposable
        {
            private IDirect3DDevice device;
            private GraphicsCaptureItem item;
            private Direct3D11CaptureFramePool pool;
            private GraphicsCaptureSession session;
            private SizeInt32 size;
            internal static NativeSession Create(GameWindowCaptureTarget target, Func<bool> eligible)
            {
                var capture = new NativeSession();
                IntPtr native = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, wrapped = IntPtr.Zero, itemPointer = IntPtr.Zero;
                try
                {
                    if (!GraphicsCaptureSession.IsSupported()) throw new CaptureFailure("window-capture-unsupported");
                    int level; Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out native, out level, out context));
                    Guid dxgiId = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
                    Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native, ref dxgiId, out dxgi));
                    Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out wrapped));
                    capture.device = (IDirect3DDevice)Marshal.GetObjectForIUnknown(wrapped);
                    if (!eligible()) throw new CaptureFailure("window-capture-changed");
                    var interop = (ICaptureItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
                    Guid itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
                    Marshal.ThrowExceptionForHR(interop.CreateForWindow(target.Window, ref itemId, out itemPointer));
                    capture.item = (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(itemPointer); capture.size = capture.item.Size;
                    // Extended frame bounds are physical, and exclude invisible
                    // resize borders. Ambiguous mapping is rejected, not guessed.
                    if (capture.size.Width != target.CaptureBounds.Width || capture.size.Height != target.CaptureBounds.Height)
                        throw new CaptureFailure("window-content-size-mismatch");
                    capture.pool = Direct3D11CaptureFramePool.CreateFreeThreaded(capture.device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, capture.size);
                    capture.session = capture.pool.CreateCaptureSession(capture.item);
                    if (!eligible()) throw new CaptureFailure("window-capture-changed");
                    // Keep the system capture border and cursor defaults. Never
                    // request borderless access, monitor capture or PrintWindow.
                    capture.session.StartCapture(); return capture;
                }
                catch { capture.Dispose(); throw; }
                finally
                {
                    if (itemPointer != IntPtr.Zero) Marshal.Release(itemPointer);
                    if (wrapped != IntPtr.Zero) Marshal.Release(wrapped);
                    if (dxgi != IntPtr.Zero) Marshal.Release(dxgi);
                    if (context != IntPtr.Zero) Marshal.Release(context);
                    if (native != IntPtr.Zero) Marshal.Release(native);
                }
            }
            internal SoftwareBitmap Take(long after, Func<bool> eligible, Action copyTimedOut, out long timestamp, out string failure)
            {
                timestamp = 0; failure = "window-frame-pending";
                Direct3D11CaptureFrame frame = null; IAsyncOperation<SoftwareBitmap> copy = null; SoftwareBitmap result = null;
                try
                {
                    // Drain at most the bounded pool size; take the newest item.
                    for (int count = 0; count < 2; count++)
                    { var next = pool.TryGetNextFrame(); if (next == null) break; if (frame != null) frame.Dispose(); frame = next; }
                    if (frame == null) return null;
                    if (frame.ContentSize.Width != size.Width || frame.ContentSize.Height != size.Height)
                    { failure = "window-content-size-mismatch"; return null; }
                    TimeSpan? sourceTime = frame.SystemRelativeTime;
                    if (!sourceTime.HasValue) { failure = "window-frame-timestamp-missing"; return null; }
                    timestamp = sourceTime.Value.Ticks;
                    if (!Fresh(timestamp, QpcTicks(), after)) { failure = timestamp <= after ? "window-frame-duplicate" : "window-frame-stale"; return null; }
                    if (!eligible()) { failure = "window-capture-changed"; return null; }
                    copy = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Ignore);
                    long deadline = QpcTicks() + MaximumAgeMilliseconds * TimeSpan.TicksPerMillisecond;
                    bool cancelled = false;
                    while (copy.Status == AsyncStatus.Started)
                    {
                        if (!cancelled && (QpcTicks() > deadline || !eligible()))
                        {
                            cancelled = true; copyTimedOut();
                            try { copy.Cancel(); } catch { }
                            // Stop delivery immediately. The outstanding frame
                            // stays alive until WinRT confirms copy termination.
                            if (session != null) { CloseQuietly(session); session = null; }
                        }
                        Thread.Sleep(cancelled ? 20 : 3);
                    }
                    if (copy.Status != AsyncStatus.Completed) { failure = "window-capture-copy-timeout"; return null; }
                    result = copy.GetResults();
                    // Cancel is a request: WinRT may finish successfully after
                    // it. The capture session was already stopped, so retire
                    // this wrapper even when the copy completed in that race.
                    if (cancelled) { failure = "window-capture-copy-timeout"; return null; }
                    if (!eligible() || !Fresh(timestamp, QpcTicks(), after))
                    { failure = "window-frame-stale"; return null; }
                    if (result.BitmapPixelFormat != BitmapPixelFormat.Bgra8 || result.PixelWidth != size.Width || result.PixelHeight != size.Height)
                    { failure = "window-content-size-mismatch"; return null; }
                    failure = "captured"; var owned = result; result = null; return owned;
                }
                finally
                {
                    if (result != null) CloseQuietly(result);
                    if (copy != null) { try { copy.Close(); } catch { } }
                    if (frame != null) CloseQuietly(frame);
                }
            }
            public void Dispose()
            {
                if (session != null) { CloseQuietly(session); session = null; }
                if (pool != null) { CloseQuietly(pool); pool = null; }
                item = null;
                if (device != null) { CloseQuietly(device); device = null; }
            }
        }

        private static void CloseQuietly(IDisposable value) { try { value.Dispose(); } catch { } }

        [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ICaptureItemInterop { [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item); [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item); }
        [ComImport, Guid("5b0d3235-4dba-4d44-865e-8f1d0e4fd04d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMemoryBufferByteAccess { void GetBuffer(out IntPtr buffer, out uint capacity); }
        [StructLayout(LayoutKind.Sequential)] private struct NativeRect { internal int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct NativePoint { internal int X, Y; }
        [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")] private static extern void CopyMemory(IntPtr destination, IntPtr source, UIntPtr bytes);
        [DllImport("d3d11.dll")] private static extern int D3D11CreateDevice(IntPtr adapter, int driver, IntPtr software, uint flags, IntPtr levels, uint count, uint sdk, out IntPtr device, out int level, out IntPtr context);
        [DllImport("d3d11.dll")] private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr device);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int size);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out NativeRect rectangle);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out NativeRect value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    }

    internal sealed class GameWindowCaptureTarget
    {
        internal readonly IntPtr Window;
        internal readonly uint ProcessId;
        internal readonly long ProcessStartUtcTicks;
        internal readonly Rectangle ClientBounds, CaptureBounds;
        internal GameWindowCaptureTarget(IntPtr window, uint processId, long start, Rectangle client, Rectangle capture)
        { Window = window; ProcessId = processId; ProcessStartUtcTicks = start; ClientBounds = client; CaptureBounds = capture; }
        internal static bool Same(GameWindowCaptureTarget left, GameWindowCaptureTarget right)
        { return left != null && right != null && left.Window == right.Window && left.ProcessId == right.ProcessId && left.ProcessStartUtcTicks == right.ProcessStartUtcTicks && left.ClientBounds == right.ClientBounds && left.CaptureBounds == right.CaptureBounds; }
    }

    internal sealed class GameWindowCaptureFrame : IDisposable
    {
        internal readonly GameWindowCaptureTarget Target;
        internal readonly long FrameTimestamp, CapturedAtUtcMs, Generation, Sequence;
        internal readonly Bitmap[] Regions;
        internal GameWindowCaptureFrame(GameWindowCaptureTarget target, long timestamp, long utc, long generation, long sequence, int count)
        { Target = target; FrameTimestamp = timestamp; CapturedAtUtcMs = utc; Generation = generation; Sequence = sequence; Regions = new Bitmap[count]; }
        public void Dispose() { for (int index = 0; index < Regions.Length; index++) if (Regions[index] != null) { Regions[index].Dispose(); Regions[index] = null; } }
    }
}
