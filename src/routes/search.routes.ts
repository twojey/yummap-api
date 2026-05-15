import { Router } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { supabaseService } from "../../config.ts";

// GET /search?q=...
//
// Recherche unifiée restaurants + influenceurs pour la barre de recherche app.
// Avant cette route, l'app appelait /search qui n'existait pas (404 silencieux).
//
// Format de réponse — liste plate compatible avec SearchResult côté app :
// [
//   { id, type: "restaurant"|"influencer", name, subtitle?, imageUrl? },
//   ...
// ]
//
// On limite à 10 par type pour garder le sheet utilisable. L'ordre privilégie les
// restaurants en premier (90% des intentions de recherche), influenceurs ensuite.
export function registerSearchRoutes(router: Router) {
  router.get("/search", guestOrAuth, async (ctx) => {
    const q = ctx.request.url.searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) {
      ctx.response.body = [];
      return;
    }

    const [restaurants, influencers] = await Promise.all([
      searchRestaurants(q),
      searchInfluencers(q),
    ]);

    ctx.response.body = [...restaurants, ...influencers];
  });
}

async function searchRestaurants(q: string): Promise<unknown[]> {
  // ILIKE plutôt que to_tsvector ici parce que les noms de restos sont souvent
  // courts/propriétaires (un seul mot, "marque déposée") où le full-text rate
  // les sous-chaînes. ILIKE %q% indexable via pg_trgm au besoin.
  const { data, error } = await supabaseService
    .from("restaurants")
    .select("id, place_id, name, address, cover_image_url")
    .or(`name.ilike.%${q}%,address.ilike.%${q}%`)
    .limit(10);
  if (error) {
    console.warn(`[search] restaurants failed: ${error.message}`);
    return [];
  }
  const rows = (data ?? []) as Array<{
    id: string;
    place_id: string;
    name: string;
    address: string;
    cover_image_url: string | null;
  }>;

  // Coords via RPC existante (location est en GEOGRAPHY binaire — non lisible
  // directement via PostgREST select). N appels en parallèle, OK pour <= 10
  // résultats. Si le coût devient un sujet, créer une RPC batch dédiée.
  const coords = await Promise.all(
    rows.map(async (r) => {
      try {
        const { data } = await supabaseService
          .rpc("get_restaurant_lat_lng", { p_restaurant_id: r.id });
        // deno-lint-ignore no-explicit-any
        const row = (data as any[] | null)?.[0];
        return {
          id: r.id,
          lat: row?.lat as number | undefined,
          lng: row?.lng as number | undefined,
        };
      } catch (_) {
        return { id: r.id, lat: undefined as number | undefined, lng: undefined as number | undefined };
      }
    }),
  );
  const coordsById = new Map(coords.map((c) => [c.id, { lat: c.lat, lng: c.lng }]));

  return rows.map((r) => {
    const c = coordsById.get(r.id);
    return {
      id: r.place_id,                // l'app utilise placeId pour les routes restaurant/:id
      type: "restaurant",
      name: r.name,
      subtitle: r.address,
      imageUrl: r.cover_image_url,
      // lat/lng utilisés par l'app pour centrer la carte au tap d'un résultat
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
    };
  });
}

async function searchInfluencers(q: string): Promise<unknown[]> {
  // Pas de table `influencers` séparée : un influenceur est un `users` avec
  // role='influencer' (cf. influencers.routes.ts qui suit la même convention).
  // L'ancien select sur `influencers` faisait planter la route en boucle.
  // Pas de colonne `bio` non plus en base — on omet le subtitle.
  const { data, error } = await supabaseService
    .from("users")
    .select("id, display_name, avatar_url")
    .eq("role", "influencer")
    .ilike("display_name", `%${q}%`)
    .limit(10);
  if (error) {
    console.warn(`[search] influencers failed: ${error.message}`);
    return [];
  }
  return ((data ?? []) as Array<{
    id: string;
    display_name: string | null;
    avatar_url: string | null;
  }>).map((i) => ({
    id: i.id,
    type: "influencer",
    name: i.display_name ?? "",
    subtitle: null,
    imageUrl: i.avatar_url,
  }));
}
