import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { NotFoundError } from "../shared/errors.ts";
import { supabaseService } from "../../config.ts";
import type { AppContainer } from "../boot/container.ts";

const validateBodySchema = z.object({
  code: z.string(),
});

export function registerRestaurantInvitationRoutes(
  router: Router,
  _container: AppContainer,
) {
  router.get(
    "/influencer/restaurant-invitations",
    guestOrAuth,
    async (ctx) => {
      const influencerId = ctx.state.userId;

      const { data, error } = await supabaseService
        .from("restaurant_invitations")
        .select(
          `id, status, expires_at, used_at, created_at,
           restaurants (id, place_id, name, address, google_rating)`,
        )
        .eq("influencer_id", influencerId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      ctx.response.body = (data ?? []).map((row: any) => ({
        id: row.id,
        restaurantId: row.restaurants?.id ?? null,
        restaurant: row.restaurants
          ? {
            id: row.restaurants.id,
            placeId: row.restaurants.place_id,
            name: row.restaurants.name,
            address: row.restaurants.address,
            googleRating: row.restaurants.google_rating,
          }
          : null,
        status: row.status,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        createdAt: row.created_at,
      }));
    },
  );

  router.get(
    "/influencer/restaurant-invitations/:id",
    guestOrAuth,
    async (ctx) => {
      const influencerId = ctx.state.userId;
      const { id } = ctx.params;

      const { data, error } = await supabaseService
        .from("restaurant_invitations")
        .select(
          `id, token, code_court, status, expires_at, used_at, created_at,
           restaurants (id, place_id, name, address, google_rating)`,
        )
        .eq("id", id)
        .eq("influencer_id", influencerId)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new NotFoundError("RestaurantInvitation", id);

      // deno-lint-ignore no-explicit-any
      const r = (data as any).restaurants as any;
      ctx.response.body = {
        id: data.id,
        restaurantId: r?.id ?? null,
        restaurant: r
          ? {
            id: r.id,
            placeId: r.place_id,
            name: r.name,
            address: r.address,
            googleRating: r.google_rating,
          }
          : null,
        token: data.token,
        codeCourt: data.code_court,
        status: data.status,
        expiresAt: data.expires_at,
        usedAt: data.used_at,
        createdAt: data.created_at,
      };
    },
  );

  router.patch(
    "/influencer/restaurant-invitations/:id/validate",
    guestOrAuth,
    async (ctx) => {
      const influencerId = ctx.state.userId;
      const { id } = ctx.params;

      const body = await ctx.request.body({ type: "json" }).value;
      const parsed = validateBodySchema.safeParse(body);
      if (!parsed.success) {
        ctx.response.status = 400;
        ctx.response.body = { error: "Invalid request body", details: parsed.error.issues };
        return;
      }
      const { code } = parsed.data;

      const { data: invitation, error: fetchError } = await supabaseService
        .from("restaurant_invitations")
        .select("id, code_court, status")
        .eq("id", id)
        .eq("influencer_id", influencerId)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!invitation) throw new NotFoundError("RestaurantInvitation", id);

      if (invitation.status !== "pending") {
        ctx.response.status = 400;
        ctx.response.body = { error: "Invitation is not pending" };
        return;
      }

      if (invitation.code_court !== code) {
        ctx.response.status = 400;
        ctx.response.body = { error: "Invalid code" };
        return;
      }

      const { error: updateError } = await supabaseService
        .from("restaurant_invitations")
        .update({ status: "used", used_at: new Date().toISOString() })
        .eq("id", id);

      if (updateError) throw updateError;

      ctx.response.body = { success: true };
    },
  );
}
