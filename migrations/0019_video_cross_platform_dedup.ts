import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Déduplication cross-plateforme des vidéos partagées.
//
// Problème : un même contenu peut être posté par l'influenceur sur Instagram
// ET TikTok. Deux abonnés différents qui partagent les deux URLs créaient deux
// vidéos distinctes en base, polluant la carte avec des doublons.
//
// Solution : deux signaux complémentaires pour reconnaître le même contenu
// indépendamment de la plateforme :
//   1) content_fingerprint = sha256(transcription normalisée + restaurant_ids triés)
//      → reconnaît un contenu sémantiquement identique même si l'URL diffère
//   2) heuristique (uploader_influencer + restaurant + posted_at ±48h)
//      → couvre les vidéos peu/pas parlées (donc fingerprint pauvre)
//
// Quand un doublon est détecté à l'import, on ne crée PAS de nouvelle vidéo
// mais on enregistre l'uploader courant comme contributor de la vidéo
// existante (table video_contributors). La carte reste propre, les uploaders
// gardent leur "crédit" social.
//
// Distinction temporelle importante :
//   posted_at     = quand l'influenceur a publié sur la plateforme (scraper)
//   created_at    = quand notre pipeline a inséré la ligne en DB
//   contributed_at = quand un contributor a partagé son URL chez nous
// L'heuristique ±48h se fonde sur posted_at (le moment de publication réel).
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      -- 1) Colonnes de dédup sur videos
      ALTER TABLE videos
        ADD COLUMN IF NOT EXISTS content_fingerprint TEXT,
        ADD COLUMN IF NOT EXISTS posted_at           TIMESTAMPTZ;

      -- Lookup par fingerprint (signal #1). Cardinalité haute → btree suffit.
      -- Partiel : les anciennes lignes sans fingerprint n'encombrent pas l'index.
      CREATE INDEX IF NOT EXISTS idx_videos_content_fingerprint
        ON videos(content_fingerprint)
        WHERE content_fingerprint IS NOT NULL;

      -- Range scan sur posted_at pour la fenêtre 30j et l'heuristique 48h.
      CREATE INDEX IF NOT EXISTS idx_videos_posted_at
        ON videos(posted_at DESC)
        WHERE posted_at IS NOT NULL;

      -- 2) Table des contributors : N users peuvent partager la même vidéo
      -- via leurs URLs respectives (TikTok, IG, repost…). Ils sont tous
      -- crédités. PK composite : un user au plus une fois par vidéo.
      CREATE TABLE IF NOT EXISTS video_contributors (
        video_id         UUID        NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        user_id          UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
        source_url       TEXT        NOT NULL,
        platform         TEXT,       -- 'instagram' | 'tiktok' | NULL si inconnu
        external_post_id TEXT,       -- id du post sur la plateforme partagée
        contributed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (video_id, user_id)
      );

      -- Empêche un même user de se créditer deux fois pour le même post
      -- (re-partage idempotent depuis l'app). Partiel : seul l'index pour les
      -- lignes avec external_post_id renseigné (NULL = post inconnu, pas dédup).
      CREATE UNIQUE INDEX IF NOT EXISTS video_contributors_user_post_unique
        ON video_contributors(user_id, platform, external_post_id)
        WHERE external_post_id IS NOT NULL;

      -- Index pour "qui a contribué à cette vidéo ?" (affichage côté vidéo).
      CREATE INDEX IF NOT EXISTS idx_video_contributors_video
        ON video_contributors(video_id);

      -- Index pour "mes imports" (timeline user, ordre récent → ancien).
      CREATE INDEX IF NOT EXISTS idx_video_contributors_user
        ON video_contributors(user_id, contributed_at DESC);

      -- 3) Backfill : chaque vidéo existante a son uploader d'origine comme
      -- premier contributor (pas de perte d'attribution sociale).
      INSERT INTO video_contributors
        (video_id, user_id, source_url, platform, external_post_id, contributed_at)
      SELECT
        v.id, v.uploader_id, v.source_url, v.platform, v.external_post_id, v.created_at
      FROM videos v
      ON CONFLICT (video_id, user_id) DO NOTHING;
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      DROP TABLE IF EXISTS video_contributors;
      DROP INDEX IF EXISTS idx_videos_posted_at;
      DROP INDEX IF EXISTS idx_videos_content_fingerprint;
      ALTER TABLE videos
        DROP COLUMN IF EXISTS posted_at,
        DROP COLUMN IF EXISTS content_fingerprint;
    `);
  }
}
