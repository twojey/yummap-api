// Génération de thumbnail JPEG depuis une vidéo locale via ffmpeg.
//
// Pourquoi JPEG : encodeur disponible partout (ffmpeg minimal, brew, apt).
// WebP serait ~2-3x plus petit mais nécessite ffmpeg compilé avec libwebp,
// pas garanti sur toutes les distros. JPEG à qualité 5 (=~75 %) donne
// ~25-40 kB à 400px de large — toujours > 99 % d'économie vs la vidéo
// (~10 MB), donc le gain marginal du WebP ne justifie pas la dépendance
// supplémentaire.
//
// Pourquoi 2 secondes : la frame 0 est souvent noire ou un fade-in.
// La 2e seconde donne une image représentative dans 95 % des cas.
//
// Pourquoi 400px : largeur affichée sur l'app
//  - grille influenceur 3 colonnes : ~130 px @3x = 390 px de source
//  - tile resto 220 px : 220 @3x = 660 px (légèrement undersized mais
//    invisible vu la taille à l'écran)
// 400 reste un bon compromis taille/qualité.

import { exists } from "https://deno.land/std@0.224.0/fs/exists.ts";

export interface ThumbnailResult {
  thumbPath: string;
  // Taille en bytes pour logging/observabilité.
  size: number;
  // Content-type à utiliser à l'upload Storage.
  contentType: string;
}

export const THUMBNAIL_EXTENSION = "jpg";
export const THUMBNAIL_CONTENT_TYPE = "image/jpeg";

/**
 * Génère un thumbnail JPEG à côté du fichier vidéo source.
 * Retourne le path et la taille du thumbnail.
 *
 * Le caller est responsable de :
 *   - supprimer le thumbnail après upload Storage (cleanup local)
 *   - gérer les erreurs ffmpeg (vidéo corrompue, etc.)
 */
export async function generateThumbnail(videoPath: string): Promise<ThumbnailResult> {
  const thumbPath = videoPath.replace(/\.mp4$/, `_thumb.${THUMBNAIL_EXTENSION}`);

  // -ss 2 : seek à 2 secondes (avant -i pour seek rapide via keyframes)
  // -vframes 1 : 1 frame seulement
  // -vf scale=400:-1 : largeur 400px, hauteur auto (préserve aspect)
  // -q:v 5 : qualité MJPEG (échelle 2-31, plus bas = meilleur ; 5 ≈ 80 %)
  // -y : overwrite si le fichier existe (idempotent)
  const ff = new Deno.Command("ffmpeg", {
    args: [
      "-ss", "2",
      "-i", videoPath,
      "-vframes", "1",
      "-vf", "scale=400:-1",
      "-q:v", "5",
      "-y",
      thumbPath,
    ],
    stdout: "null",
    stderr: "piped",
  });

  const res = await ff.output();
  if (!res.success) {
    // Filtre le banner ffmpeg pour ne garder que l'erreur réelle (les
    // dernières lignes du stderr).
    const stderr = new TextDecoder().decode(res.stderr);
    const tail = stderr.split("\n").filter((l) => l.trim()).slice(-3).join(" | ");
    throw new Error(`ffmpeg thumbnail failed: ${tail.slice(0, 300)}`);
  }

  if (!(await exists(thumbPath))) {
    throw new Error(`ffmpeg succeeded but ${thumbPath} not found`);
  }

  const stat = await Deno.stat(thumbPath);
  return { thumbPath, size: stat.size, contentType: THUMBNAIL_CONTENT_TYPE };
}
