import type { IGuideRepository } from "../../domain/guide/guide.repository.ts";
import type { Guide } from "../../domain/guide/guide.types.ts";
import type { INotificationDispatcher } from "../../domain/notification/notification.dispatcher.ts";

export class CreateGuideUsecase {
  constructor(
    private readonly guides: IGuideRepository,
    private readonly notifications: INotificationDispatcher,
  ) {}

  async execute(input: {
    influencerId: string;
    title: string;
    description?: string;
  }): Promise<Guide> {
    const guide = await this.guides.create({
      influencerId: input.influencerId,
      title: input.title,
      description: input.description ?? null,
      coverImageUrl: null,
    });

    await this.notifications.dispatch({
      type: "NewGuide",
      influencerId: input.influencerId,
      guideId: guide.id,
    });

    return guide;
  }
}
