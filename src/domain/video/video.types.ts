export interface Video {
  id: string;
  restaurantId: string;
  uploaderId: string; // user UUID
  sourceUrl: string; // URL TikTok/Instagram originale
  storedPath: string; // chemin sur le serveur perso
  streamUrl: string; // URL de streaming
  subtitlesUrl: string | null; // URL du fichier .vtt
  transcription: string | null;
  duration: number | null; // secondes
  createdAt: string;
}

export interface PartialVideo {
  sourceUrl: string;
  uploaderId: string;
  transcription: string | null;
  detectedName: string | null;
  detectedAddress: string | null;
}
