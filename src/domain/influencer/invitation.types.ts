export type InvitationType = "admin" | "influencer";
export type InvitationStatus = "pending" | "claimed" | "expired" | "rejected";

// @invariant token est unique et non prédictible
// @invariant type == "influencer" → invitationsCount(createdById) < 3 avant création
// @invariant claimedById != null ↔ status == "claimed"
export interface InfluencerInvitation {
  id: string;
  token: string;                     // UUID utilisé dans le deep link
  type: InvitationType;
  createdById: string;               // admin ID (type=="admin") ou influencer ID (type=="influencer")
  targetEmail: string | null;
  targetPhone: string | null;
  // Pour les invitations admin : profile déjà importé à relier au compte
  linkedInfluencerId: string | null;
  status: InvitationStatus;
  expiresAt: string;                 // ISO — 10 jours par défaut (CONTEXT.md)
  claimedById: string | null;        // User ID qui a revendiqué l'invitation
  createdAt: string;
}

export type SocialPlatform = "instagram" | "tiktok";

export interface SocialProfile {
  platform: SocialPlatform;
  profileUrl: string;
}

// Profil d'un influenceur en attente de validation admin
// (créé via invitation influenceur→influenceur)
export type InfluencerAccountStatus = "pending_review" | "active" | "rejected";

export interface PendingInfluencerProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  socialProfiles: SocialProfile[];
  invitedById: string;               // Influenceur qui a envoyé l'invitation
  status: InfluencerAccountStatus;
  createdAt: string;
}
