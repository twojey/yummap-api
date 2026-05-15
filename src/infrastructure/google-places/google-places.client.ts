import { config } from "../../../config.ts";

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  location: { lat: number; lng: number };
  rating?: number;
  ratingsCount?: number;
  openNow?: boolean;
  websiteUrl?: string;
  phoneNumber?: string;
  photoReference?: string; // Référence Places API pour télécharger via /place/photo
}

// Types Google Places considérés comme "food venue" (filtre anti-pollution)
const FOOD_TYPES = new Set([
  "restaurant", "cafe", "bar", "bakery",
  "meal_takeaway", "meal_delivery", "food",
]);

export class GooglePlacesClient {
  readonly #apiKey = config.googlePlaces.apiKey;
  readonly #baseUrl = "https://maps.googleapis.com/maps/api/place";

  async findPlace(name: string, address: string): Promise<PlaceResult | null> {
    const query = encodeURIComponent(`${name} ${address} Paris`);
    // Fields supportés par findplacefromtext (Basic + Atmosphere uniquement).
    // website/phone/opening_hours nécessitent un Place Details (2e appel ci-dessous).
    const fields = "place_id,name,formatted_address,geometry,rating,user_ratings_total,types,photos";

    const url = `${this.#baseUrl}/findplacefromtext/json?input=${query}&inputtype=textquery&fields=${fields}&key=${this.#apiKey}&language=fr`;
    const res = await fetch(url);
    const data = await res.json() as {
      status?: string;
      error_message?: string;
      candidates?: Array<{
        place_id: string;
        name: string;
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
        rating?: number;
        user_ratings_total?: number;
        types?: string[];
        photos?: Array<{ photo_reference: string }>;
      }>;
    };
    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.warn(`[Places] ${data.status}: ${data.error_message ?? ""}`);
      return null;
    }

    // Prend le premier candidat qui matche un type "food"
    const candidate = (data.candidates ?? []).find(
      (c) => (c.types ?? []).some((t) => FOOD_TYPES.has(t)),
    );
    if (!candidate) return null;

    // Récupère les Contact Data via getDetails (website, phone, opening_hours)
    const extra = await this.#getContactDetails(candidate.place_id);

    return {
      placeId: candidate.place_id,
      name: candidate.name,
      address: candidate.formatted_address,
      location: candidate.geometry.location,
      rating: candidate.rating,
      ratingsCount: candidate.user_ratings_total,
      openNow: extra?.openNow,
      websiteUrl: extra?.website,
      phoneNumber: extra?.phone,
      photoReference: candidate.photos?.[0]?.photo_reference,
    };
  }

  // Place Details (2e appel) pour les Contact Data non disponibles dans findplacefromtext.
  async #getContactDetails(
    placeId: string,
  ): Promise<{ website?: string; phone?: string; openNow?: boolean } | null> {
    const fields = "website,formatted_phone_number,opening_hours";
    const url = `${this.#baseUrl}/details/json?place_id=${placeId}&fields=${fields}&key=${this.#apiKey}&language=fr`;
    const res = await fetch(url);
    const data = await res.json() as {
      status?: string;
      result?: {
        website?: string;
        formatted_phone_number?: string;
        opening_hours?: { open_now?: boolean };
      };
    };
    if (data.status !== "OK") return null;
    return {
      website: data.result?.website,
      phone: data.result?.formatted_phone_number,
      openNow: data.result?.opening_hours?.open_now,
    };
  }

  // Télécharge les bytes d'une photo Google Places à partir d'une photo_reference
  async fetchPhotoBytes(photoReference: string, maxWidth = 800): Promise<Uint8Array | null> {
    const url = `${this.#baseUrl}/photo?maxwidth=${maxWidth}&photo_reference=${photoReference}&key=${this.#apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  async getDetails(placeId: string): Promise<PlaceResult | null> {
    const fields = "place_id,name,formatted_address,geometry,rating,user_ratings_total,opening_hours,website,formatted_phone_number";
    const url = `${this.#baseUrl}/details/json?place_id=${placeId}&fields=${fields}&key=${this.#apiKey}&language=fr`;

    const res = await fetch(url);
    const data = await res.json() as {
      result?: {
        place_id: string;
        name: string;
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
        rating?: number;
        user_ratings_total?: number;
        opening_hours?: { open_now: boolean };
        website?: string;
        formatted_phone_number?: string;
      };
    };

    if (!data.result) return null;
    const r = data.result;

    return {
      placeId: r.place_id,
      name: r.name,
      address: r.formatted_address,
      location: r.geometry.location,
      rating: r.rating,
      ratingsCount: r.user_ratings_total,
      openNow: r.opening_hours?.open_now,
      websiteUrl: r.website,
      phoneNumber: r.formatted_phone_number,
    };
  }

  // Récupère les 5 avis Google d'un restaurant (Place Details API "reviews" field).
  // Obligatoire d'afficher le logo Google avec les reviews (CGU Places API).
  async getReviews(placeId: string): Promise<Array<{
    author: string;
    avatarUrl?: string;
    rating: number;
    text: string;
    // Unix epoch (seconds) — utilisé pour construire un publishedAt ISO côté API.
    time?: number;
    relativeTime?: string;
  }>> {
    const url = `${this.#baseUrl}/details/json?place_id=${placeId}&fields=reviews&key=${this.#apiKey}&language=fr&reviews_no_translations=true`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as {
      status?: string;
      result?: {
        reviews?: Array<{
          author_name: string;
          profile_photo_url?: string;
          rating: number;
          text: string;
          time?: number;
          relative_time_description?: string;
        }>;
      };
    };
    if (data.status !== "OK") return [];
    return (data.result?.reviews ?? []).slice(0, 5).map((r) => ({
      author: r.author_name,
      avatarUrl: r.profile_photo_url,
      rating: r.rating,
      text: r.text,
      time: r.time,
      relativeTime: r.relative_time_description,
    }));
  }

  // Récupère les horaires d'ouverture détaillés (periods + weekday_text) d'un
  // restaurant via Place Details API. Renvoyé tel quel à l'app dans le format
  // déjà attendu par OpeningHours côté Flutter (weekdayText camelCase).
  //
  // Pourquoi un appel séparé : le pipeline d'import écrit `opening_hours: null`
  // (on ne stocke pas ces données qui changent dans la vie d'un resto). On les
  // refetch ici à chaque consultation de la fiche pour rester à jour.
  async getOpeningHours(placeId: string): Promise<{
    periods: Array<{ open: { day: number; time: string }; close: { day: number; time: string } }>;
    weekdayText: string[];
  } | null> {
    const url = `${this.#baseUrl}/details/json?place_id=${placeId}&fields=opening_hours&key=${this.#apiKey}&language=fr`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as {
      status?: string;
      result?: {
        opening_hours?: {
          periods?: Array<{
            open?: { day: number; time: string };
            close?: { day: number; time: string };
          }>;
          weekday_text?: string[];
        };
      };
    };
    if (data.status !== "OK") return null;
    const oh = data.result?.opening_hours;
    if (!oh) return null;
    // Filtre les periods sans `close` (ex: restos ouverts 24/7 retournent juste
    // {open: {day: 0, time: "0000"}} → on les skip ici car le modèle app exige close).
    const periods = (oh.periods ?? [])
      .filter((p): p is { open: { day: number; time: string }; close: { day: number; time: string } } =>
        p.open != null && p.close != null)
      .map((p) => ({ open: p.open, close: p.close }));
    return {
      periods,
      weekdayText: oh.weekday_text ?? [],
    };
  }
}
