import { assertEquals } from "@std/assert";
import { normalizeHandle } from "../../../src/infrastructure/video/downloaders/ytdlp-downloader.ts";

Deno.test("normalizeHandle: handle valide yt-dlp", () => {
  assertEquals(normalizeHandle("gastro_no_meat"), "gastro_no_meat");
  assertEquals(normalizeHandle("@theovoyageurgourmand"), "theovoyageurgourmand");
  assertEquals(normalizeHandle("  paname_in_my_belly  "), "paname_in_my_belly");
});

Deno.test("normalizeHandle: champ absent yt-dlp (NA/None/vide) → null", () => {
  assertEquals(normalizeHandle("NA"), null);
  assertEquals(normalizeHandle("None"), null);
  assertEquals(normalizeHandle(""), null);
  assertEquals(normalizeHandle(undefined), null);
  assertEquals(normalizeHandle(null), null);
});
