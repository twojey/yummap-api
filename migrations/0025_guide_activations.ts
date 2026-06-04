import { supabaseService } from "../config.ts";

export async function up() {
  const { error } = await supabaseService.rpc("exec_sql", {
    sql: `
CREATE TABLE IF NOT EXISTS guide_activations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id   UUID NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guide_activations_guide
  ON guide_activations (guide_id, activated_at DESC);
CREATE INDEX IF NOT EXISTS idx_guide_activations_user
  ON guide_activations (user_id, activated_at DESC);
`,
  });
  if (error) throw new Error(`Migration 0025 failed: ${error.message}`);
  console.log("Migration 0025: guide_activations created");
}
