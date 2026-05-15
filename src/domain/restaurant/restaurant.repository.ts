import type { Restaurant, SearchFilters } from "./restaurant.types.ts";
import type { BoundingBox } from "../map/map.query.ts";

export interface IRestaurantRepository {
  findById(placeId: string): Promise<Restaurant | null>;
  findByViewport(bbox: BoundingBox, filters?: SearchFilters): Promise<Restaurant[]>;
  findByGuide(guideId: string, filters?: SearchFilters): Promise<Restaurant[]>;
  search(filters: SearchFilters): Promise<Restaurant[]>;
  // coverImageUrl exclu : il est setté séparément par le pipeline d'import via
  // `#ensureRestaurantPhoto` (upload Google Places photo), pas à l'upsert initial.
  upsert(restaurant: Omit<Restaurant, "tags" | "createdAt" | "updatedAt" | "coverImageUrl">): Promise<Restaurant>;
  assignTags(placeId: string, tagIds: string[]): Promise<void>;
}
