import { assertEquals, assertExists, assertRejects } from "@std/assert";
import type { IGuideRepository } from "../../../src/domain/guide/guide.repository.ts";
import type { Guide, GuideWithRestaurants } from "../../../src/domain/guide/guide.types.ts";

// Stub conforme au contrat — aucune dépendance Supabase
class StubGuideRepository implements IGuideRepository {
  private guides = new Map<string, Guide>();
  private restaurants = new Map<string, Set<string>>();
  private counter = 0;

  async findById(id: string): Promise<Guide | null> {
    return this.guides.get(id) ?? null;
  }

  async findByInfluencer(influencerId: string): Promise<Guide[]> {
    return [...this.guides.values()].filter((g) => g.influencerId === influencerId);
  }

  async create(guide: Omit<Guide, "id" | "restaurantCount" | "createdAt" | "updatedAt">): Promise<Guide> {
    const id = `guide_${++this.counter}`;
    const created: Guide = {
      ...guide,
      id,
      restaurantCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.guides.set(id, created);
    return created;
  }

  async update(id: string, patch: Partial<Pick<Guide, "title" | "description" | "coverImageUrl">>): Promise<Guide> {
    const guide = this.guides.get(id);
    if (!guide) throw new Error(`Guide ${id} not found`);
    const updated = { ...guide, ...patch, updatedAt: new Date().toISOString() };
    this.guides.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.guides.delete(id);
  }

  async addRestaurant(guideId: string, restaurantId: string): Promise<void> {
    const set = this.restaurants.get(guideId) ?? new Set();
    set.add(restaurantId);
    this.restaurants.set(guideId, set);
    const guide = this.guides.get(guideId);
    if (guide) this.guides.set(guideId, { ...guide, restaurantCount: set.size });
  }

  async removeRestaurant(guideId: string, restaurantId: string): Promise<void> {
    const set = this.restaurants.get(guideId);
    set?.delete(restaurantId);
    const guide = this.guides.get(guideId);
    if (guide) this.guides.set(guideId, { ...guide, restaurantCount: set?.size ?? 0 });
  }

  async getWithRestaurants(id: string): Promise<GuideWithRestaurants | null> {
    const guide = this.guides.get(id);
    if (!guide) return null;
    return { ...guide, restaurantIds: [...(this.restaurants.get(id) ?? [])] };
  }
}

Deno.test("IGuideRepository — create retourne un Guide avec id non vide", async () => {
  const repo = new StubGuideRepository();
  const guide = await repo.create({ influencerId: "i1", title: "Bistrots du Marais", description: null, coverImageUrl: null });
  assertExists(guide.id);
  assertEquals(guide.title, "Bistrots du Marais");
  assertEquals(guide.restaurantCount, 0);
});

Deno.test("IGuideRepository — findById retourne null si inexistant", async () => {
  const repo = new StubGuideRepository();
  assertEquals(await repo.findById("inconnu"), null);
});

Deno.test("IGuideRepository — findById retourne le Guide après création", async () => {
  const repo = new StubGuideRepository();
  const created = await repo.create({ influencerId: "i1", title: "Test", description: null, coverImageUrl: null });
  const found = await repo.findById(created.id);
  assertExists(found);
  assertEquals(found.id, created.id);
});

Deno.test("IGuideRepository — findByInfluencer retourne uniquement ses Guides", async () => {
  const repo = new StubGuideRepository();
  await repo.create({ influencerId: "i1", title: "Guide 1", description: null, coverImageUrl: null });
  await repo.create({ influencerId: "i2", title: "Guide 2", description: null, coverImageUrl: null });
  const guides = await repo.findByInfluencer("i1");
  assertEquals(guides.length, 1);
  assertEquals(guides[0].influencerId, "i1");
});

Deno.test("IGuideRepository — addRestaurant incrémente restaurantCount", async () => {
  const repo = new StubGuideRepository();
  const guide = await repo.create({ influencerId: "i1", title: "Test", description: null, coverImageUrl: null });
  await repo.addRestaurant(guide.id, "r1");
  const updated = await repo.findById(guide.id);
  assertEquals(updated?.restaurantCount, 1);
});

Deno.test("IGuideRepository — getWithRestaurants retourne les restaurantIds", async () => {
  const repo = new StubGuideRepository();
  const guide = await repo.create({ influencerId: "i1", title: "Test", description: null, coverImageUrl: null });
  await repo.addRestaurant(guide.id, "r1");
  await repo.addRestaurant(guide.id, "r2");
  const withRestaurants = await repo.getWithRestaurants(guide.id);
  assertEquals(withRestaurants?.restaurantIds.length, 2);
});

Deno.test("IGuideRepository — delete supprime le Guide", async () => {
  const repo = new StubGuideRepository();
  const guide = await repo.create({ influencerId: "i1", title: "Test", description: null, coverImageUrl: null });
  await repo.delete(guide.id);
  assertEquals(await repo.findById(guide.id), null);
});

Deno.test("IGuideRepository — getWithRestaurants retourne [] avant addRestaurant", async () => {
  const repo = new StubGuideRepository();
  const guide = await repo.create({ influencerId: "i1", title: "Test", description: null, coverImageUrl: null });
  const result = await repo.getWithRestaurants(guide.id);
  assertEquals(result?.restaurantIds.length, 0);
});

Deno.test("IGuideRepository — removeRestaurant décrémente restaurantCount", async () => {
  const repo = new StubGuideRepository();
  const guide = await repo.create({ influencerId: "i1", title: "Test", description: null, coverImageUrl: null });
  await repo.addRestaurant(guide.id, "r1");
  await repo.addRestaurant(guide.id, "r2");
  await repo.removeRestaurant(guide.id, "r1");
  const updated = await repo.findById(guide.id);
  assertEquals(updated?.restaurantCount, 1);
});

Deno.test("IGuideRepository — getWithRestaurants retourne [] pour Guide inexistant", async () => {
  const repo = new StubGuideRepository();
  assertEquals(await repo.getWithRestaurants("inconnu"), null);
});
