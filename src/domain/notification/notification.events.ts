export type NotificationEvent =
  | { type: "NewVideo"; influencerId: string; videoId: string; restaurantId: string }
  | { type: "NewGuide"; influencerId: string; guideId: string }
  | { type: "ImportComplete"; userId: string; videoId: string; restaurantId: string }
  | { type: "ImportFailed"; userId: string; videoUrl: string; missing: string[] }
  | { type: "NewFollower"; influencerId: string; followerId: string };
