#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Script de correction: ré-enrichit les restaurants sans opening_hours
 * depuis Google Places et met à jour la base de données.
 *
 * Usage: deno run --allow-net --allow-env scripts/fix_missing_restaurant_hours.ts
 */

import { supabaseService } from "../config.ts";
import { GooglePlacesClient } from "../src/infrastructure/google-places/google-places.client.ts";
import { EnrichRestaurantGoogleDataUsecase } from "../src/application/restaurant/enrich-google-data.usecase.ts";

const RESTAURANTS_TO_FIX = [
  "bf2a1395-8470-4e28-8202-2be4e66e983e", // Mopa Döner
  "22293ee0-bdd4-4219-a508-171138fec483", // La Vie Dirty vegan Burger par Taster
  "87243061-07db-4715-9291-fda0c9db5f86", // Sapid
  "da19d87e-3fe0-47f3-9b98-91c0dd7f79b2", // Kiss my burger by La Vie
  "e7289e3b-f85c-4b8a-a416-4160279b942a", // La Ferme
];

async function main() {
  // GooglePlacesClient lit GOOGLE_PLACES_API_KEY directement depuis config.
  if (!Deno.env.get("GOOGLE_PLACES_API_KEY")) {
    console.error("❌ GOOGLE_PLACES_API_KEY manquante");
    Deno.exit(1);
  }

  console.log("🔧 Correction des horaires manquants...\n");

  const placesClient = new GooglePlacesClient();
  const enrichGoogle = new EnrichRestaurantGoogleDataUsecase(placesClient);

  for (const restaurantId of RESTAURANTS_TO_FIX) {
    // Récupérer le restaurant
    const { data: restaurant, error } = await supabaseService
      .from("restaurants")
      .select("id, place_id, name, opening_hours")
      .eq("id", restaurantId)
      .single();

    if (error || !restaurant) {
      console.log(`❌ ${restaurantId}: restaurant non trouvé`);
      continue;
    }

    const hasHours = restaurant.opening_hours &&
                     Object.keys(restaurant.opening_hours).length > 0;

    console.log(`\n${restaurant.name}`);
    console.log(`  ID: ${restaurantId}`);
    console.log(`  Place ID: ${restaurant.place_id}`);
    console.log(`  Horaires actuels: ${hasHours ? "✅ présent" : "❌ manquant"}`);

    if (hasHours) {
      console.log(`  → Déjà enrichi, skip`);
      continue;
    }

    // Ré-enrichir depuis Google
    console.log(`  → Récupération depuis Google Places...`);
    try {
      await enrichGoogle.run(restaurantId, restaurant.place_id);

      // Vérifier le résultat
      const { data: updated } = await supabaseService
        .from("restaurants")
        .select("opening_hours")
        .eq("id", restaurantId)
        .single();

      if (updated?.opening_hours) {
        const periods = (updated.opening_hours as Record<string, unknown>).periods;
        console.log(`  ✅ Horaires importés (${Array.isArray(periods) ? periods.length : 0} périodes)`);
      } else {
        console.log(`  ⚠️  Google n'a pas retourné d'horaires pour ce restaurant`);
      }
    } catch (err) {
      console.log(`  ❌ Erreur: ${(err as Error).message}`);
    }
  }

  console.log("\n✅ Correction terminée");
}

main().catch((err) => {
  console.error("❌ Erreur:", err);
  Deno.exit(1);
});
