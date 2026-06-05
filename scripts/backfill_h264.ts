#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run

/**
 * Backfill H.264 : ré-encode les vidéos stockées dont la piste vidéo n'est PAS
 * en h264 (typiquement du VP9 servi par Instagram). Ces vidéos se lisent dans
 * les navigateurs (panel admin OK) mais pas dans le video_player Flutter sur
 * iOS (AVPlayer ne décode pas VP9) → "son sans image".
 *
 * Pour chaque vidéo :
 *   1. Télécharge le .mp4 depuis stream_url (Supabase Storage)
 *   2. ffprobe la piste vidéo ; si déjà h264 → skip
 *   3. Sinon ré-encode en libx264 (ensureH264) et ré-upload sur la MÊME clé
 *      Storage (upsert) → stream_url inchangé, aucune mise à jour DB requise
 *
 * Best-effort : une vidéo qui échoue est loggée, on continue. Relançable.
 *
 * Prérequis : ffmpeg + ffprobe dans le PATH, SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY dans l'env.
 *
 * Usage :
 *   deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
 *     scripts/backfill_h264.ts [--limit=N] [--dry-run] [<videoId> ...]
 *
 *   --dry-run : sonde et rapporte les codecs sans rien transcoder/uploader
 *   <videoId> : restreint le traitement à ces IDs (sinon : toutes les vidéos)
 */

import { supabaseService } from "../config.ts";
import { SupabaseStorageAdapter } from "../src/infrastructure/storage/supabase-storage.adapter.ts";
import { ensureH264, probeVideoCodec } from "../src/infrastructure/video/ensure-h264.ts";

interface VideoRow {
  id: string;
  stream_url: string;
  stored_path: string | null;
  uploader_id: string;
}

function parseLimit(): number {
  for (const arg of Deno.args) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return 5000;
}

const DRY_RUN = Deno.args.includes("--dry-run");
const EXPLICIT_IDS = Deno.args.filter((a) => !a.startsWith("--"));

// stream_url : https://<project>.supabase.co/storage/v1/object/public/videos/<uploader>/<file>.mp4
function buildStorageKey(row: VideoRow): string {
  const m = row.stream_url.match(/\/videos\/(.+\.mp4)(?:\?|$)/);
  if (m) return m[1];
  const basename = (row.stored_path ?? "").split("/").pop()!.replace(".mp4", "");
  return `${row.uploader_id}/${basename}.mp4`;
}

async function downloadToTemp(streamUrl: string): Promise<string> {
  const res = await fetch(streamUrl);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tmpPath = await Deno.makeTempFile({ suffix: ".mp4" });
  await Deno.writeFile(tmpPath, bytes);
  return tmpPath;
}

async function processVideo(
  row: VideoRow,
  storage: SupabaseStorageAdapter,
): Promise<{ status: "skipped" | "fixed" | "would-fix" | "failed"; codec?: string | null; error?: string }> {
  let tmpPath: string | null = null;
  try {
    tmpPath = await downloadToTemp(row.stream_url);
    const codec = await probeVideoCodec(tmpPath);

    if (codec === "h264") return { status: "skipped", codec };
    if (DRY_RUN) return { status: "would-fix", codec };

    // Ré-encode sur place puis ré-upload sur la même clé (upsert overwrite).
    await ensureH264(tmpPath);
    const key = buildStorageKey(row);
    const bytes = await Deno.readFile(tmpPath);
    await storage.upload(key, bytes, "video/mp4");

    return { status: "fixed", codec };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  } finally {
    if (tmpPath) await Deno.remove(tmpPath).catch(() => {});
  }
}

async function main() {
  const limit = parseLimit();
  console.log(
    `🔧 Backfill H.264 ${DRY_RUN ? "(DRY-RUN) " : ""}` +
      (EXPLICIT_IDS.length ? `(${EXPLICIT_IDS.length} IDs ciblés)` : `(limite: ${limit})`) +
      `...\n`,
  );

  let query = supabaseService
    .from("videos")
    .select("id, stream_url, stored_path, uploader_id")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (EXPLICIT_IDS.length) query = query.in("id", EXPLICIT_IDS);

  const { data, error } = await query;
  if (error) {
    console.error(`❌ Query failed: ${error.message}`);
    Deno.exit(1);
  }

  const rows = (data ?? []) as VideoRow[];
  console.log(`📋 ${rows.length} vidéos à sonder\n`);
  if (rows.length === 0) {
    console.log("✨ Rien à faire");
    return;
  }

  const storage = new SupabaseStorageAdapter();
  const counts = { skipped: 0, fixed: 0, "would-fix": 0, failed: 0 };
  const encoder = new TextEncoder();

  for (const [idx, row] of rows.entries()) {
    const label = `[${idx + 1}/${rows.length}] ${row.id.slice(0, 8)}`;
    Deno.stdout.writeSync(encoder.encode(`${label} ... `));
    const r = await processVideo(row, storage);
    counts[r.status]++;
    if (r.status === "skipped") console.log(`✅ h264 (skip)`);
    else if (r.status === "fixed") console.log(`🛠️  ${r.codec} → h264 (ré-uploadé)`);
    else if (r.status === "would-fix") console.log(`⚠️  ${r.codec} → à corriger`);
    else console.log(`❌ ${r.error}`);
  }

  console.log(
    `\n📊 Résultat: ${counts.skipped} déjà h264 / ` +
      (DRY_RUN ? `${counts["would-fix"]} à corriger` : `${counts.fixed} corrigées`) +
      ` / ${counts.failed} fail / ${rows.length} total`,
  );
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  Deno.exit(1);
});
