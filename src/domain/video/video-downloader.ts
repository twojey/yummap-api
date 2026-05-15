/// Téléchargeur de vidéo depuis une URL (Instagram, TikTok, …).
///
/// Plusieurs implémentations existent en parallèle (yt-dlp, gallery-dl, fetch
/// direct…). Un orchestrateur (CascadingDownloader) les essaie en ordre pour
/// maximiser le taux de succès face à un Instagram capricieux : si yt-dlp
/// échoue, gallery-dl prend la suite, puis le HTTP fallback.
///
/// Toutes les implémentations doivent :
///  - écrire le MP4 dans le path qu'elles retournent (`videoPath`)
///  - écrire le MP3 audio dans `audioPath` (utile pour Whisper)
///  - retourner `postedAt` quand la plateforme le fournit, sinon null
///  - throw [DownloaderError] (jamais d'exception brute)
export interface IVideoDownloader {
  /// Nom court de l'adapter pour les logs (`yt-dlp`, `gallery-dl`, etc.).
  readonly name: string;

  download(url: string): Promise<DownloadResult>;
}

export interface DownloadResult {
  videoPath: string;
  audioPath: string;
  /// Timestamp de publication sur la plateforme si dispo. NULL si pas
  /// extractable.
  postedAt: Date | null;
  /// ID du post sur la plateforme si extractible ("shortcode" IG, video_id
  /// TikTok). NULL si pas extractable.
  externalPostId: string | null;
  /// Plateforme détectée depuis l'URL, utile en aval pour la dédup et le
  /// stockage.
  platform: "instagram" | "tiktok" | null;
}

/// Erreur classifiée d'un téléchargeur.
/// `kind` permet au caller (CascadingDownloader) de décider si l'erreur
/// justifie de tenter le niveau suivant ou non.
export class DownloaderError extends Error {
  constructor(
    readonly kind: DownloaderErrorKind,
    readonly adapter: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${adapter}] ${kind}: ${message}`);
  }
}

export type DownloaderErrorKind =
  /// Le binaire/outil n'est pas installé (yt-dlp absent, lib missing).
  /// Le cascade saute directement à l'adapter suivant.
  | "tool_missing"
  /// Instagram a renvoyé "login required" ou cookie expiré.
  /// Le cascade essaie l'adapter suivant (peut-être qu'il a une autre auth).
  | "auth"
  /// Rate limit / 429.
  | "rate_limited"
  /// Vidéo introuvable ou supprimée côté plateforme.
  /// Le cascade essaie quand même les autres (yt-dlp peut se tromper).
  | "not_found"
  /// Téléchargement échoué pour autre raison (réseau, parse, ...).
  | "download_failed"
  /// Le téléchargeur ne sait pas gérer cette URL (ex: HTTP fallback ne fait
  /// que Instagram, on appelle avec TikTok). Cascade saute.
  | "unsupported_url";
