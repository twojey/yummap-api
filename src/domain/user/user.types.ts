export type AccountRole = "user" | "influencer" | "restaurant" | "admin";

export interface User {
  id: string; // UUID local (guest) ou UUID Supabase Auth (authenticated)
  role: AccountRole;
  displayName: string;         // obligatoire dès le premier lancement (ADR-0002)
  avatarUrl: string | null;
  phoneNumber: string | null;  // null = non vérifié (données locales uniquement)
  preferences: UserPreferences;
  createdAt: string;
}

export interface UserPreferences {
  experiences: string[]; // ex: ["couple", "gastro"]
  dietaryConstraints: string[]; // ex: ["vegetarian", "halal"]
  notificationsEnabled: NotificationPreferences;
}

export interface NotificationPreferences {
  newVideo: boolean;
  newGuide: boolean;
  importComplete: boolean;
}
