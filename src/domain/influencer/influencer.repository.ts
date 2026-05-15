import type { Influencer, InfluencerForUser } from "./influencer.types.ts";

export interface IInfluencerRepository {
  // @post result.id == id || result == null
  findById(id: string, viewingUserId?: string): Promise<InfluencerForUser | null>;

  // Pool curé par l'admin + filtré par catégories préférées
  // @post résultat trié : catégories matchantes en tête
  getForOnboarding(preferredCategories: string[]): Promise<Influencer[]>;

  // Influenceurs suivis par un User
  // @post chaque Influencer retourné a isFollowed == true
  getFollowedByUser(userId: string): Promise<InfluencerForUser[]>;

  // Guides des Influenceurs suivis par un User (conséquence directe du follow)
  getFollowedGuideIds(userId: string): Promise<string[]>;

  // Admin : gérer les tags et la visibilité onboarding
  // @post (await findById(id)).categories == categories
  updateCategories(id: string, categories: string[]): Promise<void>;

  // @post (await findById(id)).visibleAtOnboarding == visible
  setVisibleAtOnboarding(id: string, visible: boolean): Promise<void>;
}
