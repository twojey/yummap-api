import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Corrige la logique de filtrage par tags dans get_map_pins :
//
// AVANT : OR global sur tous les tag_ids. Sélectionner "italienne" + "vegan"
// renvoyait l'union (restos italiens UNION restos vegan), ce qui n'est pas
// ce que l'utilisateur veut quand il combine des catégories différentes.
//
// MAINTENANT :
//   - OR à l'intérieur d'une catégorie ("italienne OU japonaise" → restos
//     qui sont italiens OU japonais)
//   - AND entre catégories ("cuisine=italienne ET regime=vegan" → restos
//     italiens ET vegan)
//
// Implémentation : pour chaque catégorie représentée dans p_tag_ids, le
// resto doit posséder au moins un tag de cette catégorie figurant dans
// p_tag_ids. Exprimé via NOT EXISTS sur "il existe une catégorie filtrée
// pour laquelle le resto n'a aucun tag matchant".
//
// Aucun changement de signature : le frontend continue à envoyer un seul
// tableau plat p_tag_ids. La RPC re-groupe par catégorie à la volée.
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      DROP FUNCTION IF EXISTS get_map_pins(double precision, double precision, double precision, double precision, uuid[], uuid[], boolean, numeric, uuid);

      CREATE OR REPLACE FUNCTION get_map_pins(
        sw_lng double precision,
        sw_lat double precision,
        ne_lng double precision,
        ne_lat double precision,
        p_guide_ids uuid[] DEFAULT NULL,
        p_tag_ids uuid[] DEFAULT NULL,
        p_open_now boolean DEFAULT NULL,
        p_min_rating numeric DEFAULT NULL,
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
          AND (p_min_rating IS NULL OR r.google_rating >= p_min_rating);
      END;
      $function$;
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      DROP FUNCTION IF EXISTS get_map_pins(double precision, double precision, double precision, double precision, uuid[], uuid[], boolean, numeric, uuid);
    `);
  }
}
