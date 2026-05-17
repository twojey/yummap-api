#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run

/**
 * Backfill des thumbnails pour les vidéos importées avant le pipeline
 * de génération automatique (migration 0022).
 *
 * Pour chaque vidéo sans `thumbnail_url` :
 *   1. Télécharge la vidéo depuis stream_url (Supabase Storage)
 *   2. Génère un thumbnail WebP via ffmpeg
 *   3. Upload le thumbnail sur Storage (à côté du .mp4)
 *   4. Met à jour `videos.thumbnail_url` en DB
 *
 * Best-effort : si une vidéo échoue (introuvable, ffmpeg crash) on log et on
 * passe à la suivante. Le caller peut relancer le script pour reprendre.
 *
 * Prérequis : ffmpeg dans le PATH, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * dans l'env.
 *
 * Usage :
 *   deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
 *     scripts/backfill_video_thumbnails.ts [--limit=N]
 */

import { supabaseService } from "../config.ts";
import { SupabaseStorageAdapter } from "../src/infrastructure/storage/supabase-storage.adapter.ts";
import { generateThumbnail } from "../src/infrastructure/video/video-thumbnail.ts";

interface VideoRow {
  id: string;
  stream_url: string;
  stored_path: string;
  uploader_id: string;
}

// Parse --limit=N (défaut 1000 = tout)
function parseLimit(): number {
  for (const arg of Deno.args) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return 1000;
}

// Reconstruit la clé Storage (uploader/<basename>.mp4) depuis stored_path
// ou stream_url. Le pipeline d'import upload sous la forme `${uploaderId}/${filename}.mp4`.
function buildStorageKey(row: VideoRow): string {
  // stream_url est de la forme https://<project>.supabase.co/storage/v1/object/public/videos/<uploader>/<file>.mp4
  // On extrait <uploader>/<file>.mp4
  const m = row.stream_url.match(/\/videos\/(.+\.mp4)(?:\?|$)/);
  if (m) return m[1];
  // Fallback : reconstruire depuis stored_path
  const basename = row.stored_path.split("/").pop()!.replace(".mp4", "");
  return `${row.uploader_id}/${basename}.mp4`;
}

async function downloadVideoToTemp(streamUrl: string): Promise<string> {
  const res = await fetch(streamUrl);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // tmp file local, sera supprimé après l'upload du thumbnail
  const tmpPath = await Deno.makeTempFile({ suffix: ".mp4" });
  await Deno.writeFile(tmpPath, bytes);
  return tmpPath;
}

async function processVideo(
  row: VideoRow,
  storage: SupabaseStorageAdapter,
): Promise<{ ok: boolean; thumbnailUrl?: string; error?: string }> {
  let tmpVideoPath: string | null = null;
  try {
    // 1. Télécharger la vidéo en local
    tmpVideoPath = await downloadVideoToTemp(row.stream_url);

    // 2. Générer le thumbnail à côté
    const { thumbPath, contentType } = await generateThumbnail(tmpVideoPath);

    // 3. Upload sur Storage (même structure de clé que le pipeline)
    const videoKey = buildStorageKey(row);
    const thumbKey = videoKey.replace(/\.mp4$/, "_thumb.jpg");
    const thumbBytes = await Deno.readFile(thumbPath);
    const thumbnailUrl = await storage.upload(thumbKey, thumbBytes, contentType);

    // 4. Mettre à jour la DB
    const { error: updateErr } = await supabaseService
      .from("videos")
      .update({ thumbnail_url: thumbnailUrl })
      .eq("id", row.id);
    if (updateErr) throw new Error(`DB update failed: ${updateErr.message}`);

    // Cleanup local
    await Deno.remove(thumbPath).catch(() => {});

    return { ok: true, thumbnailUrl };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    if (tmpVideoPath) {
      await Deno.remove(tmpVideoPath).catch(() => {});
    }
  }
}

async function main() {
  const limit = parseLimit();
  console.log(`🔧 Backfill thumbnails (limite: ${limit})...\n`);

  // Lister les vidéos sans thumbnail
  const { data, error } = await supabaseService
    .from("videos")
    .select("id, stream_url, stored_path, uploader_id")
    .is("thumbnail_url", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`❌ Query failed: ${error.message}`);
    Deno.exit(1);
  }

  const rows = (data ?? []) as VideoRow[];
  console.log(`📋 ${rows.length} vidéos sans thumbnail\n`);

  if (rows.length === 0) {
    console.log("✨ Rien à faire");
    return;
  }

  const storage = new SupabaseStorageAdapter();
  let okCount = 0;
  let failCount = 0;

  const encoder = new TextEncoder();
  for (const [idx, row] of rows.entries()) {
    const label = `[${idx + 1}/${rows.length}] ${row.id.slice(0, 8)}`;
    Deno.stdout.writeSync(encoder.encode(`${label} ... `));
    const result = await processVideo(row, storage);
    if (result.ok) {
      okCount++;
      console.log(`✅`);
    } else {
      failCount++;
      console.log(`❌ ${result.error}`);
    }
  }

  console.log(`\n📊 Résultat: ${okCount} ok / ${failCount} fail / ${rows.length} total`);
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  Deno.exit(1);
});
