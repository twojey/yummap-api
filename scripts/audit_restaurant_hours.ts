#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Script d'audit: identifie les restaurants sans opening_hours
 * et génère un rapport pour action manuelle ou automatique.
 *
 * Usage: deno run --allow-net --allow-env scripts/audit_restaurant_hours.ts
 */

import { supabaseService } from "../config.ts";

interface Restaurant {
  id: string;
  place_id: string;
  name: string;
  opening_hours: Record<string, unknown> | null;
  created_at: string;
}

async function main() {
  console.log("🔍 Audit des horaires des restaurants...\n");

  const { data: restaurants, error } = await supabaseService
    .from("restaurants")
    .select("id, place_id, name, opening_hours, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("❌ Erreur lors de la requête:", error);
    Deno.exit(1);
  }

  if (!restaurants) {
    console.log("Aucun restaurant trouvé.");
    return;
  }

  const missing = (restaurants as Restaurant[]).filter((r) => {
    if (!r.opening_hours) return true;
    const hours = r.opening_hours as Record<string, unknown>;
    const periods = hours.periods as unknown[] | undefined;
    return !Array.isArray(periods) || periods.length === 0;
  });

  console.log(`✅ Total: ${restaurants.length} restaurants`);
  console.log(`⚠️  ${missing.length} sans horaires (${((missing.length / restaurants.length) * 100).toFixed(1)}%)\n`);

  if (missing.length === 0) {
    console.log("✨ Tous les restaurants ont des horaires!");
    return;
  }

  console.log("📋 Restaurants sans horaires:");
  console.log("─".repeat(80));

  missing.forEach((r, idx) => {
    const createdDate = new Date(r.created_at).toLocaleDateString("fr-FR");
    console.log(`\n${idx + 1}. ${r.name}`);
    console.log(`   ID: ${r.id}`);
    console.log(`   Place ID: ${r.place_id}`);
    console.log(`   Créé le: ${createdDate}`);
  });

  console.log("\n💡 Pour corriger:");
  console.log("   deno run --allow-net --allow-env scripts/fix_missing_restaurant_hours.ts");

  console.log("\n📊 Stratégie recommandée:");
  console.log(
    `   - ${missing.length} restaurants à corriger (environ ${(missing.length * 5).toLocaleString("fr-FR")} secondes avec rate-limit Google)`,
  );
  console.log("   - Lancer le script de correction en off-peak pour éviter de bloquer le serveur");
  console.log("   - Ajouter un monitoring pour détecter les futures restaurants sans horaires");
}

main().catch((err) => {
  console.error("❌ Erreur:", err);
  Deno.exit(1);
});
