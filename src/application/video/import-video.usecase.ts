import type { IVideoImportPipeline } from "../../domain/video/video.pipeline.ts";
import type { INotificationDispatcher } from "../../domain/notification/notification.dispatcher.ts";
import type { IVideoImportRequestRepository } from "../../domain/video/video-import-request.repository.ts";
import type { IUserRepository } from "../../domain/user/user.repository.ts";

export interface ImportVideoInput {
  url: string;
  description: string;
  uploaderId: string;
}

export class ImportVideoUsecase {
  constructor(
    private readonly pipeline: IVideoImportPipeline,
    private readonly notifications: INotificationDispatcher,
    private readonly userRepo: IUserRepository,
  ) {}

  // Traitement synchrone — utilisé directement par les tests
  async execute(input: ImportVideoInput) {
    const result = await this.pipeline.import(input.url, input.description, input.uploaderId);

    if (result.status === "complete") {
      if (result.video.restaurantId) {
        await this.userRepo.addToWatchlist(input.uploaderId, result.video.restaurantId).catch(() => {});
      }
      await this.notifications.dispatch({
        type: "ImportComplete",
        userId: input.uploaderId,
        videoId: result.video.id,
        restaurantId: result.video.restaurantId,
      });
    } else {
      await this.notifications.dispatch({
        type: "ImportFailed",
        userId: input.uploaderId,
        videoUrl: input.url,
        missing: result.missing,
      });
    }

    return result;
  }

  // Traitement avec suivi de job — appelé par la route async
  async executeWithJob(
    input: ImportVideoInput,
    jobId: string,
    jobRepo: IVideoImportRequestRepository,
  ): Promise<void> {
    await jobRepo.updateStatus(jobId, "processing");

    try {
      const result = await this.pipeline.import(input.url, input.description, input.uploaderId);

      if (result.status === "complete") {
        // Ajoute le restaurant à la watchlist de l'utilisateur qui a partagé
        // la vidéo (input.uploaderId = partageur original, même si la vidéo a
        // été ré-attribuée à l'influenceur auteur). Best-effort : un échec ici
        // ne doit pas faire échouer l'import.
        if (result.video.restaurantId) {
          await this.userRepo.addToWatchlist(input.uploaderId, result.video.restaurantId).catch(() => {});
        }
        await jobRepo.updateStatus(jobId, "complete", {
          // place_id Google (pas l'UUID interne) : l'app navigue vers
          // /restaurant/:placeId qui résout via GET /restaurants/:placeId.
          restaurantPlaceId: result.video.restaurantPlaceId ?? undefined,
          restaurantName: undefined,
        });
        await this.notifications.dispatch({
          type: "ImportComplete",
          userId: input.uploaderId,
          videoId: result.video.id,
          restaurantId: result.video.restaurantId,
        });
      } else {
        await jobRepo.updateStatus(jobId, "incomplete", {
          missingFields: result.missing,
        });
        await this.notifications.dispatch({
          type: "ImportFailed",
          userId: input.uploaderId,
          videoUrl: input.url,
          missing: result.missing,
        });
      }
    } catch (err) {
      await jobRepo.updateStatus(jobId, "failed", {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
