export type NotificationEvent =
  | { type: "NewVideo"; influencerId: string; videoId: string; restaurantId: string }
  | { type: "NewGuide"; influencerId: string; guideId: string }
  | { type: "ImportComplete"; userId: string; videoId: string; restaurantId: string }
  | { type: "ImportFailed"; userId: string; videoUrl: string; missing: string[] }
  | { type: "NewFollower"; influencerId: string; followerId: string }
  // Alerte admin : la cascade de telechargement Instagram echoue massivement,
  // typiquement parce que les cookies de session ont expire.
  | { type: "CookiesAuthAlert"; failedCount: number; totalCount: number }
  // Alerte admin : taux d'echec eleve sans signature "cookies" (TikWm down,
  // OpenAI quota mort, Supabase indisponible, bug deploy...). Action :
  // ouvrir les logs Railway pour identifier la cause.
  | {
      type: "PipelineFailureAlert";
      failedCount: number;
      totalCount: number;
      topErrorSample: string;
    };
