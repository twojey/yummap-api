import { Application, Router, oakCors } from "./deps.ts";
import { config } from "./config.ts";
import { errorHandler } from "./src/middleware/error-handler.middleware.ts";
import { requestId } from "./src/middleware/request-id.middleware.ts";
import { createContainer } from "./src/boot/container.ts";
import { registerMapRoutes } from "./src/routes/map.routes.ts";
import { registerVideoRoutes } from "./src/routes/videos.routes.ts";
import { registerRestaurantRoutes } from "./src/routes/restaurants.routes.ts";
import { registerGuideRoutes } from "./src/routes/guides.routes.ts";
import { registerUserRoutes } from "./src/routes/users.routes.ts";
import { registerFeedRoutes } from "./src/routes/feed.routes.ts";
import { registerAdminRoutes } from "./src/routes/admin.routes.ts";
import { registerInvitationRoutes } from "./src/routes/invitations.routes.ts";
import { registerCreatorRoutes } from "./src/routes/creator.routes.ts";
import { registerInfluencerRoutes } from "./src/routes/influencers.routes.ts";
import { registerTagRoutes } from "./src/routes/tags.routes.ts";
import { registerSearchRoutes } from "./src/routes/search.routes.ts";

const app = new Application();
const router = new Router();
const container = createContainer();

// Middleware
app.use(oakCors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] }));
app.use(requestId);
app.use(errorHandler);

// Health check
router.get("/health", (ctx) => {
  ctx.response.body = { status: "ok", env: config.env };
});

// Routes
registerMapRoutes(router, container);
registerVideoRoutes(router, container);
registerRestaurantRoutes(router, container);
registerGuideRoutes(router, container);
registerUserRoutes(router, container);
registerFeedRoutes(router, container);
registerAdminRoutes(router, container);
registerInvitationRoutes(router, container);
registerCreatorRoutes(router, container);
registerInfluencerRoutes(router, container);
registerTagRoutes(router);
registerSearchRoutes(router);

app.use(router.routes());
app.use(router.allowedMethods());

// Schedulers : reprise jobs paused/zombies + backfill données Google.
// Activés uniquement quand on est dans un process avec un cycle de vie long
// (mode "worker" ou "all"). Sur Deno Deploy (mode "api") les invocations sont
// éphémères : setInterval ne survivrait pas entre deux requêtes, donc on
// laisse la responsabilité au worker dédié.
if (config.deployMode !== "api") {
  // Reprise des jobs paused/zombies au boot + toutes les 60s.
  const tickResumableJobs = async (): Promise<void> => {
    try {
      const ids = await container.importJobRepo.findResumable(new Date());
      if (ids.length > 0) {
        console.log(`[Scheduler] resuming ${ids.length} job(s): ${ids.map((i) => i.slice(0, 8)).join(", ")}`);
        for (const id of ids) {
          container.bulkProfileImport.resume(id).catch((err) => {
            console.error(`[Scheduler] resume(${id}) failed:`, err);
          });
        }
      }
    } catch (err) {
      console.error("[Scheduler] tick failed:", err);
    }
  };
  setTimeout(tickResumableJobs, 2_000);
  setInterval(tickResumableJobs, 60_000);

  // Backfill données Google (horaires + reviews) au boot + toutes les 5 min.
  // Petite cadence pour ne pas exploser le quota Google API.
  const GOOGLE_BACKFILL_BATCH = 10;
  const tickGoogleBackfill = async (): Promise<void> => {
    try {
      const processed = await container.enrichRestaurantGoogleData
        .runBatchStale(GOOGLE_BACKFILL_BATCH);
      if (processed > 0) {
        console.log(`[Scheduler] google backfill: ${processed} restaurant(s) processed`);
      }
    } catch (err) {
      console.error("[Scheduler] google backfill failed:", err);
    }
  };
  setTimeout(tickGoogleBackfill, 5_000);
  setInterval(tickGoogleBackfill, 5 * 60_000);

  // Poller video_import_requests : les jobs crees par l'API Deno Deploy
  // (mode=api) y atterrissent en status="pending" sans personne pour les
  // traiter. Le worker les pique d'ici. executeWithJob met status="processing"
  // des l'entree → le tick suivant ne re-prend pas le meme job.
  const VIDEO_IMPORT_BATCH = 3;
  const tickVideoImports = async (): Promise<void> => {
    try {
      const pending = await container.videoImportRequestRepo.findPending(VIDEO_IMPORT_BATCH);
      if (pending.length === 0) return;
      console.log(`[Scheduler] picking up ${pending.length} pending video import(s)`);
      for (const job of pending) {
        container.importVideo.executeWithJob(
          { url: job.url, description: "", uploaderId: job.uploaderId },
          job.id,
          container.videoImportRequestRepo,
        ).catch((err) => {
          // executeWithJob a deja marque le job en "failed" — on log juste.
          console.error(`[Scheduler] video import ${job.id.slice(0, 8)} crashed:`, err.message ?? err);
        });
      }
    } catch (err) {
      console.error("[Scheduler] video import tick failed:", err);
    }
  };
  setTimeout(tickVideoImports, 3_000);
  setInterval(tickVideoImports, 15_000);
}

// Démarrage du serveur HTTP. Sur Deno Deploy on utilise Deno.serve() (pas de
// PORT à binder, géré par la plateforme) ; en local et sur VM on garde
// app.listen() avec le port configuré.
console.log(`[Yummap] Server starting in mode=${config.deployMode}`);
if (config.deployMode === "api") {
  // Deno Deploy : pas de listen avec port — la plateforme gère le binding.
  const handler = app.handle.bind(app);
  Deno.serve(async (req) => {
    const res = await handler(req);
    return res ?? new Response("Not found", { status: 404 });
  });
} else {
  await app.listen({ port: config.port });
}
