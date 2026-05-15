import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError, NotFoundError } from "../shared/errors.ts";
import { analyticsService } from "../infrastructure/analytics/analytics.service.ts";
import { supabaseService } from "../../config.ts";
import type { AppContainer } from "../boot/container.ts";

// Charge la liste des influenceurs suivis par un user (ou Set vide).
// Utilisé pour trier les vidéos avec "follow priority".
async function loadFollowedSet(userId?: string): Promise<Set<string>> {
  if (!userId) return new Set();
  const { data } = await supabaseService
    .from("follows")
    .select("influencer_id")
    .eq("user_id", userId);
  return new Set(((data ?? []) as Array<{ influencer_id: string }>).map((r) => r.influencer_id));
}

export interface FeaturedRestaurant {
  id: string;
  placeId: string;
  name: string;
  startSeconds: number | null;
}

// Pour un batch d'IDs de vidéos, retourne map<videoId, FeaturedRestaurant[]>.
// Inclut TOUS les restos featured dans la vidéo (position 0..N), triés par
// position croissante. Utilisé par les routes qui exposent le multi-resto au
// client (player chapter band, badge "N spots").
export async function loadFeaturedRestaurantsForVideos(
  videoIds: string[],
): Promise<Record<string, FeaturedRestaurant[]>> {
  if (videoIds.length === 0) return {};
  const { data } = await supabaseService
    .from("video_restaurants")
    .select("video_id, position, start_seconds, restaurants!inner(id, place_id, name)")
    .in("video_id", videoIds)
    .order("position", { ascending: true });
  const result: Record<string, FeaturedRestaurant[]> = {};
  for (const row of (data ?? []) as Array<{
    video_id: string;
    start_seconds: number | null;
    restaurants: { id: string; place_id: string; name: string };
  }>) {
    const list = result[row.video_id] ?? (result[row.video_id] = []);
    list.push({
      id: row.restaurants.id,
      placeId: row.restaurants.place_id,
      name: row.restaurants.name,
      startSeconds: row.start_seconds,
    });
  }
  return result;
}

// Trie : influenceurs suivis en tête, puis chrono DESC pour chaque groupe
function sortVideosByFollow<T extends { uploader_id: string; created_at: string }>(
  videos: T[],
  followedSet: Set<string>,
): T[] {
  return [...videos].sort((a, b) => {
    const aFollowed = followedSet.has(a.uploader_id);
    const bFollowed = followedSet.has(b.uploader_id);
    if (aFollowed !== bFollowed) return aFollowed ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

const SearchSchema = z.object({
  q: z.string().optional(),
  tagIds: z.string().optional().transform((v) => v?.split(",").filter(Boolean)),
  openNow: z.coerce.boolean().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
});

export function registerRestaurantRoutes(router: Router, container: AppContainer) {
  router.get("/restaurants/search", guestOrAuth, async (ctx) => {
    const params = Object.fromEntries(ctx.request.url.searchParams);
    const parsed = SearchSchema.safeParse(params);
    if (!parsed.success) throw new ValidationError("Invalid search params", parsed.error.issues);

    const restaurants = await container.restaurantRepo.search({
      query: parsed.data.q,
      tagIds: parsed.data.tagIds,
      openNow: parsed.data.openNow,
      minRating: parsed.data.minRating,
    });

    ctx.response.body = { restaurants };
  });

  router.get("/restaurants/:placeId", guestOrAuth, async (ctx) => {
    const restaurant = await container.restaurantRepo.findById(ctx.params.placeId);
    if (!restaurant) throw new NotFoundError("Restaurant", ctx.params.placeId);

    analyticsService.track({
      eventType: "restaurant_view",
      userId: ctx.state.userId,
      restaurantId: restaurant.id,
    });

    // Récupère les vidéos liées + influenceurs suivis pour trier.
    // Passe par video_restaurants pour gérer le multi-resto par vidéo.
    // deno-lint-ignore no-explicit-any
    const { data: vrRows } = await supabaseService
      .from("video_restaurants")
      .select("start_seconds, videos!inner(id, stream_url, subtitles_url, transcription, created_at, uploader_id, users!uploader_id(id, display_name, avatar_url))")
      .eq("restaurant_id", restaurant.id)
      .order("created_at", { referencedTable: "videos", ascending: false })
      .limit(50) as { data: any[] | null };
    const videos = (vrRows ?? []).map((r) => ({ ...r.videos, start_seconds: r.start_seconds }));
    const allFeaturedByVideo = await loadFeaturedRestaurantsForVideos(
      videos.map((v) => v.id as string),
    );

    const followedSet = await loadFollowedSet(ctx.state.userId);

    // Reviews Google : lues depuis la colonne `google_reviews` (JSONB) peuplée
    // à l'import par EnrichRestaurantGoogleDataUsecase. Les routes consommées
    // par l'app NE doivent JAMAIS appeler Google en runtime — pour les restos
    // antérieurs sans cache, on retourne une liste vide jusqu'à ce que le
    // backfill admin tourne.
    const { data: cachedGoogle } = await supabaseService
      .from("restaurants")
      .select("google_reviews")
      .eq("id", restaurant.id)
      .single();
    const googleReviews = ((cachedGoogle?.google_reviews ?? []) as Array<{
      author?: string;
      avatarUrl?: string;
      rating?: number;
      text?: string;
      time?: number;
      relativeTime?: string;
    }>);

    // Extrait lat/lng via PostGIS (la colonne location est en WKB binaire)
    const { data: geo } = await supabaseService
      .rpc("get_restaurant_lat_lng", { p_restaurant_id: restaurant.id });

    // Récupère les guides qui contiennent ce restaurant
    const { data: guideLinks } = await supabaseService
      .from("guide_restaurants")
      .select("guides(id, title, restaurant_count, users:influencer_id(id, display_name))")
      .eq("restaurant_id", restaurant.id);

    // Format attendu par l'app (RestaurantDetail)
    // deno-lint-ignore no-explicit-any
    const geoRow = (geo as any[] | null)?.[0];
    ctx.response.body = {
      id: restaurant.id,
      placeId: restaurant.placeId,
      name: restaurant.name,
      address: restaurant.address,
      lat: geoRow?.lat ?? 0,
      lng: geoRow?.lng ?? 0,
      googleRating: restaurant.googleRating,
      openNow: restaurant.openNow,
      // Lu depuis la DB (peuplé à l'import par EnrichRestaurantGoogleDataUsecase).
      openingHours: restaurant.openingHours,
      websiteUrl: restaurant.websiteUrl,
      phoneNumber: restaurant.phoneNumber,
      coverImageUrl: restaurant.coverImageUrl,
      // deno-lint-ignore no-explicit-any
      tags: ((restaurant as any).tags ?? []),
      isInWatchlist: false,
      // deno-lint-ignore no-explicit-any
      videos: sortVideosByFollow((videos ?? []) as any[], followedSet).map((v: any) => ({
        id: v.id,
        thumbnailUrl: v.stream_url,
        videoUrl: v.stream_url,
        vttUrl: v.subtitles_url,
        transcription: v.transcription,
        createdAt: v.created_at,
        influencerId: v.users?.id,
        influencerName: v.users?.display_name ?? "",
        influencerAvatarUrl: v.users?.avatar_url,
        isFromFollowedInfluencer: followedSet.has(v.uploader_id),
        // Tous les restos featured dans cette vidéo (≥ 1, ordonné par position).
        // Permet au player d'afficher une bande chapitres avec jump-to-time.
        featuredRestaurants: allFeaturedByVideo[v.id] ?? [],
      })),
      // Format aligné sur le modèle Avis côté app (id/source/authorName/authorAvatarUrl/
      // rating/text/isFromFollowedInfluencer/publishedAt). Avant ce fix, les avis Google
      // ne s'affichaient pas du tout côté app (parse error sur authorName/id manquants).
      // id : on synthétise un id stable depuis (placeId + index + author) — Google
      //      n'expose pas d'id de review.
      // publishedAt : on convertit le `time` Unix en ISO ; à défaut on prend "now".
      avis: googleReviews.map((r, i) => ({
        id: `google_${restaurant.placeId}_${i}_${(r.author ?? "").length}`,
        source: "google",
        authorName: r.author,
        authorAvatarUrl: r.avatarUrl,
        rating: r.rating,
        text: r.text,
        isFromFollowedInfluencer: false,
        publishedAt: r.time
          ? new Date(r.time * 1000).toISOString()
          : new Date().toISOString(),
      })),
      // deno-lint-ignore no-explicit-any
      guides: (guideLinks ?? []).map((row: any) => ({
        id: row.guides?.id,
        influencerId: row.guides?.users?.id,
        influencerName: row.guides?.users?.display_name ?? "",
        title: row.guides?.title ?? "",
        description: null,
        coverImageUrl: null,
        restaurantCount: row.guides?.restaurant_count ?? 0,
      })).filter((g: { id?: string }) => g.id),
    };
  });

  // Résumé léger pour la quick-view depuis un pin de la map
  router.get("/restaurants/:placeId/summary", guestOrAuth, async (ctx) => {
    const restaurant = await container.restaurantRepo.findById(ctx.params.placeId);
    if (!restaurant) throw new NotFoundError("Restaurant", ctx.params.placeId);
    // deno-lint-ignore no-explicit-any
    const { data: vrRows } = await supabaseService
      .from("video_restaurants")
      .select("start_seconds, videos!inner(id, stream_url, subtitles_url, transcription, created_at, uploader_id, users!uploader_id(id, display_name, avatar_url))")
      .eq("restaurant_id", restaurant.id)
      .order("created_at", { referencedTable: "videos", ascending: false })
      .limit(20) as { data: any[] | null };
    const videos = (vrRows ?? []).map((r) => ({ ...r.videos, start_seconds: r.start_seconds }));
    const summaryFeaturedByVideo = await loadFeaturedRestaurantsForVideos(
      videos.map((v) => v.id as string),
    );
    const summaryFollowedSet = await loadFollowedSet(ctx.state.userId);
    ctx.response.body = {
      id: restaurant.id,
      placeId: restaurant.placeId,
      name: restaurant.name,
      address: restaurant.address,
      googleRating: restaurant.googleRating,
      openNow: restaurant.openNow,
      // openingHours envoyé pour que l'app calcule open/closed LIVE depuis
      // l'heure du téléphone (le openNow ci-dessus est figé à l'import).
      openingHours: restaurant.openingHours,
      coverImageUrl: restaurant.coverImageUrl,
      // deno-lint-ignore no-explicit-any
      videos: sortVideosByFollow((videos ?? []) as any[], summaryFollowedSet).map((v: any) => ({
        id: v.id,
        thumbnailUrl: v.stream_url,
        videoUrl: v.stream_url,
        vttUrl: v.subtitles_url,
        transcription: v.transcription,
        createdAt: v.created_at,
        influencerId: v.users?.id,
        influencerName: v.users?.display_name ?? "",
        influencerAvatarUrl: v.users?.avatar_url,
        isFromFollowedInfluencer: summaryFollowedSet.has(v.uploader_id),
        featuredRestaurants: summaryFeaturedByVideo[v.id] ?? [],
      })),
    };
  });

  router.post("/restaurants/:placeId/map-open", guestOrAuth, async (ctx) => {
    const restaurant = await container.restaurantRepo.findById(ctx.params.placeId);
    if (!restaurant) throw new NotFoundError("Restaurant", ctx.params.placeId);

    analyticsService.track({
      eventType: "restaurant_map_open",
      userId: ctx.state.userId,
      restaurantId: restaurant.id,
    });

    ctx.response.status = 204;
  });
}
