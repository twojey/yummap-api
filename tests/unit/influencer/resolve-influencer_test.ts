import { assertEquals } from "@std/assert";
import {
  type InfluencerLookupPort,
  normalizeInfluencerHandle,
  resolveInfluencerByHandle,
} from "../../../src/application/influencer/resolve-influencer.ts";

// ── normalizeInfluencerHandle ──────────────────────────────────────────────

Deno.test("normalizeInfluencerHandle: retire le @ et trim", () => {
  assertEquals(normalizeInfluencerHandle("@gastro_no_meat"), "gastro_no_meat");
  assertEquals(normalizeInfluencerHandle("  paname_in_my_belly  "), "paname_in_my_belly");
});

Deno.test("normalizeInfluencerHandle: écarte les valeurs vides/sentinelles", () => {
  assertEquals(normalizeInfluencerHandle(null), null);
  assertEquals(normalizeInfluencerHandle(undefined), null);
  assertEquals(normalizeInfluencerHandle(""), null);
  assertEquals(normalizeInfluencerHandle("   "), null);
  assertEquals(normalizeInfluencerHandle("NA"), null);
  assertEquals(normalizeInfluencerHandle("na"), null);
  assertEquals(normalizeInfluencerHandle("None"), null);
});

// ── resolveInfluencerByHandle ──────────────────────────────────────────────

// Stub du port : enregistre les appels pour les assertions.
class StubPort implements InfluencerLookupPort {
  constructor(private readonly existingId: string | null) {}
  findCalls: string[] = [];
  createCalls: string[] = [];
  ensureGuideCalls: Array<{ id: string; handle: string }> = [];
  createdId = "new-influencer-id";

  async findInfluencerByHandle(handle: string): Promise<string | null> {
    this.findCalls.push(handle);
    return this.existingId;
  }
  async createInfluencer(handle: string): Promise<string> {
    this.createCalls.push(handle);
    return this.createdId;
  }
  async ensureDefaultGuide(influencerId: string, handle: string): Promise<void> {
    this.ensureGuideCalls.push({ id: influencerId, handle });
  }
}

Deno.test("resolveInfluencerByHandle: influenceur existant → renvoie son id, pas de création", async () => {
  const port = new StubPort("existing-123");
  const id = await resolveInfluencerByHandle("@gastro_no_meat", port);

  assertEquals(id, "existing-123");
  assertEquals(port.findCalls, ["gastro_no_meat"]);
  assertEquals(port.createCalls, []); // pas de création
  assertEquals(port.ensureGuideCalls, [{ id: "existing-123", handle: "gastro_no_meat" }]);
});

Deno.test("resolveInfluencerByHandle: influenceur absent → création + guide", async () => {
  const port = new StubPort(null);
  const id = await resolveInfluencerByHandle("new_creator", port);

  assertEquals(id, "new-influencer-id");
  assertEquals(port.findCalls, ["new_creator"]);
  assertEquals(port.createCalls, ["new_creator"]);
  assertEquals(port.ensureGuideCalls, [{ id: "new-influencer-id", handle: "new_creator" }]);
});

Deno.test("resolveInfluencerByHandle: handle nul/invalide → null sans toucher le port", async () => {
  const port = new StubPort("whatever");
  assertEquals(await resolveInfluencerByHandle(null, port), null);
  assertEquals(await resolveInfluencerByHandle("NA", port), null);
  assertEquals(await resolveInfluencerByHandle("  ", port), null);
  assertEquals(port.findCalls, []);
  assertEquals(port.createCalls, []);
});
