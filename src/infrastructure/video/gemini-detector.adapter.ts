import { config } from "../../../config.ts";
import type { IRestaurantDetector, DetectionResult } from "../../domain/video/video.pipeline.ts";
import { DailyQuotaExceededError } from "../../shared/errors.ts";
import { parseDetectionJson } from "./detection-parser.ts";
import { buildExtractionPrompt } from "./restaurant-extraction.prompt.ts";

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
    const prompt = buildExtractionPrompt(input);
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
      throw new DailyQuotaExceededError("gemini", resumeAfter, parsed.quotaId ?? undefined);
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
