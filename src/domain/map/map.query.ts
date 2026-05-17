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
  maxRating?: number;
  // True : ne montrer que les restos déjà dans la watchlist de l'user.
  // Ignoré si l'user est guest (pas d'userId).
  inWatchlistOnly?: boolean;
}

export interface Pin {
  restaurantId: string;
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  // Slug stable (cuisine étrangère ou type_lieu) servant à choisir l'emoji du pin.
  // Le nom "cuisineType" est conservé pour compat. Valeurs : francaise, italienne,
  // japonaise, cafe, boulangerie, patisserie, pizzeria, gastronomique, ...
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
