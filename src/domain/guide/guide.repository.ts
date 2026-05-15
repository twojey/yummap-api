import type { Guide, GuideWithRestaurants } from "./guide.types.ts";

export interface IGuideRepository {
  findById(id: string): Promise<Guide | null>;
  findByInfluencer(influencerId: string): Promise<Guide[]>;
  create(guide: Omit<Guide, "id" | "restaurantCount" | "createdAt" | "updatedAt">): Promise<Guide>;
  update(id: string, patch: Partial<Pick<Guide, "title" | "description" | "coverImageUrl">>): Promise<Guide>;
  delete(id: string): Promise<void>;
  addRestaurant(guideId: string, restaurantId: string): Promise<void>;
  removeRestaurant(guideId: string, restaurantId: string): Promise<void>;
  getWithRestaurants(id: string): Promise<GuideWithRestaurants | null>;
}
