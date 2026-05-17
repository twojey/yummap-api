import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Consolide la taxonomie des tags pour rendre les pins de la carte lisibles.
//
// Problème : avant cette migration, la catégorie `cuisine` mélangeait origine
// culinaire (italienne, japonaise…) et régime (vegan, végétarienne…). Comme
// `vegan` était dominant (43/128 usages), la majorité des pins sortaient en
// emoji "salade" — l'icône ne reflétait pas le type de cuisine du lieu.
//
// Solution : taxonomie fermée (whitelist) en 7 catégories, chaque tag a un
// slug stable ASCII servant d'identifiant indépendant de la langue.
//   - cuisine        : origine (françoise, italienne, japonaise, …)
//   - type_lieu      : type d'établissement (café, boulangerie, pizzeria, …)
//   - regime         : NOUVEAU — végétarien, vegan, options végé, halal, …
//   - prix           : € / €€ / €€€ / €€€€ uniquement
//   - moment         : petit-déj, brunch, déjeuner, goûter, dîner, tard le soir
//   - ambiance       : cosy, calme, animé, romantique, familial, élégant, …
//   - particularite  : étoilé, bib gourmand, terrasse, vue, à emporter, …
//
// La RPC get_map_pins renvoie désormais un slug (cuisine étrangère →
// type_lieu distinctif → française → restaurant générique → NULL) que le
// frontend mappe à un emoji.
//
// Rollback : on garde une colonne `legacy_name` snapshot du `name` avant
// migration, qui permettrait de reconstituer les tags d'origine si besoin.
// Les restaurant_tags supprimés (DROP des tags hors whitelist) sont en
// revanche perdus — ils étaient soit non sémantiques soit one-shot.
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      -- 1) Colonnes pour slug stable + snapshot rollback
      ALTER TABLE tags ADD COLUMN IF NOT EXISTS legacy_name TEXT;
      ALTER TABLE tags ADD COLUMN IF NOT EXISTS slug TEXT;
      UPDATE tags SET legacy_name = name WHERE legacy_name IS NULL;

      -- 2) Restructuration des catégories
      UPDATE tag_categories SET slug = 'type_lieu', name = 'type de lieu' WHERE slug = 'type';
      UPDATE tag_categories SET sort_order = 0 WHERE slug = 'cuisine';
      UPDATE tag_categories SET sort_order = 1 WHERE slug = 'type_lieu';
      UPDATE tag_categories SET sort_order = 3 WHERE slug = 'prix';
      UPDATE tag_categories SET sort_order = 4 WHERE slug = 'moment';
      UPDATE tag_categories SET sort_order = 5 WHERE slug = 'ambiance';
      UPDATE tag_categories SET sort_order = 6 WHERE slug = 'particularite';
      INSERT INTO tag_categories (slug, name, is_required, sort_order)
      VALUES ('regime', 'régime alimentaire', false, 2)
      ON CONFLICT (slug) DO NOTHING;

      -- 3) Insertion / fixation des tags canoniques par catégorie
      WITH cat AS (SELECT id FROM tag_categories WHERE slug = 'cuisine')
      INSERT INTO tags (category_id, name, slug)
      SELECT cat.id, v.name, v.slug FROM cat, (VALUES
        ('française', 'francaise'),('italienne', 'italienne'),('japonaise', 'japonaise'),
        ('coréenne', 'coreenne'),('chinoise', 'chinoise'),('vietnamienne', 'vietnamienne'),
        ('thaï', 'thai'),('indienne', 'indienne'),('libanaise', 'libanaise'),
        ('méditerranéenne', 'mediterraneenne'),('mexicaine', 'mexicaine'),
        ('péruvienne', 'peruvienne'),('africaine', 'africaine'),
        ('américaine', 'americaine'),('espagnole', 'espagnole'),('brésilienne', 'bresilienne')
      ) AS v(name, slug)
      ON CONFLICT (category_id, name) DO UPDATE SET slug = EXCLUDED.slug;

      WITH cat AS (SELECT id FROM tag_categories WHERE slug = 'type_lieu')
      INSERT INTO tags (category_id, name, slug)
      SELECT cat.id, v.name, v.slug FROM cat, (VALUES
        ('restaurant', 'restaurant'),('bistrot', 'bistrot'),('brasserie', 'brasserie'),
        ('gastronomique', 'gastronomique'),('pizzeria', 'pizzeria'),('café', 'cafe'),
        ('boulangerie', 'boulangerie'),('pâtisserie', 'patisserie'),
        ('bar à vin', 'bar_a_vin'),('bar à cocktails', 'bar_a_cocktails'),
        ('street food', 'street_food'),('crêperie', 'creperie'),('burger', 'burger'),
        ('sandwicherie', 'sandwicherie'),('glacier', 'glacier'),('kebab', 'kebab')
      ) AS v(name, slug)
      ON CONFLICT (category_id, name) DO UPDATE SET slug = EXCLUDED.slug;

      WITH cat AS (SELECT id FROM tag_categories WHERE slug = 'regime')
      INSERT INTO tags (category_id, name, slug)
      SELECT cat.id, v.name, v.slug FROM cat, (VALUES
        ('végétarien', 'vegetarien'),('vegan', 'vegan'),('options végé', 'options_vege'),
        ('sans gluten', 'sans_gluten'),('halal', 'halal'),('casher', 'casher')
      ) AS v(name, slug)
      ON CONFLICT (category_id, name) DO UPDATE SET slug = EXCLUDED.slug;

      WITH cat AS (SELECT id FROM tag_categories WHERE slug = 'prix')
      INSERT INTO tags (category_id, name, slug)
      SELECT cat.id, v.name, v.slug FROM cat, (VALUES
        ('€', 'eur1'),('€€', 'eur2'),('€€€', 'eur3'),('€€€€', 'eur4')
      ) AS v(name, slug)
      ON CONFLICT (category_id, name) DO UPDATE SET slug = EXCLUDED.slug;

      WITH cat AS (SELECT id FROM tag_categories WHERE slug = 'moment')
      INSERT INTO tags (category_id, name, slug)
      SELECT cat.id, v.name, v.slug FROM cat, (VALUES
        ('petit-déj', 'petit_dej'),('brunch', 'brunch'),('déjeuner', 'dejeuner'),
        ('goûter', 'gouter'),('dîner', 'diner'),('tard le soir', 'tard_le_soir')
      ) AS v(name, slug)
      ON CONFLICT (category_id, name) DO UPDATE SET slug = EXCLUDED.slug;

      WITH cat AS (SELECT id FROM tag_categories WHERE slug = 'ambiance')
      INSERT INTO tags (category_id, name, slug)
      SELECT cat.id, v.name, v.slug FROM cat, (VALUES
        ('cosy', 'cosy'),('calme', 'calme'),('animé', 'anime'),('romantique', 'romantique'),
        ('familial', 'familial'),('élégant', 'elegant'),('décontracté', 'decontracte')
      ) AS v(name, slug)
      ON CONFLICT (category_id, name) DO UPDATE SET slug = EXCLUDED.slug;

      WITH cat AS (SELECT id FROM tag_categories WHERE slug = 'particularite')
      INSERT INTO tags (category_id, name, slug)
      SELECT cat.id, v.name, v.slug FROM cat, (VALUES
        ('étoilé', 'etoile'),('bib gourmand', 'bib_gourmand'),('terrasse', 'terrasse'),
        ('vue', 'vue'),('à emporter', 'a_emporter'),('fait maison', 'fait_maison')
      ) AS v(name, slug)
      ON CONFLICT (category_id, name) DO UPDATE SET slug = EXCLUDED.slug;

      CREATE INDEX IF NOT EXISTS idx_tags_slug_per_category ON tags(category_id, slug);

      -- 4) Remap des restaurant_tags vers les tags canoniques via une table de
      -- correspondance temporaire. Couvre les déplacements de catégorie (vegan
      -- cuisine→regime, gastronomique cuisine→type_lieu, …) et les splits de
      -- tags compound (ex: "bretonne, libanaise, vegan").
      CREATE TEMP TABLE _tag_remap (
        legacy_name TEXT, src_category_slug TEXT,
        dst_category_slug TEXT, dst_tag_slug TEXT
      );
      INSERT INTO _tag_remap VALUES
        ('vegan', 'cuisine', 'regime', 'vegan'),
        ('végétarienne', 'cuisine', 'regime', 'vegetarien'),
        ('niçoise', 'cuisine', 'cuisine', 'francaise'),
        ('végétale', 'cuisine', 'regime', 'vegan'),
        ('bretonne, libanaise, vegan', 'cuisine', 'cuisine', 'francaise'),
        ('bretonne, libanaise, vegan', 'cuisine', 'cuisine', 'libanaise'),
        ('bretonne, libanaise, vegan', 'cuisine', 'regime', 'vegan'),
        ('café', 'cuisine', 'type_lieu', 'cafe'),
        ('gastronomique', 'cuisine', 'type_lieu', 'gastronomique'),
        ('provençale', 'cuisine', 'cuisine', 'francaise'),
        ('savoyarde', 'cuisine', 'cuisine', 'francaise'),
        ('vegan, libanaise, bretonne', 'cuisine', 'cuisine', 'libanaise'),
        ('vegan, libanaise, bretonne', 'cuisine', 'cuisine', 'francaise'),
        ('vegan, libanaise, bretonne', 'cuisine', 'regime', 'vegan'),
        ('veggie', 'cuisine', 'regime', 'vegetarien'),
        ('bar à café', 'type_lieu', 'type_lieu', 'cafe'),
        ('bar à nouilles', 'type_lieu', 'type_lieu', 'restaurant'),
        ('barbecue', 'type_lieu', 'type_lieu', 'restaurant'),
        ('bistro', 'type_lieu', 'type_lieu', 'bistrot'),
        ('boulangerie pâtisserie', 'type_lieu', 'type_lieu', 'boulangerie'),
        ('boulangerie pâtisserie', 'type_lieu', 'type_lieu', 'patisserie'),
        ('brunch', 'type_lieu', 'moment', 'brunch'),
        ('izakaya', 'type_lieu', 'type_lieu', 'restaurant'),
        ('patisserie', 'type_lieu', 'type_lieu', 'patisserie'),
        ('restaurant de pâtes', 'type_lieu', 'type_lieu', 'restaurant'),
        ('restaurant deux étoiles michelin', 'type_lieu', 'type_lieu', 'gastronomique'),
        ('restaurant deux étoiles michelin', 'type_lieu', 'particularite', 'etoile'),
        ('restaurant éphémère', 'type_lieu', 'type_lieu', 'restaurant'),
        ('restaurant étoilé', 'type_lieu', 'type_lieu', 'gastronomique'),
        ('restaurant étoilé', 'type_lieu', 'particularite', 'etoile'),
        ('restaurant traditionnel', 'type_lieu', 'type_lieu', 'restaurant'),
        ('rôtisserie', 'type_lieu', 'type_lieu', 'restaurant'),
        ('sandwich', 'type_lieu', 'type_lieu', 'sandwicherie'),
        ('steakhouse', 'type_lieu', 'type_lieu', 'restaurant'),
        ('végétarien', 'type_lieu', 'regime', 'vegetarien'),
        ('€12-€16', 'prix', 'prix', 'eur2'),
        ('€16', 'prix', 'prix', 'eur2'),
        ('€7', 'prix', 'prix', 'eur1'),
        ('€7,90-8,90 / formule 10,90-11,90€', 'prix', 'prix', 'eur1'),
        ('16€-25€', 'prix', 'prix', 'eur2'),
        ('vegan friendly', 'particularite', 'regime', 'options_vege'),
        ('options veggie', 'particularite', 'regime', 'options_vege'),
        ('options vegans', 'particularite', 'regime', 'options_vege'),
        ('options végétariennes', 'particularite', 'regime', 'options_vege'),
        ('option vegan', 'particularite', 'regime', 'options_vege'),
        ('100% végétarien', 'particularite', 'regime', 'vegetarien'),
        ('options vegan', 'particularite', 'regime', 'options_vege'),
        ('options végés', 'particularite', 'regime', 'options_vege'),
        ('plats végés et véganes', 'particularite', 'regime', 'options_vege'),
        ('entièrement végétal', 'particularite', 'regime', 'vegan'),
        ('viande halal', 'particularite', 'regime', 'halal'),
        ('2 étoiles michelin', 'particularite', 'particularite', 'etoile'),
        ('bib michelin', 'particularite', 'particularite', 'bib_gourmand'),
        ('deux étoiles michelin', 'particularite', 'particularite', 'etoile'),
        ('vue sur la tour eiffel', 'particularite', 'particularite', 'vue'),
        ('déjeuner, dîner', 'moment', 'moment', 'dejeuner'),
        ('déjeuner, dîner', 'moment', 'moment', 'diner'),
        ('élégante', 'ambiance', 'ambiance', 'elegant'),
        ('accueil exceptionnel, chaleureuse, humaine', 'ambiance', 'ambiance', 'cosy'),
        ('bruyante', 'ambiance', 'ambiance', 'anime'),
        ('chaleureuse', 'ambiance', 'ambiance', 'cosy'),
        ('chaleureuse, humaine', 'ambiance', 'ambiance', 'cosy'),
        ('chaleureux', 'ambiance', 'ambiance', 'cosy'),
        ('conviviale, décalée', 'ambiance', 'ambiance', 'decontracte'),
        ('cosy et chaleureux', 'ambiance', 'ambiance', 'cosy'),
        ('cosy, chaleureux', 'ambiance', 'ambiance', 'cosy'),
        ('décontractée', 'ambiance', 'ambiance', 'decontracte'),
        ('guinguette', 'ambiance', 'ambiance', 'decontracte'),
        ('luxuriant', 'ambiance', 'ambiance', 'elegant');

      INSERT INTO restaurant_tags (restaurant_id, tag_id)
      SELECT rt.restaurant_id, dst.id
      FROM restaurant_tags rt
      JOIN tags ot ON ot.id = rt.tag_id
      JOIN tag_categories oc ON oc.id = ot.category_id
      JOIN _tag_remap m ON m.legacy_name = ot.legacy_name AND m.src_category_slug = oc.slug
      JOIN tag_categories dc ON dc.slug = m.dst_category_slug
      JOIN tags dst ON dst.category_id = dc.id AND dst.slug = m.dst_tag_slug
      ON CONFLICT (restaurant_id, tag_id) DO NOTHING;

      -- 5) Cleanup : supprimer les liens vers tags non canoniques puis les tags eux-mêmes
      DELETE FROM restaurant_tags WHERE tag_id IN (SELECT id FROM tags WHERE slug IS NULL);
      DELETE FROM tags WHERE slug IS NULL;

      -- 6) Mise à jour de get_map_pins : retourne le slug du pin (cuisine étrangère
      -- → type_lieu distinctif → française → restaurant générique → NULL).
      -- La colonne reste "cuisine_type" pour compat avec le backend déjà déployé.
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
      DROP INDEX IF EXISTS idx_tags_slug_per_category;
      -- Best-effort : on ne reconstruit pas les anciens tags (les compounds /
      -- one-shots étaient justement la raison de la migration). Les colonnes
      -- legacy_name et slug peuvent être supprimées si besoin.
    `);
  }
}
