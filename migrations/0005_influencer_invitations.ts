import { supabaseService } from "../config.ts";

export async function up() {
  const { error } = await supabaseService.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS influencer_invitations (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token                 UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
        type                  TEXT NOT NULL CHECK (type IN ('admin', 'influencer')),
        created_by_id         UUID NOT NULL,
        target_email          TEXT,
        target_phone          TEXT,
        linked_influencer_id  UUID REFERENCES influencers(id) ON DELETE SET NULL,
        status                TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'claimed', 'expired', 'rejected')),
        expires_at            TIMESTAMPTZ NOT NULL,
        claimed_by_id         UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_invitations_token ON influencer_invitations (token);
      CREATE INDEX IF NOT EXISTS idx_invitations_creator ON influencer_invitations (created_by_id, status);

      CREATE TABLE IF NOT EXISTS pending_influencer_profiles (
        user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        display_name      TEXT NOT NULL,
        avatar_url        TEXT,
        bio               TEXT,
        social_profiles   JSONB NOT NULL DEFAULT '[]',
        invited_by_id     UUID NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
        status            TEXT NOT NULL DEFAULT 'pending_review'
                            CHECK (status IN ('pending_review', 'active', 'rejected')),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_pending_status
        ON pending_influencer_profiles (status, created_at);
    `,
  });
  if (error) throw new Error(`Migration 0005 failed: ${error.message}`);
  console.log("Migration 0005: influencer_invitations + pending_influencer_profiles created");
}
