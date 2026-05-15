export interface BoundingBox {
  swLng: number;
  swLat: number;
  neLng: number;
  neLat: number;
}

export interface PinFilters {
  guideIds?: string[];
  tagIds?: string[];
  openNow?: boolean;
  minRating?: number;
}

export interface Pin {
  restaurantId: string;
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  cuisineType: string | null;
  openNow: boolean | null;
  googleRating: number | null;
  hasVideos: boolean;
  isInWatchlist: boolean;
  guideIds: string[];
}

export interface IMapQueryService {
  getPins(bbox: BoundingBox, filters: PinFilters, userId?: string): Promise<Pin[]>;
}
