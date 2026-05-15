import { supabaseService } from "../../../config.ts";
import type { IImportJobRepository, PausedJobState } from "../../domain/import-job/import-job.repository.ts";
import type { ImportJob, ImportJobStatus, ImportJobVideoItem } from "../../domain/import-job/import-job.types.ts";

export class SupabaseImportJobRepository implements IImportJobRepository {
  async create(job: Omit<ImportJob, "id" | "processedVideos" | "successCount" | "failureCount" | "incompleteCount" | "errors" | "startedAt" | "completedAt" | "createdAt">): Promise<ImportJob> {
    const { data, error } = await supabaseService
      .from("import_jobs")
      .insert({
        profile_url: job.profileUrl,
        influencer_id: job.influencerId,
        created_by: job.createdBy,
        status: job.status,
        total_videos: job.totalVideos,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findById(id: string): Promise<ImportJob | null> {
    const { data, error } = await supabaseService
      .from("import_jobs")
      .select("*")
      .eq("id", id)
      .single();

    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findAll(): Promise<ImportJob[]> {
    const { data, error } = await supabaseService
      .from("import_jobs")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
  }

  async updateStatus(
    id: string,
    status: ImportJobStatus,
    extra?: Partial<Pick<ImportJob, "startedAt" | "completedAt" | "totalVideos">>,
  ): Promise<void> {
    const { error } = await supabaseService
      .from("import_jobs")
      .update({
        status,
        ...(extra?.startedAt    && { started_at: extra.startedAt }),
        ...(extra?.completedAt  && { completed_at: extra.completedAt }),
        ...(extra?.totalVideos !== undefined && { total_videos: extra.totalVideos }),
      })
      .eq("id", id);

    if (error) throw new Error(error.message);
  }

  async incrementProgress(
    id: string,
    outcome: "success" | "failure" | "incomplete",
    error?: { videoUrl: string; reason: string; missing?: string[] },
  ): Promise<void> {
    const { data: current, error: fetchErr } = await supabaseService
      .from("import_jobs")
      .select("processed_videos, success_count, failure_count, incomplete_count, errors")
      .eq("id", id)
      .single();

    if (fetchErr) throw new Error(fetchErr.message);

    const errors = (current.errors ?? []) as ImportJob["errors"];
    if (error) errors.push(error);

    const { error: updateErr } = await supabaseService
      .from("import_jobs")
      .update({
        processed_videos: (current.processed_videos ?? 0) + 1,
        success_count:    outcome === "success"    ? (current.success_count ?? 0) + 1    : (current.success_count ?? 0),
        failure_count:    outcome === "failure"    ? (current.failure_count ?? 0) + 1    : (current.failure_count ?? 0),
        incomplete_count: outcome === "incomplete" ? (current.incomplete_count ?? 0) + 1 : (current.incomplete_count ?? 0),
        errors,
      })
      .eq("id", id);

    if (updateErr) throw new Error(updateErr.message);
  }

  async findResumable(now: Date): Promise<string[]> {
    // Reprend: paused dont paused_until <= now, ET running zombies (process killé)
    const { data: paused } = await supabaseService
      .from("import_jobs")
      .select("id")
      .eq("status", "paused")
      .lte("paused_until", now.toISOString());
    const { data: running } = await supabaseService
      .from("import_jobs")
      .select("id")
      .eq("status", "running");
    const ids = [
      ...((paused ?? []) as Array<{ id: string }>).map((r) => r.id),
      ...((running ?? []) as Array<{ id: string }>).map((r) => r.id),
    ];
    return [...new Set(ids)];
  }

  async saveQueue(id: string, queue: ImportJobVideoItem[]): Promise<void> {
    const { error } = await supabaseService
      .from("import_jobs")
      .update({ video_queue: queue, total_videos: queue.length })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  async loadQueue(id: string): Promise<PausedJobState | null> {
    const { data, error } = await supabaseService
      .from("import_jobs")
      .select("video_queue, last_processed_index, paused_until")
      .eq("id", id)
      .single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return {
      videoQueue: (data.video_queue ?? []) as ImportJobVideoItem[],
      lastProcessedIndex: (data.last_processed_index ?? 0) as number,
      pausedUntil: (data.paused_until ?? null) as string | null,
    };
  }

  async setLastProcessedIndex(id: string, index: number): Promise<void> {
    const { error } = await supabaseService
      .from("import_jobs")
      .update({ last_processed_index: index })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  async pause(id: string, pausedUntil: Date, reason: string): Promise<void> {
    const { error } = await supabaseService
      .from("import_jobs")
      .update({ status: "paused", paused_until: pausedUntil.toISOString(), paused_reason: reason })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  #mapRow(row: Record<string, unknown>): ImportJob {
    return {
      id:               row.id as string,
      profileUrl:       row.profile_url as string,
      influencerId:     row.influencer_id as string | null,
      createdBy:        row.created_by as string,
      status:           row.status as ImportJobStatus,
      totalVideos:      row.total_videos as number | null,
      processedVideos:  row.processed_videos as number ?? 0,
      successCount:     row.success_count as number ?? 0,
      failureCount:     row.failure_count as number ?? 0,
      incompleteCount:  row.incomplete_count as number ?? 0,
      errors:           (row.errors ?? []) as ImportJob["errors"],
      startedAt:        row.started_at as string | null,
      completedAt:      row.completed_at as string | null,
      createdAt:        row.created_at as string,
      pausedUntil:        (row.paused_until ?? null) as string | null,
      pausedReason:       (row.paused_reason ?? null) as string | null,
      lastProcessedIndex: (row.last_processed_index ?? 0) as number,
    };
  }
}
