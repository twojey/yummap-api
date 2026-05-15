import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Calcul live de "ouvert maintenant" pour les pins de la map.
// - compute_open_now(hours, now_local) : fonction réutilisable qui croise les
//   opening_hours stockés (format Google Places JSONB) avec une heure locale.
//   Gère plages normales, plages qui passent minuit, et le débordement de la
//   veille (1h du mat samedi → on regarde la période vendredi 19h-3h).
// - get_map_pins : remplace `r.open_now` (snapshot figé à l'import) par
//   COALESCE(compute_open_now(...), r.open_now). Idem dans le filtre p_open_now
//   pour que "ouvert maintenant" côté pin et côté filtre soient cohérents.
//
// Heure de référence : Europe/Paris. Acceptable car le serveur DB est aussi
// en Europe et la totalité de l'app cible Paris pour le moment. Si on déploie
// internationalement, prendre la TZ du resto au lieu de la TZ serveur.
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      CREATE OR REPLACE FUNCTION compute_open_now(hours JSONB, now_local TIMESTAMP)
      RETURNS BOOLEAN AS $$
      DECLARE
        google_day INT;
        yesterday_day INT;
        now_min INT;
        period JSONB;
        open_min INT;
        close_min INT;
      BEGIN
        IF hours IS NULL OR jsonb_typeof(hours->'periods') != 'array' THEN
          RETURN NULL;
        END IF;

        google_day := EXTRACT(DOW FROM now_local)::INT;
        yesterday_day := (google_day + 6) % 7;
        now_min := EXTRACT(HOUR FROM now_local)::INT * 60
                 + EXTRACT(MINUTE FROM now_local)::INT;

        FOR period IN SELECT * FROM jsonb_array_elements(hours->'periods') LOOP
          IF (period->'open'->>'day')::INT IS DISTINCT FROM google_day THEN
            CONTINUE;
          END IF;
          BEGIN
            open_min  := SUBSTRING(period->'open'->>'time'  FROM 1 FOR 2)::INT * 60
                       + SUBSTRING(period->'open'->>'time'  FROM 3 FOR 2)::INT;
            close_min := SUBSTRING(period->'close'->>'time' FROM 1 FOR 2)::INT * 60
                       + SUBSTRING(period->'close'->>'time' FROM 3 FOR 2)::INT;
          EXCEPTION WHEN others THEN
            CONTINUE;
          END;

          IF close_min > open_min THEN
            IF now_min >= open_min AND now_min < close_min THEN
              RETURN TRUE;
            END IF;
          ELSE
            IF now_min >= open_min THEN
              RETURN TRUE;
            END IF;
          END IF;
        END LOOP;

        FOR period IN SELECT * FROM jsonb_array_elements(hours->'periods') LOOP
          IF (period->'open'->>'day')::INT IS DISTINCT FROM yesterday_day THEN
            CONTINUE;
          END IF;
          BEGIN
            open_min  := SUBSTRING(period->'open'->>'time'  FROM 1 FOR 2)::INT * 60
                       + SUBSTRING(period->'open'->>'time'  FROM 3 FOR 2)::INT;
            close_min := SUBSTRING(period->'close'->>'time' FROM 1 FOR 2)::INT * 60
                       + SUBSTRING(period->'close'->>'time' FROM 3 FOR 2)::INT;
          EXCEPTION WHEN others THEN
            CONTINUE;
          END;

          IF close_min <= open_min AND now_min < close_min THEN
            RETURN TRUE;
          END IF;
        END LOOP;

        RETURN FALSE;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;

      CREATE OR REPLACE FUNCTION public.get_map_pins(
        sw_lng double precision, sw_lat double precision,
        ne_lng double precision, ne_lat double precision,
        p_guide_ids uuid[] DEFAULT NULL::uuid[],
        p_tag_ids uuid[] DEFAULT NULL::uuid[],
        p_open_now boolean DEFAULT NULL::boolean,
        p_min_rating numeric DEFAULT NULL::numeric,
        p_user_id uuid DEFAULT NULL::uuid
      )
      RETURNS TABLE(
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
          (SELECT t.name FROM restaurant_tags rt JOIN tags t ON t.id = rt.tag_id
           JOIN tag_categories tc ON tc.id = t.category_id
           WHERE rt.restaurant_id = r.id AND tc.name = 'cuisine' LIMIT 1) AS cuisine_type,
          COALESCE(compute_open_now(r.opening_hours, now_paris), r.open_now) AS open_now,
          r.google_rating,
          EXISTS(SELECT 1 FROM videos v WHERE v.restaurant_id = r.id) AS has_videos,
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
          AND (p_tag_ids IS NULL OR EXISTS(
            SELECT 1 FROM restaurant_tags rt WHERE rt.restaurant_id = r.id AND rt.tag_id = ANY(p_tag_ids)
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
      DROP FUNCTION IF EXISTS compute_open_now(JSONB, TIMESTAMP);
    `);
  }
}
