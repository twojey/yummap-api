import { supabaseService } from "../config.ts";

export async function up() {
  const { error } = await supabaseService.rpc("exec_sql", {
    sql: `
CREATE TABLE IF NOT EXISTS avis_influencer (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id      TEXT NOT NULL,  -- Google Places place_id
  note          SMALLINT NOT NULL CHECK (note BETWEEN 1 AND 5),
  texte         TEXT NOT NULL CHECK (char_length(texte) BETWEEN 1 AND 2000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(influencer_id, place_id)  -- 1 avis per influencer per restaurant
);

CREATE INDEX IF NOT EXISTS idx_avis_influencer_place
  ON avis_influencer (place_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_avis_influencer_author
  ON avis_influencer (influencer_id, created_at DESC);
    `,
  });
  if (error) throw new Error(`Migration 0024 failed: ${error.message}`);
  console.log("Migration 0024: avis_influencer created");
}
