import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth, requireRole } from "../middleware/auth.middleware.ts";
import { ValidationError } from "../shared/errors.ts";
import { supabaseService } from "../../config.ts";
import type { AppContainer } from "../boot/container.ts";

const CreateGuideSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export function registerGuideRoutes(router: Router, container: AppContainer) {
  // Guides d'un influenceur
  router.get("/guides/:influencerId", guestOrAuth, async (ctx) => {
    const guides = await container.guideRepo.findByInfluencer(ctx.params.influencerId);
    ctx.response.body = { guides };
  });

  // Créer un Guide
  router.post("/guides", guestOrAuth, requireRole("influencer"), async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = CreateGuideSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid guide data", parsed.error.issues);
    const guide = await container.createGuide.execute({
      influencerId: ctx.state.userId,
      ...parsed.data,
    });
    ctx.response.status = 201;
    ctx.response.body = guide;
  });

  // Restaurants d'un Guide (avec infos enrichies)
  router.get("/guides/:guideId/restaurants", guestOrAuth, async (ctx) => {
    const { data, error } = await supabaseService
      .from("guide_restaurants")
      .select("restaurant_id, restaurants(id, place_id, name, address, google_rating)")
      .eq("guide_id", ctx.params.guideId);
    if (error) throw new Error(error.message);
    ctx.response.body = (data ?? []).map((row: Record<string, unknown>) => {
      const r = (row.restaurants ?? {}) as Record<string, unknown>;
      return {
        placeId:      r.place_id,
        name:         r.name,
        address:      r.address ?? null,
        googleRating: r.google_rating ?? null,
      };
    });
  });

  // Ajouter un Restaurant à un Guide (restaurantId = UUID interne)
  router.post("/guides/:guideId/restaurants/:restaurantId", guestOrAuth, requireRole("influencer"), async (ctx) => {
    await container.guideRepo.addRestaurant(ctx.params.guideId, ctx.params.restaurantId);
    ctx.response.status = 204;
  });

  // Retirer un Restaurant d'un Guide (placeId = Google Places ID)
  router.delete("/guides/:guideId/restaurants/:placeId", guestOrAuth, requireRole("influencer"), async (ctx) => {
    // Récupérer l'id interne depuis le placeId
    const { data } = await supabaseService
      .from("restaurants").select("id").eq("place_id", ctx.params.placeId).single();
    if (data) {
      await container.guideRepo.removeRestaurant(ctx.params.guideId, (data as { id: string }).id);
    }
    ctx.response.status = 204;
  });
}
