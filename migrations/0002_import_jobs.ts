import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      CREATE TABLE import_jobs (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        profile_url      TEXT NOT NULL,
        influencer_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status           TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        total_videos     INTEGER,
        processed_videos INTEGER NOT NULL DEFAULT 0,
        success_count    INTEGER NOT NULL DEFAULT 0,
        failure_count    INTEGER NOT NULL DEFAULT 0,
        incomplete_count INTEGER NOT NULL DEFAULT 0,
        errors           JSONB NOT NULL DEFAULT '[]',
        started_at       TIMESTAMPTZ,
        completed_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_import_jobs_influencer ON import_jobs(influencer_id);
      CREATE INDEX idx_import_jobs_status     ON import_jobs(status);
      CREATE INDEX idx_import_jobs_created    ON import_jobs(created_at DESC);
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      DROP TABLE IF EXISTS import_jobs;
    `);
  }
}
