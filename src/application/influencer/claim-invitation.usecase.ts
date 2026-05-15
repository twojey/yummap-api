import type { IInfluencerInvitationRepository } from "../../domain/influencer/invitation.repository.ts";
import type { SocialProfile } from "../../domain/influencer/invitation.types.ts";
import type { IUserRepository } from "../../domain/user/user.repository.ts";

export interface ClaimInvitationInput {
  token: string;
  userId: string;        // User ID créé lors de l'inscription
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  // Uniquement pour les invitations influenceur→influenceur
  socialProfiles?: SocialProfile[];
}

export type ClaimResult =
  | { outcome: "active"; influencerId: string }   // Invitation admin : compte actif immédiatement
  | { outcome: "pending_review" };                  // Invitation influenceur : en attente admin

export class ClaimInvitationUsecase {
  constructor(
    private readonly invitationRepo: IInfluencerInvitationRepository,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(input: ClaimInvitationInput): Promise<ClaimResult> {
    const invitation = await this.invitationRepo.findByToken(input.token);
    if (!invitation) throw new Error("Invitation not found");
    if (invitation.status !== "pending") throw new Error(`Invitation is ${invitation.status}`);
    if (new Date(invitation.expiresAt) < new Date()) {
      await this.invitationRepo.updateStatus(invitation.id, "expired");
      throw new Error("Invitation expired");
    }

    // Marquer comme utilisée
    await this.invitationRepo.claim(invitation.id, input.userId);

    if (invitation.type === "admin") {
      // Flux admin : le profil est déjà importé, relier et activer
      await this.userRepo.upsert({
        id: input.userId,
        role: "influencer",
        displayName: input.displayName,
        phoneNumber: "", // sera rempli après vérification SMS
      });
      return { outcome: "active", influencerId: invitation.linkedInfluencerId ?? input.userId };
    } else {
      // Flux influenceur→influenceur : créer profil en attente de validation
      await this.invitationRepo.createPendingProfile({
        userId: input.userId,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        bio: input.bio ?? null,
        socialProfiles: input.socialProfiles ?? [],
        invitedById: invitation.createdById,
        status: "pending_review",
      });
      return { outcome: "pending_review" };
    }
  }
}
