import { Router } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { supabaseService } from "../../config.ts";

// GET /tags
//
// Retourne la taxonomie complète (7 catégories canoniques + leurs tags) pour
// alimenter les sélecteurs côté clients (filtres map, dropdowns admin/influencer).
//
// Format :
// [
//   { slug, name, isRequired, sortOrder, tags: [{ id, slug, name }] },
//   ...
// ]
//
// Le `slug` du tag est l'identifiant stable côté client (matche la whitelist
// dans api/src/domain/tags/tag-taxonomy.ts). Le `id` (UUID) est utilisé pour
// les jointures restaurant_tags.
//
// Catégories triées par sort_order (cuisine en premier), tags triés par
// sort_order de catégorie puis par nom pour un affichage stable.
export function registerTagRoutes(router: Router) {
  router.get("/tags", guestOrAuth, async (ctx) => {
    const { data: cats, error: catsErr } = await supabaseService
      .from("tag_categories")
      .select("id, slug, name, is_required, sort_order")
      .order("sort_order", { ascending: true });
    if (catsErr) throw new Error(`tag_categories load failed: ${catsErr.message}`);

    const { data: tags, error: tagsErr } = await supabaseService
      .from("tags")
      .select("id, category_id, slug, name")
      .order("name", { ascending: true });
    if (tagsErr) throw new Error(`tags load failed: ${tagsErr.message}`);

    const tagsByCategory = new Map<string, Array<{ id: string; slug: string; name: string }>>();
    for (const t of (tags ?? []) as Array<{ id: string; category_id: string; slug: string; name: string }>) {
      const list = tagsByCategory.get(t.category_id) ?? [];
      list.push({ id: t.id, slug: t.slug, name: t.name });
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
