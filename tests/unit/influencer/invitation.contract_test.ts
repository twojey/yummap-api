import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { IInfluencerInvitationRepository } from "../../../src/domain/influencer/invitation.repository.ts";
import type { InfluencerInvitation, PendingInfluencerProfile } from "../../../src/domain/influencer/invitation.types.ts";

class StubInvitationRepository implements IInfluencerInvitationRepository {
  private invitations = new Map<string, InfluencerInvitation>();
  private pendingProfiles = new Map<string, PendingInfluencerProfile>();
  private counter = 0;

  async create(params: Parameters<IInfluencerInvitationRepository["create"]>[0]): Promise<InfluencerInvitation> {
    const inv: InfluencerInvitation = {
      id: `inv_${++this.counter}`,
      token: crypto.randomUUID(),
      type: params.type,
      createdById: params.createdById,
      targetEmail: params.targetEmail ?? null,
      targetPhone: params.targetPhone ?? null,
      linkedInfluencerId: params.linkedInfluencerId ?? null,
      status: "pending",
      expiresAt: params.expiresAt,
      claimedById: null,
      createdAt: new Date().toISOString(),
    };
    this.invitations.set(inv.id, inv);
    return inv;
  }

  async findById(id: string): Promise<InfluencerInvitation | null> {
    return this.invitations.get(id) ?? null;
  }

  async findByToken(token: string): Promise<InfluencerInvitation | null> {
    return [...this.invitations.values()].find((i) => i.token === token) ?? null;
  }

  async findByCreator(createdById: string): Promise<InfluencerInvitation[]> {
    return [...this.invitations.values()].filter((i) => i.createdById === createdById);
  }

  async findLatestByLinkedInfluencer(linkedInfluencerId: string): Promise<InfluencerInvitation | null> {
    const matching = [...this.invitations.values()]
      .filter((i) => i.linkedInfluencerId === linkedInfluencerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matching[0] ?? null;
  }

  async refresh(id: string, expiresAt: string): Promise<InfluencerInvitation> {
    const inv = this.invitations.get(id);
    if (!inv) throw new Error("Invitation not found");
    const refreshed = { ...inv, status: "pending" as const, expiresAt };
    this.invitations.set(id, refreshed);
    return refreshed;
  }

  async claim(id: string, claimedById: string): Promise<InfluencerInvitation> {
    const inv = this.invitations.get(id);
    if (!inv) throw new Error("Invitation not found");
    const claimed = { ...inv, status: "claimed" as const, claimedById };
    this.invitations.set(id, claimed);
    return claimed;
  }

  async updateStatus(id: string, status: InfluencerInvitation["status"]): Promise<void> {
    const inv = this.invitations.get(id);
    if (inv) this.invitations.set(id, { ...inv, status });
  }

  async countActiveByCreator(createdById: string): Promise<number> {
    return [...this.invitations.values()].filter(
      (i) => i.createdById === createdById && i.status === "pending"
    ).length;
  }

  async createPendingProfile(profile: Omit<PendingInfluencerProfile, "createdAt">): Promise<PendingInfluencerProfile> {
    const p: PendingInfluencerProfile = { ...profile, createdAt: new Date().toISOString() };
    this.pendingProfiles.set(profile.userId, p);
    return p;
  }

  async findPendingProfiles(): Promise<PendingInfluencerProfile[]> {
    return [...this.pendingProfiles.values()].filter((p) => p.status === "pending_review");
  }

  async updatePendingStatus(userId: string, status: PendingInfluencerProfile["status"]): Promise<void> {
    const p = this.pendingProfiles.get(userId);
    if (p) this.pendingProfiles.set(userId, { ...p, status });
  }
}

const expiry = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();

Deno.test("IInfluencerInvitationRepository — create génère un token unique", async () => {
  const repo = new StubInvitationRepository();
  const inv1 = await repo.create({ type: "admin", createdById: "admin_1", expiresAt: expiry });
  const inv2 = await repo.create({ type: "admin", createdById: "admin_1", expiresAt: expiry });
  assertNotEquals(inv1.token, inv2.token);
  assertEquals(inv1.status, "pending");
});

Deno.test("IInfluencerInvitationRepository — findByToken retourne l'invitation", async () => {
  const repo = new StubInvitationRepository();
  const inv = await repo.create({ type: "admin", createdById: "admin_1", expiresAt: expiry });
  const found = await repo.findByToken(inv.token);
  assertExists(found);
  assertEquals(found.id, inv.id);
});

Deno.test("IInfluencerInvitationRepository — claim lie le claimedById", async () => {
  const repo = new StubInvitationRepository();
  const inv = await repo.create({ type: "admin", createdById: "admin_1", expiresAt: expiry });
  const claimed = await repo.claim(inv.id, "user_42");
  assertEquals(claimed.status, "claimed");
  assertEquals(claimed.claimedById, "user_42");
});

Deno.test("IInfluencerInvitationRepository — countActiveByCreator respecte la limite de 3", async () => {
  const repo = new StubInvitationRepository();
  for (let i = 0; i < 3; i++) {
    await repo.create({ type: "influencer", createdById: "inf_1", expiresAt: expiry });
  }
  const count = await repo.countActiveByCreator("inf_1");
  assertEquals(count, 3);
});

Deno.test("IInfluencerInvitationRepository — profil en attente créé et retrouvé", async () => {
  const repo = new StubInvitationRepository();
  await repo.createPendingProfile({
    userId: "u1",
    displayName: "Test Influencer",
    avatarUrl: null,
    bio: null,
    socialProfiles: [{ platform: "instagram", profileUrl: "https://instagram.com/test" }],
    invitedById: "inf_1",
    status: "pending_review",
  });
  const pending = await repo.findPendingProfiles();
  assertEquals(pending.length, 1);
  assertEquals(pending[0].userId, "u1");
});

Deno.test("IInfluencerInvitationRepository — updatePendingStatus active le profil", async () => {
  const repo = new StubInvitationRepository();
  await repo.createPendingProfile({
    userId: "u1",
    displayName: "Test",
    avatarUrl: null,
    bio: null,
    socialProfiles: [],
    invitedById: "inf_1",
    status: "pending_review",
  });
  await repo.updatePendingStatus("u1", "active");
  const pending = await repo.findPendingProfiles();
  assertEquals(pending.length, 0); // actif → plus en attente
});
