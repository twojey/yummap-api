import type { DetectionResult, DetectedRestaurant } from "../../domain/video/video.pipeline.ts";

// Parse une réponse JSON brute d'un détecteur (Groq/Gemini/OpenAI) en
// DetectionResult validé. Accepte 2 shapes :
//
//   - Nouveau format multi-resto :
//       { status: "complete", restaurants: [{name, address, startSeconds?}, ...], tags? }
//
//   - Ancien format single-resto (régression possible si le modèle ne lit pas
//     bien le prompt — on est tolérant) :
//       { status: "complete", name, address, tags? }
//     → on l'enveloppe dans restaurants: [...] pour uniformiser.
//
// Filtre les entrées sans name OU sans address (l'IA hallucine parfois des
// placeholders comme name: "?" address: "Paris"). Si rien de valide ne reste,
// renvoie incomplete.
export function parseDetectionJson(raw: string): DetectionResult {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { status: "incomplete", missing: ["parse_error"] };
  }

  if (json.status === "incomplete") {
    return {
      status: "incomplete",
      missing: Array.isArray(json.missing) ? (json.missing as string[]) : ["unknown"],
    };
  }
  if (json.status !== "complete") {
    return { status: "incomplete", missing: ["unknown_status"] };
  }

  // Récupère la liste (nouveau format) OU fallback ancien format single-resto.
  let rawList: Array<Record<string, unknown>> = [];
  if (Array.isArray(json.restaurants)) {
    rawList = json.restaurants as Array<Record<string, unknown>>;
  } else if (typeof json.name === "string" && typeof json.address === "string") {
    rawList = [{ name: json.name, address: json.address }];
  }

  const restaurants: DetectedRestaurant[] = [];
  const seen = new Set<string>();
  for (const r of rawList) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const address = typeof r.address === "string" ? r.address.trim() : "";
    if (name.length === 0 || address.length === 0) continue;
    // Dédup basique : nom + 3 premiers caractères de l'adresse. Évite "Le Bon
    // Coin / 12 rue X" et "le bon coin / 12 RUE X" dupliqués.
    const key = `${name.toLowerCase()}|${address.toLowerCase().slice(0, 3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const startSeconds = typeof r.startSeconds === "number" ? r.startSeconds : null;
    restaurants.push({ name, address, startSeconds });
  }

  if (restaurants.length === 0) {
    return { status: "incomplete", missing: ["name", "address"] };
  }

  return {
    status: "complete",
    restaurants,
    // deno-lint-ignore no-explicit-any
    tags: Array.isArray(json.tags) ? (json.tags as any[]) : undefined,
  };
}
