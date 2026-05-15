import { assertEquals } from "@std/assert";

// Helper sortVideosByFollow (extrait de routes/restaurants.routes.ts).
// Si on refactore le helper en module dédié, l'importer ici directement.
function sortVideosByFollow<T extends { uploader_id: string; created_at: string }>(
  videos: T[],
  followedSet: Set<string>,
): T[] {
  return [...videos].sort((a, b) => {
    const aFollowed = followedSet.has(a.uploader_id);
    const bFollowed = followedSet.has(b.uploader_id);
    if (aFollowed !== bFollowed) return aFollowed ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

Deno.test("sortVideosByFollow met les vidéos d'influenceurs suivis en tête", () => {
  const videos = [
    { uploader_id: "alice", created_at: "2026-05-15T10:00:00Z" },
    { uploader_id: "bob",   created_at: "2026-05-14T10:00:00Z" },
    { uploader_id: "carol", created_at: "2026-05-13T10:00:00Z" },
  ];
  const followed = new Set(["bob"]);
  const sorted = sortVideosByFollow(videos, followed);
  assertEquals(sorted[0].uploader_id, "bob");
});

Deno.test("sortVideosByFollow garde l'ordre chronologique au sein de chaque groupe", () => {
  const videos = [
    { uploader_id: "alice", created_at: "2026-05-10T10:00:00Z" }, // suivie, vieille
    { uploader_id: "bob",   created_at: "2026-05-15T10:00:00Z" }, // pas suivi, récente
    { uploader_id: "alice", created_at: "2026-05-14T10:00:00Z" }, // suivie, récente
    { uploader_id: "carol", created_at: "2026-05-13T10:00:00Z" }, // pas suivie
  ];
  const followed = new Set(["alice"]);
  const sorted = sortVideosByFollow(videos, followed);
  // Suivis (alice) d'abord, par date desc, puis non-suivis par date desc
  assertEquals(
    sorted.map((v) => `${v.uploader_id}@${v.created_at.slice(0, 10)}`),
    [
      "alice@2026-05-14",
      "alice@2026-05-10",
      "bob@2026-05-15",
      "carol@2026-05-13",
    ],
  );
});

Deno.test("sortVideosByFollow avec followedSet vide = tri chrono pur", () => {
  const videos = [
    { uploader_id: "a", created_at: "2026-05-13T10:00:00Z" },
    { uploader_id: "b", created_at: "2026-05-15T10:00:00Z" },
    { uploader_id: "c", created_at: "2026-05-14T10:00:00Z" },
  ];
  const sorted = sortVideosByFollow(videos, new Set());
  assertEquals(sorted.map((v) => v.uploader_id), ["b", "c", "a"]);
});
