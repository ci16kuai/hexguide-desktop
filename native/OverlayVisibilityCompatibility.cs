using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace HexGuide.Desktop
{
    // Versioned UI compatibility policy, not an opacity test. A layered window
    // with alpha=0 / flags=0 can still contain opaque compositor pixels. The one
    // profile below is a locally observed, inactive NVIDIA helper; no other
    // class, executable version, or unknown layered window inherits this rule.
    internal static class OverlayVisibilityCompatibility
    {
        private const string ProfileClass = "CEF-OSC-WIDGET";
        private const string ProfileFile = "NVIDIA Overlay.exe";
        private const string ProfileCompany = "NVIDIA Corporation";
        private const string ProfileProduct = "NVIDIA App";
        private const string ProfileVersion = "128.4.13.31";
        private const string ProfileHash = "9b77a23fb0ecb92e3e5cf05afd7a9b9cb46cad094ecf75430c9cd630f40a590a";
        private const long RequiredStyles = 0x00080000L | 0x00000020L | 0x00000080L;
        private const uint QueryLimitedInformation = 0x1000;
        private const uint RootOwner = 3;
        private const int VerificationDeadlineMs = 4000;
        private const int NegativeRetryMs = 10000;
        private const int MaximumIdentities = 8;
        private const int MaximumWorkers = 2;
        private const long MaximumBinaryBytes = 16L * 1024L * 1024L;
        private static readonly object CacheGate = new object();
        private static readonly IdentityCache Cache = new IdentityCache();
        private static int prewarmStarted;

        // Only process metadata is read on the polling thread. Version resources,
        // executable bytes, and hashing always run in the bounded background job.
        public static bool IsNonCoveringCompatibilityLayer(IntPtr window)
        {
            WindowFacts facts;
            if (!TryReadWindowFacts(window, out facts) || !MeetsWindowPolicy(facts)) return false;
            ProcessIdentity identity;
            if (!TryReadProcessIdentity(facts.ProcessId, out identity)) return false;
            Verification job;
            bool verified;
            lock (CacheGate) verified = Cache.GetOrBegin(identity, Environment.TickCount, out job);
            if (job != null) QueueVerification(job);
            if (!verified) return false;

            // Foreground ownership can change during a process metadata query.
            // Recheck every interaction gate before applying the exception.
            WindowFacts current;
            return TryReadWindowFacts(window, out current) && MeetsWindowPolicy(current)
                && current.ProcessId == facts.ProcessId && current.Owner == facts.Owner;
        }

        // Run once during startup, before the first game/application switch. The
        // process-name inventory is only a hint; it never bypasses identity proof.
        public static void Prewarm()
        {
            if (Interlocked.Exchange(ref prewarmStarted, 1) != 0) return;
            try
            {
                Task.Run(delegate
                {
                    Process[] processes;
                    try { processes = Process.GetProcessesByName("NVIDIA Overlay"); }
                    catch { return; }
                    int examined = 0;
                    foreach (Process process in processes)
                    {
                        using (process)
                        {
                            if (examined >= MaximumIdentities) continue;
                            examined++;
                            ProcessIdentity identity;
                            try { if (!TryReadProcessIdentity((uint)process.Id, out identity)) continue; }
                            catch { continue; }
                            Verification job;
                            lock (CacheGate) Cache.GetOrBegin(identity, Environment.TickCount, out job);
                            if (job != null) QueueVerification(job);
                        }
                    }
                });
            }
            catch { }
        }

        private struct WindowFacts
        {
            internal string ClassName;
            internal long Styles;
            internal bool LayerAttributesKnown;
            internal byte Alpha;
            internal uint Flags;
            internal uint ProcessId, ForegroundProcessId, OwnerProcessId, ForegroundOwnerProcessId;
            internal IntPtr Window, Foreground, Owner, ForegroundOwner;
        }

        private static bool MeetsWindowPolicy(WindowFacts facts)
        {
            return String.Equals(facts.ClassName, ProfileClass, StringComparison.Ordinal)
                && (facts.Styles & RequiredStyles) == RequiredStyles
                && facts.LayerAttributesKnown && facts.Alpha == 0 && facts.Flags == 0
                && facts.Window != IntPtr.Zero && facts.Foreground != IntPtr.Zero
                && facts.Owner != IntPtr.Zero && facts.ForegroundOwner != IntPtr.Zero
                && facts.ProcessId != 0 && facts.ForegroundProcessId != 0
                && facts.OwnerProcessId != 0 && facts.ForegroundOwnerProcessId != 0
                && facts.Window != facts.Foreground && facts.Owner != facts.ForegroundOwner
                && facts.ProcessId != facts.ForegroundProcessId
                && facts.ProcessId != facts.ForegroundOwnerProcessId
                && facts.OwnerProcessId != facts.ForegroundProcessId
                && facts.OwnerProcessId != facts.ForegroundOwnerProcessId;
        }

        private static bool TryReadWindowFacts(IntPtr window, out WindowFacts facts)
        {
            facts = new WindowFacts();
            if (window == IntPtr.Zero) return false;
            var name = new StringBuilder(256);
            if (GetClassName(window, name, name.Capacity) <= 0
                || !String.Equals(name.ToString(), ProfileClass, StringComparison.Ordinal)) return false;
            facts.ClassName = name.ToString();
            facts.Styles = IntPtr.Size == 8 ? GetWindowLongPtr(window, -20).ToInt64() : GetWindowLong(window, -20);
            if ((facts.Styles & RequiredStyles) != RequiredStyles) return false;
            uint colorKey;
            facts.LayerAttributesKnown = GetLayeredWindowAttributes(window, out colorKey, out facts.Alpha, out facts.Flags);
            if (!facts.LayerAttributesKnown || facts.Alpha != 0 || facts.Flags != 0) return false;

            // More costly ownership/process calls occur only after class/style/
            // attribute gates. Missing handles or identities fail closed.
            facts.Window = window;
            facts.Foreground = GetForegroundWindow();
            if (facts.Foreground == IntPtr.Zero || facts.Foreground == window) return false;
            facts.Owner = GetAncestor(window, RootOwner);
            facts.ForegroundOwner = GetAncestor(facts.Foreground, RootOwner);
            if (facts.Owner == IntPtr.Zero || facts.ForegroundOwner == IntPtr.Zero || facts.Owner == facts.ForegroundOwner) return false;
            if (GetWindowThreadProcessId(window, out facts.ProcessId) == 0
                || GetWindowThreadProcessId(facts.Foreground, out facts.ForegroundProcessId) == 0
                || GetWindowThreadProcessId(facts.Owner, out facts.OwnerProcessId) == 0
                || GetWindowThreadProcessId(facts.ForegroundOwner, out facts.ForegroundOwnerProcessId) == 0) return false;
            return true;
        }

        private sealed class ProcessIdentity : IEquatable<ProcessIdentity>
        {
            internal readonly uint ProcessId;
            internal readonly long StartTimeUtcTicks;
            internal readonly string Path;
            internal ProcessIdentity(uint processId, long startTimeUtcTicks, string path)
            { ProcessId = processId; StartTimeUtcTicks = startTimeUtcTicks; Path = path; }
            public bool Equals(ProcessIdentity other)
            {
                return other != null && ProcessId == other.ProcessId && StartTimeUtcTicks == other.StartTimeUtcTicks
                    && String.Equals(Path, other.Path, StringComparison.OrdinalIgnoreCase);
            }
            public override bool Equals(object other) { return Equals(other as ProcessIdentity); }
            public override int GetHashCode()
            {
                return ProcessId.GetHashCode() ^ StartTimeUtcTicks.GetHashCode()
                    ^ StringComparer.OrdinalIgnoreCase.GetHashCode(Path);
            }
        }

        private static bool TryReadProcessIdentity(uint processId, out ProcessIdentity identity)
        {
            identity = null;
            if (processId == 0 || processId > Int32.MaxValue) return false;
            IntPtr handle = OpenProcess(QueryLimitedInformation, false, processId);
            if (handle == IntPtr.Zero) return false;
            try
            {
                long created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) return false;
                var path = new StringBuilder(32768);
                uint length = (uint)path.Capacity;
                if (!QueryFullProcessImageName(handle, 0, path, ref length) || length == 0 || length >= path.Capacity) return false;
                string imagePath = path.ToString();
                if (!String.Equals(System.IO.Path.GetFileName(imagePath), ProfileFile, StringComparison.OrdinalIgnoreCase)) return false;
                long startTime;
                using (Process process = Process.GetProcessById((int)processId)) startTime = process.StartTime.ToUniversalTime().Ticks;
                // Associate Process.StartTime with the same limited-information
                // handle used for the path, including a concurrent PID reuse.
                if (startTime != DateTime.FromFileTimeUtc(created).Ticks) return false;
                uint exitCode;
                if (!GetExitCodeProcess(handle, out exitCode) || exitCode != 259) return false;
                identity = new ProcessIdentity(processId, startTime, imagePath);
                return true;
            }
            catch { return false; }
            finally { CloseHandle(handle); }
        }

        private struct BinaryFacts
        {
            internal string FileName, Company, Product, OriginalFileName, Version, Hash;
        }

        private static bool MatchesProfile(BinaryFacts facts)
        {
            return String.Equals(facts.FileName, ProfileFile, StringComparison.OrdinalIgnoreCase)
                && String.Equals(facts.Company, ProfileCompany, StringComparison.Ordinal)
                && String.Equals(facts.Product, ProfileProduct, StringComparison.Ordinal)
                && String.Equals(facts.OriginalFileName, ProfileFile, StringComparison.Ordinal)
                && String.Equals(facts.Version, ProfileVersion, StringComparison.Ordinal)
                && String.Equals(facts.Hash, ProfileHash, StringComparison.OrdinalIgnoreCase);
        }

        // Positive proof belongs to this loaded process identity for its lifetime;
        // it has no periodic expiry that could flicker a stable background panel.
        // Windows normally prevents writes to a loaded executable. A replacement
        // process or path needs fresh proof. All caches and worker slots are bounded.
        private sealed class CacheEntry
        {
            internal ProcessIdentity Identity;
            internal bool Verified, Attempted;
            internal int LastAttempt;
            internal long LastUse;
            internal Verification ActiveJob;
        }

        private sealed class Verification
        {
            internal readonly CacheEntry Entry;
            internal readonly int StartedAt;
            internal volatile bool TimedOut;
            internal bool Finished;
            internal Task WorkTask;
            internal System.Threading.Timer DeadlineTimer;
            internal Verification(CacheEntry entry, int now) { Entry = entry; StartedAt = now; }
        }

        // State methods are deliberately independent of Windows, files and tasks
        // so lifecycle fixtures use the same cache as runtime without any I/O.
        // Runtime holds CacheGate around each call.
        private sealed class IdentityCache
        {
            private readonly List<CacheEntry> entries = new List<CacheEntry>();
            private readonly List<Verification> running = new List<Verification>();
            private long useOrder;
            internal int Count { get { return entries.Count; } }
            internal int RunningCount { get { return running.Count; } }

            internal bool GetOrBegin(ProcessIdentity identity, int now, out Verification job)
            {
                job = null;
                CacheEntry entry = null;
                foreach (CacheEntry candidate in entries) if (candidate.Identity.Equals(identity)) { entry = candidate; break; }
                if (entry != null)
                {
                    entry.LastUse = ++useOrder;
                    if (entry.ActiveJob != null)
                    {
                        Expire(entry.ActiveJob, now);
                        return false;
                    }
                    if (entry.Verified) return true;
                    if (entry.Attempted && unchecked((uint)(now - entry.LastAttempt)) < NegativeRetryMs) return false;
                }
                // An evicted pending job retains its slot and owns its completion;
                // do not duplicate it or resurrect its former cache entry.
                foreach (Verification active in running) if (active.Entry.Identity.Equals(identity)) return false;
                if (running.Count >= MaximumWorkers) return false;
                if (entry == null)
                {
                    if (entries.Count >= MaximumIdentities)
                    {
                        CacheEntry oldest = entries[0];
                        foreach (CacheEntry candidate in entries) if (candidate.LastUse < oldest.LastUse) oldest = candidate;
                        entries.Remove(oldest);
                    }
                    entry = new CacheEntry { Identity = identity, LastUse = ++useOrder };
                    entries.Add(entry);
                }
                entry.Verified = false; entry.Attempted = true; entry.LastAttempt = now;
                job = new Verification(entry, now);
                entry.ActiveJob = job;
                running.Add(job);
                return false;
            }

            internal void Expire(Verification job, int now)
            {
                if (job.Finished || job.TimedOut || unchecked((uint)(now - job.StartedAt)) < VerificationDeadlineMs) return;
                job.TimedOut = true;
                if (entries.Contains(job.Entry) && Object.ReferenceEquals(job.Entry.ActiveJob, job))
                { job.Entry.Verified = false; job.Entry.LastAttempt = now; }
                // A timeout changes the result, not the number of actual tasks.
                // A blocked OS read keeps this worker slot until it returns.
            }

            internal void Complete(Verification job, bool verified, int now)
            {
                if (job.Finished) return;
                Expire(job, now);
                job.Finished = true;
                running.Remove(job);
                if (!entries.Contains(job.Entry) || !Object.ReferenceEquals(job.Entry.ActiveJob, job)) return;
                job.Entry.ActiveJob = null;
                job.Entry.Verified = verified && !job.TimedOut;
                job.Entry.LastAttempt = now;
            }
        }

        private static void QueueVerification(Verification job)
        {
            try
            {
                job.DeadlineTimer = new System.Threading.Timer(delegate
                {
                    lock (CacheGate) Cache.Expire(job, Environment.TickCount);
                }, null, VerificationDeadlineMs, Timeout.Infinite);
                job.WorkTask = Task.Run(delegate
                {
                    bool verified = false;
                    try { verified = VerifyBinary(job); }
                    catch { }
                    finally
                    {
                        lock (CacheGate) Cache.Complete(job, verified, Environment.TickCount);
                        if (job.DeadlineTimer != null) job.DeadlineTimer.Dispose();
                    }
                });
            }
            catch
            {
                lock (CacheGate) Cache.Complete(job, false, Environment.TickCount);
                if (job.DeadlineTimer != null) job.DeadlineTimer.Dispose();
            }
        }

        private static bool WithinDeadline(Verification job)
        { return WithinDeadline(job, Environment.TickCount); }

        private static bool WithinDeadline(Verification job, int now)
        { return !job.TimedOut && unchecked((uint)(now - job.StartedAt)) < VerificationDeadlineMs; }

        private static bool VerifyBinary(Verification job)
        {
            if (!WithinDeadline(job)) return false;
            ProcessIdentity current;
            ProcessIdentity expected = job.Entry.Identity;
            if (!TryReadProcessIdentity(expected.ProcessId, out current) || !expected.Equals(current)) return false;
            string root = System.IO.Path.GetPathRoot(expected.Path);
            // Never load an executable from a network location as a side effect
            // of a visibility poll. The observed application uses a local disk.
            if (String.IsNullOrEmpty(root) || root.Length != 3 || root[1] != ':' || GetDriveType(root) != 3) return false;
            if (!WithinDeadline(job)) return false;
            var info = new FileInfo(expected.Path);
            long length = info.Length;
            if (length <= 0 || length > MaximumBinaryBytes) return false;
            FileVersionInfo version = FileVersionInfo.GetVersionInfo(expected.Path);
            var facts = new BinaryFacts {
                FileName = System.IO.Path.GetFileName(expected.Path), Company = version.CompanyName,
                Product = version.ProductName, OriginalFileName = version.OriginalFilename, Version = version.FileVersion,
                Hash = ProfileHash
            };
            if (!MatchesProfile(facts) || !WithinDeadline(job)) return false;
            using (var stream = new FileStream(expected.Path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 65536, FileOptions.SequentialScan))
            using (SHA256 hash = SHA256.Create())
            {
                if (stream.Length != length) return false;
                var buffer = new byte[65536];
                long total = 0;
                int count;
                while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    total += count;
                    if (total > MaximumBinaryBytes || !WithinDeadline(job)) return false;
                    hash.TransformBlock(buffer, 0, count, buffer, 0);
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                facts.Hash = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
                if (total != length || !MatchesProfile(facts) || !WithinDeadline(job)) return false;
            }
            return TryReadProcessIdentity(expected.ProcessId, out current) && expected.Equals(current) && WithinDeadline(job);
        }

        // Offline fixtures never enumerate processes, invoke Win32, read installed
        // software, or schedule tasks. A generic opaque/color-key/per-pixel layer
        // remains covering; alpha=0 / flags=0 alone proves nothing about opacity.
        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool condition, string message)
            { if (!condition) throw new InvalidOperationException("Overlay compatibility: " + message); checks++; };
            var good = new WindowFacts {
                ClassName = ProfileClass, Styles = RequiredStyles, LayerAttributesKnown = true, Alpha = 0, Flags = 0,
                Window = new IntPtr(10), Foreground = new IntPtr(20), Owner = new IntPtr(10), ForegroundOwner = new IntPtr(20),
                ProcessId = 100, ForegroundProcessId = 200, OwnerProcessId = 100, ForegroundOwnerProcessId = 200
            };
            check(MeetsWindowPolicy(good), "inactive observed helper should pass window gates");
            WindowFacts changed = good; changed.ClassName = "OtherCompositor";
            check(!MeetsWindowPolicy(changed), "unknown opaque compositor must count as coverage");
            changed = good; changed.ClassName = null; check(!MeetsWindowPolicy(changed), "unknown class");
            changed = good; changed.ClassName = "cef-osc-widget"; check(!MeetsWindowPolicy(changed), "class must be exact");
            foreach (long style in new long[] { 0x80000, 0x20, 0x80 })
            { changed = good; changed.Styles &= ~style; check(!MeetsWindowPolicy(changed), "missing required style"); }
            changed = good; changed.LayerAttributesKnown = false;
            check(!MeetsWindowPolicy(changed), "per-pixel/unknown attributes must count as coverage");
            foreach (uint flags in new uint[] { 1, 2, 3, 4 })
            { changed = good; changed.Flags = flags; check(!MeetsWindowPolicy(changed), "color-key/alpha/unknown flags must count as coverage"); }
            foreach (byte alpha in new byte[] { 1, 128, 255 })
            { changed = good; changed.Alpha = alpha; check(!MeetsWindowPolicy(changed), "nonzero alpha must count as coverage"); }
            changed = good; changed.Window = IntPtr.Zero; check(!MeetsWindowPolicy(changed), "unknown target");
            changed = good; changed.Foreground = IntPtr.Zero; check(!MeetsWindowPolicy(changed), "unknown foreground");
            changed = good; changed.Owner = IntPtr.Zero; check(!MeetsWindowPolicy(changed), "unknown target root owner");
            changed = good; changed.ForegroundOwner = IntPtr.Zero; check(!MeetsWindowPolicy(changed), "unknown foreground root owner");
            changed = good; changed.ProcessId = 0; check(!MeetsWindowPolicy(changed), "unknown target process");
            changed = good; changed.ForegroundProcessId = 0; check(!MeetsWindowPolicy(changed), "unknown foreground process");
            changed = good; changed.OwnerProcessId = 0; check(!MeetsWindowPolicy(changed), "unknown target root process");
            changed = good; changed.ForegroundOwnerProcessId = 0; check(!MeetsWindowPolicy(changed), "unknown foreground root process");
            changed = good; changed.Window = good.Foreground; check(!MeetsWindowPolicy(changed), "interactive target window");
            changed = good; changed.ProcessId = good.ForegroundProcessId; check(!MeetsWindowPolicy(changed), "interactive same-process helper");
            changed = good; changed.Owner = good.ForegroundOwner; check(!MeetsWindowPolicy(changed), "interactive shared root owner");
            changed = good; changed.ForegroundOwnerProcessId = good.ProcessId; check(!MeetsWindowPolicy(changed), "interactive foreground-root process");
            changed = good; changed.OwnerProcessId = good.ForegroundProcessId; check(!MeetsWindowPolicy(changed), "interactive helper-owner process");
            changed = good; changed.OwnerProcessId = good.ForegroundOwnerProcessId; check(!MeetsWindowPolicy(changed), "interactive shared root-owner process");

            var binary = new BinaryFacts { FileName = ProfileFile, Company = ProfileCompany, Product = ProfileProduct,
                OriginalFileName = ProfileFile, Version = ProfileVersion, Hash = ProfileHash };
            check(MatchesProfile(binary), "pinned exact public identity");
            BinaryFacts bad = binary; bad.FileName = "Other.exe"; check(!MatchesProfile(bad), "unknown executable");
            bad = binary; bad.Company = "Other"; check(!MatchesProfile(bad), "unknown company");
            bad = binary; bad.Product = "Other"; check(!MatchesProfile(bad), "unknown product");
            bad = binary; bad.OriginalFileName = "Other.exe"; check(!MatchesProfile(bad), "unknown original filename");
            bad = binary; bad.Version = "128.4.13.32"; check(!MatchesProfile(bad), "unobserved NVIDIA version");
            bad = binary; bad.Hash = new string('0', 64); check(!MatchesProfile(bad), "unobserved executable bytes");
            bad = binary; bad.Hash = null; check(!MatchesProfile(bad), "missing hash proof");

            var cache = new IdentityCache();
            var identity = new ProcessIdentity(100, 123456, "Q:\\fixture\\NVIDIA Overlay.exe");
            Verification first, other;
            check(!cache.GetOrBegin(identity, 0, out first) && first != null, "cold cache is conservative");
            check(!cache.GetOrBegin(identity, 1, out other) && other == null && cache.RunningCount == 1, "pending job is shared");
            cache.Complete(first, true, 100);
            check(cache.GetOrBegin(identity, 100, out other) && other == null, "verified identity is available");
            check(cache.GetOrBegin(identity, 86400100, out other), "positive proof has no periodic flicker");
            var reused = new ProcessIdentity(100, 123457, identity.Path);
            check(!cache.GetOrBegin(reused, 200, out first) && first != null, "PID reuse needs new proof");
            var moved = new ProcessIdentity(100, identity.StartTimeUtcTicks, "Q:\\other\\NVIDIA Overlay.exe");
            check(!cache.GetOrBegin(moved, 201, out other) && other != null, "path change needs new proof");
            Verification movedJob = other;
            check(!cache.GetOrBegin(new ProcessIdentity(101, 1, identity.Path), 202, out other) && other == null
                && cache.RunningCount == MaximumWorkers, "worker cap");
            cache.Expire(first, 4200);
            check(first.TimedOut && cache.RunningCount == MaximumWorkers, "timeout retains actual task slot");
            cache.Complete(first, true, 4201);
            check(!cache.GetOrBegin(reused, 4202, out other) && other == null, "late success cannot bypass timeout");
            cache.Complete(first, true, 4203);
            check(cache.RunningCount == 1, "duplicate completion cannot release another task slot");
            cache.Complete(movedJob, false, 4204);
            check(!cache.GetOrBegin(moved, 4205, out other) && other == null, "negative retry cooldown");
            check(!cache.GetOrBegin(moved, 14204, out other) && other != null, "negative identity can be retried");
            cache.Complete(other, true, 14205);
            check(cache.GetOrBegin(new ProcessIdentity(moved.ProcessId, moved.StartTimeUtcTicks, moved.Path.ToLowerInvariant()), 14206, out other), "Windows path case does not duplicate identity");

            var eviction = new IdentityCache();
            Verification evicted;
            eviction.GetOrBegin(identity, 0, out evicted);
            for (int index = 0; index < MaximumIdentities; index++)
            {
                Verification fill;
                eviction.GetOrBegin(new ProcessIdentity((uint)(300 + index), 1, identity.Path), index + 1, out fill);
                if (fill != null) eviction.Complete(fill, true, index + 2);
            }
            check(eviction.Count == MaximumIdentities && eviction.RunningCount == 1, "bounded LRU keeps evicted worker lifecycle");
            eviction.Complete(evicted, true, 100);
            check(eviction.Count == MaximumIdentities && eviction.RunningCount == 0, "late completion cannot resurrect evicted entry");
            check(!eviction.GetOrBegin(identity, 101, out other) && other != null, "evicted proof must be established again");
            eviction.Complete(other, false, 102);
            check(!eviction.GetOrBegin(identity, 10102, out other) && other != null, "negative eviction retry remains bounded");

            var wrapping = new IdentityCache();
            Verification wrapJob;
            int nearWrap = Int32.MaxValue - 100;
            wrapping.GetOrBegin(identity, nearWrap, out wrapJob);
            wrapping.Complete(wrapJob, false, nearWrap + 1);
            check(!wrapping.GetOrBegin(identity, unchecked(nearWrap + 500), out other) && other == null, "retry survives monotonic clock wrap");
            check(!wrapping.GetOrBegin(identity, unchecked(nearWrap + 10001), out other) && other != null, "retry after monotonic clock wrap");
            wrapping.Expire(other, unchecked(nearWrap + 14001));
            check(other.TimedOut && wrapping.RunningCount == 1, "deadline survives monotonic clock wrap");
            var suspended = new IdentityCache();
            Verification suspendedJob;
            suspended.GetOrBegin(identity, 0, out suspendedJob);
            int longSleep = unchecked((int)0x80004000U);
            check(!WithinDeadline(suspendedJob, longSleep), "a long suspended interval cannot revive the verification deadline");
            suspended.Complete(suspendedJob, true, longSleep);
            check(suspendedJob.TimedOut && !suspended.GetOrBegin(identity, longSleep + 1, out other) && other == null, "late verification after long suspension stays conservative");
            check(!suspended.GetOrBegin(identity, unchecked(longSleep + 10001), out other) && other != null, "retry recovers after a long suspended verification");
            var negativeSleep = new IdentityCache();
            negativeSleep.GetOrBegin(identity, 0, out suspendedJob);
            negativeSleep.Complete(suspendedJob, false, 1);
            check(!negativeSleep.GetOrBegin(identity, longSleep, out other) && other != null, "negative retry is not suppressed by a signed elapsed interval");
            return checks;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(IntPtr window, out uint colorKey, out byte alpha, out uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetDriveType(string rootPath);
    }
}
