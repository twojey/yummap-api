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

import { parseJsonDescription } from "../../../src/infrastructure/video/downloaders/ytdlp-downloader.ts";

Deno.test("parseJsonDescription: description JSON-encodée avec newlines/tabs", () => {
  assertEquals(
    parseJsonDescription('"Resto Le Pistil\\n12 rue de la Paix\\t75002 Paris"'),
    "Resto Le Pistil\n12 rue de la Paix\t75002 Paris",
  );
});

Deno.test("parseJsonDescription: absent/NA/None/vide/invalide → null", () => {
  assertEquals(parseJsonDescription(undefined), null);
  assertEquals(parseJsonDescription('"NA"'), null);
  assertEquals(parseJsonDescription('"None"'), null);
  assertEquals(parseJsonDescription('"  "'), null);
  assertEquals(parseJsonDescription("pas du json"), null);
  assertEquals(parseJsonDescription("42"), null);
});
