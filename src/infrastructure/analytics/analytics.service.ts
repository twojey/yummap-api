import { supabaseService } from "../../../config.ts";

export type AnalyticsEventType =
  // Événements v1 (capturés dès le lancement)
  | "restaurant_view"        // ouverture Quick View ou Full Profile
  | "restaurant_map_open"    // clic "ouvrir dans Maps"
  | "video_view"             // lecture d'une vidéo
  | "guide_view"             // consultation d'un Guide
  | "watchlist_add"          // ajout à la Watchlist
  | "watchlist_remove"
  | "influencer_follow"
  | "influencer_unfollow"
  | "video_import"           // import d'une vidéo
  // Événements B2B futurs (structure déjà prête)
  | "restaurant_proximity_enter"  // entrée dans le rayon 100m — v2
  | "reservation_created"         // réservation — v2
  | "loyalty_stamp";              // tampon fidélité — v2

export interface AnalyticsEvent {
  eventType: AnalyticsEventType;
  userId?: string;
  restaurantId?: string;
  sessionId?: string;
  lat?: number;
  lng?: number;
  metadata?: Record<string, unknown>;
}

export class AnalyticsService {
  // Fire-and-forget — ne jamais await dans les routes critiques
  track(event: AnalyticsEvent): void {
    supabaseService.from("analytics_events").insert({
      event_type:    event.eventType,
      user_id:       event.userId    ?? null,
      restaurant_id: event.restaurantId ?? null,
      session_id:    event.sessionId ?? null,
      lat:           event.lat       ?? null,
      lng:           event.lng       ?? null,
      metadata:      event.metadata  ?? {},
    }).then(({ error }) => {
      if (error) console.warn("[Analytics] Failed to track event:", error.message);
    });
  }
}

export const analyticsService = new AnalyticsService();
