using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;

namespace HexGuide.Desktop
{
    // Accessed on the sidebar UI thread. Network workers return only bytes;
    // ownership of decoded images and tinted variants stays on this thread.
    internal sealed class RemoteIconCache : IDisposable
    {
        private sealed class Entry
        {
            internal Image Image;
            internal LinkedListNode<string> Node;
        }
        private readonly int capacity, concurrency;
        private readonly long retryMilliseconds;
        private readonly Func<long> now;
        private readonly Dictionary<string, Entry> images = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly LinkedList<string> recent = new LinkedList<string>();
        private readonly HashSet<string> pending = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, long> retryAt = new Dictionary<string, long>(StringComparer.Ordinal);
        private bool disposed;
        internal event Action<string> Evicted;

        internal RemoteIconCache() : this(96, 8, 30000, null) { }
        internal RemoteIconCache(int capacity, int concurrency, long retryMilliseconds, Func<long> clock)
        {
            if (capacity < 1 || concurrency < 1 || retryMilliseconds < 0) throw new ArgumentOutOfRangeException("cache limits");
            this.capacity = capacity; this.concurrency = concurrency; this.retryMilliseconds = retryMilliseconds;
            if (clock != null) now = clock;
            else { var watch = Stopwatch.StartNew(); now = delegate { return watch.ElapsedMilliseconds; }; }
        }
        internal int Count { get { return images.Count; } }
        internal int PendingCount { get { return pending.Count; } }
        internal int RetryCount { get { return retryAt.Count; } }
        internal Image this[string url]
        {
            get { Image image; return TryGetValue(url, out image) ? image : null; }
            set { Store(url, value); }
        }
        internal bool TryGetValue(string url, out Image image)
        {
            image = null;
            Entry entry;
            if (disposed || string.IsNullOrEmpty(url) || !images.TryGetValue(url, out entry)) return false;
            recent.Remove(entry.Node); recent.AddLast(entry.Node);
            image = entry.Image;
            return true;
        }
        internal bool TryBegin(string url)
        {
            if (disposed || string.IsNullOrEmpty(url) || images.ContainsKey(url) || pending.Contains(url) || pending.Count >= concurrency) return false;
            long retry;
            if (retryAt.TryGetValue(url, out retry) && now() < retry) return false;
            retryAt.Remove(url);
            pending.Add(url);
            return true;
        }
        internal void Complete(string url, Image image)
        {
            if (!pending.Remove(url) || disposed) { if (image != null) image.Dispose(); return; }
            if (image != null) { retryAt.Remove(url); Store(url, image); return; }
            retryAt[url] = now() + retryMilliseconds;
            // Failure bookkeeping must not grow with all icons ever seen.
            while (retryAt.Count > capacity)
            {
                string oldest = null; long earliest = long.MaxValue;
                foreach (var entry in retryAt) if (oldest == null || entry.Value < earliest) { oldest = entry.Key; earliest = entry.Value; }
                retryAt.Remove(oldest);
            }
        }
        private void Store(string url, Image image)
        {
            if (image == null) throw new ArgumentNullException("image");
            if (disposed) { image.Dispose(); return; }
            if (string.IsNullOrEmpty(url)) { image.Dispose(); throw new ArgumentException("Icon URL is required.", "url"); }
            Entry existing;
            if (images.TryGetValue(url, out existing))
            {
                if (ReferenceEquals(existing.Image, image)) { recent.Remove(existing.Node); recent.AddLast(existing.Node); return; }
                Remove(url);
            }
            images[url] = new Entry { Image = image, Node = recent.AddLast(url) };
            while (images.Count > capacity) Remove(recent.First.Value);
        }
        private void Remove(string url)
        {
            var entry = images[url];
            images.Remove(url); recent.Remove(entry.Node);
            try { if (Evicted != null) Evicted(url); }
            finally { entry.Image.Dispose(); }
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            while (recent.Count > 0) Remove(recent.First.Value);
            pending.Clear(); retryAt.Clear(); Evicted = null;
        }
        private static bool IsDisposed(Image image)
        {
            try { int width = image.Width; return false; }
            catch (ArgumentException) { return true; }
        }
        internal static int ValidateFixtures()
        {
            int checks = 0; long clock = 0;
            Action<bool, string> check = delegate(bool value, string reason) { checks++; if (!value) throw new InvalidOperationException("Icon cache fixture: " + reason); };
            using (var cache = new RemoteIconCache(96, 8, 30000, delegate { return clock; }))
            {
                check(cache.TryBegin("failed"), "initial request starts");
                check(!cache.TryBegin("failed"), "in-flight requests deduplicate");
                cache.Complete("failed", null);
                check(cache.PendingCount == 0 && !cache.TryBegin("failed"), "failure frees concurrency but waits before retry");
                clock = 29999; check(!cache.TryBegin("failed"), "retry waits full interval");
                clock = 30000; check(cache.TryBegin("failed"), "retry allowed at boundary");
                cache.Complete("failed", new Bitmap(12, 12));
                check(!cache.TryBegin("failed") && cache.RetryCount == 0, "success is cached and clears retry marker");
                for (int index = 0; index < 8; index++) check(cache.TryBegin("pending" + index), "bounded concurrent request starts");
                check(!cache.TryBegin("overflow"), "concurrency limit respected");
                cache.Complete("pending0", null);
                check(cache.TryBegin("overflow"), "completed request frees a slot");
                cache.Complete("overflow", null);
                for (int index = 1; index < 8; index++) cache.Complete("pending" + index, null);
                for (int index = 0; index < 220; index++)
                {
                    string url = "icon" + index;
                    check(cache.TryBegin(url), "new icons load beyond lifetime capacity");
                    cache.Complete(url, new Bitmap(12, 12));
                    check(cache.Count <= 96 && cache.PendingCount == 0, "resident images stay bounded");
                }
                Image found;
                check(!cache.TryGetValue("icon0", out found) && cache.TryGetValue("icon219", out found), "old image evicted, newest retained");
                for (int index = 0; index < 220; index++) { string url = "failure" + index; cache.TryBegin(url); cache.Complete(url, null); }
                check(cache.RetryCount <= 96, "failure history remains bounded");
            }
            using (var cache = new RemoteIconCache(2, 1, 30000, delegate { return clock; }))
            {
                var first = new Bitmap(12, 12); var second = new Bitmap(12, 12); var tint = new Bitmap(12, 12);
                int evictions = 0;
                cache.Evicted += delegate(string url) { if (url == "second") { evictions++; tint.Dispose(); } };
                cache["first"] = first; cache["second"] = second;
                Image touched; cache.TryGetValue("first", out touched);
                cache["third"] = new Bitmap(12, 12);
                check(cache["first"] == first && cache["second"] == null, "read updates least-recently-used order");
                check(evictions == 1 && IsDisposed(second) && IsDisposed(tint), "eviction disposes raw and related tinted images");
                cache["first"] = first;
                check(!IsDisposed(first), "same image assignment remains valid");
                var replacement = new Bitmap(12, 12); cache["first"] = replacement;
                check(IsDisposed(first) && cache["first"] == replacement, "replacement disposes obsolete image");
                check(cache.TryBegin("late"), "late request starts");
                cache.Dispose(); var late = new Bitmap(12, 12); cache.Complete("late", late);
                check(cache.Count == 0 && cache.PendingCount == 0 && IsDisposed(late) && IsDisposed(replacement), "late completion cannot resurrect disposed cache");
                check(!cache.TryBegin("new"), "disposed cache does not request");
            }
            return checks;
        }
    }
}
