import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Cache des données Google Places sur restaurants pour servir l'app sans
// jamais appeler Google en runtime.
// - opening_hours : la colonne existe déjà depuis la migration 0001 (JSONB)
//   mais n'était jamais peuplée par le pipeline d'import — on la branche maintenant.
// - google_reviews : nouvelle colonne JSONB qui stocke jusqu'à 5 reviews. Mise
//   à jour à l'import + à un eventuel refresh périodique (cron, hors scope ici).
// - google_data_fetched_at : timestamp pour détecter les fiches obsolètes
//   (un cron pourra rafraîchir si > N jours).
//
// Format google_reviews :
// [
//   { author, avatarUrl, rating, text, time, relativeTime },
//   ...
// ]
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      ALTER TABLE restaurants
        ADD COLUMN IF NOT EXISTS google_reviews JSONB,
        ADD COLUMN IF NOT EXISTS google_data_fetched_at TIMESTAMPTZ;

      -- Index partiel : permet à un futur cron de cibler vite les fiches
      -- "stale" (jamais fetchées ou anciennes) sans scanner toute la table.
      CREATE INDEX IF NOT EXISTS idx_restaurants_google_stale
        ON restaurants(google_data_fetched_at NULLS FIRST);
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      DROP INDEX IF EXISTS idx_restaurants_google_stale;
      ALTER TABLE restaurants
        DROP COLUMN IF EXISTS google_data_fetched_at,
        DROP COLUMN IF EXISTS google_reviews;
    `);
  }
}
