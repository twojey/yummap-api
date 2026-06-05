import {
  type DownloadResult,
  DownloaderError,
  type IVideoDownloader,
} from "../../../domain/video/video-downloader.ts";

/// Orchestrateur de téléchargement en cascade.
///
/// Essaie chaque adapter dans l'ordre fourni. Si un adapter réussit, on
/// retourne son résultat. Si un adapter échoue, on logue l'erreur classifiée
/// puis on passe au suivant. Si tous échouent, on remonte la dernière erreur
/// (celle qui correspond à l'adapter le plus "fort" qu'on avait à proposer).
///
/// Cas particulier : `unsupported_url`. Cet adapter ne sait pas gérer cette
/// URL (ex: gallery-dl pour une URL TikTok). On le saute sans le compter
/// comme un échec : ça ne pollue pas les métriques.
export class CascadingDownloader implements IVideoDownloader {
  readonly name = "cascading";

  constructor(private readonly adapters: readonly IVideoDownloader[]) {
    if (adapters.length === 0) {
      throw new Error("CascadingDownloader needs at least one adapter");
    }
  }

  async download(url: string): Promise<DownloadResult> {
    let lastErr: DownloaderError | null = null;
    let attemptCount = 0;

    for (const adapter of this.adapters) {
      try {
        const result = await adapter.download(url);
        // Garde anti-"écran noir" : certains downloaders (yt-dlp sur un reel
        // dont Instagram sert audio et vidéo en streams séparés) "réussissent"
        // en ne produisant qu'un MP4 audio-only. On le détecte via ffprobe et
        // on traite ça comme un échec → la cascade essaie l'adapter suivant
        // (souvent gallery-dl récupère le MP4 progressif complet).
        if (!(await hasVideoTrack(result.videoPath))) {
          await Deno.remove(result.videoPath).catch(() => {});
          await Deno.remove(result.audioPath).catch(() => {});
          throw new DownloaderError(
            "download_failed",
            adapter.name,
            "downloaded file has no video track (audio-only stream)",
          );
        }
        if (attemptCount > 0) {
          console.log(
            `[Cascade] ✓ ${adapter.name} succeeded after ${attemptCount} fallback(s)`,
          );
        }
        return result;
      } catch (err) {
        const downloaderErr = toDownloaderError(adapter.name, err);
        if (downloaderErr.kind === "unsupported_url") {
          // Ne compte pas comme un échec ; l'adapter n'aurait pas dû être
          // appelé pour cette URL. Pas de log bruyant.
          continue;
        }
        if (downloaderErr.kind === "tool_missing") {
          // Cas opérationnel (binaire pas installé) : log moins fort que
          // les erreurs Instagram, et on passe au suivant.
          console.warn(
            `[Cascade] ${adapter.name} skipped (tool missing): ${downloaderErr.message}`,
          );
          continue;
        }
        console.warn(
          `[Cascade] ${adapter.name} failed (${downloaderErr.kind}), trying next…`,
        );
        lastErr = downloaderErr;
        attemptCount++;
      }
    }

    if (lastErr) throw lastErr;
    // Tous les adapters ont retourné `unsupported_url` → l'URL n'est pas
    // supportée par notre stack. Remonte une erreur dédiée.
    throw new DownloaderError(
      "unsupported_url",
      this.name,
      "no adapter could handle this URL",
    );
  }
}

/// Vérifie via ffprobe que le fichier contient une piste vidéo. Si ffprobe est
/// absent ou échoue, on renvoie `true` (on ne bloque pas un import à cause d'un
/// outil manquant — mieux vaut tenter l'upload).
async function hasVideoTrack(videoPath: string): Promise<boolean> {
  try {
    const probe = new Deno.Command("ffprobe", {
      args: [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_type",
        "-of", "default=noprint_wrappers=1",
        videoPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout } = await probe.output();
    return new TextDecoder().decode(stdout).includes("codec_type=video");
  } catch {
    return true;
  }
}

function toDownloaderError(adapter: string, err: unknown): DownloaderError {
  if (err instanceof DownloaderError) return err;
  return new DownloaderError(
    "download_failed",
    adapter,
    err instanceof Error ? err.message : String(err),
    err,
  );
}
