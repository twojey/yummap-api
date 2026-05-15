import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Refonte de la taxonomie des tags : 5 catégories standard avec slug stable
// (cuisine, dietary, dish, ambiance, formula). Vide les données existantes
// (option choisie : on repart sur une taxonomie propre, pas de remap).
//
// - cuisine : type de cuisine (italienne, japonaise, française…) — OBLIGATOIRE
//   sur tout restaurant. Le pipeline d'import refuse de créer un resto sans cuisine.
// - dietary : restrictions ou compatibilités (vegan, halal, casher, sans gluten…)
// - dish : plats spécifiques de la carte (pizza, kebab, ramen, sushi, tacos…)
// - ambiance : ambiance du lieu (romantique, familial, business, branché…)
// - formula : type de formule (à volonté, brunch, gastronomique, fast-food…)
//
// Le pipeline Gemini (et un futur admin) ne peuvent créer un tag que dans une de
// ces 5 catégories — d'où le slug stable + check côté insert.
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      -- 1. Vide les données existantes (cascade vers tags + restaurant_tags)
      DELETE FROM tag_categories;

      -- 2. Ajoute slug + is_required à tag_categories
      --    slug = identifiant stable utilisé par le code (cuisine, dietary…)
      --    is_required = la catégorie doit être présente sur tout resto (cuisine = true)
      ALTER TABLE tag_categories
        ADD COLUMN IF NOT EXISTS slug TEXT NOT NULL UNIQUE,
        ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

      -- 3. Slug + is_required + sort_order : seed des 5 catégories
      INSERT INTO tag_categories (slug, name, is_required, sort_order) VALUES
        ('cuisine',  'Cuisine',     TRUE,  0),
        ('dietary',  'Restriction', FALSE, 1),
        ('dish',     'Plat',        FALSE, 2),
        ('ambiance', 'Ambiance',    FALSE, 3),
        ('formula',  'Formule',     FALSE, 4);

      -- 4. Seed des tags initiaux (modifiables ensuite via admin)
      --    Tous en lowercase pour matcher le pipeline Gemini qui normalise.
      INSERT INTO tags (category_id, name)
      SELECT id, t FROM tag_categories, UNNEST(ARRAY[
        'italienne', 'française', 'japonaise', 'chinoise', 'thaïlandaise',
        'vietnamienne', 'coréenne', 'indienne', 'mexicaine', 'libanaise',
        'turque', 'marocaine', 'espagnole', 'grecque', 'américaine',
        'péruvienne', 'portugaise', 'sénégalaise', 'éthiopienne', 'brésilienne',
        'argentine', 'méditerranéenne', 'asiatique', 'africaine', 'européenne',
        'fusion', 'world'
      ]) AS t WHERE slug = 'cuisine';

      INSERT INTO tags (category_id, name)
      SELECT id, t FROM tag_categories, UNNEST(ARRAY[
        'vegan', 'végétarien', 'halal', 'casher', 'sans gluten',
        'sans lactose', 'bio', 'pescatarien'
      ]) AS t WHERE slug = 'dietary';

      INSERT INTO tags (category_id, name)
      SELECT id, t FROM tag_categories, UNNEST(ARRAY[
        'pizza', 'burger', 'sushi', 'kebab', 'ramen',
        'tacos', 'pâtes', 'salade', 'poke', 'bao',
        'crêpes', 'bagel', 'hot-dog', 'sandwich', 'wok',
        'wrap', 'couscous', 'tajine', 'paëlla', 'risotto',
        'steak', 'grillade', 'fish & chips', 'dim sum', 'pad thaï',
        'curry', 'tartare', 'fondue', 'raclette'
      ]) AS t WHERE slug = 'dish';

      INSERT INTO tags (category_id, name)
      SELECT id, t FROM tag_categories, UNNEST(ARRAY[
        'romantique', 'familial', 'chic', 'branché', 'calme',
        'business', 'festif', 'décontracté', 'cosy', 'rooftop',
        'terrasse', 'vue', 'caveau', 'jardin'
      ]) AS t WHERE slug = 'ambiance';

      INSERT INTO tags (category_id, name)
      SELECT id, t FROM tag_categories, UNNEST(ARRAY[
        'à volonté', 'brunch', 'déjeuner', 'dîner', 'apéro',
        'fast-food', 'gastronomique', 'street food', 'à emporter', 'livraison',
        'petit-déjeuner', 'goûter', 'happy hour', 'bistrot', 'bar à vin',
        'omakase', 'menu dégustation'
      ]) AS t WHERE slug = 'formula';

      -- 5. Indexes pour requêtes fréquentes
      CREATE INDEX IF NOT EXISTS idx_tag_categories_slug ON tag_categories(slug);
      CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category_id);
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      DROP INDEX IF EXISTS idx_tags_category;
      DROP INDEX IF EXISTS idx_tag_categories_slug;
      DELETE FROM tag_categories;
      ALTER TABLE tag_categories
        DROP COLUMN IF EXISTS sort_order,
        DROP COLUMN IF EXISTS is_required,
        DROP COLUMN IF EXISTS slug;
    `);
  }
}
