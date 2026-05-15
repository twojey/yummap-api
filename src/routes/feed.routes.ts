import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError } from "../shared/errors.ts";
import { supabaseService } from "../../config.ts";
import { loadFeaturedRestaurantsForVideos } from "./restaurants.routes.ts";
import type { AppContainer } from "../boot/container.ts";

// `seed` est fourni par le client (généré au cold start de l'app) → l'ordre est
// stable pendant une session mais pseudo-aléatoire et différent entre sessions.
// On utilise offset au lieu d'un cursor parce que l'ordre random ne se prête
// pas à un cursor monotone.
const FeedSchema = z.object({
  seed: z.string().min(1).max(64),
  offset: z.coerce.number().min(0).default(0),
  limit: z.coerce.number().min(1).max(50).default(20),
});

export function registerFeedRoutes(router: Router, _container: AppContainer) {
  router.get("/feed", guestOrAuth, async (ctx) => {
    const params = Object.fromEntries(ctx.request.url.searchParams);
    const parsed = FeedSchema.safeParse(params);
    if (!parsed.success) throw new ValidationError("Invalid feed params", parsed.error.issues);

    const { data, error } = await supabaseService.rpc("feed_random", {
      p_seed: parsed.data.seed,
      p_limit: parsed.data.limit,
      p_offset: parsed.data.offset,
    });
    if (error) throw new Error(error.message);

    // deno-lint-ignore no-explicit-any
    const rows = (data ?? []) as any[];
    // Charge tous les restos featured pour chaque vidéo en un seul appel
    // → permet au player d'afficher la bande chapitres dès l'ouverture du feed.
    const featuredByVideo = await loadFeaturedRestaurantsForVideos(
      rows.map((v) => v.video_id),
    );

    // Format attendu par l'app (camelCase). La RPC déjà retourne des colonnes
    // pré-jointées, plus de mapping {restaurants:{...}, users:{...}}.
    // deno-lint-ignore no-explicit-any
    ctx.response.body = rows.map((v: any) => ({
      videoId: v.video_id,
      thumbnailUrl: v.stream_url,         // pas de thumbnail séparée encore (TODO_OPTIMIZATIONS)
      videoUrl: v.stream_url,
      vttUrl: v.subtitles_url,
      restaurantId: v.restaurant_id,
      restaurantPlaceId: v.restaurant_place_id,
      restaurantName: v.restaurant_name ?? "",
      influencerId: v.uploader_id,
      influencerName: v.user_display_name ?? "",
      influencerAvatarUrl: v.user_avatar_url,
      publishedAt: v.created_at,
      featuredRestaurants: featuredByVideo[v.video_id] ?? [],
    }));
  });
}
