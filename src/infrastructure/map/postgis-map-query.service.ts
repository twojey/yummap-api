import { supabaseService } from "../../../config.ts";
import type { IMapQueryService, BoundingBox, PinFilters, Pin } from "../../domain/map/map.query.ts";

export class PostgisMapQueryService implements IMapQueryService {
  async getPins(bbox: BoundingBox, filters: PinFilters, userId?: string): Promise<Pin[]> {
    const { data, error } = await supabaseService.rpc("get_map_pins", {
      sw_lng: bbox.swLng,
      sw_lat: bbox.swLat,
      ne_lng: bbox.neLng,
      ne_lat: bbox.neLat,
      p_guide_ids: filters.guideIds ?? null,
      p_tag_ids: filters.tagIds ?? null,
      p_open_now: filters.openNow ?? null,
      p_min_rating: filters.minRating ?? null,
      p_user_id: userId ?? null,
    });

    if (error) throw new Error(error.message);
    return (data ?? []).map((r: Record<string, unknown>) => ({
      restaurantId: r.restaurant_id as string,
      placeId: r.place_id as string,
      name: r.name as string,
      lat: r.lat as number,
      lng: r.lng as number,
      cuisineType: r.cuisine_type as string | null,
      openNow: r.open_now as boolean | null,
      googleRating: r.google_rating as number | null,
      hasVideos: r.has_videos as boolean,
      isInWatchlist: r.is_in_watchlist as boolean,
      guideIds: (r.guide_ids as string[]) ?? [],
    }));
  }
}
