// Matérialisation du cookies.txt Instagram à partir d'une env var base64.
//
// Pourquoi base64 : un cookies.txt Netscape contient des tabulations et des
// retours-ligne qui passent mal dans la plupart des secret managers (Fly
// secrets, Deno Deploy env vars). Base64 garantit un transport propre.
//
// Cycle de vie :
//   1. À l'export local : `base64 < .instagram-cookies.txt | tr -d '\n'`
//   2. Stocké dans `INSTAGRAM_COOKIES_B64` côté secret manager
//   3. Au boot du worker : décodé + écrit dans /tmp/instagram-cookies.txt
//   4. yt-dlp / gallery-dl lisent ce fichier via --cookies
//
// Le cookie expire (~30-90 jours). Quand yt-dlp commence à renvoyer
// "login required", refresh manuel : nouvelle session → nouveau b64 → secret
// → restart worker.

import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const RUNTIME_PATH = "/tmp/instagram-cookies.txt";

/// Matérialise le cookies.txt si une env var est définie. Retourne le path
/// utilisable (runtime ou dev local) ou null s'il n'y a pas de cookie dispo.
/// Idempotent : appelable plusieurs fois sans effet de bord.
export async function ensureInstagramCookies(): Promise<string | null> {
  // Priorité 1 : env var (prod). Toujours écrit en /tmp pour ne pas dépendre
  // du CWD du process.
  const b64 = Deno.env.get("INSTAGRAM_COOKIES_B64");
  if (b64 && b64.length > 0) {
    try {
      const bytes = decodeBase64(b64);
      await Deno.writeFile(RUNTIME_PATH, bytes);
      return RUNTIME_PATH;
    } catch (err) {
      console.warn("[InstagramCookies] base64 decode/write failed:", err);
      return null;
    }
  }

  // Priorité 2 : fichier local à la racine (dev). On ne le copie pas, on
  // pointe dessus directement.
  const localPath = `${Deno.env.get("PWD") ?? "."}/.instagram-cookies.txt`;
  try {
    const stat = await Deno.stat(localPath);
    if (stat.isFile) return localPath;
  } catch (_) {
    // Pas de fichier local — pas grave, juste pas de cookies dispo.
  }

  return null;
}
