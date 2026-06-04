import { supabaseService } from "../../../config.ts";
import type { InfluencerLookupPort } from "../../application/influencer/resolve-influencer.ts";

/// Implémentation Supabase du port de résolution d'influenceur.
/// Même politique que BulkProfileImportUsecase (match par display_name,
/// création avec avatar DiceBear, guide par défaut idempotent).
export class SupabaseInfluencerResolver implements InfluencerLookupPort {
  async findInfluencerByHandle(handle: string): Promise<string | null> {
    const { data } = await supabaseService
      .from("users")
      .select("id")
      .eq("role", "influencer")
      .eq("display_name", handle)
      .maybeSingle();
    return data?.id ?? null;
  }

  async createInfluencer(handle: string): Promise<string> {
    const avatarUrl = `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(handle)}`;
    const { data, error } = await supabaseService
      .from("users")
      .insert({ role: "influencer", display_name: handle, avatar_url: avatarUrl })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to create influencer '${handle}': ${error.message}`);
    return data.id;
  }

  async ensureDefaultGuide(influencerId: string, handle: string): Promise<void> {
    const { error } = await supabaseService.from("guides").insert({
      influencer_id: influencerId,
      title: `Guide de @${handle}`,
      description: `Les restos partagés par @${handle}`,
      is_default: true,
    });
    // UNIQUE partial index sur (influencer_id) where is_default → duplicate
    // attendu si le guide existe déjà. On l'ignore.
    if (error && !error.message.includes("duplicate")) {
      console.warn(`[InfluencerResolver] ensureDefaultGuide failed: ${error.message}`);
    }
  }
}
