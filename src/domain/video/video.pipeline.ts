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

// Le détecteur renvoie des paires (category_slug, tag_slug). La validation
// stricte contre la whitelist se fait dans le pipeline via isValidTag (voir
// domain/tags/tag-taxonomy.ts). Tout tag hors taxonomie est silencieusement
// rejeté — on ne pollue plus la base avec des hallucinations LLM.
export interface DetectedTag {
  category: string; // slug de catégorie (cuisine, type_lieu, regime, …)
  slug: string;     // slug de tag canonique (francaise, italienne, vegan, …)
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
