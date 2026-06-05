import { config } from "../../../../config.ts";
import {
  type DownloadResult,
  DownloaderError,
  type IVideoDownloader,
} from "../../../domain/video/video-downloader.ts";
import { ensureInstagramCookies } from "../instagram-cookies.ts";
import { detectPlatform, extractExternalPostId } from "../url-parsing.ts";
import { parseYtDlpTimestamp } from "../ytdlp-timestamp.ts";

/// Téléchargeur par défaut : yt-dlp + ffmpeg.
///
/// Couvre TikTok (sans cookies) et Instagram (avec cookies).
/// Cas particulier : pour les URLs CDN Instagram directes (cdninstagram.com /
/// scontent.*), on ne passe pas par yt-dlp mais par un fetch direct + ffmpeg
/// pour extraire l'audio. Ces URLs sont éphémères et n'ont pas de metadata
/// → postedAt et externalPostId restent null sur ce chemin.
export class YtDlpDownloader implements IVideoDownloader {
  readonly name = "yt-dlp";

  async download(url: string): Promise<DownloadResult> {
    await Deno.mkdir(config.videoStorage.basePath, { recursive: true });
    const filename = crypto.randomUUID();
    const videoPath = `${config.videoStorage.basePath}/${filename}.mp4`;
    const audioPath = `${config.videoStorage.basePath}/${filename}.mp3`;
    const platform = detectPlatform(url);
    const externalPostId = extractExternalPostId(url);

    // Chemin CDN Instagram direct (URL d'un MP4 déjà signé). Pas de metadata,
    // pas de chance de marcher avec yt-dlp.
    if (url.includes("cdninstagram") || url.includes("scontent")) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new DownloaderError(
            "download_failed",
            this.name,
            `direct CDN fetch HTTP ${res.status}`,
          );
        }
        await Deno.writeFile(videoPath, new Uint8Array(await res.arrayBuffer()));
        await this.#extractAudio(videoPath, audioPath);
      } catch (err) {
        if (err instanceof DownloaderError) throw err;
        throw new DownloaderError(
          "download_failed",
          this.name,
          `CDN direct fetch failed`,
          err,
        );
      }
      return { videoPath, audioPath, postedAt: null, externalPostId, platform, authorHandle: null, caption: null };
    }

    // Chemin yt-dlp standard. Cookies passés uniquement si dispo (sans
    // cookies yt-dlp fait quand même les URLs publiques TikTok/YouTube/…).
    //
    // --output utilise le template %(ext)s pour que yt-dlp produise deux
    // fichiers separes : <uuid>.mp4 (video) + <uuid>.mp3 (audio post-extrait).
    // Sans ca, --output qui contient deja une extension finit en .mp4.mp3.
    // --keep-video empeche yt-dlp de supprimer le mp4 apres l'extraction.
    const cookiesPath = await ensureInstagramCookies();
    const outputTemplate = `${config.videoStorage.basePath}/${filename}.%(ext)s`;
    const args = [
      url,
      "--output", outputTemplate,
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--keep-video",
      // Force remux en mp4 : Instagram sert parfois du webm, et le pipeline
      // (Supabase storage, lecteur video Flutter) attend du mp4.
      "--remux-video", "mp4",
      "--no-playlist",
      // timestamp + plusieurs champs candidats pour le @handle, séparés par
      // des tabulations. Sur Instagram, uploader_id est l'ID NUMÉRIQUE — le
      // handle textuel est dans channel/uploader. On essaie chaque champ et on
      // garde le premier non-numérique (voir pickHandle ci-dessous).
      "--print", "%(timestamp)s\t%(channel)s\t%(uploader)s\t%(uploader_id)s",
      "--no-simulate",
      "--quiet",
    ];
    if (cookiesPath) args.push("--cookies", cookiesPath);
    // TikTok detecte les TLS fingerprints Python par defaut → "IP blocked".
    // curl_cffi (installe dans le venv via Dockerfile) sait imiter Chrome.
    // On le sollicite uniquement pour TikTok : Instagram marche sans (et
    // les builds ou curl_cffi se charge mal feraient crasher yt-dlp si
    // l'option etait globale).
    if (platform === "tiktok") args.push("--impersonate", "chrome");

    let proc;
    try {
      proc = new Deno.Command("yt-dlp", { args, stdout: "piped", stderr: "piped" });
    } catch (err) {
      // Deno lève NotFound si le binaire n'est pas dans PATH.
      throw new DownloaderError(
        "tool_missing",
        this.name,
        "yt-dlp binary not in PATH",
        err,
      );
    }

    const { code, stdout, stderr } = await proc.output();
    if (code !== 0) {
      const msg = new TextDecoder().decode(stderr);
      const kind = classifyYtDlpError(msg);
      throw new DownloaderError(kind, this.name, msg.slice(0, 500));
    }

    const printed = new TextDecoder().decode(stdout);
    const [tsField, ...handleFields] = printed.split("\n")[0]?.split("\t") ?? [];
    const postedAt = parseYtDlpTimestamp(tsField ?? "");
    // channel > uploader > uploader_id : on garde le premier qui donne un
    // handle textuel valide (normalizeHandle rejette les IDs numériques).
    const authorHandle = handleFields.map(normalizeHandle).find((h) => h !== null) ?? null;
    return { videoPath, audioPath, postedAt, externalPostId, platform, authorHandle, caption: null };
  }

  async #extractAudio(videoPath: string, audioPath: string): Promise<void> {
    const ff = new Deno.Command("ffmpeg", {
      args: ["-y", "-i", videoPath, "-vn", "-q:a", "0", audioPath],
      stdout: "piped",
      stderr: "piped",
    });
    const res = await ff.output();
    if (res.code !== 0) {
      throw new DownloaderError(
        "download_failed",
        this.name,
        `ffmpeg failed: ${new TextDecoder().decode(res.stderr).slice(0, 200)}`,
      );
    }
  }
}

/// Normalise le handle auteur renvoyé par yt-dlp (`%(uploader_id)s`).
/// Retire un éventuel `@`, trim, et écarte les valeurs vides ou "NA" que
/// yt-dlp imprime quand le champ est absent. Exporté pour test.
export function normalizeHandle(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^@/, "");
  if (!cleaned || cleaned.toUpperCase() === "NA" || cleaned === "None") return null;
  // Rejette les IDs purement numériques : sur Instagram, yt-dlp expose souvent
  // l'owner_id numérique (ex: "48282483883") au lieu du @handle textuel. On ne
  // veut pas créer un faux influenceur nommé d'après cet ID.
  if (/^\d+$/.test(cleaned)) return null;
  return cleaned;
}

/// Heuristique sur la sortie stderr de yt-dlp pour classifier l'erreur.
/// Exporté pour test.
export function classifyYtDlpError(stderr: string): import("../../../domain/video/video-downloader.ts").DownloaderErrorKind {
  const s = stderr.toLowerCase();
  if (s.includes("login required") || s.includes("rate-limit") && s.includes("login")) {
    return "auth";
  }
  if (s.includes("http error 429") || s.includes("rate limit")) {
    return "rate_limited";
  }
  if (s.includes("http error 404") || s.includes("not found") || s.includes("unavailable")) {
    return "not_found";
  }
  return "download_failed";
}
