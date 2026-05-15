import { supabaseService } from "../../../config.ts";
import type { IRestaurantRepository } from "../../domain/restaurant/restaurant.repository.ts";
import type { Restaurant, SearchFilters } from "../../domain/restaurant/restaurant.types.ts";
import type { BoundingBox } from "../../domain/map/map.query.ts";
import { NotFoundError } from "../../shared/errors.ts";

// Cache module-level des slugs de catégorie (categoryId → slug).
// Évite un round-trip Supabase à chaque mapping de tags. La taxonomie change
// rarement (admin uniquement) → 60s de TTL est largement suffisant.
let _slugCache: Map<string, string> | null = null;
let _slugCacheAt = 0;
const _SLUG_TTL_MS = 60_000;

async function loadCategorySlugs(): Promise<Map<string, string>> {
  if (_slugCache && Date.now() - _slugCacheAt < _SLUG_TTL_MS) return _slugCache;
  // Try with slug column ; fallback silencieux si la migration 0006 n'a pas
  // tourné (la colonne n'existe pas → erreur Supabase 42703). Sans ce fallback,
  // toutes les requêtes restaurants/tags casseraient avant la migration.
  try {
    const { data, error } = await supabaseService.from("tag_categories").select("id, slug");
    if (error) throw error;
    _slugCache = new Map(
      ((data ?? []) as Array<{ id: string; slug: string | null }>)
        .filter((c) => c.slug)
        .map((c) => [c.id, c.slug as string]),
    );
  } catch (_) {
    _slugCache = new Map();
  }
  _slugCacheAt = Date.now();
  return _slugCache;
}

export class SupabaseRestaurantRepository implements IRestaurantRepository {
  async findById(placeId: string): Promise<Restaurant | null> {
    const { data, error } = await supabaseService
      .from("restaurants")
      .select("*, restaurant_tags(tags(id, name, tag_categories(id, name)))")
      .eq("place_id", placeId)
      .single();

    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return await this.#enrichSlugs(this.#mapRow(data));
  }

  async findByViewport(bbox: BoundingBox, filters?: SearchFilters): Promise<Restaurant[]> {
    // PostGIS ST_Within query via RPC
    const { data, error } = await supabaseService.rpc("restaurants_in_viewport", {
      sw_lng: bbox.swLng,
      sw_lat: bbox.swLat,
      ne_lng: bbox.neLng,
      ne_lat: bbox.neLat,
      tag_ids: filters?.tagIds ?? null,
      open_now: filters?.openNow ?? null,
      min_rating: filters?.minRating ?? null,
    });

    if (error) throw new Error(error.message);
    const mapped = (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
    return await this.#enrichSlugsBatch(mapped);
  }

  async findByGuide(guideId: string, filters?: SearchFilters): Promise<Restaurant[]> {
    let query = supabaseService
      .from("restaurants")
      .select("*, restaurant_tags(tags(id, name, tag_categories(id, name))), guide_restaurants!inner(guide_id)")
      .eq("guide_restaurants.guide_id", guideId);

    if (filters?.openNow !== undefined) query = query.eq("open_now", filters.openNow);
    if (filters?.minRating) query = query.gte("google_rating", filters.minRating);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const mapped = (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
    return await this.#enrichSlugsBatch(mapped);
  }

  async search(filters: SearchFilters): Promise<Restaurant[]> {
    const { data, error } = await supabaseService.rpc("search_restaurants_in_guides", {
      search_query: filters.query ?? null,
      tag_ids: filters.tagIds ?? null,
      open_now: filters.openNow ?? null,
      min_rating: filters.minRating ?? null,
    });

    if (error) throw new Error(error.message);
    const mapped = (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
    return await this.#enrichSlugsBatch(mapped);
  }

  async upsert(restaurant: Omit<Restaurant, "tags" | "createdAt" | "updatedAt" | "coverImageUrl">): Promise<Restaurant> {
    const { data, error } = await supabaseService
      .from("restaurants")
      .upsert({
        place_id: restaurant.placeId,
        name: restaurant.name,
        address: restaurant.address,
        city: restaurant.city,
        location: `POINT(${restaurant.location.lng} ${restaurant.location.lat})`,
        google_rating: restaurant.googleRating,
        google_ratings_count: restaurant.googleRatingsCount,
        open_now: restaurant.openNow,
        opening_hours: restaurant.openingHours,
        website_url: restaurant.websiteUrl,
        phone_number: restaurant.phoneNumber,
      }, { onConflict: "place_id" })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async assignTags(placeId: string, tagIds: string[]): Promise<void> {
    const restaurant = await this.findById(placeId);
    if (!restaurant) throw new NotFoundError("Restaurant", placeId);

    await supabaseService.from("restaurant_tags").delete().eq("restaurant_id", restaurant.id);

    if (tagIds.length > 0) {
      const { error } = await supabaseService.from("restaurant_tags").insert(
        tagIds.map((tagId) => ({ restaurant_id: restaurant.id, tag_id: tagId })),
      );
      if (error) throw new Error(error.message);
    }
  }

  #mapRow(row: Record<string, unknown>): Restaurant {
    return {
      id: row.id as string,
      placeId: row.place_id as string,
      name: row.name as string,
      address: row.address as string,
      city: row.city as string,
      location: row.location as { lat: number; lng: number },
      googleRating: row.google_rating as number | null,
      googleRatingsCount: row.google_ratings_count as number | null,
      openNow: row.open_now as boolean | null,
      openingHours: row.opening_hours as Restaurant["openingHours"],
      websiteUrl: row.website_url as string | null,
      phoneNumber: row.phone_number as string | null,
      // coverImageUrl : auparavant non mappé (le repo retournait undefined),
      // ce qui faisait que les routes /restaurants/:id et .../summary envoyaient
      // toujours null à l'app → photo de couverture jamais affichée.
      coverImageUrl: row.cover_image_url as string | null,
      tags: this.#mapTags(row.restaurant_tags as unknown[]),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  #mapTags(rows: unknown[]): Restaurant["tags"] {
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => {
      const row = r as Record<string, Record<string, unknown>>;
      const cat = row.tags?.tag_categories as Record<string, unknown> | undefined;
      return {
        id: row.tags?.id as string,
        name: row.tags?.name as string,
        categoryId: cat?.id as string,
        categoryName: cat?.name as string,
        // categorySlug est résolu plus tard dans #enrichSlugs (voir loadCategorySlugs
        // pour pourquoi on ne le sélectionne pas inline : compat pré-migration 0006).
      };
    });
  }

  // Enrichit chaque tag avec son categorySlug en lookup-ant le cache module-level.
  // Si la migration 0006 n'a pas tourné, le cache est vide → tous les slugs restent
  // undefined côté API → l'app retombe gracefully sur ses fallbacks.
  async #enrichSlugs<T extends { tags: Restaurant["tags"] } | null>(r: T): Promise<T> {
    if (r === null) return r;
    const slugs = await loadCategorySlugs();
    return {
      ...r,
      tags: r.tags.map((t) => ({ ...t, categorySlug: slugs.get(t.categoryId) })),
    } as T;
  }

  async #enrichSlugsBatch(rs: Restaurant[]): Promise<Restaurant[]> {
    if (rs.length === 0) return rs;
    const slugs = await loadCategorySlugs();
    return rs.map((r) => ({
      ...r,
      tags: r.tags.map((t) => ({ ...t, categorySlug: slugs.get(t.categoryId) })),
    }));
  }
}
