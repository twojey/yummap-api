import type {
  FingerprintCriteria,
  HeuristicCriteria,
} from "./cross-platform-dedup.ts";

/// Résultat compact d'un match de dédup (cross-plateforme).
/// On ne charge que ce qui est nécessaire pour décider "même vidéo".
export interface VideoDedupMatch {
  videoId: string;
  /// Restos déjà liés à cette vidéo, dans l'ordre (position 0 = principal).
  restaurantIds: string[];
  /// uploader_id d'origine — utile pour les logs et la trace d'attribution.
  originalUploaderId: string;
}

/// Trace d'une contribution : "user X a partagé l'URL Y pour la vidéo Z".
export interface AddContributorInput {
  videoId: string;
  userId: string;
  sourceUrl: string;
  platform: string | null;
  externalPostId: string | null;
}

/// Toutes les méthodes sont best-effort en lecture (retournent null) et
/// idempotentes en écriture (ON CONFLICT DO NOTHING côté implémentation).
export interface IVideoDedupRepository {
  /// Cherche une vidéo existante dont le content_fingerprint matche, ET qui
  /// est liée à au moins un des restos détectés, ET dont posted_at est dans
  /// la fenêtre. Retourne null si aucun match.
  findByFingerprint(criteria: FingerprintCriteria): Promise<VideoDedupMatch | null>;

  /// Cherche une vidéo existante du même uploader (heuristique : "l'influenceur
  /// a posté ce contenu à ±48h sur un autre canal"), liée à au moins un des
  /// restos détectés. Retourne null si aucun match.
  findByHeuristic(criteria: HeuristicCriteria): Promise<VideoDedupMatch | null>;

  /// Inscrit un contributor pour une vidéo existante. Idempotent : si le user
  /// est déjà contributor de cette vidéo, ne lève pas d'erreur.
  addContributor(input: AddContributorInput): Promise<void>;
}
