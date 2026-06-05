import { TAXONOMY } from "../../domain/tags/tag-taxonomy.ts";

// Construit le prompt LLM d'extraction de restaurants depuis une vidéo
// TikTok/Instagram. Le prompt est généré dynamiquement à partir de la
// TAXONOMY pour rester aligné avec la base — toute évolution de la
// whitelist se propage automatiquement sans modifier ce fichier.
//
// Section "régimes alimentaires" : volontairement placée en premier
// dans les règles + listée avec ses slugs car les utilisateurs avec
// contraintes (intolérance, allergie, choix éthique) dépendent de
// cette info pour leurs décisions d'aller au restaurant.
export function buildExtractionPrompt(input: {
  description: string;
  transcription: string;
}): string {
  return `
Tu es un assistant qui extrait les restaurants mentionnés dans la description et la transcription d'une vidéo TikTok/Instagram. La vidéo peut parler d'1, 2 ou plusieurs restaurants (compilations "top 5", food crawls "on a fait 3 spots"…).

Description de la vidéo : """${input.description}"""
Transcription audio : """${input.transcription}"""

Réponds UNIQUEMENT en JSON valide, sans markdown. Deux formats possibles.

Si tu identifies au moins 1 restaurant avec son nom ET son adresse/arrondissement :
{
  "status": "complete",
  "restaurants": [
    { "name": "<nom>", "address": "<adresse>", "startSeconds": <int|null> }
  ],
  "tags": [
    { "category": "<slug>", "slug": "<slug-du-tag>" }
  ]
}

Si tu ne trouves pas le nom OU l'adresse d'au moins 1 restaurant :
{ "status": "incomplete", "missing": ["name"|"address"] }

────────────────────────────────────────────────────────────────────
TAXONOMIE DES TAGS — WHITELIST FERMÉE
────────────────────────────────────────────────────────────────────
Tu DOIS recopier le SLUG EXACT (la valeur AVANT la parenthèse), jamais le
libellé entre parenthèses. Chaque ligne est au format :  slug  (libellé).
Tu écris le slug. Si rien ne convient, ne mets pas de tag pour la catégorie.

Exemple de tags BIEN formés pour un bistrot végétarien parisien à 25€ :
  "tags": [
    { "category": "cuisine", "slug": "francaise" },
    { "category": "type_lieu", "slug": "bistrot" },
    { "category": "regime", "slug": "vegetarien" },
    { "category": "prix", "slug": "eur2" }
  ]
MAUVAIS (sera rejeté) : { "category": "type", "slug": "bistrot végétarien" }
  → catégorie inventée ("type" au lieu de "type_lieu") + libellé au lieu du slug.

${renderTaxonomy()}

────────────────────────────────────────────────────────────────────
RÈGLES STRICTES
────────────────────────────────────────────────────────────────────

1. RÉGIMES ALIMENTAIRES (catégorie "regime") — INFORMATION CRITIQUE
   Les utilisateurs avec contraintes alimentaires (allergies, intolérances,
   choix religieux ou éthiques) dépendent de ces tags. Sois exhaustif sur
   les régimes mentionnés mais NE DEVINE JAMAIS.
   - Si le restaurant est 100% vegan → "vegan" ET aussi "options_vege"
   - Si la vidéo dit "options veggie / vegan friendly / plats végétariens
     disponibles / menu végé" → "options_vege"
   - Si la vidéo mentionne explicitement halal, casher, sans gluten,
     sans lactose, bio → ajoute le slug correspondant
   - Aucune mention claire → AUCUN tag regime (préférable à un tag faux)

2. CUISINE (catégorie "cuisine") — UN SEUL TAG
   Détermine l'origine culinaire dominante (ex: "italienne" pour une
   pizzeria napolitaine, "japonaise" pour un sushi, "francaise" pour un
   bistrot parisien classique). Ne devine pas — si vraiment incertain,
   ne mets pas de cuisine et le restaurant sera marqué pour review.

3. TYPE DE LIEU (catégorie "type_lieu") — UN SEUL TAG
   Choisis le plus spécifique applicable :
   - une boulangerie qui vend aussi des pâtisseries → "boulangerie"
   - un restaurant qui sert des pizzas → "pizzeria"
   - un café qui sert des sandwiches → "cafe"
   - sinon "restaurant" / "bistrot" / "brasserie" selon le format

4. PRIX (catégorie "prix") — UN SEUL TAG
   eur1 ≤15€/pers, eur2 15-35€, eur3 35-80€, eur4 >80€. Estime depuis
   la fourchette mentionnée. Si rien n'est dit, ne mets pas de prix.

5. AMBIANCE — UN SEUL TAG recommandé. Si la vidéo ne dit rien
   d'explicite sur l'atmosphère, ne mets pas de tag ambiance.

6. PARTICULARITÉ — uniquement si EXPLICITE (ex: "étoilé Michelin",
   "vue sur la Tour Eiffel", "magnifique terrasse"). Ne devine jamais.

7. RESTAURANTS
   - N'invente AUCUN restaurant. Aucune certitude = pas de restaurant.
   - startSeconds : uniquement si la transcription donne un repère clair,
     sinon null.
   - Les tags s'appliquent à TOUS les restaurants de la vidéo (la vidéo
     a une ambiance/cuisine globale, pas un set de tags par resto).

8. FORMAT JSON
   - "category" doit être un slug de catégorie (cuisine, type_lieu,
     regime, prix, moment, ambiance, particularite).
   - "slug" doit être un slug de tag de cette catégorie.
   - Tout tag hors whitelist sera silencieusement ignoré.
`.trim();
}

function renderTaxonomy(): string {
  return TAXONOMY.map((cat) => {
    const tagList = cat.tags
      .map((t) => `  - ${t.slug}  (${t.name})`)
      .join("\n");
    const requiredMark = cat.required ? " [OBLIGATOIRE si déterminable]" : "";
    return `Catégorie "${cat.slug}"${requiredMark}
${cat.description}
${tagList}`;
  }).join("\n\n");
}
