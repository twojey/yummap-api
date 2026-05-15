import { supabaseService } from "../../../config.ts";
import type {
  FingerprintCriteria,
  HeuristicCriteria,
} from "../../domain/video/cross-platform-dedup.ts";
import type {
  AddContributorInput,
  IVideoDedupRepository,
  VideoDedupMatch,
} from "../../domain/video/video-dedup.repository.ts";

/// Implémentation Supabase de la dédup cross-plateforme.
///
/// Stratégie de requête : on filtre d'abord sur `video_restaurants` (un des
/// restos détectés) pour réduire l'espace de recherche, puis on intersecte
/// avec les critères de fingerprint OU d'heuristique. Cela évite de scanner
/// toute la table `videos`.
export class SupabaseVideoDedupRepository implements IVideoDedupRepository {
  async findByFingerprint(
    criteria: FingerprintCriteria,
  ): Promise<VideoDedupMatch | null> {
    if (criteria.restaurantIds.length === 0) return null;

    // SELECT v.* FROM videos v
    // JOIN video_restaurants vr ON vr.video_id = v.id
    // WHERE v.content_fingerprint = $1
    //   AND vr.restaurant_id = ANY($2)
    //   AND COALESCE(v.posted_at, v.created_at) >= $3
    // LIMIT 1
    const { data, error } = await supabaseService
      .from("videos")
      .select("id, uploader_id, video_restaurants!inner(restaurant_id, position)")
      .eq("content_fingerprint", criteria.fingerprint)
      .in("video_restaurants.restaurant_id", criteria.restaurantIds)
      .gte("posted_at", criteria.postedAtMin.toISOString())
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return this.#toMatch(data);
  }

  async findByHeuristic(
    criteria: HeuristicCriteria,
  ): Promise<VideoDedupMatch | null> {
    if (criteria.restaurantIds.length === 0) return null;

    const { data, error } = await supabaseService
      .from("videos")
      .select("id, uploader_id, video_restaurants!inner(restaurant_id, position)")
      .eq("uploader_id", criteria.uploaderId)
      .in("video_restaurants.restaurant_id", criteria.restaurantIds)
      .gte("posted_at", criteria.postedAtMin.toISOString())
      .lte("posted_at", criteria.postedAtMax.toISOString())
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return this.#toMatch(data);
  }

  async addContributor(input: AddContributorInput): Promise<void> {
    // ON CONFLICT DO NOTHING : un user ne peut être contributor que 1 fois
    // par vidéo (PK composite (video_id, user_id)).
    const { error } = await supabaseService.from("video_contributors").upsert(
      {
        video_id: input.videoId,
        user_id: input.userId,
        source_url: input.sourceUrl,
        platform: input.platform,
        external_post_id: input.externalPostId,
      },
      { onConflict: "video_id,user_id", ignoreDuplicates: true },
    );
    if (error) {
      console.warn(`[Dedup] addContributor failed: ${error.message}`);
    }
  }

  #toMatch(row: {
    id: string;
    uploader_id: string;
    video_restaurants: Array<{ restaurant_id: string; position: number }>;
  }): VideoDedupMatch {
    const sorted = [...row.video_restaurants].sort(
      (a, b) => a.position - b.position,
    );
    return {
      videoId: row.id,
      restaurantIds: sorted.map((r) => r.restaurant_id),
      originalUploaderId: row.uploader_id,
    };
  }
}
