import { Router } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { supabaseService } from "../../config.ts";

// GET /tags
//
// Retourne la taxonomie complète (5 catégories standard + leurs tags) pour
// alimenter les filtres rapides côté app (chips au-dessus de la map).
//
// Format :
// [
//   { slug, name, isRequired, sortOrder, tags: [{ id, name }] },
//   ...
// ]
//
// Les catégories sont retournées triées par sort_order (cuisine en premier),
// et les tags par nom alphabétique pour avoir un affichage stable.
export function registerTagRoutes(router: Router) {
  router.get("/tags", guestOrAuth, async (ctx) => {
    const { data: cats, error: catsErr } = await supabaseService
      .from("tag_categories")
      .select("id, slug, name, is_required, sort_order")
      .order("sort_order", { ascending: true });
    if (catsErr) throw new Error(`tag_categories load failed: ${catsErr.message}`);

    const { data: tags, error: tagsErr } = await supabaseService
      .from("tags")
      .select("id, category_id, name")
      .order("name", { ascending: true });
    if (tagsErr) throw new Error(`tags load failed: ${tagsErr.message}`);

    const tagsByCategory = new Map<string, Array<{ id: string; name: string }>>();
    for (const t of (tags ?? []) as Array<{ id: string; category_id: string; name: string }>) {
      const list = tagsByCategory.get(t.category_id) ?? [];
      list.push({ id: t.id, name: t.name });
      tagsByCategory.set(t.category_id, list);
    }

    ctx.response.body = ((cats ?? []) as Array<{
      id: string;
      slug: string;
      name: string;
      is_required: boolean;
      sort_order: number;
    }>).map((c) => ({
      slug: c.slug,
      name: c.name,
      isRequired: c.is_required,
      sortOrder: c.sort_order,
      tags: tagsByCategory.get(c.id) ?? [],
    }));
  });
}
