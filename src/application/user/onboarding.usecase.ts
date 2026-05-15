import type { IUserRepository } from "../../domain/user/user.repository.ts";
import type { UserPreferences } from "../../domain/user/user.types.ts";

export class OnboardingUsecase {
  constructor(private readonly users: IUserRepository) {}

  async execute(input: {
    userId: string;
    experiences: string[];
    dietaryConstraints: string[];
    influencerIdsToFollow: string[];
  }): Promise<void> {
    const prefs: UserPreferences = {
      experiences: input.experiences,
      dietaryConstraints: input.dietaryConstraints,
      notificationsEnabled: {
        newVideo: true,
        newGuide: true,
        importComplete: true,
      },
    };

    await this.users.updatePreferences(input.userId, prefs);

    await Promise.all(
      input.influencerIdsToFollow.map((id) => this.users.follow(input.userId, id)),
    );
  }
}
