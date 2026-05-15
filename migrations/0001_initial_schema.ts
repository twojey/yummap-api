import { AbstractMigration, ClientPostgreSQL } from "https://deno.land/x/nessie@2.1.0/mod.ts";

export default class extends AbstractMigration<ClientPostgreSQL> {
  async up(): Promise<void> {
    await this.client.queryArray(`
      -- Extensions
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      -- Users & accounts
      CREATE TABLE users (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'influencer', 'restaurant', 'admin')),
        display_name TEXT,
        avatar_url  TEXT,
        preferences JSONB NOT NULL DEFAULT '{"experiences":[],"dietaryConstraints":[],"notificationsEnabled":{"newVideo":true,"newGuide":true,"importComplete":true}}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Follows (user → influencer)
      CREATE TABLE follows (
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        influencer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, influencer_id)
      );

      -- Invitations
      CREATE TABLE invitations (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        inviter_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Tag categories & tags
      CREATE TABLE tag_categories (
        id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE tags (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        category_id UUID NOT NULL REFERENCES tag_categories(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(category_id, name)
      );

      -- Restaurants (Google Places comme source de vérité pour les données factuelles)
      CREATE TABLE restaurants (
        id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        place_id             TEXT NOT NULL UNIQUE,  -- Google Places place_id
        name                 TEXT NOT NULL,
        address              TEXT NOT NULL,
        city                 TEXT NOT NULL DEFAULT 'Paris',
        location             GEOGRAPHY(Point, 4326) NOT NULL,
        google_rating        NUMERIC(2,1),
        google_ratings_count INTEGER,
        open_now             BOOLEAN,
        opening_hours        JSONB,
        website_url          TEXT,
        phone_number         TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_restaurants_location ON restaurants USING GIST(location);
      CREATE INDEX idx_restaurants_place_id ON restaurants(place_id);

      -- Restaurant tags
      CREATE TABLE restaurant_tags (
        restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        tag_id        UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (restaurant_id, tag_id)
      );

      -- Videos
      CREATE TABLE videos (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        uploader_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_url    TEXT NOT NULL,
        stored_path   TEXT NOT NULL,
        stream_url    TEXT NOT NULL,
        subtitles_url TEXT,
        transcription TEXT,
        duration      INTEGER,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_videos_restaurant ON videos(restaurant_id);
      CREATE INDEX idx_videos_uploader ON videos(uploader_id);
      CREATE INDEX idx_videos_created ON videos(created_at DESC);

      -- Guides
      CREATE TABLE guides (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        influencer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        description     TEXT,
        cover_image_url TEXT,
        restaurant_count INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_guides_influencer ON guides(influencer_id);

      -- Guide ↔ Restaurant many-to-many
      CREATE TABLE guide_restaurants (
        guide_id      UUID NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
        restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guide_id, restaurant_id)
      );

      -- Trigger: update guide restaurant_count
      CREATE OR REPLACE FUNCTION update_guide_restaurant_count()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          UPDATE guides SET restaurant_count = restaurant_count + 1 WHERE id = NEW.guide_id;
        ELSIF TG_OP = 'DELETE' THEN
          UPDATE guides SET restaurant_count = restaurant_count - 1 WHERE id = OLD.guide_id;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_guide_restaurant_count
        AFTER INSERT OR DELETE ON guide_restaurants
        FOR EACH ROW EXECUTE FUNCTION update_guide_restaurant_count();

      -- Watchlist
      CREATE TABLE watchlist (
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, restaurant_id)
      );

      -- Notification preferences & push tokens
      CREATE TABLE notification_preferences (
        user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        push_token            TEXT,
        platform              TEXT CHECK (platform IN ('ios', 'android')),
        new_video_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        new_guide_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        import_complete_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- RPC: get_map_pins (PostGIS viewport query avec filtres Guide Layer)
      CREATE OR REPLACE FUNCTION get_map_pins(
        sw_lng FLOAT, sw_lat FLOAT, ne_lng FLOAT, ne_lat FLOAT,
        guide_ids UUID[] DEFAULT NULL,
        tag_ids UUID[] DEFAULT NULL,
        open_now BOOLEAN DEFAULT NULL,
        min_rating NUMERIC DEFAULT NULL,
        user_id UUID DEFAULT NULL
      )
      RETURNS TABLE (
        restaurant_id UUID, place_id TEXT, name TEXT,
        lat FLOAT, lng FLOAT, cuisine_type TEXT,
        open_now BOOLEAN, google_rating NUMERIC,
        has_videos BOOLEAN, is_in_watchlist BOOLEAN,
        guide_ids UUID[]
      ) AS $$
      BEGIN
        RETURN QUERY
        SELECT
          r.id,
          r.place_id,
          r.name,
          ST_Y(r.location::geometry)::FLOAT AS lat,
          ST_X(r.location::geometry)::FLOAT AS lng,
          (SELECT t.name FROM restaurant_tags rt JOIN tags t ON t.id = rt.tag_id
           JOIN tag_categories tc ON tc.id = t.category_id
           WHERE rt.restaurant_id = r.id AND tc.name = 'cuisine' LIMIT 1) AS cuisine_type,
          r.open_now,
          r.google_rating,
          EXISTS(SELECT 1 FROM videos v WHERE v.restaurant_id = r.id) AS has_videos,
          CASE WHEN user_id IS NOT NULL THEN
            EXISTS(SELECT 1 FROM watchlist w WHERE w.user_id = get_map_pins.user_id AND w.restaurant_id = r.id)
          ELSE FALSE END AS is_in_watchlist,
          ARRAY(SELECT gr.guide_id FROM guide_restaurants gr WHERE gr.restaurant_id = r.id) AS guide_ids
        FROM restaurants r
        WHERE
          ST_Within(r.location::geometry, ST_MakeEnvelope(sw_lng, sw_lat, ne_lng, ne_lat, 4326))
          AND (guide_ids IS NULL OR EXISTS(
            SELECT 1 FROM guide_restaurants gr WHERE gr.restaurant_id = r.id AND gr.guide_id = ANY(guide_ids)
          ))
          AND (tag_ids IS NULL OR EXISTS(
            SELECT 1 FROM restaurant_tags rt WHERE rt.restaurant_id = r.id AND rt.tag_id = ANY(tag_ids)
          ))
          AND (get_map_pins.open_now IS NULL OR r.open_now = get_map_pins.open_now)
          AND (min_rating IS NULL OR r.google_rating >= min_rating);
      END;
      $$ LANGUAGE plpgsql;

      -- RPC: search_restaurants_in_guides (full-text search, uniquement restaurants dans des Guides)
      CREATE OR REPLACE FUNCTION search_restaurants_in_guides(
        search_query TEXT DEFAULT NULL,
        tag_ids UUID[] DEFAULT NULL,
        open_now BOOLEAN DEFAULT NULL,
        min_rating NUMERIC DEFAULT NULL
      )
      RETURNS SETOF restaurants AS $$
      BEGIN
        RETURN QUERY
        SELECT DISTINCT r.*
        FROM restaurants r
        INNER JOIN guide_restaurants gr ON gr.restaurant_id = r.id
        WHERE
          (search_query IS NULL OR to_tsvector('french', r.name || ' ' || r.address) @@ plainto_tsquery('french', search_query))
          AND (tag_ids IS NULL OR EXISTS(
            SELECT 1 FROM restaurant_tags rt WHERE rt.restaurant_id = r.id AND rt.tag_id = ANY(tag_ids)
          ))
          AND (open_now IS NULL OR r.open_now = open_now)
          AND (min_rating IS NULL OR r.google_rating >= min_rating)
        ORDER BY r.google_rating DESC NULLS LAST;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }

  async down(): Promise<void> {
    await this.client.queryArray(`
      DROP FUNCTION IF EXISTS search_restaurants_in_guides;
      DROP FUNCTION IF EXISTS get_map_pins;
      DROP TRIGGER IF EXISTS trg_guide_restaurant_count ON guide_restaurants;
      DROP FUNCTION IF EXISTS update_guide_restaurant_count;
      DROP TABLE IF EXISTS notification_preferences;
      DROP TABLE IF EXISTS watchlist;
      DROP TABLE IF EXISTS guide_restaurants;
      DROP TABLE IF EXISTS guides;
      DROP TABLE IF EXISTS videos;
      DROP TABLE IF EXISTS restaurant_tags;
      DROP TABLE IF EXISTS restaurants;
      DROP TABLE IF EXISTS tags;
      DROP TABLE IF EXISTS tag_categories;
      DROP TABLE IF EXISTS invitations;
      DROP TABLE IF EXISTS follows;
      DROP TABLE IF EXISTS users;
    `);
  }
}
