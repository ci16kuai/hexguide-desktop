using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace HexGuide.Desktop
{
    // Shared by the OCR process and the native watcher. Features stay in memory;
    // no text, screen image or player identity is persisted here.
    public sealed class CardTitleFeature
    {
        public int[] Feature = new int[128];
        public bool Usable;
        public int Contrast, EdgePixels, ActiveCells;
    }

    public static class CardTitleIdentity
    {
        public const string Algorithm = "luma-sobel-16x8-v1";

        public static CardTitleFeature Extract(Bitmap source, Rectangle box)
        {
            var result = new CardTitleFeature();
            if (source == null || box.Width < 8 || box.Height < 8 || box.X < 0 || box.Y < 0
                || box.Right > source.Width || box.Bottom > source.Height) return result;
            const int width = 128, height = 64;
            var gray = new int[width * height];
            var histogram = new int[256];
            using (var small = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(small))
                {
                    graphics.CompositingMode = CompositingMode.SourceCopy;
                    graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.DrawImage(source, new Rectangle(0, 0, width, height), box, GraphicsUnit.Pixel);
                }
                BitmapData data = small.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    var row = new byte[width * 4];
                    for (int y = 0; y < height; y++)
                    {
                        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                        for (int x = 0; x < width; x++)
                        {
                            int offset = x * 4;
                            int luminance = (299 * row[offset + 2] + 587 * row[offset + 1] + 114 * row[offset] + 500) / 1000;
                            gray[y * width + x] = luminance;
                            histogram[luminance]++;
                        }
                    }
                }
                finally { small.UnlockBits(data); }
            }
            int low = Percentile(histogram, (int)Math.Floor((gray.Length - 1) * .05));
            int high = Percentile(histogram, (int)Math.Floor((gray.Length - 1) * .95));
            result.Contrast = high - low;
            if (result.Contrast < 24) return result;
            for (int i = 0; i < gray.Length; i++)
                gray[i] = Math.Max(0, Math.Min(255, (int)Math.Round((gray[i] - low) * 255.0 / result.Contrast, MidpointRounding.AwayFromZero)));
            for (int y = 1; y < height - 1; y++) for (int x = 1; x < width - 1; x++)
            {
                int p = y * width + x;
                int gx = -gray[p - width - 1] + gray[p - width + 1] - 2 * gray[p - 1]
                    + 2 * gray[p + 1] - gray[p + width - 1] + gray[p + width + 1];
                int gy = -gray[p - width - 1] - 2 * gray[p - width] - gray[p - width + 1]
                    + gray[p + width - 1] + 2 * gray[p + width] + gray[p + width + 1];
                if (Math.Abs(gx) + Math.Abs(gy) < 128) continue;
                result.Feature[(y / 8) * 16 + x / 8]++;
                result.EdgePixels++;
            }
            foreach (int value in result.Feature) if (value > 0) result.ActiveCells++;
            result.Usable = IsUsable(result.Feature);
            return result;
        }

        private static int Percentile(int[] histogram, int rank)
        {
            int count = 0;
            for (int i = 0; i < histogram.Length; i++) { count += histogram[i]; if (count > rank) return i; }
            return 255;
        }

        public static bool IsUsable(int[] values)
        {
            if (values == null || values.Length != 128) return false;
            int count = 0, active = 0; double squared = 0;
            foreach (int value in values)
            {
                if (value < 0 || value > 64) return false;
                count += value; squared += value * value; if (value > 0) active++;
            }
            // Dense Chinese glyphs can legitimately occupy over half the edge
            // cells. Reject near-uniform maps by variance, rather than treating
            // all high-density titles as empty. This is an information check,
            // independent of the conservative shape comparison below.
            double mean = count / 128.0;
            return count >= 64 && count <= 7000 && active >= 8 && squared / 128 - mean * mean >= 8;
        }

        // A provisional identity gate, not a name classifier or an accuracy
        // estimate. All three exact OCR titles must also share the same offer.
        public static bool Matches(int[] current, int[] reference)
        {
            if (!IsUsable(current) || !IsUsable(reference)) return false;
            double dot = 0, a = 0, b = 0, difference = 0, total = 0;
            for (int i = 0; i < 128; i++)
            {
                dot += current[i] * reference[i]; a += current[i] * current[i]; b += reference[i] * reference[i];
                difference += Math.Abs(current[i] - reference[i]); total += Math.Max(current[i], reference[i]);
            }
            return a > 0 && b > 0 && dot / Math.Sqrt(a * b) >= .97 && total > 0 && difference / total <= .12;
        }

        internal static int ValidateFixtures()
        {
            int checks = 0;
            Action<bool, string> check = delegate(bool value, string message) { checks++; if (!value) throw new InvalidOperationException(message); };
            Func<Color, Color, int, Bitmap> draw = delegate(Color background, Color foreground, int variant)
            {
                var image = new Bitmap(220, 110);
                using (Graphics graphics = Graphics.FromImage(image))
                using (var pen = new Pen(foreground, 3))
                {
                    graphics.Clear(background);
                    for (int i = 0; i < 5; i++)
                    {
                        int x = 17 + i * 35;
                        graphics.DrawLine(pen, x, 23, x + 24, 23);
                        graphics.DrawLine(pen, x + 12, 14, x + 12, 63);
                        graphics.DrawLine(pen, x, 48, x + 24, 48);
                        if (variant == 0) graphics.DrawLine(pen, x, 64, x + 24, 35);
                        else graphics.DrawEllipse(pen, x, 33, 24, 29);
                    }
                }
                return image;
            };
            Rectangle title = new Rectangle(10, 10, 187, 61);
            using (Bitmap neutral = draw(Color.FromArgb(13, 20, 28), Color.FromArgb(225, 225, 225), 0))
            using (Bitmap gold = draw(Color.FromArgb(35, 35, 35), Color.FromArgb(240, 191, 70), 0))
            using (Bitmap cyan = draw(Color.FromArgb(13, 20, 28), Color.FromArgb(90, 225, 225), 0))
            using (Bitmap other = draw(Color.FromArgb(13, 20, 28), Color.White, 1))
            using (Bitmap blank = new Bitmap(220, 110))
            {
                var original = Extract(neutral, title);
                check(original.Usable, "Synthetic title has insufficient information.");
                check(Matches(Extract(gold, title).Feature, original.Feature), "Gold hover changed normalized title identity.");
                check(Matches(Extract(cyan, title).Feature, original.Feature), "Cyan hover changed normalized title identity.");
                check(!Matches(Extract(other, title).Feature, original.Feature), "Different synthetic title was accepted.");
                using (Graphics graphics = Graphics.FromImage(neutral)) graphics.FillRectangle(Brushes.Gold, 0, 80, 220, 30);
                check(Matches(Extract(neutral, title).Feature, original.Feature), "Card body animation altered the title-only feature.");
                check(!Extract(blank, title).Usable, "Blank title was accepted.");
                check(!Extract(blank, new Rectangle(-1, 0, 12, 12)).Usable, "Out-of-bounds title was accepted.");
                check(!Matches(new int[128], original.Feature), "Blank feature matched a title.");
                var uniform = new int[128]; for (int i = 0; i < uniform.Length; i++) uniform[i] = 32;
                check(!IsUsable(uniform), "Uniform dense edge map was accepted as an informative title.");
                var malformed = (int[])original.Feature.Clone(); malformed[0] = 65;
                check(!IsUsable(malformed), "Out-of-range feature was accepted.");
            }
            return checks;
        }
    }
}
