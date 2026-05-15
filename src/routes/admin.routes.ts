import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { requireAuth, requireRole } from "../middleware/auth.middleware.ts";
import { ValidationError, NotFoundError } from "../shared/errors.ts";
import { supabaseService } from "../../config.ts";
import type { AppContainer } from "../boot/container.ts";

// Préprocesse: une chaîne vide ou whitespace devient `undefined`
// pour permettre au panel admin d'envoyer des champs vides sans validation error.
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const ImportProfileSchema = z.object({
  profileUrl:    z.string().url(),
  influencerId:  z.preprocess(emptyToUndef, z.string().uuid().optional()),
  targetEmail:   z.preprocess(emptyToUndef, z.string().email().optional()),
  targetPhone:   z.preprocess(emptyToUndef, z.string().min(8).optional()),
  videoLimit:    z.preprocess(
    (v) => v === undefined || v === null || v === "" ? undefined : Number(v),
    z.number().int().min(1).max(500).optional(),
  ),
});

const ApproveSchema = z.object({
  primaryProfileUrl: z.string().url(),
});

export function registerAdminRoutes(router: Router, container: AppContainer) {

  // ── Import profil + création invitation admin ──────────────────────────────
  // POST /admin/import-profile
  // Remplace l'ancien endpoint qui nécessitait un influencerId existant
  router.post(
    "/admin/import-profile",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const body = await ctx.request.body({ type: "json" }).value;
      const parsed = ImportProfileSchema.safeParse(body);
      if (!parsed.success) throw new ValidationError("Invalid import params", parsed.error.issues);

      const result = await container.createAdminInvitation.execute({
        adminId: ctx.state.userId,
        profileUrl: parsed.data.profileUrl,
        influencerId: parsed.data.influencerId,
        targetEmail: parsed.data.targetEmail,
        targetPhone: parsed.data.targetPhone,
        videoLimit: parsed.data.videoLimit,
      });

      ctx.response.status = 202;
      ctx.response.body = result;
    },
  );

  // ── Liste des jobs d'import ────────────────────────────────────────────────
  router.get(
    "/admin/import-jobs",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const jobs = await container.importJobRepo.findAll();
      ctx.response.body = { jobs };
    },
  );

  router.get(
    "/admin/import-jobs/:jobId",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const job = await container.importJobRepo.findById(ctx.params.jobId);
      if (!job) throw new NotFoundError("ImportJob", ctx.params.jobId);
      ctx.response.body = job;
    },
  );

  // ── Liste des invitations admin ────────────────────────────────────────────
  router.get(
    "/admin/invitations",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const invitations = await container.invitationRepo.findByCreator(ctx.state.userId);
      ctx.response.body = invitations;
    },
  );

  // ── Influenceurs en attente de validation ──────────────────────────────────
  router.get(
    "/admin/influencers/pending",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const pending = await container.invitationRepo.findPendingProfiles();
      ctx.response.body = pending;
    },
  );

  // POST /admin/influencers/:userId/approve
  router.post(
    "/admin/influencers/:userId/approve",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const body = await ctx.request.body({ type: "json" }).value;
      const parsed = ApproveSchema.safeParse(body);
      if (!parsed.success) throw new ValidationError("Invalid approval params", parsed.error.issues);

      const result = await container.approveInfluencer.approve({
        userId: ctx.params.userId,
        adminId: ctx.state.userId,
        primaryProfileUrl: parsed.data.primaryProfileUrl,
      });

      ctx.response.body = result;
    },
  );

  // POST /admin/influencers/:userId/reject
  router.post(
    "/admin/influencers/:userId/reject",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      await container.approveInfluencer.reject({
        userId: ctx.params.userId,
        adminId: ctx.state.userId,
      });
      ctx.response.status = 204;
    },
  );

  // ── Suppressions ───────────────────────────────────────────────────────────
  router.delete(
    "/admin/import-jobs/:id",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const { error } = await supabaseService
        .from("import_jobs").delete().eq("id", ctx.params.id);
      if (error) throw new Error(error.message);
      ctx.response.status = 204;
    },
  );

  router.delete(
    "/admin/invitations/:id",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const { error } = await supabaseService
        .from("influencer_invitations").delete().eq("id", ctx.params.id);
      if (error) throw new Error(error.message);
      ctx.response.status = 204;
    },
  );

  // Supprime un influenceur : nettoie aussi les fichiers Storage liés (sinon orphelins)
  router.delete(
    "/admin/influencers/:id",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      // 1. Récupère les paths Storage des vidéos/sous-titres + avatar
      const { data: vids } = await supabaseService
        .from("videos")
        .select("stream_url, subtitles_url")
        .eq("uploader_id", ctx.params.id);
      const { data: user } = await supabaseService
        .from("users")
        .select("display_name, avatar_url")
        .eq("id", ctx.params.id)
        .single();
      const videoPaths: string[] = [];
      const prefix = "/storage/v1/object/public/videos/";
      for (const v of (vids ?? []) as Array<{ stream_url: string; subtitles_url: string | null }>) {
        for (const u of [v.stream_url, v.subtitles_url]) {
          if (!u) continue;
          const idx = u.indexOf(prefix);
          if (idx >= 0) videoPaths.push(u.slice(idx + prefix.length));
        }
      }
      if (videoPaths.length > 0) {
        await supabaseService.storage.from("videos").remove(videoPaths);
      }
      // Avatar (si stocké côté Supabase, pas DiceBear externe)
      if (user?.avatar_url?.includes("/user-avatars/")) {
        const key = `${user.display_name}.jpg`;
        await supabaseService.storage.from("user-avatars").remove([key]);
      }

      // 2. DELETE DB (cascade sur videos, follows, etc.)
      const { error } = await supabaseService
        .from("users").delete().eq("id", ctx.params.id).eq("role", "influencer");
      if (error) throw new Error(error.message);
      ctx.response.status = 204;
    },
  );

  // ── Assigne les catégories de créateur à un influenceur (pour matching onboarding) ──
  router.put(
    "/admin/influencers/:id/categories",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const body = await ctx.request.body({ type: "json" }).value;
      const cats = Array.isArray(body?.categories)
        ? body.categories.map((c: unknown) => String(c).trim().toLowerCase()).filter(Boolean)
        : [];
      const { error } = await supabaseService
        .from("users")
        .update({ creator_categories: cats })
        .eq("id", ctx.params.id)
        .eq("role", "influencer");
      if (error) throw new Error(error.message);
      ctx.response.body = { categories: cats };
    },
  );

  // ── Retry forcé : efface les tentatives passées d'un influenceur pour qu'un
  // prochain import les retraite (failures + incomplete). Les success restent
  // intouchés tant que les vidéos existent en DB.
  router.post(
    "/admin/influencers/:id/reset-attempts",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const status = ctx.request.url.searchParams.get("status") ?? "failure,incomplete";
      const statuses = status.split(",").map((s) => s.trim());
      const { error, count } = await supabaseService
        .from("video_import_attempts")
        .delete({ count: "exact" })
        .eq("uploader_id", ctx.params.id)
        .in("status", statuses);
      if (error) throw new Error(error.message);
      ctx.response.body = { resetCount: count ?? 0, statuses };
    },
  );

  // ── Liste des influenceurs (validés) ───────────────────────────────────────
  router.get(
    "/admin/influencers",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const { data: users, error } = await supabaseService
        .from("users")
        .select("id, display_name, avatar_url, created_at")
        .eq("role", "influencer")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);

      // Count vidéos par uploader_id (1 requête + agrégat côté JS)
      const ids = (users ?? []).map((u: { id: string }) => u.id);
      const counts: Record<string, number> = {};
      if (ids.length > 0) {
        const { data: vids, error: e2 } = await supabaseService
          .from("videos")
          .select("uploader_id")
          .in("uploader_id", ids);
        if (e2) throw new Error(e2.message);
        for (const v of (vids ?? []) as Array<{ uploader_id: string }>) {
          counts[v.uploader_id] = (counts[v.uploader_id] ?? 0) + 1;
        }
      }

      ctx.response.body = (users ?? []).map((u: { id: string; display_name: string | null; avatar_url: string | null; created_at: string }) => ({
        id:           u.id,
        displayName:  u.display_name,
        avatarUrl:    u.avatar_url,
        createdAt:    u.created_at,
        videoCount:   counts[u.id] ?? 0,
      }));
    },
  );

  // ── Vidéos d'un influenceur (avec restaurant) ──────────────────────────────
  router.get(
    "/admin/influencers/:id/videos",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const { data, error } = await supabaseService
        .from("videos")
        .select("id, source_url, stream_url, subtitles_url, transcription, created_at, video_restaurants(position, restaurants(id, name, address, google_rating, cover_image_url))")
        .eq("uploader_id", ctx.params.id)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      // deno-lint-ignore no-explicit-any
      ctx.response.body = (data ?? []).map((v: any) => {
        const links = ((v.video_restaurants ?? []) as Array<{ position: number; restaurants: any }>)
          .sort((a, b) => a.position - b.position);
        const primary = links[0]?.restaurants;
        return {
          id:            v.id,
          sourceUrl:     v.source_url,
          streamUrl:     v.stream_url,
          subtitlesUrl:  v.subtitles_url,
          transcription: v.transcription,
          createdAt:     v.created_at,
          restaurant:    primary
            ? {
                id:            primary.id,
                name:          primary.name,
                address:       primary.address,
                googleRating:  primary.google_rating,
                coverImageUrl: primary.cover_image_url,
              }
            : null,
          allRestaurants: links.map((l) => ({
            id: l.restaurants.id,
            name: l.restaurants.name,
            address: l.restaurants.address,
          })),
        };
      });
    },
  );

  // ── Backfill des données Google des restos déjà créés ──────────────────────
  // POST /admin/restaurants/refresh-google-data?limit=N&force=true|false
  //
  // Pour les restos antérieurs à la migration 0007, leurs colonnes
  // opening_hours / google_reviews sont nulles → la fiche s'affiche sans
  // horaires ni avis. Cet endpoint itère sur les restos sans cache (ou tous
  // si force=true) et appelle EnrichRestaurantGoogleDataUsecase pour chacun.
  //
  // À appeler ponctuellement après la migration. Limité par défaut à 50 par
  // run pour ne pas tout faire d'un coup (chaque resto = 2 appels Google,
  // attention au quota).
  router.post(
    "/admin/restaurants/refresh-google-data",
    requireAuth,
    requireRole("admin"),
    async (ctx) => {
      const params = ctx.request.url.searchParams;
      const limit = Math.min(500, Math.max(1, parseInt(params.get("limit") ?? "50", 10) || 50));
      const force = params.get("force") === "true";

      let query = supabaseService
        .from("restaurants")
        .select("id, place_id, google_data_fetched_at")
        .order("google_data_fetched_at", { ascending: true, nullsFirst: true })
        .limit(limit);
      if (!force) query = query.is("google_data_fetched_at", null);

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as Array<{ id: string; place_id: string }>;
      let ok = 0;
      let failed = 0;
      for (const r of rows) {
        try {
          await container.enrichRestaurantGoogleData.run(r.id, r.place_id);
          ok++;
        } catch (err) {
          console.warn(`[admin:refresh-google-data] ${r.place_id} failed: ${(err as Error).message}`);
          failed++;
        }
      }

      ctx.response.body = {
        processed: rows.length,
        ok,
        failed,
        // Astuce d'utilisation : le caller peut ré-appeler tant que processed > 0.
        hasMore: rows.length === limit,
      };
    },
  );
}
