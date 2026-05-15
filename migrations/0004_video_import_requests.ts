import { supabaseService } from "../config.ts";

// Table de suivi des imports vidéo unitaires (un import = un job)
// Correspond au VideoImportJob côté Flutter
export async function up() {
  const { error } = await supabaseService.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS video_import_requests (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url             TEXT NOT NULL,
        uploader_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'complete', 'incomplete', 'failed')),
        restaurant_place_id  TEXT,
        restaurant_name      TEXT,
        missing_fields       TEXT[] DEFAULT '{}',
        error_message        TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_video_import_requests_uploader
        ON video_import_requests (uploader_id, created_at DESC);
    `,
  });
  if (error) throw new Error(`Migration 0004 failed: ${error.message}`);
  console.log("Migration 0004: video_import_requests created");
}
