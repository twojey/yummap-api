import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError } from "../shared/errors.ts";
import type { AppContainer } from "../boot/container.ts";

const ViewportSchema = z.object({
  swLng: z.coerce.number(),
  swLat: z.coerce.number(),
  neLng: z.coerce.number(),
  neLat: z.coerce.number(),
  guideIds: z.string().optional().transform((v) => v?.split(",").filter(Boolean)),
  tagIds: z.string().optional().transform((v) => v?.split(",").filter(Boolean)),
  openNow: z.coerce.boolean().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
});

export function registerMapRoutes(router: Router, container: AppContainer) {
  router.get("/map/pins", guestOrAuth, async (ctx) => {
    const params = Object.fromEntries(ctx.request.url.searchParams);
    const parsed = ViewportSchema.safeParse(params);
    if (!parsed.success) throw new ValidationError("Invalid viewport params", parsed.error.issues);

    const { swLng, swLat, neLng, neLat, guideIds, tagIds, openNow, minRating } = parsed.data;
    const pins = await container.mapQuery.getPins(
      { swLng, swLat, neLng, neLat },
      { guideIds, tagIds, openNow, minRating },
      ctx.state.userId,
    );

    // Tableau direct (l'app attend List<dynamic>, pas un wrapper)
    ctx.response.body = pins;
  });
}
