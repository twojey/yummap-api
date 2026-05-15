import type { IInfluencerInvitationRepository } from "../../domain/influencer/invitation.repository.ts";
import type { InfluencerInvitation } from "../../domain/influencer/invitation.types.ts";

const MAX_INFLUENCER_INVITATIONS = 3;
const INVITATION_TTL_DAYS = 10;

export interface CreateInfluencerInvitationInput {
  influencerId: string;
  targetPhone?: string;
  targetEmail?: string;
}

export class CreateInfluencerInvitationUsecase {
  constructor(private readonly invitationRepo: IInfluencerInvitationRepository) {}

  async execute(input: CreateInfluencerInvitationInput): Promise<{ invitation: InfluencerInvitation; deepLink: string }> {
    // Vérifier la limite de 3 invitations actives
    const activeCount = await this.invitationRepo.countActiveByCreator(input.influencerId);
    if (activeCount >= MAX_INFLUENCER_INVITATIONS) {
      throw new Error(`Limit reached: an influencer can create at most ${MAX_INFLUENCER_INVITATIONS} active invitations`);
    }

    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000).toISOString();
    const invitation = await this.invitationRepo.create({
      type: "influencer",
      createdById: input.influencerId,
      targetPhone: input.targetPhone,
      targetEmail: input.targetEmail,
      expiresAt,
    });

    const deepLink = `yummap-influencer://invite?token=${invitation.token}`;
    return { invitation, deepLink };
  }
}
