import { config } from "../../../../config.ts";
import {
  type DownloadResult,
  DownloaderError,
  type IVideoDownloader,
} from "../../../domain/video/video-downloader.ts";
import { extractVideoUrlFromHtml } from "../instagram-html-parsing.ts";
import { detectPlatform, extractExternalPostId } from "../url-parsing.ts";

/// Dernier filet : fetch HTTP direct de la page Instagram, parse l'URL du
/// MP4 depuis le HTML rendu serveur. Pas de dépendance binaire externe.
///
/// Stratégie de parsing (ordre de robustesse) :
///   1. `<meta property="og:video" content="...">` — couvre tous les Reels
///      publics.
///   2. `<meta property="og:video:secure_url" content="...">` — variante.
///   3. Bloc JSON `__additionalDataLoaded` ou `__NEXT_DATA__` qui contient
///      video_url. Plus fragile à l'évolution du DOM IG.
///
/// Limites :
///   - Posts privés inaccessibles (page renvoie un login wall).
///   - postedAt non extrait depuis le HTML (la date n'est pas en meta).
///   - On dépend du User-Agent : IG sert un HTML différent selon UA.
export class HttpFallbackDownloader implements IVideoDownloader {
  readonly name = "http-fallback";

  async download(url: string): Promise<DownloadResult> {
    const platform = detectPlatform(url);
    if (platform !== "instagram") {
      throw new DownloaderError(
        "unsupported_url",
        this.name,
        `http-fallback only handles Instagram, got ${platform ?? "unknown"}`,
      );
    }

    const html = await fetchInstagramHtml(url).catch((err) => {
      throw new DownloaderError(
        "download_failed",
        this.name,
        `fetch page failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    const videoUrl = extractVideoUrlFromHtml(html);
    if (!videoUrl) {
      throw new DownloaderError(
        "not_found",
        this.name,
        "no og:video meta tag nor json payload with video_url",
      );
    }

    await Deno.mkdir(config.videoStorage.basePath, { recursive: true });
    const filename = crypto.randomUUID();
    const videoPath = `${config.videoStorage.basePath}/${filename}.mp4`;
    const audioPath = `${config.videoStorage.basePath}/${filename}.mp3`;

    const res = await fetch(videoUrl);
    if (!res.ok) {
      throw new DownloaderError(
        "download_failed",
        this.name,
        `CDN fetch HTTP ${res.status}`,
      );
    }
    await Deno.writeFile(videoPath, new Uint8Array(await res.arrayBuffer()));

    // ffmpeg pour l'audio (Whisper).
    const ff = new Deno.Command("ffmpeg", {
      args: ["-y", "-i", videoPath, "-vn", "-q:a", "0", audioPath],
      stdout: "piped",
      stderr: "piped",
    });
    const ffRes = await ff.output();
    if (ffRes.code !== 0) {
      throw new DownloaderError(
        "download_failed",
        this.name,
        `ffmpeg failed: ${new TextDecoder().decode(ffRes.stderr).slice(0, 200)}`,
      );
    }

    return {
      videoPath,
      audioPath,
      // Le HTML public ne contient pas de timestamp parsable de manière stable.
      // L'heuristique posted_at sera dégradée, le fingerprint reste le signal #1.
      postedAt: null,
      externalPostId: extractExternalPostId(url),
      platform: "instagram",
    };
  }
}

/// Fetch la page Instagram avec un UA mobile (HTML plus simple + plus stable
/// que la version desktop). Suit les redirects.
async function fetchInstagramHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

