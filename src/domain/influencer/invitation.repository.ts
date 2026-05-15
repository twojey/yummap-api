import type { InfluencerInvitation, InvitationType, PendingInfluencerProfile } from "./invitation.types.ts";

export interface IInfluencerInvitationRepository {
  // @post result.token est unique et non-null
  // @post result.status == "pending"
  create(params: {
    type: InvitationType;
    createdById: string;
    targetEmail?: string;
    targetPhone?: string;
    linkedInfluencerId?: string;
    expiresAt: string;
  }): Promise<InfluencerInvitation>;

  // @post result.id == id || result == null
  findById(id: string): Promise<InfluencerInvitation | null>;

  // @post result.token == token || result == null
  findByToken(token: string): Promise<InfluencerInvitation | null>;

  findByCreator(createdById: string): Promise<InfluencerInvitation[]>;

  // Trouve l'invitation existante (la plus récente) liée à cet influenceur,
  // tous statuts confondus. Utilisé pour refresh au lieu de créer en double.
  findLatestByLinkedInfluencer(linkedInfluencerId: string): Promise<InfluencerInvitation | null>;

  // Met à jour la date d'expiration et remet status='pending' sur une invitation existante
  refresh(id: string, expiresAt: string): Promise<InfluencerInvitation>;

  // @pre invitation.status == "pending"
  // @post result.status == "claimed" && result.claimedById == claimedById
  claim(id: string, claimedById: string): Promise<InfluencerInvitation>;

  updateStatus(id: string, status: InfluencerInvitation["status"]): Promise<void>;

  // Compte le nombre d'invitations actives créées par un influenceur
  // (pour vérifier la limite de 3)
  countActiveByCreator(createdById: string): Promise<number>;

  // ── Profils en attente de validation admin ────────────────────────────────
  createPendingProfile(profile: Omit<PendingInfluencerProfile, "createdAt">): Promise<PendingInfluencerProfile>;
  findPendingProfiles(): Promise<PendingInfluencerProfile[]>;
  updatePendingStatus(userId: string, status: PendingInfluencerProfile["status"]): Promise<void>;
}
