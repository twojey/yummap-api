import type { IImportJobRepository } from "../../domain/import-job/import-job.repository.ts";
import type { ImportJobVideoItem } from "../../domain/import-job/import-job.types.ts";
import type { IVideoImportPipeline } from "../../domain/video/video.pipeline.ts";
import type { INotificationDispatcher } from "../../domain/notification/notification.dispatcher.ts";
import { supabaseService } from "../../../config.ts";
import { DailyQuotaExceededError } from "../../shared/errors.ts";

export interface BulkProfileImportInput {
  profileUrl: string;
  influencerId: string | null;
  createdBy: string;
  videoLimit?: number;  // Max vidéos à scraper (default 200)
}

export class BulkProfileImportUsecase {
  constructor(
    private readonly jobs: IImportJobRepository,
    private readonly pipeline: IVideoImportPipeline,
    private readonly notifications: INotificationDispatcher,
  ) {}

  // Extrait le username depuis une URL Instagram/TikTok
  // Ex: https://www.instagram.com/gastro_no_meat/ -> gastro_no_meat
  //     https://www.tiktok.com/@oh_my_food_paris -> oh_my_food_paris
  static extractUsername(profileUrl: string): string | null {
    try {
      const u = new URL(profileUrl);
      if (u.hostname.includes("instagram.com")) {
        const seg = u.pathname.split("/").filter(Boolean)[0];
        return seg ?? null;
      }
      if (u.hostname.includes("tiktok.com")) {
        const seg = u.pathname.split("/").filter(Boolean)[0];
        return seg?.replace(/^@/, "") ?? null;
      }
    } catch { /* fall through */ }
    return null;
  }

  // Lookup-or-create d'un user influencer à partir du profileUrl.
  // Réutilise l'existant si display_name déjà présent avec role='influencer'.
  // Public pour pouvoir être appelé depuis CreateAdminInvitationUsecase
  // afin de lier l'invitation et le job au même user.
  async findOrCreateInfluencer(profileUrl: string): Promise<string | null> {
    return this.#findOrCreateInfluencer(profileUrl);
  }

  async #findOrCreateInfluencer(profileUrl: string): Promise<string | null> {
    const username = BulkProfileImportUsecase.extractUsername(profileUrl);
    if (!username) return null;

    const { data: existing } = await supabaseService
      .from("users")
      .select("id, avatar_url")
      .eq("role", "influencer")
      .eq("display_name", username)
      .maybeSingle();
    if (existing?.id) {
      // Backfill avatar si manquant sur un user déjà créé sans avatar
      if (!existing.avatar_url) {
        const avatarUrl = await this.#resolveAvatarUrl(profileUrl, username);
        if (avatarUrl) {
          await supabaseService.from("users").update({ avatar_url: avatarUrl }).eq("id", existing.id);
        }
      }
      // Safety net : crée le guide default si manquant sur un user pré-existant
      await this.#ensureDefaultGuide(existing.id, username);
      return existing.id;
    }

    const avatarUrl = await this.#resolveAvatarUrl(profileUrl, username);
    const { data: created, error } = await supabaseService
      .from("users")
      .insert({ role: "influencer", display_name: username, avatar_url: avatarUrl })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to create influencer: ${error.message}`);

    // Crée un guide par défaut pour ce nouvel influenceur (les vidéos importées
    // y seront automatiquement ajoutées par le pipeline).
    await this.#ensureDefaultGuide(created.id, username);
    return created.id;
  }

  // Idempotent : crée 1 guide par défaut par influencer (UNIQUE partial index).
  async #ensureDefaultGuide(influencerId: string, username: string): Promise<void> {
    const { error } = await supabaseService.from("guides").insert({
      influencer_id: influencerId,
      title: `Guide de @${username}`,
      description: `Les restos partagés par @${username}`,
      is_default: true,
    });
    if (error && !error.message.includes("duplicate")) {
      console.warn(`[BulkImport] ensureDefaultGuide failed: ${error.message}`);
    }
  }

  // Stratégie d'avatar:
  //  1. Tentative de récupération du VRAI avatar Instagram via l'API web_profile_info
  //     (utilise nos cookies sessionid). Upload sur Supabase Storage si succès.
  //  2. Fallback: avatar généré DiceBear stable.
  // Pour TikTok, on n'a pas d'API simple → DiceBear direct.
  async #resolveAvatarUrl(profileUrl: string, username: string): Promise<string | null> {
    if (!username) return null;
    try {
      const host = new URL(profileUrl).hostname;
      if (host.includes("instagram.com")) {
        const url = await this.#fetchInstagramAvatar(username);
        if (url) return url;
      }
      // tiktok.com et fallback → DiceBear
    } catch { /* noop */ }
    return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(username)}`;
  }

  async #fetchInstagramAvatar(username: string): Promise<string | null> {
    // Récupère TOUS les cookies (sessionid seul ne suffit pas, Instagram fait
    // une boucle de redirects sinon)
    const cookiesPath = `${Deno.env.get("PWD") ?? "."}/.instagram-cookies.txt`;
    let cookieHeader = "";
    try {
      const raw = await Deno.readTextFile(cookiesPath);
      cookieHeader = raw.split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split("\t"))
        .filter((p) => p.length >= 7)
        .map((p) => `${p[5]}=${p[6]}`)
        .join("; ");
    } catch { /* pas de fichier cookies → on skip */ }
    if (!cookieHeader) return null;

    const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const res = await fetch(apiUrl, {
      headers: {
        "cookie": cookieHeader,
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "x-ig-app-id": "936619743392459",
        "accept": "*/*",
        "x-asbd-id": "129477",
        "referer": `https://www.instagram.com/${username}/`,
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { user?: { profile_pic_url_hd?: string; profile_pic_url?: string } } };
    const picUrl = data.data?.user?.profile_pic_url_hd ?? data.data?.user?.profile_pic_url;
    if (!picUrl) return null;

    // Download et upload sur Supabase Storage pour avoir une URL stable
    const imgRes = await fetch(picUrl);
    if (!imgRes.ok) return null;
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    const key = `${username}.jpg`;
    const { error } = await supabaseService.storage
      .from("user-avatars")
      .upload(key, bytes, { contentType: "image/jpeg", upsert: true });
    if (error) {
      console.warn(`[Avatar] upload failed: ${error.message}`);
      return null;
    }
    const { data: publicData } = supabaseService.storage.from("user-avatars").getPublicUrl(key);
    return publicData.publicUrl;
  }

  async start(input: BulkProfileImportInput): Promise<string> {
    // Auto-création d'un compte influenceur si pas fourni explicitement
    const influencerId = input.influencerId
      ?? await this.#findOrCreateInfluencer(input.profileUrl);

    const job = await this.jobs.create({
      profileUrl: input.profileUrl,
      influencerId,
      createdBy: input.createdBy,
      status: "pending",
      totalVideos: null,
    });

    // Lancer le job en arrière-plan — ne pas await
    // videoLimit undefined = pas de limite (tous les posts du profil)
    this.#run(job.id, input.profileUrl, influencerId, input.createdBy, input.videoLimit).catch((err) => {
      console.error(`[BulkImport] Job ${job.id} crashed:`, err);
      this.jobs.updateStatus(job.id, "failed", { completedAt: new Date().toISOString() });
    });

    return job.id;
  }

  // Réveille un job paused (ou running zombie) et continue depuis last_processed_index.
  // Idempotent : si tout est déjà traité, marque completed et sort.
  async resume(jobId: string): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      console.warn(`[BulkImport] resume: job ${jobId} not found`);
      return;
    }
    if (job.status === "completed" || job.status === "failed") return;

    console.log(`[BulkImport] resuming job ${jobId} (status=${job.status})`);
    // À la reprise, la queue est déjà persistée donc videoLimit ne sert pas
    // (undefined = "tous" si jamais on doit re-scraper)
    this.#run(job.id, job.profileUrl, job.influencerId, job.createdBy, undefined).catch((err) => {
      console.error(`[BulkImport] Job ${job.id} resume crashed:`, err);
      this.jobs.updateStatus(job.id, "failed", { completedAt: new Date().toISOString() });
    });
  }

  async #run(
    jobId: string,
    profileUrl: string,
    influencerId: string | null,
    createdBy: string,
    videoLimit: number | undefined,
  ): Promise<void> {
    await this.jobs.updateStatus(jobId, "running", {
      startedAt: new Date().toISOString(),
    });

    // 1. Charge la queue persistée si elle existe, sinon scrape et persiste.
    //    Permet d'éviter de re-fetcher gallery-dl à chaque resume.
    let state = await this.jobs.loadQueue(jobId);
    if (!state || state.videoQueue.length === 0) {
      const videos = await this.#fetchProfileVideos(profileUrl, videoLimit);
      await this.jobs.saveQueue(jobId, videos);
      state = { videoQueue: videos, lastProcessedIndex: 0, pausedUntil: null };
    }

    const uploaderId = influencerId ?? createdBy;
    const queue = state.videoQueue;
    let i = state.lastProcessedIndex;

    // 2. Boucle reprise au checkpoint. Sur DailyQuotaExceededError → pause.
    for (; i < queue.length; i++) {
      // Si le job a été supprimé via l'admin, on arrête proprement la boucle
      // au lieu de continuer à tourner en zombie.
      const stillExists = await this.jobs.findById(jobId);
      if (!stillExists) {
        console.log(`[BulkImport] Job ${jobId} no longer exists (deleted) → stop`);
        return;
      }
      const { url, description, platform, externalPostId } = queue[i];

      // Idempotence stricte : si on a déjà tenté ce post (success/failure/incomplete),
      // on skip pour ne pas regaspiller Whisper + Gemini + Places.
      // Pour forcer un re-essai : DELETE FROM video_import_attempts WHERE ...
      if (externalPostId && platform) {
        const { data: attempt } = await supabaseService
          .from("video_import_attempts")
          .select("status")
          .eq("uploader_id", uploaderId)
          .eq("platform", platform)
          .eq("external_post_id", externalPostId)
          .maybeSingle();
        if (attempt) {
          console.log(`[BulkImport] skip ${externalPostId} (déjà tenté: ${attempt.status})`);
          await this.jobs.setLastProcessedIndex(jobId, i + 1);
          continue;
        }
      }

      try {
        const result = await this.pipeline.import(url, description, uploaderId, externalPostId, platform);

        if (result.status === "complete") {
          // Si la vidéo a été skipée (déjà en DB), on n'incrémente PAS les
          // compteurs ni la notif : elle a déjà été comptée au premier passage.
          if (!result.skipped) {
            await this.jobs.incrementProgress(jobId, "success");
            await this.#recordAttempt(uploaderId, platform, externalPostId, "success");
            if (influencerId) {
              await this.notifications.dispatch({
                type: "NewVideo",
                influencerId,
                videoId: result.video.id,
                restaurantId: result.video.restaurantId,
              });
            }
          }
        } else {
          await this.jobs.incrementProgress(jobId, "incomplete", {
            videoUrl: url,
            reason: "Restaurant non détecté automatiquement",
            missing: result.missing,
          });
          await this.#recordAttempt(uploaderId, platform, externalPostId, "incomplete", `missing: ${result.missing.join(",")}`);
        }
      } catch (err) {
        if (err instanceof DailyQuotaExceededError) {
          // On n'incrémente PAS le compteur : on retentera la même vidéo après reprise.
          await this.jobs.setLastProcessedIndex(jobId, i);
          await this.jobs.pause(jobId, err.resumeAfter, `${err.provider} daily quota exceeded`);
          console.log(`[BulkImport] Job ${jobId} paused at index ${i}/${queue.length} until ${err.resumeAfter.toISOString()}`);
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        await this.jobs.incrementProgress(jobId, "failure", { videoUrl: url, reason });
        await this.#recordAttempt(uploaderId, platform, externalPostId, "failure", reason);
      }

      // Checkpoint après chaque vidéo traitée (success/incomplete/failure)
      await this.jobs.setLastProcessedIndex(jobId, i + 1);

      // Pause entre vidéos. flash-lite free tier ~ 30 RPM → 2s = safety.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Réconcilie les compteurs depuis la réalité (video_import_attempts).
    // Les reprises multiples peuvent faire diverger processed_videos / success_count
    // de la vérité — on remet d'aplomb avant de marquer completed.
    await this.#reconcileCounters(jobId, uploaderId, queue);
    await this.jobs.updateStatus(jobId, "completed", {
      completedAt: new Date().toISOString(),
    });
  }

  async #reconcileCounters(
    jobId: string,
    uploaderId: string,
    queue: ImportJobVideoItem[],
  ): Promise<void> {
    const postIds = queue.map((v) => v.externalPostId).filter((id): id is string => !!id);
    if (postIds.length === 0) return;
    const { data: attempts } = await supabaseService
      .from("video_import_attempts")
      .select("status, external_post_id")
      .eq("uploader_id", uploaderId)
      .in("external_post_id", postIds);
    let s = 0, f = 0, i = 0;
    for (const a of (attempts ?? []) as Array<{ status: string }>) {
      if (a.status === "success") s++;
      else if (a.status === "failure") f++;
      else if (a.status === "incomplete") i++;
    }
    await supabaseService.from("import_jobs").update({
      processed_videos: s + f + i,
      success_count: s,
      failure_count: f,
      incomplete_count: i,
    }).eq("id", jobId);
  }

  // Enregistre une tentative d'import dans video_import_attempts.
  // Permet aux re-runs de skip les posts déjà tentés (success/failure/incomplete).
  async #recordAttempt(
    uploaderId: string,
    platform: "instagram" | "tiktok" | null,
    externalPostId: string | null,
    status: "success" | "failure" | "incomplete",
    reason?: string,
  ): Promise<void> {
    if (!externalPostId || !platform) return; // pas trackable sans ID stable
    const { error } = await supabaseService
      .from("video_import_attempts")
      .upsert(
        {
          uploader_id: uploaderId,
          platform,
          external_post_id: externalPostId,
          status,
          reason: reason?.slice(0, 500),
          attempted_at: new Date().toISOString(),
        },
        { onConflict: "uploader_id,platform,external_post_id" },
      );
    if (error) console.warn(`[BulkImport] recordAttempt failed: ${error.message}`);
  }

  async #fetchProfileVideos(profileUrl: string, videoLimit: number | undefined): Promise<ImportJobVideoItem[]> {
    if (profileUrl.includes("instagram.com")) {
      return await this.#fetchInstagramVideos(profileUrl, videoLimit);
    }
    // yt-dlp pour TikTok et autres : URL + description + ID stable
    const limitArgs = videoLimit ? ["--playlist-end", String(videoLimit)] : [];
    const proc = new Deno.Command("yt-dlp", {
      args: [
        "--flat-playlist",
        ...limitArgs,
        "--print", "###%(url)s",
        "--print", "@@@%(description)j",
        "--print", "%%%(id)s",
        "--no-warnings",
        "--quiet",
        profileUrl,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await proc.output();
    if (code !== 0) {
      throw new Error(`yt-dlp failed to fetch profile: ${new TextDecoder().decode(stderr)}`);
    }

    const platform = profileUrl.includes("tiktok.com") ? "tiktok" : null;
    return BulkProfileImportUsecase.#parseVideoLines(new TextDecoder().decode(stdout), platform);
  }

  // Instagram bloque yt-dlp depuis 2025 → gallery-dl extrait URL CDN + description + shortcode
  async #fetchInstagramVideos(profileUrl: string, videoLimit: number | undefined): Promise<ImportJobVideoItem[]> {
    const cookiesPath = `${Deno.env.get("PWD") ?? "."}/.instagram-cookies.txt`;
    const galleryDl = Deno.env.get("GALLERY_DL_BIN")
      ?? `${Deno.env.get("HOME")}/Library/Python/3.14/bin/gallery-dl`;
    const rangeArgs = videoLimit ? ["--range", `1-${videoLimit}`] : [];
    const proc = new Deno.Command(galleryDl, {
      args: [
        "--cookies", cookiesPath,
        "--no-download",
        ...rangeArgs,
        "--print", "###{video_url}",
        "--print", "@@@{description!j}",
        "--print", "%%%{shortcode}",
        profileUrl,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await proc.output();
    if (code !== 0) {
      throw new Error(`gallery-dl failed: ${new TextDecoder().decode(stderr)}`);
    }
    return BulkProfileImportUsecase.#parseVideoLines(new TextDecoder().decode(stdout), "instagram");
  }

  // Parse une sortie de la forme:
  //   ###<url-vidéo>
  //   @@@"<description-json-encoded>"
  //   %%%<external_post_id>     ← shortcode Instagram ou id TikTok
  // (1 triplet par vidéo). Tolère l'absence du %%% (ancienne version d'outil).
  static #parseVideoLines(
    raw: string,
    platform: "instagram" | "tiktok" | null,
  ): ImportJobVideoItem[] {
    const lines = raw.split("\n");
    const out: ImportJobVideoItem[] = [];
    let pendingUrl: string | null = null;
    let pendingDesc: string | null = null;
    const flush = (externalPostId: string | null) => {
      if (pendingUrl) {
        out.push({
          url: pendingUrl,
          description: pendingDesc ?? "",
          platform,
          externalPostId,
        });
      }
      pendingUrl = null;
      pendingDesc = null;
    };
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.startsWith("###")) {
        // Nouveau triplet : on émet l'éventuel précédent sans post_id
        if (pendingUrl) flush(null);
        pendingUrl = line.slice(3).trim();
      } else if (line.startsWith("@@@") && pendingUrl) {
        const jsonPart = line.slice(3);
        try { pendingDesc = JSON.parse(jsonPart); }
        catch { pendingDesc = jsonPart; }
      } else if (line.startsWith("%%%") && pendingUrl) {
        flush(line.slice(3).trim() || null);
      }
    }
    if (pendingUrl) flush(null);
    return out.filter((v) => v.url.startsWith("http"));
  }
}
