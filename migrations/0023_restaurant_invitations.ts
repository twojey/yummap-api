import { supabaseService } from "../config.ts";

export async function up() {
  const { error } = await supabaseService.rpc("exec_sql", {
    sql: `
-- Restaurant → Influencer invitations (partenariats)
CREATE TABLE IF NOT EXISTS restaurant_invitations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  token         UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  code_court    TEXT NOT NULL,  -- 6-digit numeric code, unique per invitation
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'used', 'expired')),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_invitations_influencer
  ON restaurant_invitations (influencer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_restaurant_invitations_token
  ON restaurant_invitations (token);

-- Guide Auto support
ALTER TABLE guides ADD COLUMN IF NOT EXISTS is_auto BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS social_handle TEXT;

-- Influencer opt-in for matching pool
ALTER TABLE pending_influencer_profiles
  ADD COLUMN IF NOT EXISTS optin_matching_pool BOOLEAN NOT NULL DEFAULT false;
    `,
  });
  if (error) throw new Error(`Migration 0023 failed: ${error.message}`);
  console.log("Migration 0023: restaurant_invitations created + guides/pending_influencer_profiles updated");
}
