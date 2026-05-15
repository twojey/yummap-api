import { supabaseService } from "../../../config.ts";
import type { IGuideRepository } from "../../domain/guide/guide.repository.ts";
import type { Guide, GuideWithRestaurants } from "../../domain/guide/guide.types.ts";

export class SupabaseGuideRepository implements IGuideRepository {
  async findById(id: string): Promise<Guide | null> {
    const { data, error } = await supabaseService
      .from("guides").select("*").eq("id", id).single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findByInfluencer(influencerId: string): Promise<Guide[]> {
    const { data, error } = await supabaseService
      .from("guides").select("*").eq("influencer_id", influencerId).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
  }

  async create(guide: Omit<Guide, "id" | "restaurantCount" | "createdAt" | "updatedAt">): Promise<Guide> {
    const { data, error } = await supabaseService
      .from("guides")
      .insert({
        influencer_id: guide.influencerId,
        title: guide.title,
        description: guide.description,
        cover_image_url: guide.coverImageUrl,
      })
      .select("*").single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async update(id: string, patch: Partial<Pick<Guide, "title" | "description" | "coverImageUrl">>): Promise<Guide> {
    const { data, error } = await supabaseService
      .from("guides")
      .update({
        ...(patch.title && { title: patch.title }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.coverImageUrl !== undefined && { cover_image_url: patch.coverImageUrl }),
      })
      .eq("id", id).select("*").single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async delete(id: string): Promise<void> {
    const { error } = await supabaseService.from("guides").delete().eq("id", id);
    if (error) throw new Error(error.message);
  }

  async addRestaurant(guideId: string, restaurantId: string): Promise<void> {
    const { error } = await supabaseService
      .from("guide_restaurants")
      .upsert({ guide_id: guideId, restaurant_id: restaurantId }, { onConflict: "guide_id,restaurant_id" });
    if (error) throw new Error(error.message);
  }

  async removeRestaurant(guideId: string, restaurantId: string): Promise<void> {
    const { error } = await supabaseService
      .from("guide_restaurants")
      .delete().eq("guide_id", guideId).eq("restaurant_id", restaurantId);
    if (error) throw new Error(error.message);
  }

  async getWithRestaurants(id: string): Promise<GuideWithRestaurants | null> {
    const { data, error } = await supabaseService
      .from("guides")
      .select("*, guide_restaurants(restaurant_id)")
      .eq("id", id).single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    const guide = this.#mapRow(data);
    return {
      ...guide,
      restaurantIds: (data.guide_restaurants ?? []).map((r: { restaurant_id: string }) => r.restaurant_id),
    };
  }

  #mapRow(row: Record<string, unknown>): Guide {
    return {
      id: row.id as string,
      influencerId: row.influencer_id as string,
      title: row.title as string,
      description: row.description as string | null,
      coverImageUrl: row.cover_image_url as string | null,
      restaurantCount: row.restaurant_count as number ?? 0,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
