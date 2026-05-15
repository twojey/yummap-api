import { Router } from "../../deps.ts";
import { supabaseService } from "../../config.ts";
import type { AppContainer } from "../boot/container.ts";

// Un user dont on n'a pas eu de signe de vie (heartbeat) depuis N jours n'est
// plus compté comme follower. Détecte les désinstallations sans suppression
// de compte explicite. 60j = compromis standard apps sociales.
const FOLLOWER_ACTIVE_WINDOW_DAYS = 60;

// Routes publiques sur les influenceurs (consommées par l'app mobile)
export function registerInfluencerRoutes(router: Router, _container: AppContainer) {
  // GET /influencers/onboarding?categories=Gastro,Bar
  // Retourne les influenceurs validés pour la sélection en onboarding.
  // Filtre+boost ceux dont creator_categories matche les expériences choisies.
  router.get("/influencers/onboarding", async (ctx) => {
    const userId = ctx.request.headers.get("X-User-Id");
    const rawCategories = ctx.request.url.searchParams.get("categories") ?? "";
    const wantedCategories = rawCategories
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);

    const { data: users, error } = await supabaseService
      .from("users")
      .select("id, display_name, avatar_url, creator_categories")
      .eq("role", "influencer")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const ids = (users ?? []).map((u: { id: string }) => u.id);
    if (ids.length === 0) {
      ctx.response.body = [];
      return;
    }

    // Agrégats : nb de guides, nb de followers actifs, follow status pour cet user
    const [guideCounts, followCounts, followedByMe] = await Promise.all([
      countByForeignKey("guides", "influencer_id", ids),
      countActiveFollowers(ids, FOLLOWER_ACTIVE_WINDOW_DAYS),
      userId
        ? supabaseService.from("follows").select("influencer_id").eq("user_id", userId).in("influencer_id", ids)
        : Promise.resolve({ data: [] as Array<{ influencer_id: string }> }),
    ]);
    const followedSet = new Set(
      ((followedByMe.data ?? []) as Array<{ influencer_id: string }>).map((r) => r.influencer_id),
    );

    const items = (users ?? []).map((u: { id: string; display_name: string | null; avatar_url: string | null; creator_categories: string[] | null }) => {
      const cats = (u.creator_categories ?? []).map((c: string) => c.toLowerCase());
      // Score : nb d'intersections avec les expériences souhaitées.
      // À score égal, on retombe sur le tri "follower count desc".
      const matchScore = wantedCategories.length === 0
        ? 0
        : wantedCategories.filter((w) => cats.includes(w)).length;
      return {
        id: u.id,
        displayName: u.display_name ?? "",
        avatarUrl: u.avatar_url,
        bio: null,
        categories: cats,
        guideCount: guideCounts.get(u.id) ?? 0,
        followerCount: followCounts.get(u.id) ?? 0,
        isFollowed: followedSet.has(u.id),
        _matchScore: matchScore,
      };
    });
    // Tri : meilleur match d'abord, puis plus de followers
    items.sort((a, b) => {
      if (a._matchScore !== b._matchScore) return b._matchScore - a._matchScore;
      return b.followerCount - a.followerCount;
    });
    // deno-lint-ignore no-explicit-any
    ctx.response.body = items.map(({ _matchScore: _, ...rest }: any) => rest);
  });

  // GET /influencers/:id/suggestions — 5 influenceurs avec catégories similaires
  router.get("/influencers/:id/suggestions", async (ctx) => {
    const { data: source } = await supabaseService
      .from("users")
      .select("creator_categories")
      .eq("id", ctx.params.id)
      .single();
    const cats = ((source?.creator_categories ?? []) as string[]).map((c) => c.toLowerCase());

    const { data: others } = await supabaseService
      .from("users")
      .select("id, display_name, avatar_url, creator_categories")
      .eq("role", "influencer")
      .neq("id", ctx.params.id);

    const scored = ((others ?? []) as Array<{ id: string; display_name: string | null; avatar_url: string | null; creator_categories: string[] | null }>)
      .map((u) => {
        const uCats = (u.creator_categories ?? []).map((c) => c.toLowerCase());
        const score = cats.filter((c) => uCats.includes(c)).length;
        return { ...u, _score: score };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 5);

    // deno-lint-ignore no-explicit-any
    ctx.response.body = scored.map((u: any) => ({
      id: u.id,
      displayName: u.display_name ?? "",
      avatarUrl: u.avatar_url,
      bio: null,
      categories: (u.creator_categories ?? []),
      guideCount: 0,
      followerCount: 0,
      isFollowed: false,
    }));
  });

  // GET /influencers/:id/followers — liste des users qui suivent cet influencer
  router.get("/influencers/:id/followers", async (ctx) => {
    const { data, error } = await supabaseService
      .from("follows")
      .select("users!user_id(id, display_name, avatar_url)")
      .eq("influencer_id", ctx.params.id);
    if (error) throw new Error(error.message);
    // deno-lint-ignore no-explicit-any
    ctx.response.body = (data ?? []).map((row: any) => ({
      id: row.users?.id,
      displayName: row.users?.display_name ?? "",
      avatarUrl: row.users?.avatar_url,
    })).filter((u: { id?: string }) => u.id);
  });

  // GET /influencers/:id/guides — liste des guides d'un influencer (pour onboarding)
  // isDefault est exposé pour permettre à l'app de pin auto le guide principal
  // au moment du follow (sinon l'utilisateur doit visiter le profil + cliquer
  // "Sur ma carte" pour voir le moindre effet de son follow).
  router.get("/influencers/:id/guides", async (ctx) => {
    const { data, error } = await supabaseService
      .from("guides")
      .select("id, influencer_id, title, description, cover_image_url, restaurant_count, is_default, users:influencer_id(display_name)")
      .eq("influencer_id", ctx.params.id)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    // deno-lint-ignore no-explicit-any
    ctx.response.body = (data ?? []).map((g: any) => ({
      id: g.id,
      influencerId: g.influencer_id,
      influencerName: g.users?.display_name ?? "",
      title: g.title,
      description: g.description,
      coverImageUrl: g.cover_image_url,
      restaurantCount: g.restaurant_count,
      isDefault: g.is_default ?? false,
    }));
  });

  // GET /influencers/:id/videos?page=&pageSize= — vidéos publiées par l'influenceur
  // Tri created_at DESC (plus récent d'abord, comme l'onglet vidéos d'un profil
  // TikTok). Pagination simple par offset (pas de cursor : la liste est petite et
  // on ré-affiche la grille complète à chaque pull-to-refresh).
  router.get("/influencers/:id/videos", async (ctx) => {
    const params = ctx.request.url.searchParams;
    const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
    const pageSize = Math.min(50, Math.max(1, parseInt(params.get("pageSize") ?? "20", 10) || 20));
    const from = page * pageSize;
    const to = from + pageSize - 1;

    // Les vidéos d'un uploader avec leur resto principal (position 0 dans
    // video_restaurants). !inner exclut les vidéos sans aucun resto lié
    // (= vidéos en review pas encore corrigées par le créateur).
    const { data, error } = await supabaseService
      .from("videos")
      .select(
        "id, stream_url, subtitles_url, created_at, video_restaurants!inner(position, restaurants!inner(id, place_id, name))",
      )
      .eq("uploader_id", ctx.params.id)
      .eq("video_restaurants.position", 0)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);

    // deno-lint-ignore no-explicit-any
    ctx.response.body = (data ?? []).map((v: any) => {
      const link = (v.video_restaurants ?? [])[0];
      const r = link?.restaurants;
      return {
        id: v.id,
        // Pas de thumbnailUrl séparé en base : on prend la stream_url comme
        // poster (le player extrait la frame 0). Côté app la grille initialise
        // le video_player en pause pour afficher cette frame.
        thumbnailUrl: v.stream_url,
        videoUrl: v.stream_url,
        vttUrl: v.subtitles_url,
        restaurantId: r?.id,
        restaurantPlaceId: r?.place_id,
        restaurantName: r?.name ?? "",
        createdAt: v.created_at,
      };
    }).filter((v: { restaurantPlaceId?: string }) => v.restaurantPlaceId);
  });

  // GET /influencers/:id?userId=... (détail d'un influencer)
  router.get("/influencers/:id", async (ctx) => {
    const { data: user, error } = await supabaseService
      .from("users")
      .select("id, display_name, avatar_url")
      .eq("id", ctx.params.id)
      .eq("role", "influencer")
      .single();
    if (error || !user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "NOT_FOUND" };
      return;
    }
    const requesterId = ctx.request.url.searchParams.get("userId");
    const [guideCounts, followCounts, followedByMe] = await Promise.all([
      countByForeignKey("guides", "influencer_id", [user.id]),
      countActiveFollowers([user.id], FOLLOWER_ACTIVE_WINDOW_DAYS),
      requesterId
        ? supabaseService.from("follows").select("influencer_id").eq("user_id", requesterId).eq("influencer_id", user.id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    ctx.response.body = {
      id: user.id,
      displayName: user.display_name ?? "",
      avatarUrl: user.avatar_url,
      bio: null,
      categories: [] as string[],
      guideCount: guideCounts.get(user.id) ?? 0,
      followerCount: followCounts.get(user.id) ?? 0,
      isFollowed: followedByMe.data !== null,
    };
  });
}

// Helper : compte par foreign key dans une table donnée, pour plusieurs IDs
async function countByForeignKey(
  table: string,
  column: string,
  ids: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const { data } = await supabaseService.from(table).select(column).in(column, ids);
  for (const row of (data ?? []) as Array<Record<string, string>>) {
    const key = row[column];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Compte les followers actifs (last_active_at > NOW() - activeWindowDays).
// On JOIN follows × users via le foreign key supabase et on filtre côté SQL —
// l'agrégation par influencer_id se fait en JS (PostgREST ne fait pas de GROUP BY).
async function countActiveFollowers(
  influencerIds: string[],
  activeWindowDays: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (influencerIds.length === 0) return counts;
  const cutoff = new Date(Date.now() - activeWindowDays * 24 * 3600 * 1000).toISOString();
  // !inner force un INNER JOIN. La table follows a 2 FK vers users (user_id et
  // influencer_id) donc on précise !user_id pour lever l'ambiguïté PostgREST.
  const { data, error } = await supabaseService
    .from("follows")
    .select("influencer_id, users!user_id!inner(last_active_at)")
    .in("influencer_id", influencerIds)
    .gte("users.last_active_at", cutoff);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{ influencer_id: string }>) {
    counts.set(row.influencer_id, (counts.get(row.influencer_id) ?? 0) + 1);
  }
  return counts;
}
