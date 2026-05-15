export type ImportJobStatus = "pending" | "running" | "paused" | "completed" | "failed";

export interface ImportJobVideoItem {
  url: string;
  description: string;
  platform: "instagram" | "tiktok" | null;
  externalPostId: string | null;  // shortcode Instagram ou id TikTok — stable dans le temps
}

export interface ImportJob {
  id: string;
  profileUrl: string;       // URL du profil TikTok/Instagram
  influencerId: string | null;  // UUID du compte Influencer cible (null si invitation pending)
  createdBy: string;        // UUID admin qui a lancé le job
  status: ImportJobStatus;
  totalVideos: number | null;
  processedVideos: number;
  successCount: number;
  failureCount: number;
  incompleteCount: number;  // vidéos où le restaurant n'a pas été détecté
  errors: ImportJobError[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  pausedUntil: string | null;     // ISO date : quand le job sera repris auto
  pausedReason: string | null;    // Raison de la pause (ex: "gemini daily quota exceeded")
  lastProcessedIndex: number;     // Checkpoint : nb de vidéos déjà traitées dans la queue
}

export interface ImportJobError {
  videoUrl: string;
  reason: string;
  missing?: string[];
}
