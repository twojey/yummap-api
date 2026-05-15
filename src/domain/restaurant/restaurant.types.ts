export interface Restaurant {
  id: string;
  placeId: string; // Google Places place_id — identifiant pivot
  name: string;
  address: string;
  city: string;
  location: { lat: number; lng: number };
  googleRating: number | null;
  googleRatingsCount: number | null;
  openNow: boolean | null;
  openingHours: OpeningHours | null;
  websiteUrl: string | null;
  phoneNumber: string | null;
  coverImageUrl: string | null;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface OpeningHours {
  periods: Array<{
    open: { day: number; time: string };
    close: { day: number; time: string };
  }>;
  weekdayText: string[];
}

export interface Tag {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  // Slug stable de la catégorie (cuisine/dietary/dish/ambiance/formula).
  // Optionnel pour rétro-compat avec les vieilles lignes pré-migration 0006.
  categorySlug?: string;
}

export interface TagCategory {
  id: string;
  name: string;
  tags: Tag[];
}

export interface SearchFilters {
  query?: string;
  tagIds?: string[];
  openNow?: boolean;
  minRating?: number;
}
