import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError, NotFoundError } from "../shared/errors.ts";
import { supabaseService } from "../../config.ts";
import type { AppContainer } from "../boot/container.ts";

// Helper local : assigne un resto unique à une vidéo en position 0.
// On supprime d'abord les anciens liens pour garantir que position 0 = ce resto.
async function linkVideoToRestaurant(videoId: string, restaurantId: string) {
  await supabaseService.from("video_restaurants").delete().eq("video_id", videoId);
  const { error } = await supabaseService.from("video_restaurants").insert({
    video_id: videoId, restaurant_id: restaurantId, position: 0,
  });
  if (error) throw new Error(error.message);
}

// Routes pour la section créateur dans yummap_app (influenceurs)
export function registerCreatorRoutes(router: Router, container: AppContainer) {

  // Vidéos importées par cet influenceur
  // GET /creator/videos?needsReview=true|false
  router.get("/creator/videos", guestOrAuth, async (ctx) => {
    const needsReview = ctx.request.url.searchParams.get("needsReview");
    let query = supabaseService
      .from("videos")
      .select(`
        id, source_url, stream_url, subtitles_url, transcription, created_at,
        needs_review, detected_name, detected_address,
        video_restaurants (position, restaurants (id, place_id, name, address))
      `)
      .eq("uploader_id", ctx.state.userId)
      .order("created_at", { ascending: false });
    if (needsReview === "true") query = query.eq("needs_review", true);
    if (needsReview === "false") query = query.eq("needs_review", false);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Aplatit le shape pour préserver la compat côté Flutter (champ `restaurants`
    // = premier resto en position 0) tout en exposant `allRestaurants` pour les
    // vidéos qui en ont plusieurs.
    // deno-lint-ignore no-explicit-any
    ctx.response.body = (data ?? []).map((v: any) => {
      const links = ((v.video_restaurants ?? []) as Array<{ position: number; restaurants: any }>)
        .sort((a, b) => a.position - b.position);
      const primary = links[0]?.restaurants ?? null;
      // deno-lint-ignore no-explicit-any
      const all = links.map((l: any) => l.restaurants).filter(Boolean);
      // deno-lint-ignore no-unused-vars
      const { video_restaurants: _, ...rest } = v;
      return { ...rest, restaurants: primary, allRestaurants: all };
    });
  });

  // Assigne un restaurant à une vidéo en review (correction manuelle)
  // POST /creator/videos/:id/assign-restaurant   body: { placeId: "..." }
  router.post("/creator/videos/:id/assign-restaurant", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = z.object({ placeId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid assign params", parsed.error.issues);

    // Vérifie que la vidéo appartient au user
    const { data: video } = await supabaseService
      .from("videos")
      .select("id")
      .eq("id", ctx.params.id)
      .eq("uploader_id", ctx.state.userId)
      .single();
    if (!video) throw new NotFoundError("Video", ctx.params.id);

    // Trouve ou crée le restaurant via Places + upsert
    const place = await container.placesClient.findPlace(parsed.data.placeId, "");
    if (!place) {
      // Fallback : si l'utilisateur a passé directement un placeId, on tente getDetails
      const details = await container.placesClient.getDetails(parsed.data.placeId);
      if (!details) throw new NotFoundError("Place", parsed.data.placeId);
      const r = await container.restaurantRepo.upsert({
        id: crypto.randomUUID(),
        placeId: details.placeId,
        name: details.name,
        address: details.address,
        city: "Paris",
        location: details.location,
        googleRating: details.rating ?? null,
        googleRatingsCount: details.ratingsCount ?? null,
        openNow: details.openNow ?? null,
        openingHours: null,
        websiteUrl: details.websiteUrl ?? null,
        phoneNumber: details.phoneNumber ?? null,
      });
      // Pré-fetch horaires + reviews à la création — sans ça, les routes app
      // devraient appeler Google en runtime (interdit par convention).
      await container.enrichRestaurantGoogleData.run(r.id, details.placeId);
      await linkVideoToRestaurant(ctx.params.id, r.id);
      await supabaseService.from("videos").update({ needs_review: false })
        .eq("id", ctx.params.id);
      ctx.response.body = { restaurantId: r.id };
      return;
    }
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
    // Idem branche principale.
    await container.enrichRestaurantGoogleData.run(restaurant.id, place.placeId);
    await linkVideoToRestaurant(ctx.params.id, restaurant.id);
    await supabaseService.from("videos").update({ needs_review: false })
      .eq("id", ctx.params.id);
    ctx.response.body = { restaurantId: restaurant.id };
  });

  // Endpoint multi-resto : remplace tous les restos d'une vidéo par la liste
  // fournie (utilisé par le creator review screen quand l'IA a détecté plusieurs
  // restos ou que le créateur veut en ajouter/réordonner).
  // POST /creator/videos/:id/assign-restaurants  body: { placeIds: [...] }
  router.post("/creator/videos/:id/assign-restaurants", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = z.object({ placeIds: z.array(z.string().min(1)).min(1) })
      .safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid assign params", parsed.error.issues);

    const { data: video } = await supabaseService
      .from("videos")
      .select("id")
      .eq("id", ctx.params.id)
      .eq("uploader_id", ctx.state.userId)
      .single();
    if (!video) throw new NotFoundError("Video", ctx.params.id);

    // Pour chaque placeId, résout en restaurant (upsert) puis ré-écrit les liens
    // dans l'ordre. Les anciens liens sont supprimés d'abord pour avoir un état
    // propre (sinon une nouvelle liste plus courte garderait des restos morts).
    const restaurantIds: string[] = [];
    for (const placeId of parsed.data.placeIds) {
      const details = await container.placesClient.getDetails(placeId);
      if (!details) continue;
      const r = await container.restaurantRepo.upsert({
        id: crypto.randomUUID(),
        placeId: details.placeId,
        name: details.name,
        address: details.address,
        city: "Paris",
        location: details.location,
        googleRating: details.rating ?? null,
        googleRatingsCount: details.ratingsCount ?? null,
        openNow: details.openNow ?? null,
        openingHours: null,
        websiteUrl: details.websiteUrl ?? null,
        phoneNumber: details.phoneNumber ?? null,
      });
      await container.enrichRestaurantGoogleData.run(r.id, details.placeId);
      restaurantIds.push(r.id);
    }
    if (restaurantIds.length === 0) {
      throw new ValidationError("No valid place resolved", []);
    }

    await supabaseService.from("video_restaurants").delete().eq("video_id", ctx.params.id);
    const rows = restaurantIds.map((rid, i) => ({
      video_id: ctx.params.id, restaurant_id: rid, position: i,
    }));
    const { error } = await supabaseService.from("video_restaurants").insert(rows);
    if (error) throw new Error(error.message);
    await supabaseService.from("videos").update({ needs_review: false })
      .eq("id", ctx.params.id);
    ctx.response.body = { restaurantIds };
  });

  // Stats rapides de l'influenceur
  // GET /creator/stats
  router.get("/creator/stats", guestOrAuth, async (ctx) => {
    const userId = ctx.state.userId;

    const [videosRes, followersRes, guidesRes] = await Promise.all([
      supabaseService
        .from("videos")
        .select("id", { count: "exact", head: true })
        .eq("uploader_id", userId),
      supabaseService
        .from("follows")
        .select("user_id", { count: "exact", head: true })
        .eq("influencer_id", userId),
      supabaseService
        .from("guides")
        .select("id", { count: "exact", head: true })
        .eq("influencer_id", userId),
    ]);

    ctx.response.body = {
      videoCount:    videosRes.count ?? 0,
      followerCount: followersRes.count ?? 0,
      guideCount:    guidesRes.count ?? 0,
    };
  });

  // Guides de cet influenceur
  // GET /creator/guides
  router.get("/creator/guides", guestOrAuth, async (ctx) => {
    const { data, error } = await supabaseService
      .from("guides")
      .select("*")
      .eq("influencer_id", ctx.state.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    ctx.response.body = data ?? [];
  });
}
