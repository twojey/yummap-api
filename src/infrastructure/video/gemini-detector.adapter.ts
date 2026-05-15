import { config } from "../../../config.ts";
import type { IRestaurantDetector, DetectionResult } from "../../domain/video/video.pipeline.ts";
import { DailyQuotaExceededError } from "../../shared/errors.ts";
import { parseDetectionJson } from "./detection-parser.ts";

// Parse une réponse d'erreur Google API (google.rpc.Status). Renvoie:
// - isDaily: true si la violation est un quota PerDay (vs PerMinute)
// - retryDelaySec: secondes recommandées par Google (RetryInfo)
// - quotaId: identifiant du quota épuisé (pour logs)
interface ParsedQuotaError {
  isDaily: boolean;
  retryDelaySec: number | null;
  quotaId: string | null;
}

export class GeminiDetectorAdapter implements IRestaurantDetector {
  static #parseQuotaError(body: string): ParsedQuotaError {
    try {
      const j = JSON.parse(body) as {
        error?: {
          details?: Array<{
            "@type"?: string;
            retryDelay?: string;
            violations?: Array<{ quotaId?: string }>;
          }>;
        };
      };
      const details = j.error?.details ?? [];
      const retryInfo = details.find((d) => (d["@type"] ?? "").endsWith("RetryInfo"));
      const quotaFailure = details.find((d) => (d["@type"] ?? "").endsWith("QuotaFailure"));
      const quotaId = quotaFailure?.violations?.[0]?.quotaId ?? null;
      const isDaily = (quotaId ?? "").includes("PerDay");
      const m = retryInfo?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
      const retryDelaySec = m ? Math.ceil(parseFloat(m[1])) : null;
      return { isDaily, retryDelaySec, quotaId };
    } catch {
      // Fallback heuristique : si le texte mentionne `per_minute`, c'est RPM, sinon daily
      const isDaily = /free_tier_requests(?!_per_minute)/i.test(body);
      return { isDaily, retryDelaySec: null, quotaId: null };
    }
  }

  async detect(input: { description: string; transcription: string }): Promise<DetectionResult> {
    // Prompt aligné sur la taxonomie de la base (migration 0006) :
    // 5 catégories standard avec slug fixe. cuisine est OBLIGATOIRE — sans ça,
    // l'import est marqué incomplete (le pipeline ne crée pas de resto sans cuisine).
    // Les 4 autres sont optionnelles : on préfère 0 tag à un mauvais tag.
    const prompt = `
Tu es un assistant qui extrait les restaurants mentionnés dans la description et la transcription d'une vidéo TikTok/Instagram. La vidéo peut parler d'1, 2 ou plusieurs restaurants (compilations "top 5", food crawls "on a fait 3 spots"…).

Description de la vidéo : """${input.description}"""
Transcription audio : """${input.transcription}"""

Réponds UNIQUEMENT en JSON valide, sans markdown. Deux formats possibles :

Si tu identifies au moins 1 restaurant avec son nom ET son adresse/arrondissement :
{
  "status": "complete",
  "restaurants": [
    { "name": "<nom>", "address": "<adresse>", "startSeconds": <int|null> }
    // ... un objet par restaurant dans l'ordre où ils apparaissent dans la vidéo
  ],
  "tags": [
    // OBLIGATOIRE : exactement 1 tag de cuisine si tu peux la déterminer
    {"category": "cuisine",  "name": "<ex: italienne, française, japonaise, libanaise, mexicaine, asiatique, méditerranéenne>"},

    // OPTIONNEL : 0 ou plusieurs tags par catégorie ci-dessous, uniquement si la vidéo l'indique clairement
    {"category": "dietary",  "name": "<ex: vegan, végétarien, halal, casher, sans gluten, sans lactose, bio>"},
    {"category": "dish",     "name": "<ex: pizza, burger, sushi, kebab, ramen, tacos, pâtes, brunch, poke>"},
    {"category": "ambiance", "name": "<ex: romantique, familial, chic, branché, calme, business, festif, terrasse, rooftop>"},
    {"category": "formula",  "name": "<ex: à volonté, brunch, gastronomique, street food, fast-food, bistrot, bar à vin, omakase>"}
  ]
}

Règles strictes :
- N'invente AUCUN restaurant. Si tu n'es pas certain qu'un endroit est mentionné, ne le mets pas.
- startSeconds : uniquement si tu vois clairement un repère dans la transcription, sinon null.
- Les tags sont partagés (la vidéo a une ambiance globale, pas un set de tags par resto).
- Catégories de tags autorisées UNIQUEMENT : cuisine, dietary, dish, ambiance, formula.
- Tous les "name" en français, en minuscules.
- Si la cuisine n'est pas claire, mets "fusion" ou "world" plutôt que de deviner.
- Ne devine JAMAIS dietary/dish/ambiance/formula : ne mets le tag que si la vidéo le dit explicitement.

Si tu ne trouves pas le nom OU l'adresse d'au moins 1 restaurant :
{"status": "incomplete", "missing": ["name"|"address"]}
    `.trim();

    const response = await this.#callWithRetry(prompt);

    const data = await response.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    return parseDetectionJson(cleaned);
  }

  // Retry exponentiel avec respect du Retry-After Google.
  // Distinction:
  // - 429 "per_minute" (RPM transitoire) → retry court (4→64s)
  // - 429 "per_day" / sans suffixe (quota DAILY) → throw DailyQuotaExceededError
  //   (le caller pause le job et le reprend plus tard, on bloque pas le worker)
  // - 5xx → retry
  async #callWithRetry(prompt: string, attempt = 0): Promise<Response> {
    const maxAttempts = 4;
    const response = await fetch(
      // flash-lite : quotas free tier plus larges que flash, qualité OK pour notre prompt
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${config.gemini.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 256,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (response.ok) return response;

    // Lecture du body une seule fois pour décider du retry
    const body = await response.text();

    // Parse les détails Google rpc.Status pour décider du retry :
    // - QuotaFailure.violations[].quotaId contient "PerDay" → quota daily
    // - RetryInfo.retryDelay = délai recommandé par Google (ex: "31s")
    const parsed = GeminiDetectorAdapter.#parseQuotaError(body);
    if (response.status === 429 && parsed.isDaily) {
      // On respecte le retryDelay de Google (avec un floor de 60s pour éviter le burst)
      const delayMs = Math.max(parsed.retryDelaySec ?? 60, 60) * 1000;
      const resumeAfter = new Date(Date.now() + delayMs);
      console.warn(`[Gemini] DAILY quota ${parsed.quotaId} exceeded → pause ${delayMs / 1000}s (until ${resumeAfter.toISOString()})`);
      throw new DailyQuotaExceededError("gemini", resumeAfter, parsed.quotaId);
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxAttempts - 1) {
      throw new Error(`Gemini API error: ${response.status} ${body.slice(0, 300)}`);
    }

    // Délai à attendre : priorité au RetryInfo de Google (body), sinon header
    // Retry-After, sinon backoff exponentiel 4 → 8 → 16 → 32 s
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSec = parsed.retryDelaySec
      ?? (retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? parseInt(retryAfterHeader, 10) : null)
      ?? Math.min(32, 4 * Math.pow(2, attempt));
    console.log(`[Gemini] ${response.status} retry in ${retryAfterSec}s (attempt ${attempt + 1}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
    return this.#callWithRetry(prompt, attempt + 1);
  }
}
