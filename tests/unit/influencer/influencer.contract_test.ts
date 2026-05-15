import { assertEquals, assertExists } from "@std/assert";
import type { IInfluencerRepository } from "../../../src/domain/influencer/influencer.repository.ts";
import type { Influencer, InfluencerForUser } from "../../../src/domain/influencer/influencer.types.ts";

const makeInfluencer = (overrides: Partial<Influencer> = {}): Influencer => ({
  id: "i1",
  displayName: "Le Fooding",
  avatarUrl: null,
  bio: "Guide gastronomique parisien",
  categories: ["gastro"],
  visibleAtOnboarding: true,
  guideCount: 5,
  followerCount: 1200,
  createdAt: new Date().toISOString(),
  ...overrides,
});

class StubInfluencerRepository implements IInfluencerRepository {
  private db = new Map<string, Influencer>();
  private following = new Map<string, Set<string>>(); // userId → Set<influencerId>

  seed(influencer: Influencer) {
    this.db.set(influencer.id, influencer);
    return this;
  }

  async findById(id: string, viewingUserId?: string): Promise<InfluencerForUser | null> {
    const inf = this.db.get(id);
    if (!inf) return null;
    const isFollowed = viewingUserId
      ? (this.following.get(viewingUserId)?.has(id) ?? false)
      : false;
    return { ...inf, isFollowed };
  }

  async getForOnboarding(preferredCategories: string[]): Promise<Influencer[]> {
    const all = [...this.db.values()].filter((i) => i.visibleAtOnboarding);
    const matching = all.filter((i) => i.categories.some((c) => preferredCategories.includes(c)));
    const rest = all.filter((i) => !matching.includes(i));
    return [...matching, ...rest];
  }

  async getFollowedByUser(userId: string): Promise<InfluencerForUser[]> {
    const ids = this.following.get(userId) ?? new Set();
    return [...ids]
      .map((id) => this.db.get(id))
      .filter((i): i is Influencer => i != null)
      .map((i) => ({ ...i, isFollowed: true }));
  }

  async getFollowedGuideIds(_userId: string): Promise<string[]> {
    return []; // stub minimal
  }

  async updateCategories(id: string, categories: string[]): Promise<void> {
    const inf = this.db.get(id);
    if (inf) this.db.set(id, { ...inf, categories });
  }

  async setVisibleAtOnboarding(id: string, visible: boolean): Promise<void> {
    const inf = this.db.get(id);
    if (inf) this.db.set(id, { ...inf, visibleAtOnboarding: visible });
  }

  _follow(userId: string, influencerId: string) {
    const set = this.following.get(userId) ?? new Set();
    set.add(influencerId);
    this.following.set(userId, set);
  }
}

Deno.test("IInfluencerRepository — findById retourne null si inexistant", async () => {
  const repo = new StubInfluencerRepository();
  assertEquals(await repo.findById("inconnu"), null);
});

Deno.test("IInfluencerRepository — findById retourne l'influenceur avec isFollowed=false", async () => {
  const repo = new StubInfluencerRepository().seed(makeInfluencer());
  const result = await repo.findById("i1");
  assertExists(result);
  assertEquals(result.isFollowed, false);
});

Deno.test("IInfluencerRepository — findById avec viewingUserId retourne isFollowed=true si suivi", async () => {
  const repo = new StubInfluencerRepository().seed(makeInfluencer());
  repo._follow("u1", "i1");
  const result = await repo.findById("i1", "u1");
  assertExists(result);
  assertEquals(result.isFollowed, true);
});

Deno.test("IInfluencerRepository — getForOnboarding : visibleAtOnboarding uniquement", async () => {
  const visible = makeInfluencer({ id: "i1", visibleAtOnboarding: true });
  const hidden = makeInfluencer({ id: "i2", visibleAtOnboarding: false });
  const repo = new StubInfluencerRepository().seed(visible).seed(hidden);
  const result = await repo.getForOnboarding([]);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "i1");
});

Deno.test("IInfluencerRepository — getForOnboarding : matchs catégories en tête", async () => {
  const gastro = makeInfluencer({ id: "i1", categories: ["gastro"], visibleAtOnboarding: true });
  const bar = makeInfluencer({ id: "i2", categories: ["bars"], visibleAtOnboarding: true });
  const repo = new StubInfluencerRepository().seed(gastro).seed(bar);
  const result = await repo.getForOnboarding(["gastro"]);
  assertEquals(result[0].id, "i1");
});

Deno.test("IInfluencerRepository — getFollowedByUser retourne [] avant follow", async () => {
  const repo = new StubInfluencerRepository().seed(makeInfluencer());
  assertEquals(await repo.getFollowedByUser("u1"), []);
});

Deno.test("IInfluencerRepository — getFollowedByUser retourne les influenceurs suivis", async () => {
  const repo = new StubInfluencerRepository().seed(makeInfluencer());
  repo._follow("u1", "i1");
  const result = await repo.getFollowedByUser("u1");
  assertEquals(result.length, 1);
  assertEquals(result[0].isFollowed, true);
});

Deno.test("IInfluencerRepository — updateCategories met à jour les catégories", async () => {
  const repo = new StubInfluencerRepository().seed(makeInfluencer({ categories: ["gastro"] }));
  await repo.updateCategories("i1", ["gastro", "bars"]);
  const result = await repo.findById("i1");
  assertEquals(result?.categories, ["gastro", "bars"]);
});

Deno.test("IInfluencerRepository — setVisibleAtOnboarding met à jour la visibilité", async () => {
  const repo = new StubInfluencerRepository().seed(makeInfluencer({ visibleAtOnboarding: true }));
  await repo.setVisibleAtOnboarding("i1", false);
  const result = await repo.findById("i1");
  assertEquals(result?.visibleAtOnboarding, false);
});
