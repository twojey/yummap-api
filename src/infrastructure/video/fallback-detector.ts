import type { IRestaurantDetector, DetectionResult } from "../../domain/video/video.pipeline.ts";
import { DailyQuotaExceededError } from "../../shared/errors.ts";

// Wrapper qui essaye le détecteur principal (Gemini, gratuit) et tombe sur un
// fallback payant (OpenAI) si quota daily atteint. Tout autre type d'erreur
// (RPM, network, parse) propage sans tenter le fallback — pas de gaspillage.
export class FallbackDetector implements IRestaurantDetector {
  constructor(
    private readonly primary: IRestaurantDetector,
    private readonly fallback: IRestaurantDetector,
  ) {}

  async detect(input: { description: string; transcription: string }): Promise<DetectionResult> {
    try {
      return await this.primary.detect(input);
    } catch (err) {
      if (err instanceof DailyQuotaExceededError) {
        console.log(`[Detector] ${err.provider} quota daily → fallback OpenAI`);
        return await this.fallback.detect(input);
      }
      throw err;
    }
  }
}
