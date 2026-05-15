import { supabaseService } from "../../../config.ts";
import type { IUserRepository } from "../../domain/user/user.repository.ts";
import type { User } from "../../domain/user/user.types.ts";

export class SupabaseUserRepository implements IUserRepository {
  async findById(id: string): Promise<User | null> {
    const { data, error } = await supabaseService
      .from("users").select("*").eq("id", id).single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findByPhoneNumber(phoneNumber: string): Promise<User | null> {
    const { data, error } = await supabaseService
      .from("users").select("*").eq("phone_number", phoneNumber).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.#mapRow(data) : null;
  }

  async upsert(
    user: Pick<User, "id" | "role"> & { displayName: string; phoneNumber: string },
  ): Promise<User> {
    // Phone vérifié → l'user n'est plus anonyme, on bump last_active_at au passage
    const { data, error } = await supabaseService
      .from("users")
      .upsert(
        {
          id: user.id,
          role: user.role,
          display_name: user.displayName,
          phone_number: user.phoneNumber,
          is_anonymous: false,
          last_active_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      )
      .select("*").single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async createAnonymous(params: { id: string; displayName: string }): Promise<User> {
    // Idempotent : si l'UUID existe déjà, on touche juste last_active_at + display_name
    // (sans écraser is_anonymous=false si l'user avait déjà vérifié son phone)
    const { data, error } = await supabaseService
      .from("users")
      .upsert(
        {
          id: params.id,
          role: "user",
          display_name: params.displayName,
          last_active_at: new Date().toISOString(),
        },
        { onConflict: "id", ignoreDuplicates: false },
      )
      .select("*").single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async heartbeat(id: string): Promise<void> {
    const { error } = await supabaseService
      .from("users")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  async countActiveFollowers(influencerId: string, activeWindowDays: number): Promise<number> {
    // Cutoff = NOW() - activeWindowDays. On exclut les users non vus depuis.
    const cutoff = new Date(Date.now() - activeWindowDays * 24 * 3600 * 1000).toISOString();
    const { count, error } = await supabaseService
      .from("follows")
      .select("user_id, users!inner(last_active_at)", { count: "exact", head: true })
      .eq("influencer_id", influencerId)
      .gte("users.last_active_at", cutoff);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async mergeInto(fromId: string, toId: string): Promise<void> {
    // Transfère atomiquement follows + watchlist, puis delete l'user source.
    // Note: on ne peut pas faire de transaction multi-statement via supabase-js,
    // donc on s'appuie sur les UPSERT pour rester idempotent en cas d'échec partiel.

    // 1. Follows : insert les follows de l'anon chez le user cible (sans doublon)
    const { data: srcFollows, error: e1 } = await supabaseService
      .from("follows").select("influencer_id").eq("user_id", fromId);
    if (e1) throw new Error(e1.message);
    if (srcFollows?.length) {
      const rows = srcFollows.map((f: { influencer_id: string }) => ({
        user_id: toId,
        influencer_id: f.influencer_id,
      }));
      const { error: e2 } = await supabaseService
        .from("follows").upsert(rows, { onConflict: "user_id,influencer_id" });
      if (e2) throw new Error(e2.message);
    }

    // 2. Watchlist : pareil
    const { data: srcWatch, error: e3 } = await supabaseService
      .from("watchlist").select("restaurant_id").eq("user_id", fromId);
    if (e3) throw new Error(e3.message);
    if (srcWatch?.length) {
      const rows = srcWatch.map((w: { restaurant_id: string }) => ({
        user_id: toId,
        restaurant_id: w.restaurant_id,
      }));
      const { error: e4 } = await supabaseService
        .from("watchlist").upsert(rows, { onConflict: "user_id,restaurant_id" });
      if (e4) throw new Error(e4.message);
    }

    // 3. Delete l'user source — les follows/watchlist du fromId disparaissent
    //    par CASCADE, ne reste que les rows nouvelles dans toId.
    const { error: e5 } = await supabaseService.from("users").delete().eq("id", fromId);
    if (e5) throw new Error(e5.message);
  }

  async updatePreferences(id: string, prefs: Partial<User["preferences"]>): Promise<void> {
    const { error } = await supabaseService
      .from("users").update({ preferences: prefs }).eq("id", id);
    if (error) throw new Error(error.message);
  }

  async getFollowing(userId: string): Promise<string[]> {
    const { data, error } = await supabaseService
      .from("follows").select("influencer_id").eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: { influencer_id: string }) => r.influencer_id);
  }

  async follow(userId: string, influencerId: string): Promise<void> {
    const { error } = await supabaseService
      .from("follows")
      .upsert({ user_id: userId, influencer_id: influencerId }, { onConflict: "user_id,influencer_id" });
    if (error) throw new Error(error.message);
  }

  async unfollow(userId: string, influencerId: string): Promise<void> {
    const { error } = await supabaseService
      .from("follows").delete().eq("user_id", userId).eq("influencer_id", influencerId);
    if (error) throw new Error(error.message);
  }

  async getWatchlist(userId: string): Promise<string[]> {
    const { data, error } = await supabaseService
      .from("watchlist").select("restaurant_id").eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: { restaurant_id: string }) => r.restaurant_id);
  }

  async addToWatchlist(userId: string, restaurantId: string): Promise<void> {
    const { error } = await supabaseService
      .from("watchlist")
      .upsert({ user_id: userId, restaurant_id: restaurantId }, { onConflict: "user_id,restaurant_id" });
    if (error) throw new Error(error.message);
  }

  async removeFromWatchlist(userId: string, restaurantId: string): Promise<void> {
    const { error } = await supabaseService
      .from("watchlist").delete().eq("user_id", userId).eq("restaurant_id", restaurantId);
    if (error) throw new Error(error.message);
  }

  async registerPushToken(userId: string, token: string, platform: "ios" | "android"): Promise<void> {
    const { error } = await supabaseService
      .from("notification_preferences")
      .upsert({ user_id: userId, push_token: token, platform }, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
  }

  #mapRow(row: Record<string, unknown>): User {
    const prefs = (row.preferences ?? {}) as User["preferences"];
    return {
      id: row.id as string,
      role: row.role as User["role"],
      displayName: (row.display_name as string) ?? "",
      avatarUrl: row.avatar_url as string | null,
      phoneNumber: row.phone_number as string | null,
      preferences: {
        experiences: prefs.experiences ?? [],
        dietaryConstraints: prefs.dietaryConstraints ?? [],
        notificationsEnabled: prefs.notificationsEnabled ?? {
          newVideo: true,
          newGuide: true,
          importComplete: true,
        },
      },
      createdAt: row.created_at as string,
    };
  }
}
