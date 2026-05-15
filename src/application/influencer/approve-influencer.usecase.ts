import type { IInfluencerInvitationRepository } from "../../domain/influencer/invitation.repository.ts";
import type { IUserRepository } from "../../domain/user/user.repository.ts";
import { BulkProfileImportUsecase } from "../import/bulk-profile-import.usecase.ts";

export interface ApproveInfluencerInput {
  userId: string;        // L'influenceur à approuver
  adminId: string;
  // URL du profil social à importer (fourni lors de la validation admin)
  primaryProfileUrl: string;
}

export interface RejectInfluencerInput {
  userId: string;
  adminId: string;
}

export class ApproveInfluencerUsecase {
  constructor(
    private readonly invitationRepo: IInfluencerInvitationRepository,
    private readonly userRepo: IUserRepository,
    private readonly bulkImport: BulkProfileImportUsecase,
  ) {}

  async approve(input: ApproveInfluencerInput): Promise<{ importJobId: string }> {
    // 1. Valider le profil en base
    await this.invitationRepo.updatePendingStatus(input.userId, "active");

    // 2. Promouvoir le rôle User → Influencer
    const user = await this.userRepo.findById(input.userId);
    if (user) {
      await this.userRepo.upsert({
        id: input.userId,
        role: "influencer",
        displayName: user.displayName,
        phoneNumber: user.phoneNumber ?? "",
      });
    }

    // 3. Déclencher l'import du profil en arrière-plan
    const importJobId = await this.bulkImport.start({
      profileUrl: input.primaryProfileUrl,
      influencerId: input.userId,
      createdBy: input.adminId,
    });

    return { importJobId };
  }

  async reject(input: RejectInfluencerInput): Promise<void> {
    await this.invitationRepo.updatePendingStatus(input.userId, "rejected");
  }
}
