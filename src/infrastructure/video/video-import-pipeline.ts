import type { IVideoImportPipeline, ImportResult, ITranscriptionService, IRestaurantDetector } from "../../domain/video/video.pipeline.ts";
import { ALLOWED_TAG_SLUGS } from "../../domain/video/video.pipeline.ts";
import type { IRestaurantRepository } from "../../domain/restaurant/restaurant.repository.ts";
import type { IVideoDedupRepository } from "../../domain/video/video-dedup.repository.ts";
import {
  buildFingerprintCriteria,
  buildHeuristicCriteria,
  computeContentFingerprint,
  isFingerprintReliable,
} from "../../domain/video/cross-platform-dedup.ts";
import { GooglePlacesClient } from "../google-places/google-places.client.ts";
import { SupabaseStorageAdapter } from "../storage/supabase-storage.adapter.ts";
import { supabaseService } from "../../../config.ts";
import type { EnrichRestaurantGoogleDataUsecase } from "../../application/restaurant/enrich-google-data.usecase.ts";
import type { IVideoDownloader } from "../../domain/video/video-downloader.ts";
import { detectPlatform, extractExternalPostId } from "./url-parsing.ts";

export class VideoImportPipeline implements IVideoImportPipeline {
  readonly #storage = new SupabaseStorageAdapter();

  constructor(
    private readonly downloader: IVideoDownloader,
    private readonly transcription: ITranscriptionService,
    private readonly detector: IRestaurantDetector,
    private readonly restaurantRepo: IRestaurantRepository,
    private readonly placesClient: GooglePlacesClient,
    // Préfetch des opening_hours + reviews à la création du resto. Sans ça,
    // les routes app devraient appeler Google en runtime (interdit).
    private readonly enrichGoogle: EnrichRestaurantGoogleDataUsecase,
    // Dédup cross-plateforme (TikTok ↔ Instagram). Optionnel à la
    // construction pour laisser les usages historiques (tests, bulk profile
    // qui dédup déjà par uploader+post_id) fonctionner sans casser.
    private readonly dedupRepo: IVideoDedupRepository | null = null,
  ) {}

  async import(
    url: string,
    description: string,
    uploaderId: string,
    externalPostId?: string | null,
    platform?: "instagram" | "tiktok" | null,
    postedAt?: Date | null,
  ): Promise<ImportResult> {
    // Tente d'extraire (platform, external_post_id) directement depuis l'URL
    // SANS télécharger. Permet d'utiliser ces infos dans l'idempotence step 0
    // ci-dessous quand la route /videos/import n'a pas pu les fournir.
    const effectiveExternalPostId = externalPostId ?? extractExternalPostId(url);
    const effectivePlatform = platform ?? detectPlatform(url);

    const tag = effectiveExternalPostId ?? url.split("/").pop()?.slice(0, 12) ?? "?";

    // 0. Idempotence : on cherche en priorité par (uploader_id, platform, external_post_id)
    //    qui est stable dans le temps. Fallback sur source_url si pas d'ID.
    let existing: Record<string, unknown> | null = null;
    if (effectiveExternalPostId && effectivePlatform) {
      const { data } = await supabaseService
        .from("videos")
        .select("id, source_url, stored_path, stream_url, subtitles_url, transcription, created_at, video_restaurants(restaurant_id, position)")
        .eq("uploader_id", uploaderId)
        .eq("platform", effectivePlatform)
        .eq("external_post_id", effectiveExternalPostId)
        .maybeSingle();
      existing = data;
    }
    if (!existing) {
      const { data } = await supabaseService
        .from("videos")
        .select("id, source_url, stored_path, stream_url, subtitles_url, transcription, created_at, video_restaurants(restaurant_id, position)")
        .eq("uploader_id", uploaderId)
        .eq("source_url", url)
        .maybeSingle();
      existing = data;
    }
    if (existing) {
      console.log(`[Pipeline:${tag}] skip duplicate (already in DB)`);
      // Le "restaurantId" du résultat = resto en position 0 (principal). null
      // si la vidéo n'a aucun resto lié (= cas needs_review).
      const links = (existing.video_restaurants as Array<{ restaurant_id: string; position: number }> | undefined) ?? [];
      const primary = links.find((l) => l.position === 0) ?? links[0];
      return {
        status: "complete",
        skipped: true,
        video: {
          id: existing.id as string,
          restaurantId: primary?.restaurant_id ?? "",
          uploaderId,
          sourceUrl: existing.source_url as string,
          storedPath: existing.stored_path as string,
          streamUrl: existing.stream_url as string,
          subtitlesUrl: existing.subtitles_url as string | null,
          transcription: existing.transcription as string | null,
          duration: null,
          createdAt: existing.created_at as string,
        },
      };
    }

    console.log(`[Pipeline:${tag}] description="${description.slice(0, 200).replace(/\n/g, " ⏎ ")}"`);
    // 1. Télécharger la vidéo via la cascade (yt-dlp → gallery-dl → http
    // fallback). Chaque adapter peut remonter postedAt + externalPostId quand
    // la plateforme les expose.
    const download = await this.downloader.download(url);
    const { videoPath, audioPath, postedAt: scrapedPostedAt } = download;
    // Préserve le postedAt explicitement passé par le caller (bulk profile
    // import qui peut en avoir un plus fiable depuis le scraper de profil),
    // puis fallback sur ce que le downloader a réussi à extraire.
    const effectivePostedAt = postedAt ?? scrapedPostedAt;

    // 2. Transcrire l'audio
    const { text: transcription, vttPath } = await this.transcription.transcribe(audioPath);
    console.log(`[Pipeline:${tag}] transcription="${transcription.slice(0, 150).replace(/\n/g, " ")}"`);

    // 3. Détecter le restaurant via LLM
    const detection = await this.detector.detect({ description, transcription });
    console.log(`[Pipeline:${tag}] gemini=${JSON.stringify(detection).slice(0, 300)}`);

    if (detection.status === "incomplete") {
      // Upload quand même la vidéo sur Storage + INSERT en DB avec needs_review=true
      // pour que l'influenceur puisse l'identifier manuellement plus tard.
      return await this.#saveIncompleteVideo({
        url,
        uploaderId,
        videoPath,
        vttPath,
        transcription,
        externalPostId: effectiveExternalPostId,
        platform: effectivePlatform,
        detectedName: null,
        detectedAddress: null,
        missing: detection.missing,
      });
    }

    // Cuisine obligatoire : si l'IA n'a pas pu déterminer la cuisine, on traite
    // comme incomplete (review manuel) plutôt que de créer des restos sans cuisine.
    // Les autres catégories (dietary/dish/ambiance/formula) restent optionnelles.
    const hasCuisine = (detection.tags ?? []).some(
      (t) => t.category?.trim().toLowerCase() === "cuisine" && t.name?.trim(),
    );
    if (!hasCuisine) {
      console.log(`[Pipeline:${tag}] no cuisine tag → incomplete (needs review)`);
      const first = detection.restaurants[0];
      return await this.#saveIncompleteVideo({
        url,
        uploaderId,
        videoPath,
        vttPath,
        transcription,
        externalPostId: effectiveExternalPostId,
        platform: effectivePlatform,
        detectedName: first?.name ?? null,
        detectedAddress: first?.address ?? null,
        missing: ["cuisine"],
      });
    }

    // 4. Matcher chaque resto détecté via Google Places en parallèle.
    // Les hallucinations IA (nom/adresse bidon) ne résolvent pas → on les vire.
    const placesResults = await Promise.all(
      detection.restaurants.map(async (r) => ({
        detected: r,
        place: await this.placesClient.findPlace(r.name, r.address)
          .catch(() => null),
      })),
    );
    const resolved = placesResults.filter((r) => r.place !== null) as Array<{
      detected: typeof detection.restaurants[number];
      place: NonNullable<typeof placesResults[number]["place"]>;
    }>;

    console.log(
      `[Pipeline:${tag}] detected=${detection.restaurants.length} resolved=${resolved.length}`,
    );

    if (resolved.length === 0) {
      // Aucun resto détecté ne résout sur Google → review manuel sur le premier.
      const first = detection.restaurants[0];
      return await this.#saveIncompleteVideo({
        url,
        uploaderId,
        videoPath,
        vttPath,
        transcription,
        externalPostId: effectiveExternalPostId,
        platform: effectivePlatform,
        detectedName: first?.name ?? null,
        detectedAddress: first?.address ?? null,
        missing: ["place_match"],
      });
    }

    // 5. Upsert chaque resto résolu + enrichissement. On garde l'ordre original
    // de détection comme `position` côté video_restaurants (Sprint A : index 0
    // = principal, affiché par défaut dans feed/grilles).
    const upsertedRestaurants: Array<{ id: string; startSeconds: number | null }> = [];
    for (const r of resolved) {
      const restaurant = await this.restaurantRepo.upsert({
        id: crypto.randomUUID(),
        placeId: r.place.placeId,
        name: r.place.name,
        address: r.place.address,
        city: "Paris",
        location: r.place.location,
        googleRating: r.place.rating ?? null,
        googleRatingsCount: r.place.ratingsCount ?? null,
        openNow: r.place.openNow ?? null,
        openingHours: null,
        websiteUrl: r.place.websiteUrl ?? null,
        phoneNumber: r.place.phoneNumber ?? null,
      });
      await this.enrichGoogle.run(restaurant.id, r.place.placeId);
      if (detection.tags && detection.tags.length > 0) {
        await this.#linkTags(restaurant.id, detection.tags);
      }
      if (r.place.photoReference) {
        await this.#ensureRestaurantPhoto(restaurant.id, r.place.placeId, r.place.photoReference);
      }
      // Tous les restos featured rejoignent le guide par défaut de l'influenceur.
      await this.#addToDefaultGuide(uploaderId, restaurant.id);
      upsertedRestaurants.push({ id: restaurant.id, startSeconds: r.detected.startSeconds ?? null });
    }

    // Le resto "principal" (position 0) pour les champs legacy du retour pipeline.
    const primaryRestaurantId = upsertedRestaurants[0].id;
    const restaurantIds = upsertedRestaurants.map((r) => r.id);

    // 5bis. Dédup cross-plateforme : la même vidéo a peut-être déjà été
    // partagée par quelqu'un d'autre via l'autre plateforme (TikTok ↔ IG).
    // On calcule un fingerprint stable et on cherche un match avant d'uploader
    // pour éviter une dépense inutile (Storage + DB).
    const fingerprint = await computeContentFingerprint({
      transcription,
      restaurantIds,
    });
    const fingerprintReliable = isFingerprintReliable({
      transcription,
      restaurantIds,
    });

    if (this.dedupRepo) {
      // Signal #1 : fingerprint contenu
      let match = null;
      if (fingerprintReliable) {
        const fpCriteria = buildFingerprintCriteria(
          fingerprint,
          restaurantIds,
          new Date(),
        );
        match = await this.dedupRepo.findByFingerprint(fpCriteria);
      }

      // Signal #2 : heuristique (même uploader + même resto + posted_at ±48h).
      // Couvre les vidéos peu/pas parlées dont le fingerprint dégénère.
      if (!match && effectivePostedAt) {
        const heCriteria = buildHeuristicCriteria({
          uploaderId,
          restaurantIds,
          postedAt: effectivePostedAt,
        });
        if (heCriteria) {
          match = await this.dedupRepo.findByHeuristic(heCriteria);
        }
      }

      if (match) {
        console.log(
          `[Pipeline:${tag}] cross-platform dedup hit → video=${match.videoId} (existing uploader=${match.originalUploaderId})`,
        );
        // L'uploader courant devient contributor de la vidéo déjà en DB.
        await this.dedupRepo.addContributor({
          videoId: match.videoId,
          userId: uploaderId,
          sourceUrl: url,
          platform: effectivePlatform,
          externalPostId: effectiveExternalPostId,
        });
        // On nettoie les fichiers temporaires (pas d'upload nécessaire) puis
        // on retourne le résultat existant comme un "skipped".
        await Deno.remove(videoPath).catch(() => {});
        await Deno.remove(vttPath).catch(() => {});
        await Deno.remove(videoPath.replace(".mp4", ".mp3")).catch(() => {});
        // Charge le minimum pour le retour ; les autres champs ne sont pas
        // critiques pour les callers (la notification dispatchera juste un
        // ImportComplete pointant sur match.videoId).
        const { data: existingRow } = await supabaseService
          .from("videos")
          .select("id, source_url, stored_path, stream_url, subtitles_url, transcription, created_at")
          .eq("id", match.videoId)
          .single();
        return {
          status: "complete",
          skipped: true,
          video: {
            id: match.videoId,
            restaurantId: match.restaurantIds[0] ?? primaryRestaurantId,
            uploaderId: match.originalUploaderId,
            sourceUrl: existingRow?.source_url ?? url,
            storedPath: existingRow?.stored_path ?? "",
            streamUrl: existingRow?.stream_url ?? "",
            subtitlesUrl: existingRow?.subtitles_url ?? null,
            transcription: existingRow?.transcription ?? null,
            duration: null,
            createdAt: existingRow?.created_at ?? new Date().toISOString(),
          },
        };
      }
    }

    // 6. Upload sur Supabase Storage
    const filename = videoPath.split("/").pop()!.replace(".mp4", "");
    const videoBytes = await Deno.readFile(videoPath);
    const vttBytes = await Deno.readFile(vttPath);
    const key = `${uploaderId}/${filename}`;

    const streamUrl = await this.#storage.upload(`${key}.mp4`, videoBytes, "video/mp4");
    const subtitlesUrl = await this.#storage.upload(`${key}.vtt`, vttBytes, "text/vtt");

    // Nettoyage des fichiers locaux après upload
    await Deno.remove(videoPath).catch(() => {});
    await Deno.remove(vttPath).catch(() => {});
    const audioCleanup = videoPath.replace(".mp4", ".mp3");
    await Deno.remove(audioCleanup).catch(() => {});

    // upsert (onConflict sur uploader+source_url) : si une race a inséré la
    // même vidéo entre temps, on récupère la ligne existante sans dupliquer.
    // restaurant_id n'existe plus sur videos → on crée le lien dans
    // video_restaurants juste après (multi-resto compatible).
    // content_fingerprint et posted_at sont écrits ici pour que la prochaine
    // tentative cross-plateforme matche ce nouvel enregistrement.
    const { data: videoRow, error } = await supabaseService
      .from("videos")
      .upsert(
        {
          uploader_id: uploaderId,
          source_url: url,
          stored_path: videoPath,
          stream_url: streamUrl,
          subtitles_url: subtitlesUrl,
          transcription,
          external_post_id: effectiveExternalPostId,
          platform: effectivePlatform,
          needs_review: false,
          content_fingerprint: fingerprint,
          posted_at: effectivePostedAt ? effectivePostedAt.toISOString() : null,
        },
        { onConflict: "uploader_id,source_url" },
      )
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    // Lien vidéo ↔ N restos. L'ordre suit la détection IA (= ordre de mention
    // dans la vidéo). startSeconds est passé quand l'IA l'a fourni.
    await this.#linkRestaurants(
      videoRow.id,
      upsertedRestaurants.map((r) => r.id),
      upsertedRestaurants.map((r) => r.startSeconds),
    );

    // L'uploader d'origine est aussi contributor (pour timeline "mes imports"
    // unifiée + permet à un autre user de cross-poster sans casser le compteur).
    if (this.dedupRepo) {
      await this.dedupRepo.addContributor({
        videoId: videoRow.id,
        userId: uploaderId,
        sourceUrl: url,
        platform: effectivePlatform,
        externalPostId: effectiveExternalPostId,
      });
    }

    return {
      status: "complete",
      video: {
        id: videoRow.id,
        restaurantId: primaryRestaurantId,
        uploaderId,
        sourceUrl: url,
        storedPath: videoPath,
        streamUrl,
        subtitlesUrl,
        transcription,
        duration: null,
        createdAt: videoRow.created_at,
      },
    };
  }

  // Upload la vidéo sur Storage + INSERT en DB avec needs_review=true.
  // Utilisé quand Gemini OU Places n'ont pas trouvé un resto exploitable :
  // l'influenceur peut corriger manuellement plus tard.
  async #saveIncompleteVideo(args: {
    url: string;
    uploaderId: string;
    videoPath: string;
    vttPath: string;
    transcription: string;
    externalPostId?: string | null;
    platform?: "instagram" | "tiktok" | null;
    detectedName: string | null;
    detectedAddress: string | null;
    missing: string[];
  }): Promise<ImportResult> {
    const filename = args.videoPath.split("/").pop()!.replace(".mp4", "");
    const videoBytes = await Deno.readFile(args.videoPath);
    const vttBytes = await Deno.readFile(args.vttPath);
    const key = `${args.uploaderId}/${filename}`;
    const streamUrl = await this.#storage.upload(`${key}.mp4`, videoBytes, "video/mp4");
    const subtitlesUrl = await this.#storage.upload(`${key}.vtt`, vttBytes, "text/vtt");
    await Deno.remove(args.videoPath).catch(() => {});
    await Deno.remove(args.vttPath).catch(() => {});
    await Deno.remove(args.videoPath.replace(".mp4", ".mp3")).catch(() => {});

    // needs_review = true + AUCUN lien dans video_restaurants. Le créateur
    // assignera un (ou plusieurs) resto via /creator/videos/:id/assign-restaurants.
    const { data: videoRow, error } = await supabaseService
      .from("videos")
      .upsert(
        {
          uploader_id: args.uploaderId,
          source_url: args.url,
          stored_path: args.videoPath,
          stream_url: streamUrl,
          subtitles_url: subtitlesUrl,
          transcription: args.transcription,
          external_post_id: args.externalPostId ?? null,
          platform: args.platform ?? null,
          needs_review: true,
          detected_name: args.detectedName,
          detected_address: args.detectedAddress,
        },
        { onConflict: "uploader_id,source_url" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    return {
      status: "incomplete",
      partial: {
        sourceUrl: args.url,
        uploaderId: args.uploaderId,
        transcription: args.transcription,
        detectedName: args.detectedName,
        detectedAddress: args.detectedAddress,
      },
      missing: args.missing,
    };
  }

  // Ajoute le resto au guide par défaut de l'influenceur (s'il existe).
  // Si l'influenceur n'a pas de guide default, on n'en crée pas ici (responsabilité
  // de BulkProfileImportUsecase qui le fait à la création de l'influenceur).
  // Lie une vidéo à N restos (ordre = position dans la vidéo, premier = 0).
  // Utilisé par la pipeline d'import et /creator/videos/:id/assign-restaurants.
  // Upsert pour rester idempotent (re-run pipeline sur la même vidéo OK).
  async #linkRestaurants(
    videoId: string,
    restaurantIds: string[],
    startsSeconds?: Array<number | null>,
  ): Promise<void> {
    if (restaurantIds.length === 0) return;
    const rows = restaurantIds.map((rid, i) => ({
      video_id: videoId,
      restaurant_id: rid,
      position: i,
      start_seconds: startsSeconds?.[i] ?? null,
    }));
    const { error } = await supabaseService
      .from("video_restaurants")
      .upsert(rows, { onConflict: "video_id,restaurant_id" });
    if (error) {
      console.warn(`[Pipeline] linkRestaurants(${videoId}) failed: ${error.message}`);
    }
  }

  async #addToDefaultGuide(uploaderId: string, restaurantId: string): Promise<void> {
    const { data: guide } = await supabaseService
      .from("guides")
      .select("id")
      .eq("influencer_id", uploaderId)
      .eq("is_default", true)
      .maybeSingle();
    if (!guide) return;
    const { error } = await supabaseService
      .from("guide_restaurants")
      .upsert(
        { guide_id: guide.id, restaurant_id: restaurantId },
        { onConflict: "guide_id,restaurant_id" },
      );
    if (error) console.warn(`[Pipeline] addToDefaultGuide failed: ${error.message}`);
  }

  async #ensureRestaurantPhoto(
    restaurantId: string,
    placeId: string,
    photoReference: string,
  ): Promise<void> {
    // Skip si le restaurant a déjà une photo (évite re-upload à chaque import)
    const { data: existing } = await supabaseService
      .from("restaurants")
      .select("cover_image_url")
      .eq("id", restaurantId)
      .single();
    if (existing?.cover_image_url) return;

    const bytes = await this.placesClient.fetchPhotoBytes(photoReference);
    if (!bytes) return;

    const key = `${placeId}.jpg`;
    const url = await this.#storage.upload(key, bytes, "image/jpeg", "restaurant-photos");

    const { error } = await supabaseService
      .from("restaurants")
      .update({ cover_image_url: url })
      .eq("id", restaurantId);
    if (error) {
      console.warn(`[Pipeline] failed to set cover_image_url: ${error.message}`);
    }
  }

  async #linkTags(
    restaurantId: string,
    tags: Array<{ category: string; name: string }>,
  ): Promise<void> {
    // Normalise (lowercase, trim), filtre les catégories hors taxonomie (Gemini
    // hallucine parfois "type", "moment", "prix"…), dédoublonne par (category, name).
    const seen = new Set<string>();
    const normalized = tags
      .map((t) => ({
        category: t.category?.trim().toLowerCase() ?? "",
        name: t.name?.trim().toLowerCase() ?? "",
      }))
      .filter((t) => t.category && t.name)
      .filter((t) => {
        if (!ALLOWED_TAG_SLUGS.has(t.category as never)) {
          console.warn(`[Pipeline] skip tag: unknown category "${t.category}" (allowed: cuisine|dietary|dish|ambiance|formula)`);
          return false;
        }
        return true;
      })
      .filter((t) => {
        const key = `${t.category}::${t.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (normalized.length === 0) return;

    // Charge en 1 query toutes les catégories autorisées (slug → id).
    // Les catégories sont fixées par la migration 0006, on ne les crée jamais à la volée.
    const { data: cats, error: catsErr } = await supabaseService
      .from("tag_categories")
      .select("id, slug");
    if (catsErr) {
      console.warn(`[Pipeline] tag_categories load failed: ${catsErr.message}`);
      return;
    }
    const catBySlug = new Map(
      ((cats ?? []) as Array<{ id: string; slug: string }>).map((c) => [c.slug, c.id]),
    );

    for (const tag of normalized) {
      const categoryId = catBySlug.get(tag.category);
      if (!categoryId) {
        // Catégorie déclarée mais absente en base : la migration n'a pas tourné ?
        console.warn(`[Pipeline] tag category not in DB: ${tag.category}`);
        continue;
      }

      // Le tag lui-même peut être nouveau (Gemini propose un type de cuisine
      // qu'on n'avait pas seedé) → on l'upsert. La catégorie est figée, pas le tag.
      const { data: t, error: tErr } = await supabaseService
        .from("tags")
        .upsert(
          { category_id: categoryId, name: tag.name },
          { onConflict: "category_id,name" },
        )
        .select("id")
        .single();
      if (tErr) {
        console.warn(`[Pipeline] tags upsert failed (${tag.category}/${tag.name}): ${tErr.message}`);
        continue;
      }

      const { error: linkErr } = await supabaseService
        .from("restaurant_tags")
        .upsert(
          { restaurant_id: restaurantId, tag_id: t.id },
          { onConflict: "restaurant_id,tag_id" },
        );
      if (linkErr) {
        console.warn(`[Pipeline] restaurant_tags upsert failed: ${linkErr.message}`);
      }
    }
  }

}
