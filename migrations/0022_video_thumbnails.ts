import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Thumbnails séparés pour les vidéos. Jusqu'ici on prenait `stream_url` comme
// thumbnail dans les routes (cf. influencers.routes.ts, restaurants.routes.ts,
// feed.routes.ts) ce qui obligeait le frontend à instancier un VideoPlayer
// pour chaque tile et télécharger la vidéo entière (50 tiles ≈ 50-250 MB).
//
// Avec un thumbnail WebP séparé (~15 kB) on économise > 90 % du bandwidth de
// navigation et on supprime les limites iOS/Android sur le nombre de décodeurs
// vidéo simultanés.
//
// La colonne est NULLABLE : les vidéos existantes restent valides en attendant
// le backfill (cf. scripts/backfill_video_thumbnails.ts).
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      ALTER TABLE videos
        ADD COLUMN thumbnail_url TEXT;
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      ALTER TABLE videos
        DROP COLUMN thumbnail_url;
    `);
  }
}
