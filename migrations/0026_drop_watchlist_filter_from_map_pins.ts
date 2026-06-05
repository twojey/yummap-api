import { supabaseService } from "../config.ts";

// Retire le paramètre `p_in_watchlist_only` de get_map_pins.
//
// Contexte : la watchlist (favoris) est local-first — elle vit côté app dans
// SharedPreferences (indexée par placeId Google) et le backend n'en a aucune
// notion. L'app filtre la watchlist localement (MapNotifier._applyLocalFilters)
// et n'a jamais transmis `inWatchlistOnly` à l'API (HttpMapRepository le drop).
// Le filtre serveur `p_in_watchlist_only` était donc du code mort.
//
// On garde la colonne de sortie `is_in_watchlist` (inoffensive) pour ne pas
// toucher au modèle Pin côté API/app — elle vaut désormais toujours false
// puisque plus rien n'alimente la table `watchlist`.
//
// ⚠️ ORDRE DE DÉPLOIEMENT : déployer d'abord l'API (qui n'envoie plus
// `p_in_watchlist_only`), PUIS lancer cette migration. Une API à 10 params
// fonctionne avec l'ancienne fonction (param DEFAULT NULL) ET la nouvelle ;
// l'inverse (ancienne API à 11 params + nouvelle fonction) casserait /map/pins.

export async function up() {
  const { error } = await supabaseService.rpc("exec_sql", {
    sql: `
-- Changer la liste de params crée une surcharge au lieu de remplacer : on DROP
-- explicitement l'ancienne signature (11 params, avec p_in_watchlist_only).
DROP FUNCTION IF EXISTS get_map_pins(
  double precision, double precision, double precision, double precision,
  uuid[], uuid[], boolean, numeric, numeric, boolean, uuid
);

CREATE OR REPLACE FUNCTION get_map_pins(
  sw_lng double precision,
  sw_lat double precision,
  ne_lng double precision,
  ne_lat double precision,
  p_guide_ids uuid[] DEFAULT NULL,
  p_tag_ids uuid[] DEFAULT NULL,
  p_open_now boolean DEFAULT NULL,
  p_min_rating numeric DEFAULT NULL,
  p_max_rating numeric DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  restaurant_id uuid, place_id text, name text,
  lat double precision, lng double precision,
  cuisine_type text, open_now boolean, google_rating numeric,
  has_videos boolean, is_in_watchlist boolean, guide_ids uuid[]
)
LANGUAGE plpgsql AS $function$
DECLARE
  now_paris TIMESTAMP := (NOW() AT TIME ZONE 'Europe/Paris');
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    r.place_id,
    r.name,
    ST_Y(r.location::geometry)::FLOAT AS lat,
    ST_X(r.location::geometry)::FLOAT AS lng,
    COALESCE(
      (SELECT t.slug FROM restaurant_tags rt
        JOIN tags t ON t.id = rt.tag_id
        JOIN tag_categories tc ON tc.id = t.category_id
        WHERE rt.restaurant_id = r.id AND tc.slug = 'cuisine' AND t.slug <> 'francaise'
        LIMIT 1),
      (SELECT t.slug FROM restaurant_tags rt
        JOIN tags t ON t.id = rt.tag_id
        JOIN tag_categories tc ON tc.id = t.category_id
        WHERE rt.restaurant_id = r.id AND tc.slug = 'type_lieu' AND t.slug <> 'restaurant'
        LIMIT 1),
      (SELECT t.slug FROM restaurant_tags rt
        JOIN tags t ON t.id = rt.tag_id
        JOIN tag_categories tc ON tc.id = t.category_id
        WHERE rt.restaurant_id = r.id AND tc.slug = 'cuisine' AND t.slug = 'francaise'
        LIMIT 1),
      (SELECT t.slug FROM restaurant_tags rt
        JOIN tags t ON t.id = rt.tag_id
        JOIN tag_categories tc ON tc.id = t.category_id
        WHERE rt.restaurant_id = r.id AND tc.slug = 'type_lieu'
        LIMIT 1)
    ) AS cuisine_type,
    COALESCE(compute_open_now(r.opening_hours, now_paris), r.open_now) AS open_now,
    r.google_rating,
    EXISTS(SELECT 1 FROM video_restaurants vr WHERE vr.restaurant_id = r.id) AS has_videos,
    CASE WHEN p_user_id IS NOT NULL THEN
      EXISTS(SELECT 1 FROM watchlist w WHERE w.user_id = p_user_id AND w.restaurant_id = r.id)
    ELSE FALSE END AS is_in_watchlist,
    ARRAY(SELECT gr.guide_id FROM guide_restaurants gr WHERE gr.restaurant_id = r.id) AS guide_ids
  FROM restaurants r
  WHERE
    ST_Within(r.location::geometry, ST_MakeEnvelope(sw_lng, sw_lat, ne_lng, ne_lat, 4326))
    AND (p_guide_ids IS NULL OR EXISTS(
      SELECT 1 FROM guide_restaurants gr WHERE gr.restaurant_id = r.id AND gr.guide_id = ANY(p_guide_ids)
    ))
    AND (p_tag_ids IS NULL OR NOT EXISTS (
      SELECT 1
      FROM (SELECT DISTINCT category_id FROM tags WHERE id = ANY(p_tag_ids)) AS filter_cats
      WHERE NOT EXISTS (
        SELECT 1 FROM restaurant_tags rt
        JOIN tags t ON t.id = rt.tag_id
        WHERE rt.restaurant_id = r.id
          AND t.category_id = filter_cats.category_id
          AND t.id = ANY(p_tag_ids)
      )
    ))
    AND (p_open_now IS NULL OR
         COALESCE(compute_open_now(r.opening_hours, now_paris), r.open_now) = p_open_now)
    AND (p_min_rating IS NULL OR r.google_rating >= p_min_rating)
    AND (p_max_rating IS NULL OR r.google_rating <= p_max_rating);
END;
$function$;
`,
  });
  if (error) throw new Error(`Migration 0026 failed: ${error.message}`);
  console.log("Migration 0026: p_in_watchlist_only retiré de get_map_pins");
}

// Rollback (si besoin) : recréer la fonction avec le paramètre + le filtre.
// DROP FUNCTION IF EXISTS get_map_pins(double precision, double precision,
//   double precision, double precision, uuid[], uuid[], boolean, numeric,
//   numeric, uuid);
// puis CREATE OR REPLACE ... avec, en plus :
//   p_in_watchlist_only boolean DEFAULT NULL  (dans la signature, avant p_user_id)
//   AND ( p_in_watchlist_only IS NOT TRUE
//         OR (p_user_id IS NOT NULL
//             AND EXISTS(SELECT 1 FROM watchlist w
//                        WHERE w.user_id = p_user_id AND w.restaurant_id = r.id)) )
//   (dernière clause du WHERE)
