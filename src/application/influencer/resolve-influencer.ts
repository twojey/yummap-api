/// Résolution d'un influenceur à partir du handle social (Instagram/TikTok) de
/// l'auteur d'une vidéo. Utilisé par le pipeline d'import pour attribuer la
/// vidéo à l'influenceur qui l'a publiée, et non à l'utilisateur qui l'a
/// partagée. Réutilise la même politique que le bulk import admin (match par
/// display_name, création sinon, guide par défaut garanti).
///
/// La logique est isolée derrière un port pour être testable sans DB.

export interface InfluencerLookupPort {
  /// Retourne l'id du user influenceur dont le display_name == handle, ou null.
  findInfluencerByHandle(handle: string): Promise<string | null>;
  /// Crée un user influenceur (role='influencer', display_name=handle) et
  /// retourne son id.
  createInfluencer(handle: string): Promise<string>;
  /// Garantit (idempotent) l'existence du Guide par défaut de l'influenceur.
  ensureDefaultGuide(influencerId: string, handle: string): Promise<void>;
}

/// Normalise un handle brut : retire `@`, trim, écarte les valeurs vides ou les
/// sentinelles "NA"/"None" que les scrapers renvoient quand le champ est absent.
export function normalizeInfluencerHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^@/, "");
  if (!cleaned || cleaned.toUpperCase() === "NA" || cleaned === "None") return null;
  return cleaned;
}

/// Trouve ou crée l'influenceur correspondant au handle. Retourne son user id,
/// ou null si le handle est vide/invalide (l'appelant retombe alors sur
/// l'utilisateur partageur).
export async function resolveInfluencerByHandle(
  rawHandle: string | null | undefined,
  port: InfluencerLookupPort,
): Promise<string | null> {
  const handle = normalizeInfluencerHandle(rawHandle);
  if (!handle) return null;

  const existing = await port.findInfluencerByHandle(handle);
  if (existing) {
    await port.ensureDefaultGuide(existing, handle);
    return existing;
  }

  const created = await port.createInfluencer(handle);
  await port.ensureDefaultGuide(created, handle);
  return created;
}
