import type { VideoImportRequest, VideoImportStatus } from "./video-import-request.types.ts";

export interface IVideoImportRequestRepository {
  create(url: string, uploaderId: string): Promise<VideoImportRequest>;

  // @post result.id == id || result == null
  findById(id: string): Promise<VideoImportRequest | null>;

  findByUploader(uploaderId: string): Promise<VideoImportRequest[]>;

  // Retourne les jobs en statut "pending" (FIFO sur created_at).
  // Utilisé par le scheduler worker pour piquer la queue.
  findPending(limit: number): Promise<VideoImportRequest[]>;

  updateStatus(
    id: string,
    status: VideoImportStatus,
    extra?: {
      restaurantPlaceId?: string;
      restaurantName?: string;
      missingFields?: string[];
      errorMessage?: string;
    },
  ): Promise<void>;
}
