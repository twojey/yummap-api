import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

// Tracking actif des users pour le compteur de followers.
// Permet de :
//   1) Compter les follows des users anon (sans phone vérifié)
//   2) Exclure du compteur les users qui ont désinstallé l'app (last_active_at > 60j)
//   3) Dédupliquer par phone quand un anon vérifie son numéro
export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_anonymous   BOOLEAN     NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS phone_number   TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
        ON users(phone_number) WHERE phone_number IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_users_last_active
        ON users(last_active_at);

      CREATE INDEX IF NOT EXISTS idx_users_anon_inactive
        ON users(last_active_at) WHERE is_anonymous = TRUE;
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      DROP INDEX IF EXISTS idx_users_anon_inactive;
      DROP INDEX IF EXISTS idx_users_last_active;
      DROP INDEX IF EXISTS idx_users_phone_unique;
      ALTER TABLE users
        DROP COLUMN IF EXISTS phone_number,
        DROP COLUMN IF EXISTS last_active_at,
        DROP COLUMN IF EXISTS is_anonymous;
    `);
  }
}
