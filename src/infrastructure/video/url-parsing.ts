/// Utilitaires d'inspection d'URLs Instagram/TikTok partagées.
/// Pure : pas d'I/O, faciles à tester.

export type Platform = "instagram" | "tiktok";

export function detectPlatform(url: string): Platform | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes("instagram.com")) return "instagram";
    if (h.includes("tiktok.com")) return "tiktok";
  } catch (_) { /* URL invalide */ }
  return null;
}

/// Extrait l'ID de post stable. Pour la dédup on a besoin du même ID quelle
/// que soit la variante de l'URL (avec ou sans tracking params, /reel/ vs /p/…).
///
/// Instagram :
///   https://www.instagram.com/p/{shortcode}/         → shortcode
///   https://www.instagram.com/reel/{shortcode}/      → shortcode
///   https://www.instagram.com/reels/{shortcode}/     → shortcode
///   https://www.instagram.com/tv/{shortcode}/        → shortcode
///
/// TikTok :
///   https://www.tiktok.com/@user/video/{id}          → id
///   https://vm.tiktok.com/XXXX/                      → null (URL courte
///                                                       résolvable seulement
///                                                       après redirect)
export function extractExternalPostId(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const host = u.hostname.toLowerCase();

    if (host.includes("instagram.com")) {
      const i = segs.findIndex((s) => ["p", "reel", "reels", "tv"].includes(s));
      if (i !== -1 && segs.length > i + 1) return segs[i + 1];
      return null;
    }

    if (host.includes("tiktok.com")) {
      const i = segs.indexOf("video");
      if (i !== -1 && segs.length > i + 1) return segs[i + 1];
      return null;
    }
  } catch (_) { /* URL invalide */ }
  return null;
}
