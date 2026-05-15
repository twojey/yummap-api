/// Parsing pur du HTML d'une page Instagram publique pour en extraire l'URL
/// du MP4. Aucun I/O — exécutable depuis n'importe quel contexte (tests
/// unitaires sans permission, edge runtime, etc.).
///
/// Stratégies par ordre de robustesse :
///   1. `<meta property="og:video" content="...">` — le plus stable sur les
///      Reels publics. Ce que renvoie Instagram aux crawlers SEO.
///   2. `<meta property="og:video:secure_url" content="...">` — variante.
///   3. Bloc JSON inline contenant `"video_url":"..."` — plus fragile (DOM
///      change parfois) mais sauve les cas où le meta est absent.

export function extractVideoUrlFromHtml(html: string): string | null {
  // 1. Meta og:video — le plus stable.
  const og = /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i
    .exec(html);
  if (og?.[1]) return decodeHtmlEntities(og[1]);

  const ogSecure =
    /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i
      .exec(html);
  if (ogSecure?.[1]) return decodeHtmlEntities(ogSecure[1]);

  // 2. JSON inline — cherche `"video_url":"..."` éventuellement avec
  // échappements JS standards.
  const jsonMatch = /"video_url":\s*"((?:[^"\\]|\\.)+)"/i.exec(html);
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(`"${jsonMatch[1]}"`);
    } catch (_) {
      return jsonMatch[1].replace(/\\\//g, "/");
    }
  }

  return null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
