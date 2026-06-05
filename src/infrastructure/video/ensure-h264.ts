/// Garantit que la piste vidéo est en H.264, le seul codec lu universellement
/// par AVPlayer (iOS) ET ExoPlayer (Android) via le plugin Flutter video_player.
///
/// Instagram sert parfois ses reels en VP9 : les navigateurs décodent VP9 (le
/// panel admin affiche donc bien l'image), mais AVPlayer sur iOS ne sait PAS
/// décoder VP9 → seule la piste audio AAC est lue → "son sans image". On sonde
/// la piste vidéo et, si elle n'est pas en h264, on ré-encode en libx264
/// (audio ré-encodé en AAC pour couvrir les conteneurs webm/Opus).
///
/// Idempotent : si la vidéo est déjà en h264 on ne touche à rien et on renvoie
/// le chemin inchangé. Sinon on remplace le fichier sur place (même chemin).

/// Sonde le codec de la première piste vidéo via ffprobe. Renvoie p.ex.
/// "h264", "vp9", "hevc", ou null si ffprobe échoue / pas de piste vidéo.
export async function probeVideoCodec(videoPath: string): Promise<string | null> {
  const proc = new Deno.Command("ffprobe", {
    args: [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=nk=1:nw=1",
      videoPath,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const res = await proc.output();
  if (res.code !== 0) return null;
  return new TextDecoder().decode(res.stdout).trim() || null;
}

/// Transcode `videoPath` en H.264 si nécessaire (sur place). Renvoie le codec
/// d'origine détecté ("h264" => aucun transcodage effectué).
export async function ensureH264(videoPath: string): Promise<string | null> {
  const codec = await probeVideoCodec(videoPath);
  if (codec === "h264") return codec;

  const transcodedPath = `${videoPath}.h264.mp4`;
  const ff = new Deno.Command("ffmpeg", {
    args: [
      "-y",
      "-i", videoPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      transcodedPath,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const res = await ff.output();
  if (res.code !== 0) {
    await Deno.remove(transcodedPath).catch(() => {});
    throw new Error(
      `ensureH264 ffmpeg failed (codec=${codec}): ${new TextDecoder().decode(res.stderr).slice(0, 300)}`,
    );
  }
  await Deno.rename(transcodedPath, videoPath);
  return codec;
}
