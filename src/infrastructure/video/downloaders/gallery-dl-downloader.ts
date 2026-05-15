import { config } from "../../../../config.ts";
import {
  type DownloadResult,
  DownloaderError,
  type IVideoDownloader,
} from "../../../domain/video/video-downloader.ts";
import { ensureInstagramCookies } from "../instagram-cookies.ts";
import { detectPlatform, extractExternalPostId } from "../url-parsing.ts";

/// Fallback gratuit après yt-dlp. gallery-dl parse Instagram via un endpoint
/// API mobile différent du web scraping de yt-dlp — quand IG change quelque
/// chose qui casse yt-dlp, gallery-dl tient souvent encore (et inversement).
///
/// Cible Instagram uniquement. Sur d'autres plateformes (TikTok), on lève
/// `unsupported_url` pour que le cascade saute l'adapter.
///
/// gallery-dl écrit le média dans un sous-dossier puis on a besoin de
/// l'identifier. On utilise `--print "{filename}"` pour capter le chemin
/// résultat directement.
export class GalleryDlDownloader implements IVideoDownloader {
  readonly name = "gallery-dl";

  async download(url: string): Promise<DownloadResult> {
    const platform = detectPlatform(url);
    if (platform !== "instagram") {
      throw new DownloaderError(
        "unsupported_url",
        this.name,
        `gallery-dl is only used for Instagram, got ${platform ?? "unknown"}`,
      );
    }

    await Deno.mkdir(config.videoStorage.basePath, { recursive: true });
    const filename = crypto.randomUUID();
    const targetVideoPath = `${config.videoStorage.basePath}/${filename}.mp4`;
    const audioPath = `${config.videoStorage.basePath}/${filename}.mp3`;

    const cookiesPath = await ensureInstagramCookies();
    const args = [
      url,
      // -D : destination directe, sans sous-dossier de catégorie.
      "-D", config.videoStorage.basePath,
      // Force le nom de fichier de sortie (sans extension, gallery-dl ajoute la sienne).
      "-o", `filename=${filename}`,
      // JSON sur stdout — on s'en sert pour récupérer le timestamp.
      "--write-info-json",
      "--no-postprocessors",
      "-q",
    ];
    if (cookiesPath) args.push("--cookies", cookiesPath);

    let proc;
    try {
      proc = new Deno.Command("gallery-dl", { args, stdout: "piped", stderr: "piped" });
    } catch (err) {
      throw new DownloaderError(
        "tool_missing",
        this.name,
        "gallery-dl binary not in PATH",
        err,
      );
    }

    const { code, stderr } = await proc.output();
    if (code !== 0) {
      const msg = new TextDecoder().decode(stderr);
      const kind = classifyGalleryDlError(msg);
      throw new DownloaderError(kind, this.name, msg.slice(0, 500));
    }

    // gallery-dl écrit avec l'extension de la source (mp4 généralement).
    // On localise le fichier produit puis on le déplace vers notre nom canonique.
    const produced = await findProduced(config.videoStorage.basePath, filename);
    if (!produced) {
      throw new DownloaderError(
        "download_failed",
        this.name,
        "gallery-dl claimed success but no output file found",
      );
    }
    if (produced !== targetVideoPath) {
      await Deno.rename(produced, targetVideoPath);
    }

    // Audio extraction via ffmpeg (gallery-dl ne le fait pas).
    await extractAudio(targetVideoPath, audioPath, this.name);

    // Timestamp depuis le JSON sidecar.
    const postedAt = await readPostedAtFromJson(
      `${config.videoStorage.basePath}/${filename}.json`,
    );

    return {
      videoPath: targetVideoPath,
      audioPath,
      postedAt,
      externalPostId: extractExternalPostId(url),
      platform: "instagram",
    };
  }
}

async function findProduced(dir: string, filenameStem: string): Promise<string | null> {
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    if (entry.name.startsWith(filenameStem) && entry.name.endsWith(".mp4")) {
      return `${dir}/${entry.name}`;
    }
  }
  return null;
}

async function extractAudio(videoPath: string, audioPath: string, adapter: string) {
  const ff = new Deno.Command("ffmpeg", {
    args: ["-y", "-i", videoPath, "-vn", "-q:a", "0", audioPath],
    stdout: "piped",
    stderr: "piped",
  });
  const res = await ff.output();
  if (res.code !== 0) {
    throw new DownloaderError(
      "download_failed",
      adapter,
      `ffmpeg failed: ${new TextDecoder().decode(res.stderr).slice(0, 200)}`,
    );
  }
}

/// Le JSON sidecar de gallery-dl pour Instagram contient un champ "date" en
/// secondes Unix (clé "date" ou "uploadDate" selon la version).
async function readPostedAtFromJson(path: string): Promise<Date | null> {
  try {
    const txt = await Deno.readTextFile(path);
    const j = JSON.parse(txt) as Record<string, unknown>;
    const candidates = [j["date"], j["uploadDate"], j["taken_at"]];
    for (const c of candidates) {
      if (typeof c === "number" && c > 0) return new Date(c * 1000);
      if (typeof c === "string" && c.length > 0) {
        const d = new Date(c);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  } catch (_) { /* JSON absent ou cassé */ }
  return null;
}

export function classifyGalleryDlError(stderr: string): import("../../../domain/video/video-downloader.ts").DownloaderErrorKind {
  const s = stderr.toLowerCase();
  if (s.includes("login") || s.includes("authentication") || s.includes("403")) {
    return "auth";
  }
  if (s.includes("429") || s.includes("rate limit")) return "rate_limited";
  if (s.includes("404") || s.includes("not found")) return "not_found";
  return "download_failed";
}
