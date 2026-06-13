import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError, NotFoundError } from "../shared/errors.ts";
import { supabaseService } from "../../config.ts";
import { analyticsService } from "../infrastructure/analytics/analytics.service.ts";
import { detectPlatform } from "../infrastructure/video/url-parsing.ts";
import type { AppContainer } from "../boot/container.ts";

const ImportSchema = z.object({
  url: z.string().url(),
  description: z.string().max(5000).default(""),
});

// Correction manuelle = saisie LIBRE du nom (+ adresse optionnelle). On ne
// demande PAS de placeId au client : c'est le backend qui résout sur Google
// Places, comme le pipeline auto. L'adresse aide à désambiguïser les enseignes
// multi-succursales mais n'est pas obligatoire (Places matche souvent "nom + Paris").
const CompleteSchema = z.object({
  restaurantName: z.string().min(1),
  restaurantAddress: z.string().optional().default(""),
});

// Assigne un resto unique à une vidéo en position 0 (réécrit les liens pour
// garantir un état propre). Même logique que /creator/videos/:id/assign-restaurant.
async function linkVideoToRestaurant(videoId: string, restaurantId: string) {
  await supabaseService.from("video_restaurants").delete().eq("video_id", videoId);
  const { error } = await supabaseService.from("video_restaurants").insert({
    video_id: videoId, restaurant_id: restaurantId, position: 0,
  });
  if (error) throw new Error(error.message);
}

const BulkImportSchema = z.object({
  profileUrl: z.string().url(),
  influencerId: z.string().uuid(),
});

export function registerVideoRoutes(router: Router, container: AppContainer) {

  // ── Import vidéo unique (async via job) ────────────────────────────────────
  // Le pipeline (yt-dlp + ffmpeg + Whisper + LLM) ne tourne PAS dans le mode
  // "api" (Deno Deploy ne supporte pas Deno.Command/FS écriture). Il tourne
  // dans le mode "worker" (VM). En mode "all" (dev local) on lance les deux
  // dans le même process pour ne pas avoir à gérer 2 services localement.
  router.post("/videos/import", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = ImportSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid import params", parsed.error.issues);

    // Fail-fast : rejette les URLs hors IG/TT sans toucher au pipeline.
    // Le client filtre déjà avant submit, mais on garde ce safeguard serveur
    // pour les anciens clients ou les appels directs à l'API.
    if (!detectPlatform(parsed.data.url)) {
      throw new ValidationError(
        "unsupported_platform: only Instagram and TikTok are supported",
        [{ path: ["url"], message: "unsupported_platform", code: "custom" }],
      );
    }

    // Créer le job en base (retour immédiat). Source unique de vérité pour la
    // queue : le worker poll cette table.
    const job = await container.videoImportRequestRepo.create(
      parsed.data.url,
      ctx.state.userId,
    );

    if (container.deployMode !== "api") {
      // Mode "worker" ou "all" : on traite en arrière-plan dans ce process.
      // En mode "api" pur (Deno Deploy), le job reste en "pending" jusqu'à
      // ce que le worker dédié (Fly.io) le picke.
      container.importVideo.executeWithJob(
        { url: parsed.data.url, description: parsed.data.description, uploaderId: ctx.state.userId },
        job.id,
        container.videoImportRequestRepo,
      ).catch((err) => {
        console.error(`[VideoImport] Job ${job.id} crashed:`, err);
        container.videoImportRequestRepo.updateStatus(job.id, "failed", {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
    }

    analyticsService.track({ eventType: "video_import", userId: ctx.state.userId });
    ctx.response.status = 202;
    ctx.response.body = job;
  });

  // ── Statut d'un import vidéo ───────────────────────────────────────────────
  router.get("/videos/import/:jobId", guestOrAuth, async (ctx) => {
    const job = await container.videoImportRequestRepo.findById(ctx.params.jobId);
    if (!job) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Import job not found" };
      return;
    }
    ctx.response.body = job;
  });

  // ── Correction manuelle (restaurant non détecté automatiquement) ───────────
  // Saisie libre nom (+ adresse) → résolution Google Places → création/maj du
  // resto + liaison de la vidéo déjà stockée (needs_review levé). Si Places ne
  // trouve aucun lieu "food", on NE complète pas : l'import reste en review et
  // on renvoie 422 `place_not_found` pour que l'app guide l'utilisateur.
  router.patch("/videos/import/:jobId/complete", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = CompleteSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid completion data", parsed.error.issues);

    const request = await container.videoImportRequestRepo.findById(ctx.params.jobId);
    if (!request) throw new NotFoundError("Import job", ctx.params.jobId);

    const place = await container.placesClient.findPlace(
      parsed.data.restaurantName,
      parsed.data.restaurantAddress,
    );
    if (!place) {
      // Pas de match : on garde l'import corrigeable (review) au lieu de le
      // figer en complete sans resto. missing=place_match reflète la cause réelle.
      await container.videoImportRequestRepo.updateStatus(ctx.params.jobId, "incomplete", {
        missingFields: ["place_match"],
      });
      ctx.response.status = 422;
      ctx.response.body = {
        error: "place_not_found",
        message: "No food place matched the provided name/address",
      };
      return;
    }

    // Crée/maj le resto + pré-fetch horaires/reviews (identique à assign-restaurant).
    const restaurant = await container.restaurantRepo.upsert({
      id: crypto.randomUUID(),
      placeId: place.placeId,
      name: place.name,
      address: place.address,
      city: "Paris",
      location: place.location,
      googleRating: place.rating ?? null,
      googleRatingsCount: place.ratingsCount ?? null,
      openNow: place.openNow ?? null,
      openingHours: null,
      websiteUrl: place.websiteUrl ?? null,
      phoneNumber: place.phoneNumber ?? null,
    });
    await container.enrichRestaurantGoogleData.run(restaurant.id, place.placeId);

    // Lie la vidéo déjà uploadée par le pipeline (clé uploader_id + source_url)
    // et lève needs_review. Défensif : si aucune vidéo (cas improbable), on
    // complète quand même la requête pour ne pas bloquer l'utilisateur.
    const { data: video } = await supabaseService
      .from("videos")
      .select("id")
      .eq("uploader_id", request.uploaderId)
      .eq("source_url", request.url)
      .maybeSingle();
    if (video) {
      await linkVideoToRestaurant(video.id, restaurant.id);
      await supabaseService.from("videos").update({ needs_review: false }).eq("id", video.id);
    }

    await container.videoImportRequestRepo.updateStatus(ctx.params.jobId, "complete", {
      restaurantPlaceId: place.placeId,
      restaurantName: place.name,
    });

    ctx.response.status = 200;
    ctx.response.body = await container.videoImportRequestRepo.findById(ctx.params.jobId);
  });

  // ── Import de profil en masse ──────────────────────────────────────────────
  router.post("/import/profiles", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = BulkImportSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid bulk import params", parsed.error.issues);

    const jobId = await container.bulkProfileImport.start({
      profileUrl: parsed.data.profileUrl,
      influencerId: parsed.data.influencerId,
      createdBy: ctx.state.userId,
    });

    analyticsService.track({ eventType: "video_import", userId: ctx.state.userId });
    ctx.response.status = 202;
    ctx.response.body = { jobId };
  });

  // ── Statut d'un job bulk ───────────────────────────────────────────────────
  router.get("/import/jobs/:jobId", guestOrAuth, async (ctx) => {
    const job = await container.importJobRepo.findById(ctx.params.jobId);
    if (!job) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Job not found" };
      return;
    }
    ctx.response.body = job;
  });
}
