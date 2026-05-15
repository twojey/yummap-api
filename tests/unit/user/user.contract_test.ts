import { assertEquals, assertExists } from "@std/assert";
import type { IUserRepository } from "../../../src/domain/user/user.repository.ts";
import type { User } from "../../../src/domain/user/user.types.ts";

class StubUserRepository implements IUserRepository {
  private users = new Map<string, User>();
  private following = new Map<string, Set<string>>();
  private watchlists = new Map<string, Set<string>>();

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async upsert(user: Pick<User, "id" | "role"> & { displayName: string; phoneNumber: string }): Promise<User> {
    const existing = this.users.get(user.id);
    const upserted: User = existing
      ? { ...existing, displayName: user.displayName, phoneNumber: user.phoneNumber }
      : {
          ...user,
          avatarUrl: null,
          preferences: {
            experiences: [],
            dietaryConstraints: [],
            notificationsEnabled: { newVideo: true, newGuide: true, importComplete: true },
          },
          createdAt: new Date().toISOString(),
        };
    this.users.set(user.id, upserted);
    return upserted;
  }

  async updatePreferences(id: string, prefs: Partial<User["preferences"]>): Promise<void> {
    const user = this.users.get(id);
    if (user) {
      this.users.set(id, { ...user, preferences: { ...user.preferences, ...prefs } });
    }
  }

  async getFollowing(userId: string): Promise<string[]> {
    return [...(this.following.get(userId) ?? [])];
  }

  async follow(userId: string, influencerId: string): Promise<void> {
    const set = this.following.get(userId) ?? new Set();
    set.add(influencerId);
    this.following.set(userId, set);
  }

  async unfollow(userId: string, influencerId: string): Promise<void> {
    this.following.get(userId)?.delete(influencerId);
  }

  async getWatchlist(userId: string): Promise<string[]> {
    return [...(this.watchlists.get(userId) ?? [])];
  }

  async addToWatchlist(userId: string, restaurantId: string): Promise<void> {
    const set = this.watchlists.get(userId) ?? new Set();
    set.add(restaurantId);
    this.watchlists.set(userId, set);
  }

  async removeFromWatchlist(userId: string, restaurantId: string): Promise<void> {
    this.watchlists.get(userId)?.delete(restaurantId);
  }

  async registerPushToken(_userId: string, _token: string, _platform: "ios" | "android"): Promise<void> {}
}

Deno.test("IUserRepository — upsert crée un User avec id + displayName + phoneNumber", async () => {
  const repo = new StubUserRepository();
  const user = await repo.upsert({ id: "u1", role: "user", displayName: "Thomas", phoneNumber: "+33600000000" });
  assertEquals(user.id, "u1");
  assertEquals(user.role, "user");
  assertEquals(user.displayName, "Thomas");
  assertEquals(user.phoneNumber, "+33600000000");
});

Deno.test("IUserRepository — findById retourne null avant upsert", async () => {
  const repo = new StubUserRepository();
  assertEquals(await repo.findById("u_inconnu"), null);
});

Deno.test("IUserRepository — upsert idempotent : même id retourne le même User", async () => {
  const repo = new StubUserRepository();
  await repo.upsert({ id: "u1", role: "user", displayName: "Thomas", phoneNumber: "+33600000000" });
  const second = await repo.upsert({ id: "u1", role: "user", displayName: "Thomas", phoneNumber: "+33600000000" });
  assertEquals(second.id, "u1");
});

Deno.test("IUserRepository — follow / getFollowing", async () => {
  const repo = new StubUserRepository();
  await repo.upsert({ id: "u1", role: "user", displayName: "Thomas", phoneNumber: "+33600000000" });
  assertEquals(await repo.getFollowing("u1"), []);
  await repo.follow("u1", "i1");
  const following = await repo.getFollowing("u1");
  assertEquals(following.includes("i1"), true);
});

Deno.test("IUserRepository — unfollow retire l'influenceur", async () => {
  const repo = new StubUserRepository();
  await repo.follow("u1", "i1");
  await repo.unfollow("u1", "i1");
  assertEquals(await repo.getFollowing("u1"), []);
});

Deno.test("IUserRepository — addToWatchlist / getWatchlist", async () => {
  const repo = new StubUserRepository();
  await repo.addToWatchlist("u1", "r1");
  const watchlist = await repo.getWatchlist("u1");
  assertEquals(watchlist.includes("r1"), true);
});

Deno.test("IUserRepository — removeFromWatchlist retire le restaurant", async () => {
  const repo = new StubUserRepository();
  await repo.addToWatchlist("u1", "r1");
  await repo.removeFromWatchlist("u1", "r1");
  assertEquals(await repo.getWatchlist("u1"), []);
});
