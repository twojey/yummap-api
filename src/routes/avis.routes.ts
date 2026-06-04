import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError, NotFoundError } from "../shared/errors.ts";
import { supabaseService } from "../../config.ts";
import type { AppContainer } from "../boot/container.ts";

const createAvisSchema = z.object({
  placeId: z.string().min(1),
  note: z.number().int().min(1).max(5),
  texte: z.string().min(1).max(2000),
});

const updateAvisSchema = z.object({
  note: z.number().int().min(1).max(5).optional(),
  texte: z.string().min(1).max(2000).optional(),
});

export function registerAvisRoutes(router: Router, _container: AppContainer) {
  router.get("/influencer/avis/:placeId", guestOrAuth, async (ctx) => {
    const userId = ctx.state.userId as string;
    const placeId = ctx.params.placeId;

    const { data, error } = await supabaseService
      .from("avis_influencer")
      .select("*")
      .eq("influencer_id", userId)
      .eq("place_id", placeId)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundError("Avis not found");

    ctx.response.body = data;
  });

  router.post("/influencer/avis", guestOrAuth, async (ctx) => {
    const userId = ctx.state.userId as string;
    const body = await ctx.request.body({ type: "json" }).value;

    const parsed = createAvisSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    const { placeId, note, texte } = parsed.data;

    const { data: restaurant, error: restaurantError } = await supabaseService
      .from("restaurants")
      .select("id")
      .eq("place_id", placeId)
      .maybeSingle();

    if (restaurantError) throw restaurantError;

    let hasVideo = false;

    if (restaurant) {
      const { data: videoData, error: videoError } = await supabaseService
        .from("videos")
        .select("id, video_restaurants!inner(restaurant_id)")
        .eq("uploader_id", userId)
        .eq("video_restaurants.restaurant_id", restaurant.id)
        .limit(1);

      if (videoError) throw videoError;
      hasVideo = videoData !== null && videoData.length > 0;
    }

    if (!hasVideo) {
      ctx.response.status = 403;
      ctx.response.body = {
        error: "You must have at least one video linked to this restaurant to leave a review.",
      };
      return;
    }

    const { data, error } = await supabaseService
      .from("avis_influencer")
      .upsert(
        {
          influencer_id: userId,
          place_id: placeId,
          note,
          texte,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "influencer_id,place_id" }
      )
      .select()
      .single();

    if (error) throw error;

    ctx.response.status = 201;
    ctx.response.body = data;
  });

  router.put("/influencer/avis/:placeId", guestOrAuth, async (ctx) => {
    const userId = ctx.state.userId as string;
    const placeId = ctx.params.placeId;
    const body = await ctx.request.body({ type: "json" }).value;

    const parsed = updateAvisSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    const { note, texte } = parsed.data;

    const { data: existing, error: existingError } = await supabaseService
      .from("avis_influencer")
      .select("id")
      .eq("influencer_id", userId)
      .eq("place_id", placeId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (!existing) throw new NotFoundError("Avis not found");

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (note !== undefined) updates.note = note;
    if (texte !== undefined) updates.texte = texte;

    const { data, error } = await supabaseService
      .from("avis_influencer")
      .update(updates)
      .eq("influencer_id", userId)
      .eq("place_id", placeId)
      .select()
      .single();

    if (error) throw error;

    ctx.response.body = data;
  });

  router.delete("/influencer/avis/:placeId", guestOrAuth, async (ctx) => {
    const userId = ctx.state.userId as string;
    const placeId = ctx.params.placeId;

    const { data: existing, error: existingError } = await supabaseService
      .from("avis_influencer")
      .select("id")
      .eq("influencer_id", userId)
      .eq("place_id", placeId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (!existing) throw new NotFoundError("Avis not found");

    const { error } = await supabaseService
      .from("avis_influencer")
      .delete()
      .eq("influencer_id", userId)
      .eq("place_id", placeId);

    if (error) throw error;

    ctx.response.status = 204;
  });
}
