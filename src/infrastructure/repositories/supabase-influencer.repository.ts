import { supabaseService } from "../../../config.ts";
import type { IInfluencerRepository } from "../../domain/influencer/influencer.repository.ts";
import type { Influencer, InfluencerForUser } from "../../domain/influencer/influencer.types.ts";

export class SupabaseInfluencerRepository implements IInfluencerRepository {
  async findById(id: string, viewingUserId?: string): Promise<InfluencerForUser | null> {
    const { data, error } = await supabaseService
      .from("influencers").select("*").eq("id", id).single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);

    const isFollowed = viewingUserId
      ? await this.#isFollowing(viewingUserId, id)
      : false;
    return { ...this.#mapRow(data), isFollowed };
  }

  async getForOnboarding(preferredCategories: string[]): Promise<Influencer[]> {
    const { data, error } = await supabaseService
      .from("influencers")
      .select("*")
      .eq("visible_at_onboarding", true)
      .order("follower_count", { ascending: false });
    if (error) throw new Error(error.message);

    const all = (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
    if (preferredCategories.length === 0) return all;

    const matching = all.filter((i) => i.categories.some((c) => preferredCategories.includes(c)));
    const rest = all.filter((i) => !matching.includes(i));
    return [...matching, ...rest];
  }

  async getFollowedByUser(userId: string): Promise<InfluencerForUser[]> {
    const { data, error } = await supabaseService
      .from("follows")
      .select("influencer_id, influencers(*)")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row: Record<string, unknown>) => ({
      ...this.#mapRow(row.influencers as Record<string, unknown>),
      isFollowed: true,
    }));
  }

  async getFollowedGuideIds(userId: string): Promise<string[]> {
    const { data, error } = await supabaseService
      .from("follows")
      .select("influencer_id")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    const influencerIds = (data ?? []).map((r: { influencer_id: string }) => r.influencer_id);

    if (influencerIds.length === 0) return [];
    const { data: guides, error: gError } = await supabaseService
      .from("guides").select("id").in("influencer_id", influencerIds);
    if (gError) throw new Error(gError.message);
    return (guides ?? []).map((g: { id: string }) => g.id);
  }

  async updateCategories(id: string, categories: string[]): Promise<void> {
    const { error } = await supabaseService
      .from("influencers").update({ categories }).eq("id", id);
    if (error) throw new Error(error.message);
  }

  async setVisibleAtOnboarding(id: string, visible: boolean): Promise<void> {
    const { error } = await supabaseService
      .from("influencers").update({ visible_at_onboarding: visible }).eq("id", id);
    if (error) throw new Error(error.message);
  }

  async #isFollowing(userId: string, influencerId: string): Promise<boolean> {
    const { data } = await supabaseService
      .from("follows")
      .select("influencer_id")
      .eq("user_id", userId)
      .eq("influencer_id", influencerId)
      .maybeSingle();
    return data != null;
  }

  #mapRow(row: Record<string, unknown>): Influencer {
    return {
      id: row.id as string,
      displayName: row.display_name as string,
      avatarUrl: row.avatar_url as string | null,
      bio: row.bio as string | null,
      categories: (row.categories as string[]) ?? [],
      visibleAtOnboarding: (row.visible_at_onboarding as boolean) ?? false,
      guideCount: (row.guide_count as number) ?? 0,
      followerCount: (row.follower_count as number) ?? 0,
      createdAt: row.created_at as string,
    };
  }
}
