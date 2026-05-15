// @invariant id == User.id (un compte Influencer est un User avec role "influencer")
// @invariant guideCount >= 0
// @invariant followerCount >= 0
export interface Influencer {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  categories: string[];          // tags manuels assignés par les admins
  visibleAtOnboarding: boolean;  // inclus dans le pool de recommandation onboarding
  guideCount: number;
  followerCount: number;
  createdAt: string;
}

// Influencer avec son état par rapport à un User donné
export interface InfluencerForUser extends Influencer {
  isFollowed: boolean;
}
