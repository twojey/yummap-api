import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError } from "../shared/errors.ts";
import { analyticsService } from "../infrastructure/analytics/analytics.service.ts";
import type { AppContainer } from "../boot/container.ts";

const ImportSchema = z.object({
  url: z.string().url(),
  description: z.string().max(5000).default(""),
});

const CompleteSchema = z.object({
  restaurantPlaceId: z.string().min(1),
  restaurantName: z.string().min(1),
});

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
  router.patch("/videos/import/:jobId/complete", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = CompleteSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid completion data", parsed.error.issues);

    await container.videoImportRequestRepo.updateStatus(ctx.params.jobId, "complete", {
      restaurantPlaceId: parsed.data.restaurantPlaceId,
      restaurantName: parsed.data.restaurantName,
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
