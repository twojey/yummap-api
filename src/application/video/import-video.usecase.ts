import type { IVideoImportPipeline } from "../../domain/video/video.pipeline.ts";
import type { INotificationDispatcher } from "../../domain/notification/notification.dispatcher.ts";
import type { IVideoImportRequestRepository } from "../../domain/video/video-import-request.repository.ts";

export interface ImportVideoInput {
  url: string;
  description: string;
  uploaderId: string;
}

export class ImportVideoUsecase {
  constructor(
    private readonly pipeline: IVideoImportPipeline,
    private readonly notifications: INotificationDispatcher,
  ) {}

  // Traitement synchrone — utilisé directement par les tests
  async execute(input: ImportVideoInput) {
    const result = await this.pipeline.import(input.url, input.description, input.uploaderId);

    if (result.status === "complete") {
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
        await jobRepo.updateStatus(jobId, "complete", {
          restaurantPlaceId: result.video.restaurantId,
          restaurantName: undefined, // restaurantId suffit, le nom vient de la fiche
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
