import type { Video, PartialVideo } from "./video.types.ts";

export type ImportResult =
  | { status: "complete"; video: Video; skipped?: boolean }   // skipped=true : vidéo déjà en DB
  | { status: "incomplete"; partial: PartialVideo; missing: string[] };

export interface IVideoImportPipeline {
  import(
    url: string,
    description: string,
    uploaderId: string,
    externalPostId?: string | null,
    platform?: "instagram" | "tiktok" | null,
    // Date de publication originale sur la plateforme (extraite par le
    // scraper). Distinct de `created_at` (= insertion en DB). Optionnel : si
    // absent, l'heuristique posted_at ±48h ne déclenche pas — on retombe sur
    // le seul signal de fingerprint pour la dédup cross-plateforme.
    postedAt?: Date | null,
  ): Promise<ImportResult>;
}

export interface IRestaurantDetector {
  detect(input: {
    description: string;
    transcription: string;
  }): Promise<DetectionResult>;
}

// Slugs autorisés — alignés sur la migration 0006_tag_taxonomy.
// Seules ces 5 catégories peuvent porter un tag. Tout le reste est ignoré
// (Gemini hallucine parfois "type", "moment", "prix"… → rejeté côté pipeline).
export type TagCategorySlug = "cuisine" | "dietary" | "dish" | "ambiance" | "formula";
export const ALLOWED_TAG_SLUGS: ReadonlySet<TagCategorySlug> = new Set([
  "cuisine", "dietary", "dish", "ambiance", "formula",
]);

export interface DetectedTag {
  category: string;  // doit être dans ALLOWED_TAG_SLUGS, sinon skip
  name: string;      // ex: "italienne", "romantique", "bistrot", "brunch"
}

// Un resto détecté dans la vidéo. startSeconds = timestamp où l'IA pense que
// ce resto commence à être discuté (optionnel — les modèles ne renvoient pas
// toujours, et même quand ils renvoient c'est souvent peu fiable).
export interface DetectedRestaurant {
  name: string;
  address: string;
  startSeconds?: number | null;
}

// Le détecteur peut renvoyer plusieurs restos (cas typique : compilations
// "top 5 italiens à Paris", food crawls "on a fait 3 spots"). L'ordre du
// tableau = ordre de mention dans la vidéo → utilisé comme `position` dans
// video_restaurants. La pipeline résout chaque resto via Google Places et
// supprime ceux qui ne résolvent pas (= hallucinations IA).
export type DetectionResult =
  | {
      status: "complete";
      restaurants: DetectedRestaurant[]; // toujours >= 1 quand status complete
      tags?: DetectedTag[];
      extra?: Record<string, string>;
    }
  | { status: "incomplete"; missing: string[] };

export interface ITranscriptionService {
  transcribe(audioPath: string): Promise<{ text: string; vttPath: string }>;
}
