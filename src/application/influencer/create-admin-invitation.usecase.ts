import type { IInfluencerInvitationRepository } from "../../domain/influencer/invitation.repository.ts";
import type { InfluencerInvitation } from "../../domain/influencer/invitation.types.ts";
import type { IVideoImportPipeline } from "../../domain/video/video.pipeline.ts";
import type { IImportJobRepository } from "../../domain/import-job/import-job.repository.ts";
import { BulkProfileImportUsecase } from "../import/bulk-profile-import.usecase.ts";

// Jours de validité d'une invitation (CONTEXT.md)
const INVITATION_TTL_DAYS = 10;

export interface CreateAdminInvitationInput {
  adminId: string;
  profileUrl: string;      // TikTok/Instagram URL à importer
  influencerId?: string;   // Si le profil est déjà en base, le lier
  targetEmail?: string;
  targetPhone?: string;
  videoLimit?: number;     // Max de vidéos à scraper (default 200)
}

export interface CreateAdminInvitationResult {
  invitation: InfluencerInvitation;
  importJobId: string;
  deepLink: string;        // yummap-influencer://invite?token=<token>
}

export class CreateAdminInvitationUsecase {
  constructor(
    private readonly invitationRepo: IInfluencerInvitationRepository,
    private readonly bulkImport: BulkProfileImportUsecase,
    private readonly importJobRepo: IImportJobRepository,
  ) {}

  async execute(input: CreateAdminInvitationInput): Promise<CreateAdminInvitationResult> {
    // 1. Résoudre l'influenceur (lookup-or-create par username) AVANT
    //    invitation+job pour que les deux pointent vers le même user.
    const influencerId = input.influencerId
      ?? await this.bulkImport.findOrCreateInfluencer(input.profileUrl);

    // 2. Lancer l'import du profil en arrière-plan
    const importJobId = await this.bulkImport.start({
      profileUrl: input.profileUrl,
      influencerId,
      createdBy: input.adminId,
      videoLimit: input.videoLimit,
    });

    // 3. Invitation : refresh la plus récente si elle existe pour cet
    //    influenceur, sinon en créer une nouvelle. Évite de générer
    //    plusieurs invitations parallèles pour le même compte.
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000).toISOString();
    const existing = influencerId
      ? await this.invitationRepo.findLatestByLinkedInfluencer(influencerId)
      : null;
    const invitation = existing
      ? await this.invitationRepo.refresh(existing.id, expiresAt)
      : await this.invitationRepo.create({
        type: "admin",
        createdById: input.adminId,
        targetEmail: input.targetEmail,
        targetPhone: input.targetPhone,
        linkedInfluencerId: influencerId,
        expiresAt,
      });

    const deepLink = `yummap-influencer://invite?token=${invitation.token}`;

    return { invitation, importJobId, deepLink };
  }
}
