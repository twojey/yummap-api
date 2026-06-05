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
      // JSON sur stdout — on s'en sert pour récupérer le timestamp et la caption.
      "--write-info-json",
      // NOTE: --no-postprocessors retiré intentionnellement. Instagram sert parfois
      // audio et vidéo dans des streams séparés ; gallery-dl les fusionne via un
      // postprocessor ffmpeg. Sans ce flag, on obtenait un MP4 audio-only (écran noir).
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

    // Vérifie que le fichier téléchargé contient bien une piste vidéo.
    // gallery-dl peut produire un MP4 audio-only si Instagram sert les streams
    // séparément et qu'un postprocessor échoue.
    await assertHasVideoTrack(targetVideoPath, audioPath, this.name);

    // Audio extraction via ffmpeg (gallery-dl ne le fait pas).
    await extractAudio(targetVideoPath, audioPath, this.name);

    // Timestamp, handle auteur et caption depuis le JSON sidecar.
    const jsonPath = `${config.videoStorage.basePath}/${filename}.json`;
    const postedAt = await readPostedAtFromJson(jsonPath);
    const authorHandle = await readAuthorHandleFromJson(jsonPath);
    const caption = await readCaptionFromJson(jsonPath);

    return {
      videoPath: targetVideoPath,
      audioPath,
      postedAt,
      externalPostId: extractExternalPostId(url),
      platform: "instagram",
      authorHandle,
      caption,
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

/// Extrait le handle Instagram de l'auteur depuis le JSON sidecar gallery-dl.
/// gallery-dl expose le handle via "username" ou "owner.username".
/// On rejette les valeurs purement numériques (user_id Instagram) — un handle
/// Instagram valide contient toujours au moins une lettre ou un underscore.
async function readAuthorHandleFromJson(path: string): Promise<string | null> {
  try {
    const txt = await Deno.readTextFile(path);
    const j = JSON.parse(txt) as Record<string, unknown>;
    const candidates = [
      j["username"],
      (j["owner"] as Record<string, unknown> | null)?.["username"],
      j["uploader"],
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const cleaned = candidate.trim().replace(/^@/, "");
      // Rejette les IDs numériques purs (ex: "48282483883") — ce sont des
      // user_id Instagram, pas des handles textuels.
      if (cleaned && !/^\d+$/.test(cleaned)) return cleaned;
    }
  } catch (_) { /* JSON absent ou cassé */ }
  return null;
}

/// Extrait la légende/description du post depuis le JSON sidecar gallery-dl.
/// Instagram expose la caption dans "description" ou "content".
async function readCaptionFromJson(path: string): Promise<string | null> {
  try {
    const txt = await Deno.readTextFile(path);
    const j = JSON.parse(txt) as Record<string, unknown>;
    for (const key of ["description", "content", "caption"]) {
      const v = j[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch (_) { /* JSON absent */ }
  return null;
}

/// Vérifie via ffprobe que le fichier contient une piste vidéo.
/// Nettoie les fichiers temporaires et lève download_failed si audio-only.
async function assertHasVideoTrack(videoPath: string, audioPath: string, adapter: string): Promise<void> {
  const probe = new Deno.Command("ffprobe", {
    args: ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type",
           "-of", "default=noprint_wrappers=1", videoPath],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout } = await probe.output();
  const out = new TextDecoder().decode(stdout).trim();
  if (!out.includes("codec_type=video")) {
    await Deno.remove(videoPath).catch(() => {});
    await Deno.remove(audioPath).catch(() => {});
    throw new DownloaderError(
      "download_failed",
      adapter,
      "downloaded file has no video track (audio-only stream — Instagram may have served separate streams that failed to merge)",
    );
  }
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
