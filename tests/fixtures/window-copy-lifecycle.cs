using System;
using System.Reflection;
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.Imaging;

// Compile the actual capture source against a deterministic WinRT boundary.
// Only the platform types are replaced; NativeSession.Take and its worker's
// failure classification are the production implementations. No window opens.
namespace HexGuide.Desktop
{
    internal static class GameWindow
    { internal static bool IsVerifiedGame(IntPtr window) { throw new InvalidOperationException("No native access in fixture."); } }

    internal static class WindowCopyLifecycleFixture
    {
        private static int checks;
        private static void Check(bool value, string reason)
        { checks++; if (!value) throw new InvalidOperationException(reason); }

        public static int Main()
        {
            try
            {
                foreach (int mode in new[] { 0, 1, 2 }) Run(mode);
                Console.WriteLine("{\"mode\":\"offline-fault-injection\",\"checks\":" + checks + ",\"liveVerified\":false}");
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error.GetBaseException().Message); return 1; }
        }

        private static void Run(int mode)
        {
            Type type = typeof(GameWindowCapture).GetNestedType("NativeSession", BindingFlags.NonPublic);
            var native = (IDisposable)Activator.CreateInstance(type, true);
            var session = new GraphicsCaptureSession();
            var pool = new Direct3D11CaptureFramePool();
            var size = new SizeInt32 { Width = 16, Height = 16 };
            var frame = new Direct3D11CaptureFrame { ContentSize = size, SystemRelativeTime = TimeSpan.FromTicks(GameWindowCapture.QpcTicks()) };
            pool.Frame = frame;
            foreach (var field in new[] { "session", "pool", "size" })
                type.GetField(field, BindingFlags.NonPublic | BindingFlags.Instance).SetValue(native,
                    field == "session" ? (object)session : field == "pool" ? (object)pool : size);
            SoftwareBitmap.Mode = mode;
            bool stopped = false;
            int eligibleCalls = 0;
            // First check permits the copy; subsequent loss forces cancellation
            // without depending on a scheduler or a 150 ms wall-clock timeout.
            object[] args = { 0L, new Func<bool>(delegate { return mode == 0 || ++eligibleCalls == 1; }),
                new Action(delegate { stopped = true; }), 0L, null };
            SoftwareBitmap result = null;
            try
            {
                result = (SoftwareBitmap)type.GetMethod("Take", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(native, args);
                var copy = SoftwareBitmap.Last;
                Check(copy.Closed && frame.Disposed, "Copy or frame was not released.");
                if (mode == 0)
                {
                    Check(result != null && (string)args[4] == "captured", "Normal completion was rejected.");
                    Check(!stopped && !session.Disposed && !result.Disposed, "Healthy capture was retired.");
                }
                else
                {
                    Check(result == null && stopped && session.Disposed, "Canceled capture remained usable.");
                    Check((string)args[4] == "window-capture-copy-timeout", "Stopped session was mislabeled as a retryable stale frame.");
                    Check(!GameWindowCapture.IsWaiting((string)args[4]), "Worker would retain a stopped session.");
                    Check(GameWindowCapture.CanUseDesktopFallback((string)args[4]), "Guarded fallback was lost.");
                    Check(mode != 1 || copy.Result != null && copy.Result.Disposed, "Completed-after-cancel bitmap leaked.");
                }
            }
            finally { if (result != null) result.Dispose(); native.Dispose(); }
            Check(pool.Disposed && session.Disposed, "Native session disposal leaked resources.");
        }
    }
}

namespace Windows.Foundation
{
    public enum AsyncStatus { Started, Completed, Canceled, Error }
    public interface IAsyncOperation<T> { AsyncStatus Status { get; } void Cancel(); T GetResults(); void Close(); }
    public interface IMemoryBufferReference : IDisposable { }
}
namespace Windows.Graphics { public struct SizeInt32 { public int Width, Height; } }
namespace Windows.Graphics.DirectX { public enum DirectXPixelFormat { B8G8R8A8UIntNormalized } }
namespace Windows.Graphics.DirectX.Direct3D11 { public interface IDirect3DDevice : IDisposable { } }
namespace Windows.Graphics.Capture
{
    public class GraphicsCaptureItem { public SizeInt32 Size { get; set; } }
    public class GraphicsCaptureSession : IDisposable
    {
        public bool Disposed;
        public static bool IsSupported() { throw new InvalidOperationException("No native access."); }
        public void StartCapture() { throw new InvalidOperationException("No native access."); }
        public void Dispose() { Disposed = true; }
    }
    public class Direct3D11CaptureFrame : IDisposable
    {
        public bool Disposed;
        public SizeInt32 ContentSize { get; set; }
        public TimeSpan? SystemRelativeTime { get; set; }
        public object Surface { get { return null; } }
        public void Dispose() { Disposed = true; }
    }
    public class Direct3D11CaptureFramePool : IDisposable
    {
        public Direct3D11CaptureFrame Frame;
        public bool Disposed;
        public static Direct3D11CaptureFramePool CreateFreeThreaded(Windows.Graphics.DirectX.Direct3D11.IDirect3DDevice device, Windows.Graphics.DirectX.DirectXPixelFormat format, int count, SizeInt32 size) { throw new InvalidOperationException("No native access."); }
        public GraphicsCaptureSession CreateCaptureSession(GraphicsCaptureItem item) { throw new InvalidOperationException("No native access."); }
        public Direct3D11CaptureFrame TryGetNextFrame() { var result = Frame; Frame = null; return result; }
        public void Dispose() { Disposed = true; }
    }
}
namespace Windows.Graphics.Imaging
{
    public enum BitmapAlphaMode { Ignore }
    public enum BitmapBufferAccessMode { Read }
    public enum BitmapPixelFormat { Bgra8 }
    public struct BitmapPlaneDescription { public int Stride, StartIndex; }
    public class BitmapBuffer : IDisposable
    {
        public IMemoryBufferReference CreateReference() { throw new InvalidOperationException("No pixel access."); }
        public BitmapPlaneDescription GetPlaneDescription(int plane) { throw new InvalidOperationException("No pixel access."); }
        public void Dispose() { }
    }
    public class SoftwareBitmap : IDisposable
    {
        public static int Mode;
        public static ControlledCopy Last;
        public bool Disposed;
        public BitmapPixelFormat BitmapPixelFormat { get { return BitmapPixelFormat.Bgra8; } }
        public int PixelWidth { get { return 16; } }
        public int PixelHeight { get { return 16; } }
        public BitmapBuffer LockBuffer(BitmapBufferAccessMode access) { throw new InvalidOperationException("No pixel access."); }
        public static IAsyncOperation<SoftwareBitmap> CreateCopyFromSurfaceAsync(object source, BitmapAlphaMode alpha) { Last = new ControlledCopy(Mode); return Last; }
        public void Dispose() { Disposed = true; }
    }
    public class ControlledCopy : IAsyncOperation<SoftwareBitmap>
    {
        private readonly int mode;
        private bool canceled;
        public bool Closed;
        public SoftwareBitmap Result;
        public ControlledCopy(int value) { mode = value; }
        public AsyncStatus Status { get { return mode == 0 ? AsyncStatus.Completed : !canceled ? AsyncStatus.Started : mode == 1 ? AsyncStatus.Completed : AsyncStatus.Canceled; } }
        public void Cancel() { canceled = true; }
        public SoftwareBitmap GetResults() { Result = new SoftwareBitmap(); return Result; }
        public void Close() { Closed = true; }
    }
}
