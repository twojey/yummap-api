import { assertEquals, assertExists, assertRejects } from "@std/assert";
import type { IRestaurantRepository } from "../../../src/domain/restaurant/restaurant.repository.ts";
import type { Restaurant, SearchFilters } from "../../../src/domain/restaurant/restaurant.types.ts";
import type { BoundingBox } from "../../../src/domain/map/map.query.ts";

const makeRestaurant = (overrides: Partial<Restaurant> = {}): Restaurant => ({
  id: "r1",
  placeId: "place_1",
  name: "Le Comptoir du Relais",
  address: "9 Carrefour de l'Odéon, Paris 6e",
  city: "Paris",
  location: { lat: 48.8518, lng: 2.3374 },
  googleRating: 4.3,
  googleRatingsCount: 1240,
  openNow: true,
  openingHours: null,
  websiteUrl: null,
  phoneNumber: null,
  tags: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

class StubRestaurantRepository implements IRestaurantRepository {
  private db = new Map<string, Restaurant>();
  private tagAssignments = new Map<string, string[]>();

  async findById(placeId: string): Promise<Restaurant | null> {
    return this.db.get(placeId) ?? null;
  }

  async findByViewport(bbox: BoundingBox, filters?: SearchFilters): Promise<Restaurant[]> {
    return [...this.db.values()].filter((r) => {
      const inBbox =
        r.location.lat > bbox.swLat && r.location.lat < bbox.neLat &&
        r.location.lng > bbox.swLng && r.location.lng < bbox.neLng;
      const ratingOk = filters?.minRating == null || (r.googleRating ?? 0) >= filters.minRating;
      const openOk = filters?.openNow == null || r.openNow === filters.openNow;
      return inBbox && ratingOk && openOk;
    });
  }

  async findByGuide(_guideId: string, _filters?: SearchFilters): Promise<Restaurant[]> {
    // Stub minimal : retourne tous les restaurants
    return [...this.db.values()];
  }

  async search(filters: SearchFilters): Promise<Restaurant[]> {
    return [...this.db.values()].filter((r) => {
      const queryOk = !filters.query ||
        r.name.toLowerCase().includes(filters.query.toLowerCase()) ||
        r.address.toLowerCase().includes(filters.query.toLowerCase());
      const ratingOk = filters.minRating == null || (r.googleRating ?? 0) >= filters.minRating;
      return queryOk && ratingOk;
    });
  }

  async upsert(restaurant: Omit<Restaurant, "tags" | "createdAt" | "updatedAt">): Promise<Restaurant> {
    const existing = this.db.get(restaurant.placeId);
    const upserted: Restaurant = {
      ...restaurant,
      tags: existing?.tags ?? [],
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.db.set(restaurant.placeId, upserted);
    return upserted;
  }

  async assignTags(placeId: string, tagIds: string[]): Promise<void> {
    this.tagAssignments.set(placeId, tagIds);
  }
}

const paris: BoundingBox = { swLat: 48.80, swLng: 2.20, neLat: 48.90, neLng: 2.40 };

Deno.test("IRestaurantRepository — findById retourne null si inexistant", async () => {
  const repo = new StubRestaurantRepository();
  assertEquals(await repo.findById("inconnu"), null);
});

Deno.test("IRestaurantRepository — upsert crée le restaurant", async () => {
  const repo = new StubRestaurantRepository();
  const r = makeRestaurant();
  const { tags: _, createdAt: __, updatedAt: ___, ...rest } = r;
  const created = await repo.upsert(rest);
  assertExists(created.placeId);
  assertEquals(created.name, "Le Comptoir du Relais");
});

Deno.test("IRestaurantRepository — upsert est idempotent sur placeId", async () => {
  const repo = new StubRestaurantRepository();
  const base = makeRestaurant();
  const { tags: _, createdAt: __, updatedAt: ___, ...rest } = base;
  await repo.upsert(rest);
  const updated = await repo.upsert({ ...rest, name: "Nom modifié" });
  assertEquals(updated.name, "Nom modifié");
  assertEquals(updated.placeId, "place_1");
});

Deno.test("IRestaurantRepository — findById retourne le restaurant après upsert", async () => {
  const repo = new StubRestaurantRepository();
  const r = makeRestaurant();
  const { tags: _, createdAt: __, updatedAt: ___, ...rest } = r;
  await repo.upsert(rest);
  const found = await repo.findById("place_1");
  assertExists(found);
  assertEquals(found.placeId, "place_1");
});

Deno.test("IRestaurantRepository — findByViewport retourne les restaurants dans la bbox", async () => {
  const repo = new StubRestaurantRepository();
  const inParis = makeRestaurant({ placeId: "p1", location: { lat: 48.85, lng: 2.33 } });
  const outOfParis = makeRestaurant({ placeId: "p2", location: { lat: 45.0, lng: 2.33 } });
  const { tags: _, createdAt: __, updatedAt: ___, ...r1 } = inParis;
  const { tags: _t, createdAt: _c, updatedAt: _u, ...r2 } = outOfParis;
  await repo.upsert(r1);
  await repo.upsert(r2);
  const result = await repo.findByViewport(paris);
  assertEquals(result.length, 1);
  assertEquals(result[0].placeId, "p1");
});

Deno.test("IRestaurantRepository — findByViewport filtre par minRating", async () => {
  const repo = new StubRestaurantRepository();
  const high = makeRestaurant({ placeId: "p1", googleRating: 4.5, location: { lat: 48.85, lng: 2.33 } });
  const low  = makeRestaurant({ placeId: "p2", googleRating: 3.0, location: { lat: 48.85, lng: 2.34 } });
  for (const r of [high, low]) {
    const { tags: _, createdAt: __, updatedAt: ___, ...rest } = r;
    await repo.upsert(rest);
  }
  const result = await repo.findByViewport(paris, { minRating: 4.0 });
  assertEquals(result.length, 1);
  assertEquals(result[0].placeId, "p1");
});

Deno.test("IRestaurantRepository — search par nom", async () => {
  const repo = new StubRestaurantRepository();
  const r = makeRestaurant();
  const { tags: _, createdAt: __, updatedAt: ___, ...rest } = r;
  await repo.upsert(rest);
  const result = await repo.search({ query: "Comptoir" });
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Le Comptoir du Relais");
});

Deno.test("IRestaurantRepository — search retourne [] si aucun match", async () => {
  const repo = new StubRestaurantRepository();
  const r = makeRestaurant();
  const { tags: _, createdAt: __, updatedAt: ___, ...rest } = r;
  await repo.upsert(rest);
  const result = await repo.search({ query: "zzz_inconnu" });
  assertEquals(result.length, 0);
});

Deno.test("IRestaurantRepository — assignTags ne lève pas d'erreur", async () => {
  const repo = new StubRestaurantRepository();
  await repo.assignTags("place_1", ["tag_1", "tag_2"]);
  // Pas de retour à vérifier — contrat : void, pas d'erreur
});
