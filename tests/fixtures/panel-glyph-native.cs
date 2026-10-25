using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;

namespace HexGuide.Desktop
{
    // Offline only: exercises production extraction and classification against
    // pinned catalog PNGs. It never creates a watcher or opens a game surface.
    internal static class PanelGlyphNativeFixture
    {
        public static void Main(string[] args)
        {
            string[] ids = { "its_killing_time", "final_form", "surge_field", "goliath", "eureka" };
            var shapes = new Dictionary<string, OwnedPanelShape>();
            var glyphs = new Dictionary<string, object>();
            foreach (string id in ids)
            {
                using (var bitmap = new Bitmap(Path.Combine(args[0], id + ".png")))
                {
                    var shape = OwnedPanelShape.Extract(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                    if (shape == null) throw new InvalidOperationException("Unusable catalog template: " + id);
                    shapes[id] = shape; glyphs[id] = shape.Fingerprint;
                }
            }
            var candidates = new[] { shapes["final_form"], shapes["surge_field"], shapes["goliath"] };
            var shared = OwnedPanelMatcher.Match(shapes["its_killing_time"], candidates, new[] { shapes["its_killing_time"] }, new OwnedPanelShape[0]);
            var ownedOnly = OwnedPanelMatcher.Match(shapes["its_killing_time"], new[] { shapes["goliath"], shapes["eureka"], shapes["goliath"] }, new[] { shapes["its_killing_time"] }, new OwnedPanelShape[0]);
            var context = new OwnedPanelContext {
                Ids = new[] { "final_form", "surge_field", "goliath" },
                IconUrls = new[] {
                    "https://raw.communitydragon.org/16.21/game/assets/ux/kiwi/augments/icons/finalform_small.png",
                    "https://raw.communitydragon.org/16.21/game/assets/ux/kiwi/augments/icons/surgefield_small.png",
                    "https://raw.communitydragon.org/16.21/game/assets/ux/cherry/augments/icons/goliath_small.png" },
                OwnedIds = new[] { "its_killing_time" },
                OwnedUrls = new[] { "https://raw.communitydragon.org/16.21/game/assets/ux/cherry/augments/icons/itskillingtime_small.png" }
            };
            var result = new Dictionary<string, object> {
                { "mode", "offline-no-ui" }, { "liveVerified", false }, { "glyphs", glyphs },
                { "shared", shared.Proof() }, { "ownedOnly", ownedOnly.Proof() },
                { "templateProof", OwnedPanelGlyphIdentity.Proof(context, candidates, new[] { shapes["its_killing_time"] }) },
                { "binding", OwnedPanelGlyphIdentity.Binding("final_form", "https://raw.communitydragon.org/16.21/game/assets/ux/kiwi/augments/icons/finalform_small.png") },
                { "fixtureChecks", OwnedPanelFixtures.Run() }
            };
            Console.WriteLine(new JavaScriptSerializer().Serialize(result));
        }
    }
}
