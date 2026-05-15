/// Parse la sortie de `yt-dlp --print "%(timestamp)s"` (et co).
///
/// Format attendu : un entier Unix (secondes) sur sa propre ligne, ou "NA".
/// Tolère espaces/sauts de ligne et la possibilité d'autres lignes mêlées
/// (les builds verbeux de yt-dlp imprimnent parfois du diagnostic sur stdout
/// avant la valeur). Retourne null quand aucun entier strictement positif
/// n'est trouvé — l'heuristique de dédup posted_at ±48h saute alors et on
/// retombe sur le seul signal de fingerprint.
export function parseYtDlpTimestamp(stdout: string): Date | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "NA") continue;
    const secs = Number.parseInt(line, 10);
    if (Number.isFinite(secs) && secs > 0) {
      return new Date(secs * 1000);
    }
  }
  return null;
}
