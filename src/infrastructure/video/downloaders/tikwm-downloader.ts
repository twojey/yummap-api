import { config } from "../../../../config.ts";
import {
  type DownloadResult,
  DownloaderError,
  type IVideoDownloader,
} from "../../../domain/video/video-downloader.ts";
import { detectPlatform, extractExternalPostId } from "../url-parsing.ts";

/// Telechargeur TikTok via l'API publique TikWm (https://tikwm.com).
///
/// Pourquoi cet adapter : TikTok detecte les TLS fingerprints Python par
/// defaut et renvoie "Your IP address is blocked", meme depuis une IP
/// residentielle. curl_cffi est cense fixer ca mais charge mal dans
/// certaines images Docker. TikWm fait le scraping pour nous et expose un
/// endpoint REST qui renvoie l'URL du mp4 sans watermark + metadata.
///
/// Limites :
///   - Rate limit ~5 req/s (TikWm). En pratique on est tres en-dessous.
///   - Service tiers : si TikWm tombe, on tombe aussi. Pas de SLA.
///   - Si TikTok change leur API, TikWm met quelques heures/jours a suivre.
///
/// La cascade place TikWm apres yt-dlp : si un jour curl_cffi se met a
/// marcher, on bascule automatiquement sur la voie native sans rien
/// changer.
export class TikWmDownloader implements IVideoDownloader {
  readonly name = "tikwm";

  async download(url: string): Promise<DownloadResult> {
    const platform = detectPlatform(url);
    if (platform !== "tiktok") {
      throw new DownloaderError(
        "unsupported_url",
        this.name,
        `tikwm only handles TikTok, got ${platform ?? "unknown"}`,
      );
    }

    // 1. Demande a TikWm l'URL du mp4. POST form-encoded, pas JSON.
    const body = new URLSearchParams({ url, hd: "1" });
    let res: Response;
    try {
      res = await fetch("https://www.tikwm.com/api/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      throw new DownloaderError(
        "download_failed",
        this.name,
        `network error calling tikwm: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      // 429 = rate-limited cote TikWm. Autre 5xx = transient.
      if (res.status === 429) {
        throw new DownloaderError("rate_limited", this.name, `tikwm HTTP 429`);
      }
      throw new DownloaderError(
        "download_failed",
        this.name,
        `tikwm HTTP ${res.status}`,
      );
    }

    const payload = await res.json() as {
      code?: number;
      msg?: string;
      data?: {
        play?: string;
        hdplay?: string;
        create_time?: number;
      };
    };

    if (payload.code !== 0 || !payload.data?.play) {
      // code=-1 + "Url is invalid" → TikTok ne resout pas (post supprime/prive).
      const kind: DownloaderError["kind"] =
        (payload.msg ?? "").toLowerCase().includes("invalid") ? "not_found" : "download_failed";
      throw new DownloaderError(
        kind,
        this.name,
        `tikwm code=${payload.code} msg=${payload.msg ?? "unknown"}`,
      );
    }

    // Prefere la HD si dispo, sinon SD. play = sans watermark (HD), hdplay
    // = identique mais explicite ; ils mettent les 2 par historique d'API.
    const mp4Url = payload.data.hdplay ?? payload.data.play;
    if (!mp4Url) {
      throw new DownloaderError("not_found", this.name, "tikwm returned no playable URL");
    }

    // 2. Telecharge le mp4 vers le storage local.
    await Deno.mkdir(config.videoStorage.basePath, { recursive: true });
    const filename = crypto.randomUUID();
    const videoPath = `${config.videoStorage.basePath}/${filename}.mp4`;
    const audioPath = `${config.videoStorage.basePath}/${filename}.mp3`;

    let videoRes: Response;
    try {
      videoRes = await fetch(mp4Url);
    } catch (err) {
      throw new DownloaderError(
        "download_failed",
        this.name,
        `failed to fetch mp4: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!videoRes.ok) {
      throw new DownloaderError(
        "download_failed",
        this.name,
        `mp4 download HTTP ${videoRes.status}`,
      );
    }
    await Deno.writeFile(videoPath, new Uint8Array(await videoRes.arrayBuffer()));

    // 3. Extrait l'audio via ffmpeg (qui est dans le container).
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

    // TikWm donne create_time en secondes Unix.
    const postedAt = payload.data.create_time
      ? new Date(payload.data.create_time * 1000)
      : null;

    return {
      videoPath,
      audioPath,
      postedAt,
      externalPostId: extractExternalPostId(url),
      platform: "tiktok",
    };
  }
}
