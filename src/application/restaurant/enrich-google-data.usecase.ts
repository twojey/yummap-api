import type { GooglePlacesClient } from "../../infrastructure/google-places/google-places.client.ts";
import { supabaseService } from "../../../config.ts";

// Précharge en base les données Google Places "non-factuelles" qui changent
// peu (horaires, avis) pour qu'aucune route consommée par l'app mobile n'ait
// besoin de taper Google en runtime.
//
// Convention :
// - 1 appel à ce service par restaurant créé (via pipeline d'import OU via
//   assign manuel depuis l'admin créateur).
// - Le job de backfill admin appelle aussi ce service pour les restos
//   antérieurs qui ont `google_data_fetched_at IS NULL`.
//
// Best-effort : si Google répond par une erreur ou un timeout, on log et on
// laisse les colonnes nullées — la fiche s'affichera juste sans horaires/avis,
// mais aucune route runtime ne tentera de palier en appelant Google à son tour.
export class EnrichRestaurantGoogleDataUsecase {
  constructor(private readonly placesClient: GooglePlacesClient) {}

  // Fetch + store. `restaurantId` est l'UUID interne, `placeId` le Google id.
  async run(restaurantId: string, placeId: string): Promise<void> {
    let openingHours: unknown = null;
    let reviews: unknown = null;

    try {
      openingHours = await this.placesClient.getOpeningHours(placeId);
    } catch (err) {
      console.warn(`[EnrichGoogleData] getOpeningHours(${placeId}) failed: ${(err as Error).message}`);
    }

    try {
      reviews = await this.placesClient.getReviews(placeId);
    } catch (err) {
      console.warn(`[EnrichGoogleData] getReviews(${placeId}) failed: ${(err as Error).message}`);
    }

    const { error } = await supabaseService
      .from("restaurants")
      .update({
        opening_hours: openingHours,
        google_reviews: reviews,
        google_data_fetched_at: new Date().toISOString(),
      })
      .eq("id", restaurantId);

    if (error) {
      console.warn(`[EnrichGoogleData] update(${restaurantId}) failed: ${error.message}`);
    }
  }

  // Backfill par batch des restos qui n'ont jamais été enrichis (colonne
  // google_data_fetched_at IS NULL). Utilisé par le scheduler du serveur pour
  // rendre l'opération automatique : aucun appel manuel à un endpoint admin
  // n'est nécessaire pour les restos existants. Limite stricte par batch pour
  // ne pas exploser le quota Google API ni saturer la DB d'un coup.
  //
  // Retourne le nombre de restos traités. Le caller peut appeler en boucle
  // tant que la valeur > 0 pour finir le backfill complet.
  async runBatchStale(limit: number): Promise<number> {
    const { data, error } = await supabaseService
      .from("restaurants")
      .select("id, place_id")
      .is("google_data_fetched_at", null)
      .limit(limit);
    if (error) {
      console.warn(`[EnrichGoogleData] backfill query failed: ${error.message}`);
      return 0;
    }
    const rows = (data ?? []) as Array<{ id: string; place_id: string }>;
    if (rows.length === 0) return 0;

    // Sequential pour respecter le rate-limit Google. ~150ms par resto × 2
    // appels = ~300ms par resto, donc batch de 10 ~3s — acceptable en bg.
    let ok = 0;
    for (const r of rows) {
      try {
        await this.run(r.id, r.place_id);
        ok++;
      } catch (err) {
        console.warn(`[EnrichGoogleData] batch(${r.place_id}) failed: ${(err as Error).message}`);
      }
    }
    console.log(`[EnrichGoogleData] backfill batch: ${ok}/${rows.length} ok`);
    return rows.length;
  }
}
