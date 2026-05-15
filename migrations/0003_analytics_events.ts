import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      -- Table générique d'événements analytics.
      -- Capture les comportements utilisateurs dès le lancement v1 pour alimenter
      -- les futurs dashboards B2B restaurant et hôtel sans nécessiter de migration.
      CREATE TABLE analytics_events (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        event_type    TEXT NOT NULL,
        user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
        restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
        session_id    TEXT,
        lat           DOUBLE PRECISION,
        lng           DOUBLE PRECISION,
        metadata      JSONB NOT NULL DEFAULT '{}',
        occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_analytics_restaurant ON analytics_events(restaurant_id, occurred_at DESC);
      CREATE INDEX idx_analytics_event_type ON analytics_events(event_type, occurred_at DESC);
      CREATE INDEX idx_analytics_occurred   ON analytics_events(occurred_at DESC);

      COMMENT ON TABLE analytics_events IS
        'Événements comportementaux. event_type connus au lancement : '
        'restaurant_view, restaurant_map_open, video_view, guide_view, '
        'watchlist_add. Événements B2B futurs : restaurant_proximity_enter (100m), '
        'reservation_created, loyalty_stamp.';
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`DROP TABLE IF EXISTS analytics_events;`);
  }
}
