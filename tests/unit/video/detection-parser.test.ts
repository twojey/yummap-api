import { assertEquals } from "@std/assert";
import { parseDetectionJson } from "../../../src/infrastructure/video/detection-parser.ts";

Deno.test("parseDetectionJson: shape multi-resto standard", () => {
  const raw = JSON.stringify({
    status: "complete",
    restaurants: [
      { name: "Sapore", address: "10 rue de Rivoli", startSeconds: 12 },
      { name: "Bambino", address: "5 rue Saint-Honoré", startSeconds: null },
    ],
    tags: [{ category: "cuisine", name: "italienne" }],
  });
  const r = parseDetectionJson(raw);
  assertEquals(r.status, "complete");
  if (r.status === "complete") {
    assertEquals(r.restaurants.length, 2);
    assertEquals(r.restaurants[0].startSeconds, 12);
    assertEquals(r.tags?.length, 1);
  }
});

Deno.test("parseDetectionJson: tolère le shape ancien single-resto", () => {
  // Si un modèle régresse au format pré-Sprint B, on l'enveloppe quand même.
  const raw = JSON.stringify({
    status: "complete",
    name: "Le Comptoir",
    address: "9 Carrefour de l'Odéon",
    tags: [],
  });
  const r = parseDetectionJson(raw);
  assertEquals(r.status, "complete");
  if (r.status === "complete") {
    assertEquals(r.restaurants.length, 1);
    assertEquals(r.restaurants[0].name, "Le Comptoir");
  }
});

Deno.test("parseDetectionJson: déduplique les restos en double", () => {
  const raw = JSON.stringify({
    status: "complete",
    restaurants: [
      { name: "Le Bon Coin", address: "12 rue X" },
      { name: "le bon coin", address: "12 RUE X" }, // case-différente, dédup
      { name: "Autre", address: "99 rue Y" },
    ],
  });
  const r = parseDetectionJson(raw);
  if (r.status === "complete") {
    assertEquals(r.restaurants.length, 2);
  }
});

Deno.test("parseDetectionJson: vire les entrées avec name ou address vides", () => {
  const raw = JSON.stringify({
    status: "complete",
    restaurants: [
      { name: "OK", address: "10 rue X" },
      { name: "", address: "Paris" },
      { name: "?", address: "" },
    ],
  });
  const r = parseDetectionJson(raw);
  if (r.status === "complete") {
    assertEquals(r.restaurants.length, 1);
    assertEquals(r.restaurants[0].name, "OK");
  }
});

Deno.test("parseDetectionJson: 0 resto valide → incomplete", () => {
  const raw = JSON.stringify({
    status: "complete",
    restaurants: [{ name: "", address: "" }],
  });
  const r = parseDetectionJson(raw);
  assertEquals(r.status, "incomplete");
});

Deno.test("parseDetectionJson: JSON invalide → incomplete parse_error", () => {
  const r = parseDetectionJson("not json {");
  assertEquals(r.status, "incomplete");
  if (r.status === "incomplete") {
    assertEquals(r.missing, ["parse_error"]);
  }
});

Deno.test("parseDetectionJson: status incomplete passe through", () => {
  const raw = JSON.stringify({ status: "incomplete", missing: ["name"] });
  const r = parseDetectionJson(raw);
  assertEquals(r.status, "incomplete");
  if (r.status === "incomplete") {
    assertEquals(r.missing, ["name"]);
  }
});
