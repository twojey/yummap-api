// Représente un import vidéo unique, suivi depuis le mobile
// Correspond au VideoImportJob côté Flutter
export type VideoImportStatus = "pending" | "processing" | "complete" | "incomplete" | "failed";

export interface VideoImportRequest {
  id: string;
  url: string;
  uploaderId: string;
  status: VideoImportStatus;
  restaurantPlaceId: string | null;
  restaurantName: string | null;
  missingFields: string[];
  errorMessage: string | null;
  createdAt: string;
}
