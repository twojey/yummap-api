// Déduplication cross-plateforme des vidéos importées.
//
// Une même vidéo postée par l'influenceur sur Instagram ET TikTok ne doit
// produire qu'une seule ligne `videos` en DB. Les uploaders qui partagent les
// différentes URLs deviennent contributors de cette unique vidéo.
//
// Deux signaux indépendants sont calculés ici. Le pipeline les passe ensuite
// au repository pour interroger la base — la logique d'I/O reste hors de ce
// module (pure, testable sans DB).

import { encodeHex } from "https://deno.land/std@0.224.0/encoding/hex.ts";

/// Fenêtre par défaut pour considérer que deux contenus identiques sont en
/// fait la même vidéo (et non une revisite plus tardive du même resto).
export const DEFAULT_DEDUP_WINDOW_DAYS = 30;

/// Fenêtre serrée autour du timestamp de publication pour l'heuristique
/// "même influenceur + même resto + posté à ~±X". Couvre le cross-post quasi
/// instantané (souvent <12h entre TikTok et Instagram).
export const DEFAULT_HEURISTIC_WINDOW_HOURS = 48;

export interface FingerprintInput {
  /// Texte transcrit (Whisper). Peut être vide si vidéo silencieuse.
  transcription: string;
  /// IDs des restos détectés et résolus via Google Places, dans l'ordre de
  /// détection. On les trie avant hash pour que l'ordre IA ne perturbe pas.
  restaurantIds: string[];
}

/// Hash sha256 stable d'un contenu sémantique :
///   sha256( normalize(transcription) + "|" + sorted(restaurantIds).join(",") )
///
/// Propriétés visées :
/// - Insensible à la casse, aux accents et à la ponctuation.
/// - Robuste à l'ordre de détection des restos (sorted).
/// - Une vidéo silencieuse partage le même fingerprint avec une autre vidéo
///   silencieuse du même resto → bon signal de doublon (à confirmer par
///   l'heuristique influencer + posted_at avant d'agir).
export async function computeContentFingerprint(
  input: FingerprintInput,
): Promise<string> {
  const normalizedText = normalizeForFingerprint(input.transcription);
  const sortedRestaurants = [...input.restaurantIds].sort();
  const canonical = `${normalizedText}|${sortedRestaurants.join(",")}`;
  const data = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hash));
}

/// Normalisation pour le fingerprint :
/// - lowercase
/// - suppression des accents (NFD + retrait des combining marks)
/// - collapse des espaces et ponctuation en un séparateur unique
/// - trim
export function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacritiques
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/// Indique si un fingerprint est "exploitable" pour la dédup. Si la
/// transcription est très courte ET qu'il n'y a aucun resto détecté, le
/// fingerprint dégénère vers une valeur quasi constante : on retombe alors
/// uniquement sur l'heuristique posted_at.
export function isFingerprintReliable(
  input: FingerprintInput,
  minNormalizedChars = 30,
): boolean {
  if (input.restaurantIds.length > 0) return true;
  return normalizeForFingerprint(input.transcription).length >= minNormalizedChars;
}

export interface HeuristicMatchInput {
  /// uploader_id de la vidéo qu'on est en train d'importer (Yummap user_id).
  uploaderId: string;
  /// IDs des restos détectés et résolus.
  restaurantIds: string[];
  /// Timestamp de publication sur la plateforme (TikTok/Instagram), parsé
  /// depuis les métadonnées du scraper. NULL si non disponible.
  postedAt: Date | null;
  windowHours?: number;
}

/// Décrit le critère heuristique à requêter en base. Retourne null si on n'a
/// pas assez d'infos pour interroger (pas de posted_at ou pas de restos).
/// Le repository utilise ce DTO pour construire son SELECT.
export interface HeuristicCriteria {
  uploaderId: string;
  restaurantIds: string[];
  postedAtMin: Date;
  postedAtMax: Date;
}

export function buildHeuristicCriteria(
  input: HeuristicMatchInput,
): HeuristicCriteria | null {
  if (input.postedAt === null) return null;
  if (input.restaurantIds.length === 0) return null;
  const windowMs = (input.windowHours ?? DEFAULT_HEURISTIC_WINDOW_HOURS) *
    60 *
    60 *
    1000;
  return {
    uploaderId: input.uploaderId,
    restaurantIds: input.restaurantIds,
    postedAtMin: new Date(input.postedAt.getTime() - windowMs),
    postedAtMax: new Date(input.postedAt.getTime() + windowMs),
  };
}

export interface FingerprintCriteria {
  fingerprint: string;
  restaurantIds: string[];
  postedAtMin: Date;
}

/// Critère pour le lookup par fingerprint. Scoped sur la fenêtre 30j pour
/// éviter de marquer comme doublon une revisite ultérieure du même resto.
export function buildFingerprintCriteria(
  fingerprint: string,
  restaurantIds: string[],
  now: Date,
  windowDays = DEFAULT_DEDUP_WINDOW_DAYS,
): FingerprintCriteria {
  const minMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return {
    fingerprint,
    restaurantIds,
    postedAtMin: new Date(minMs),
  };
}
