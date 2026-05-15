export interface Guide {
  id: string;
  influencerId: string;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  restaurantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GuideWithRestaurants extends Guide {
  restaurantIds: string[];
}
