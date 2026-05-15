import { assertEquals } from "@std/assert";
import {
  detectPlatform,
  extractExternalPostId,
} from "../../../src/infrastructure/video/url-parsing.ts";

Deno.test("detectPlatform: instagram", () => {
  assertEquals(detectPlatform("https://www.instagram.com/p/abc/"), "instagram");
  assertEquals(detectPlatform("https://instagram.com/reel/xyz/"), "instagram");
});

Deno.test("detectPlatform: tiktok", () => {
  assertEquals(
    detectPlatform("https://www.tiktok.com/@user/video/123"),
    "tiktok",
  );
  assertEquals(detectPlatform("https://vm.tiktok.com/abc/"), "tiktok");
});

Deno.test("detectPlatform: autre domaine → null", () => {
  assertEquals(detectPlatform("https://youtube.com/watch?v=x"), null);
  assertEquals(detectPlatform("not a url"), null);
});

Deno.test("extractExternalPostId: instagram /p/", () => {
  assertEquals(
    extractExternalPostId("https://www.instagram.com/p/Cabc123/"),
    "Cabc123",
  );
});

Deno.test("extractExternalPostId: instagram /reel/", () => {
  assertEquals(
    extractExternalPostId("https://www.instagram.com/reel/CxYz9/?igsh=zzz"),
    "CxYz9",
  );
});

Deno.test("extractExternalPostId: instagram /reels/", () => {
  assertEquals(
    extractExternalPostId("https://www.instagram.com/reels/REEL123/"),
    "REEL123",
  );
});

Deno.test("extractExternalPostId: instagram /tv/", () => {
  assertEquals(
    extractExternalPostId("https://www.instagram.com/tv/TV456/"),
    "TV456",
  );
});

Deno.test("extractExternalPostId: tiktok /video/", () => {
  assertEquals(
    extractExternalPostId("https://www.tiktok.com/@chef/video/7298765432"),
    "7298765432",
  );
});

Deno.test("extractExternalPostId: tiktok short URL vm.tiktok → null", () => {
  // Pas d'ID parsable depuis vm.tiktok.com (nécessite suivre la redirection).
  assertEquals(extractExternalPostId("https://vm.tiktok.com/AbC123"), null);
});

Deno.test("extractExternalPostId: domaine non supporté → null", () => {
  assertEquals(
    extractExternalPostId("https://youtube.com/watch?v=abc"),
    null,
  );
});

Deno.test("extractExternalPostId: URL invalide → null", () => {
  assertEquals(extractExternalPostId("not a url"), null);
});
