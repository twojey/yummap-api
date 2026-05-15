import { assertEquals } from "@std/assert";

// Test isolé de la logique de matching des suggestions onboarding.
// Réplique le tri appliqué dans influencers.routes.ts:GET /influencers/onboarding.
function scoreAndSort(
  influencers: Array<{ id: string; categories: string[]; followerCount: number }>,
  wanted: string[],
) {
  const wantedLower = wanted.map((w) => w.toLowerCase());
  const scored = influencers.map((u) => {
    const cats = u.categories.map((c) => c.toLowerCase());
    const score = wantedLower.length === 0
      ? 0
      : wantedLower.filter((w) => cats.includes(w)).length;
    return { ...u, _score: score };
  });
  scored.sort((a, b) => {
    if (a._score !== b._score) return b._score - a._score;
    return b.followerCount - a.followerCount;
  });
  return scored.map((u) => u.id);
}

Deno.test("Onboarding : influenceurs avec catégories matchant en tête", () => {
  const influencers = [
    { id: "alice", categories: ["gastro"],          followerCount: 10 },
    { id: "bob",   categories: ["bars", "vegan"],   followerCount: 50 },
    { id: "carol", categories: ["gastro", "vegan"], followerCount: 30 },
    { id: "dave",  categories: [],                  followerCount: 100 },
  ];
  // L'utilisateur cherche gastro + vegan : carol score=2, alice=1, bob=1, dave=0
  // À score égal, on retombe sur followers desc.
  assertEquals(
    scoreAndSort(influencers, ["gastro", "vegan"]),
    ["carol", "bob", "alice", "dave"],
  );
});

Deno.test("Onboarding : aucune catégorie demandée = tri par followers desc", () => {
  const influencers = [
    { id: "a", categories: ["gastro"], followerCount: 10 },
    { id: "b", categories: [],         followerCount: 50 },
    { id: "c", categories: ["bar"],    followerCount: 30 },
  ];
  assertEquals(
    scoreAndSort(influencers, []),
    ["b", "c", "a"],
  );
});

Deno.test("Onboarding : matching insensible à la casse", () => {
  const influencers = [
    { id: "a", categories: ["Gastro", "VEGAN"], followerCount: 1 },
    { id: "b", categories: ["bar"],             followerCount: 100 },
  ];
  // "gastro" en lowercase doit matcher "Gastro" stocké en mixed case
  assertEquals(
    scoreAndSort(influencers, ["gastro"]),
    ["a", "b"],
  );
});
