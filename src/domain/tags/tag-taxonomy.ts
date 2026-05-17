// Source de vérité unique de la taxonomie des tags Yummap.
//
// Cette taxonomie est dupliquée en base (table tags, voir migration 0020) :
// la base contient les UUID, ce fichier les slugs et labels FR. Pour ajouter
// ou retirer un tag :
//   1) Modifier la constante TAXONOMY ci-dessous
//   2) Écrire une migration Postgres qui insère / supprime le tag
//   3) Le prompt LLM est régénéré automatiquement à chaque appel
//
// Tout le code de validation et tous les prompts LLM consomment cette source —
// ne pas hardcoder de slugs ailleurs.

export type CategorySlug =
  | "cuisine"
  | "type_lieu"
  | "regime"
  | "prix"
  | "moment"
  | "ambiance"
  | "particularite";

export interface CanonicalTag {
  slug: string;
  name: string;
}

export interface CanonicalCategory {
  slug: CategorySlug;
  name: string;
  required: boolean;
  description: string;
  tags: ReadonlyArray<CanonicalTag>;
}

export const TAXONOMY: ReadonlyArray<CanonicalCategory> = [
  {
    slug: "cuisine",
    name: "cuisine",
    required: true,
    description:
      "Origine culinaire du restaurant (pays ou région). Détermine l'icône du pin sur la carte. Choisis 1 valeur si tu peux la déterminer.",
    tags: [
      { slug: "francaise", name: "française" },
      { slug: "italienne", name: "italienne" },
      { slug: "japonaise", name: "japonaise" },
      { slug: "coreenne", name: "coréenne" },
      { slug: "chinoise", name: "chinoise" },
      { slug: "vietnamienne", name: "vietnamienne" },
      { slug: "thai", name: "thaï" },
      { slug: "indienne", name: "indienne" },
      { slug: "libanaise", name: "libanaise" },
      { slug: "mediterraneenne", name: "méditerranéenne" },
      { slug: "mexicaine", name: "mexicaine" },
      { slug: "peruvienne", name: "péruvienne" },
      { slug: "africaine", name: "africaine" },
      { slug: "americaine", name: "américaine" },
      { slug: "espagnole", name: "espagnole" },
      { slug: "bresilienne", name: "brésilienne" },
    ],
  },
  {
    slug: "type_lieu",
    name: "type de lieu",
    required: false,
    description:
      "Type d'établissement physique. Choisis le plus spécifique applicable (cafe > restaurant, patisserie > restaurant).",
    tags: [
      { slug: "restaurant", name: "restaurant" },
      { slug: "bistrot", name: "bistrot" },
      { slug: "brasserie", name: "brasserie" },
      { slug: "gastronomique", name: "gastronomique" },
      { slug: "pizzeria", name: "pizzeria" },
      { slug: "cafe", name: "café" },
      { slug: "boulangerie", name: "boulangerie" },
      { slug: "patisserie", name: "pâtisserie" },
      { slug: "bar_a_vin", name: "bar à vin" },
      { slug: "bar_a_cocktails", name: "bar à cocktails" },
      { slug: "street_food", name: "street food" },
      { slug: "creperie", name: "crêperie" },
      { slug: "burger", name: "burger" },
      { slug: "sandwicherie", name: "sandwicherie" },
      { slug: "glacier", name: "glacier" },
      { slug: "kebab", name: "kebab" },
    ],
  },
  {
    slug: "regime",
    name: "régime alimentaire",
    required: false,
    description:
      "INFORMATION CRITIQUE pour les utilisateurs avec contraintes alimentaires. Marque chaque régime que le restaurant supporte explicitement. Si le restaurant est 100% vegan, ajoute aussi 'options_vege'. Si la vidéo ou la description mentionne 'options veggie' / 'vegan friendly' / 'plats végétariens disponibles', utilise 'options_vege'. Ne JAMAIS deviner — uniquement si c'est explicitement dit.",
    tags: [
      { slug: "vegetarien", name: "végétarien" },
      { slug: "vegan", name: "vegan" },
      { slug: "options_vege", name: "options végé" },
      { slug: "sans_gluten", name: "sans gluten" },
      { slug: "sans_lactose", name: "sans lactose" },
      { slug: "halal", name: "halal" },
      { slug: "casher", name: "casher" },
      { slug: "bio", name: "bio" },
    ],
  },
  {
    slug: "prix",
    name: "prix",
    required: false,
    description:
      "Gamme de prix. € (≤15€/pers), €€ (15-35€/pers), €€€ (35-80€/pers), €€€€ (>80€/pers). 0 ou 1 valeur.",
    tags: [
      { slug: "eur1", name: "€" },
      { slug: "eur2", name: "€€" },
      { slug: "eur3", name: "€€€" },
      { slug: "eur4", name: "€€€€" },
    ],
  },
  {
    slug: "moment",
    name: "moment",
    required: false,
    description:
      "Moment(s) de la journée où l'on peut y aller, selon ce que le restaurant met en avant. Multi-valué possible.",
    tags: [
      { slug: "petit_dej", name: "petit-déj" },
      { slug: "brunch", name: "brunch" },
      { slug: "dejeuner", name: "déjeuner" },
      { slug: "gouter", name: "goûter" },
      { slug: "diner", name: "dîner" },
      { slug: "tard_le_soir", name: "tard le soir" },
    ],
  },
  {
    slug: "ambiance",
    name: "ambiance",
    required: false,
    description:
      "Ambiance générale du lieu. 0 ou 1 valeur recommandée — pas la peine de cumuler 'cosy' + 'calme'.",
    tags: [
      { slug: "cosy", name: "cosy" },
      { slug: "calme", name: "calme" },
      { slug: "anime", name: "animé" },
      { slug: "romantique", name: "romantique" },
      { slug: "familial", name: "familial" },
      { slug: "elegant", name: "élégant" },
      { slug: "decontracte", name: "décontracté" },
    ],
  },
  {
    slug: "particularite",
    name: "particularité",
    required: false,
    description:
      "Distinctions notables et services. Uniquement si la vidéo le dit explicitement.",
    tags: [
      { slug: "etoile", name: "étoilé" },
      { slug: "bib_gourmand", name: "bib gourmand" },
      { slug: "terrasse", name: "terrasse" },
      { slug: "vue", name: "vue" },
      { slug: "a_emporter", name: "à emporter" },
      { slug: "fait_maison", name: "fait maison" },
    ],
  },
];

export const CATEGORY_SLUGS: ReadonlySet<CategorySlug> = new Set(
  TAXONOMY.map((c) => c.slug),
);

// Map slug-catégorie → set des slugs-tag autorisés. Validation rapide en pipeline.
export const ALLOWED_TAG_SLUGS_BY_CATEGORY: ReadonlyMap<
  CategorySlug,
  ReadonlySet<string>
> = new Map(
  TAXONOMY.map((c) => [c.slug, new Set(c.tags.map((t) => t.slug))]),
);

export function isValidTag(category: string, slug: string): boolean {
  if (!CATEGORY_SLUGS.has(category as CategorySlug)) return false;
  return ALLOWED_TAG_SLUGS_BY_CATEGORY.get(category as CategorySlug)!.has(slug);
}
