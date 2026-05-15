import type { User } from "./user.types.ts";

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByPhoneNumber(phoneNumber: string): Promise<User | null>;
  // Crée ou met à jour un User sur le serveur (déclenché à la vérification du téléphone)
  // @post result.id == user.id
  upsert(user: Pick<User, "id" | "role"> & { displayName: string; phoneNumber: string }): Promise<User>;
  // Enregistre un user anonyme (sans phone) avec son UUID local généré côté app.
  // Idempotent : un même UUID peut appeler plusieurs fois sans erreur.
  createAnonymous(params: { id: string; displayName: string }): Promise<User>;
  // Marque l'user comme actif (last_active_at = NOW()). Appelé à chaque démarrage app.
  heartbeat(id: string): Promise<void>;
  // Compte les followers actifs (vus depuis N jours) — exclut les users qui ont
  // désinstallé l'app sans supprimer leur compte.
  countActiveFollowers(influencerId: string, activeWindowDays: number): Promise<number>;
  // Transfère follows + watchlist du user `fromId` vers `toId`, puis delete `fromId`.
  // Utilisé quand un anon vérifie un phone qui existe déjà chez un autre user.
  mergeInto(fromId: string, toId: string): Promise<void>;
  updatePreferences(id: string, prefs: Partial<User["preferences"]>): Promise<void>;
  getFollowing(userId: string): Promise<string[]>; // influencer IDs
  follow(userId: string, influencerId: string): Promise<void>;
  unfollow(userId: string, influencerId: string): Promise<void>;
  getWatchlist(userId: string): Promise<string[]>; // restaurant IDs
  addToWatchlist(userId: string, restaurantId: string): Promise<void>;
  removeFromWatchlist(userId: string, restaurantId: string): Promise<void>;
  registerPushToken(userId: string, token: string, platform: "ios" | "android"): Promise<void>;
}
