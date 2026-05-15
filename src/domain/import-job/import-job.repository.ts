import type { ImportJob, ImportJobStatus, ImportJobVideoItem } from "./import-job.types.ts";

export interface PausedJobState {
  videoQueue: ImportJobVideoItem[];
  lastProcessedIndex: number;
  pausedUntil: string | null;
}

export interface IImportJobRepository {
  create(job: Omit<ImportJob, "id" | "processedVideos" | "successCount" | "failureCount" | "incompleteCount" | "errors" | "startedAt" | "completedAt" | "createdAt">): Promise<ImportJob>;
  findById(id: string): Promise<ImportJob | null>;
  findAll(): Promise<ImportJob[]>;
  findResumable(now: Date): Promise<string[]>;
  updateStatus(id: string, status: ImportJobStatus, extra?: Partial<Pick<ImportJob, "startedAt" | "completedAt" | "totalVideos">>): Promise<void>;
  incrementProgress(id: string, outcome: "success" | "failure" | "incomplete", error?: { videoUrl: string; reason: string; missing?: string[] }): Promise<void>;
  saveQueue(id: string, queue: ImportJobVideoItem[]): Promise<void>;
  loadQueue(id: string): Promise<PausedJobState | null>;
  setLastProcessedIndex(id: string, index: number): Promise<void>;
  pause(id: string, pausedUntil: Date, reason: string): Promise<void>;
}
