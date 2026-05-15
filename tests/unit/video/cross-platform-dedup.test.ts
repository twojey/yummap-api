import { assertEquals, assertNotEquals, assert } from "@std/assert";
import {
  buildFingerprintCriteria,
  buildHeuristicCriteria,
  computeContentFingerprint,
  DEFAULT_HEURISTIC_WINDOW_HOURS,
  isFingerprintReliable,
  normalizeForFingerprint,
} from "../../../src/domain/video/cross-platform-dedup.ts";

// ── normalizeForFingerprint ──────────────────────────────────────────────────

Deno.test("normalize: insensible à la casse", () => {
  assertEquals(normalizeForFingerprint("Pizza Mario"), normalizeForFingerprint("pizza mario"));
});

Deno.test("normalize: insensible aux accents", () => {
  assertEquals(normalizeForFingerprint("café à Paris"), normalizeForFingerprint("cafe a paris"));
});

Deno.test("normalize: collapse ponctuation et espaces", () => {
  assertEquals(
    normalizeForFingerprint("Bonjour !! Bienvenue,  chez   Mario."),
    "bonjour bienvenue chez mario",
  );
});

Deno.test("normalize: chaîne vide → chaîne vide", () => {
  assertEquals(normalizeForFingerprint(""), "");
});

// ── computeContentFingerprint ────────────────────────────────────────────────

Deno.test("fingerprint: deux textes équivalents (casse/accents) → même hash", async () => {
  const a = await computeContentFingerprint({
    transcription: "Le café est délicieux chez Mario",
    restaurantIds: ["r1"],
  });
  const b = await computeContentFingerprint({
    transcription: "LE CAFE EST DELICIEUX CHEZ MARIO!!",
    restaurantIds: ["r1"],
  });
  assertEquals(a, b);
});

Deno.test("fingerprint: ordre des restaurantIds n'a pas d'importance", async () => {
  const a = await computeContentFingerprint({
    transcription: "burger top",
    restaurantIds: ["r1", "r2", "r3"],
  });
  const b = await computeContentFingerprint({
    transcription: "burger top",
    restaurantIds: ["r3", "r1", "r2"],
  });
  assertEquals(a, b);
});

Deno.test("fingerprint: change si le contenu change", async () => {
  const a = await computeContentFingerprint({
    transcription: "burger top",
    restaurantIds: ["r1"],
  });
  const b = await computeContentFingerprint({
    transcription: "pizza top",
    restaurantIds: ["r1"],
  });
  assertNotEquals(a, b);
});

Deno.test("fingerprint: change si les restos changent", async () => {
  const a = await computeContentFingerprint({
    transcription: "même texte",
    restaurantIds: ["r1"],
  });
  const b = await computeContentFingerprint({
    transcription: "même texte",
    restaurantIds: ["r2"],
  });
  assertNotEquals(a, b);
});

Deno.test("fingerprint: format hex 64 chars (sha256)", async () => {
  const fp = await computeContentFingerprint({
    transcription: "x",
    restaurantIds: ["r1"],
  });
  assertEquals(fp.length, 64);
  assert(/^[0-9a-f]+$/.test(fp), "fingerprint doit être hex");
});

// ── isFingerprintReliable ───────────────────────────────────────────────────

Deno.test("reliable: au moins 1 resto détecté → fiable même sans texte", () => {
  assertEquals(
    isFingerprintReliable({ transcription: "", restaurantIds: ["r1"] }),
    true,
  );
});

Deno.test("reliable: pas de resto + texte court → NON fiable", () => {
  assertEquals(
    isFingerprintReliable({ transcription: "ok", restaurantIds: [] }),
    false,
  );
});

Deno.test("reliable: pas de resto + texte long → fiable", () => {
  const text = "lorem ipsum dolor sit amet consectetur adipiscing";
  assertEquals(
    isFingerprintReliable({ transcription: text, restaurantIds: [] }),
    true,
  );
});

// ── buildFingerprintCriteria ────────────────────────────────────────────────

Deno.test("fingerprintCriteria: fenêtre 30j par défaut", () => {
  const now = new Date("2026-05-15T12:00:00Z");
  const c = buildFingerprintCriteria("abc", ["r1"], now);
  const expectedMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  assertEquals(c.postedAtMin.toISOString(), expectedMin.toISOString());
});

Deno.test("fingerprintCriteria: fenêtre paramétrable", () => {
  const now = new Date("2026-05-15T12:00:00Z");
  const c = buildFingerprintCriteria("abc", ["r1"], now, 7);
  const expectedMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  assertEquals(c.postedAtMin.toISOString(), expectedMin.toISOString());
});

// ── buildHeuristicCriteria ──────────────────────────────────────────────────

Deno.test("heuristicCriteria: null si postedAt manquant", () => {
  const c = buildHeuristicCriteria({
    uploaderId: "u1",
    restaurantIds: ["r1"],
    postedAt: null,
  });
  assertEquals(c, null);
});

Deno.test("heuristicCriteria: null si aucun resto détecté", () => {
  const c = buildHeuristicCriteria({
    uploaderId: "u1",
    restaurantIds: [],
    postedAt: new Date(),
  });
  assertEquals(c, null);
});

Deno.test("heuristicCriteria: fenêtre symétrique ±48h sur posted_at", () => {
  const postedAt = new Date("2026-05-15T12:00:00Z");
  const c = buildHeuristicCriteria({
    uploaderId: "u1",
    restaurantIds: ["r1"],
    postedAt,
  });
  assert(c !== null);
  const expectedMin = new Date(
    postedAt.getTime() - DEFAULT_HEURISTIC_WINDOW_HOURS * 60 * 60 * 1000,
  );
  const expectedMax = new Date(
    postedAt.getTime() + DEFAULT_HEURISTIC_WINDOW_HOURS * 60 * 60 * 1000,
  );
  assertEquals(c.postedAtMin.toISOString(), expectedMin.toISOString());
  assertEquals(c.postedAtMax.toISOString(), expectedMax.toISOString());
});

Deno.test("heuristicCriteria: fenêtre custom respectée", () => {
  const postedAt = new Date("2026-05-15T12:00:00Z");
  const c = buildHeuristicCriteria({
    uploaderId: "u1",
    restaurantIds: ["r1"],
    postedAt,
    windowHours: 12,
  });
  assert(c !== null);
  const expectedMin = new Date(postedAt.getTime() - 12 * 60 * 60 * 1000);
  assertEquals(c.postedAtMin.toISOString(), expectedMin.toISOString());
});

// ── Scénarios métier (intégration logique pure) ─────────────────────────────

Deno.test("scénario: même vidéo publiée IG et TikTok → même fingerprint", async () => {
  // Hypothèse : Whisper produit la même transcription (modulo bruit insignifiant)
  // sur la même piste audio, et les mêmes restos sont détectés.
  const igFingerprint = await computeContentFingerprint({
    transcription: "Cette pizzeria à Bastille est incroyable !!",
    restaurantIds: ["pizza-mario", "bar-suzanne"],
  });
  const tiktokFingerprint = await computeContentFingerprint({
    transcription: "cette pizzeria a bastille est INCROYABLE",
    restaurantIds: ["bar-suzanne", "pizza-mario"], // ordre différent
  });
  assertEquals(igFingerprint, tiktokFingerprint);
});

Deno.test("scénario: 2 vidéos différentes au même resto → fingerprints différents", async () => {
  const visit1 = await computeContentFingerprint({
    transcription: "premier passage chez Mario, j'ai pris la margherita",
    restaurantIds: ["pizza-mario"],
  });
  const visit2 = await computeContentFingerprint({
    transcription: "retour chez Mario six mois plus tard pour la napoletana",
    restaurantIds: ["pizza-mario"],
  });
  assertNotEquals(visit1, visit2);
});

// ── parseYtDlpTimestamp ─────────────────────────────────────────────────────

import { parseYtDlpTimestamp } from "../../../src/infrastructure/video/ytdlp-timestamp.ts";

Deno.test("parseYtDlpTimestamp: timestamp Unix valide → Date", () => {
  const d = parseYtDlpTimestamp("1715774400\n");
  assert(d instanceof Date);
  assertEquals(d!.toISOString(), "2024-05-15T12:00:00.000Z");
});

Deno.test("parseYtDlpTimestamp: 'NA' → null", () => {
  assertEquals(parseYtDlpTimestamp("NA\n"), null);
});

Deno.test("parseYtDlpTimestamp: chaîne vide → null", () => {
  assertEquals(parseYtDlpTimestamp(""), null);
});

Deno.test("parseYtDlpTimestamp: ignore les lignes non numériques et garde la valable", () => {
  const d = parseYtDlpTimestamp("[info] Downloading\n1715774400\n[done]\n");
  assert(d instanceof Date);
  assertEquals(d!.toISOString(), "2024-05-15T12:00:00.000Z");
});

Deno.test("parseYtDlpTimestamp: timestamp 0 ou négatif → null", () => {
  assertEquals(parseYtDlpTimestamp("0\n"), null);
  assertEquals(parseYtDlpTimestamp("-1234\n"), null);
});
