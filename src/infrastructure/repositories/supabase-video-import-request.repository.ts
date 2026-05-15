import { supabaseService } from "../../../config.ts";
import type { IVideoImportRequestRepository } from "../../domain/video/video-import-request.repository.ts";
import type { VideoImportRequest, VideoImportStatus } from "../../domain/video/video-import-request.types.ts";

export class SupabaseVideoImportRequestRepository implements IVideoImportRequestRepository {
  async create(url: string, uploaderId: string): Promise<VideoImportRequest> {
    const { data, error } = await supabaseService
      .from("video_import_requests")
      .insert({ url, uploader_id: uploaderId, status: "pending" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findById(id: string): Promise<VideoImportRequest | null> {
    const { data, error } = await supabaseService
      .from("video_import_requests")
      .select("*")
      .eq("id", id)
      .single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findByUploader(uploaderId: string): Promise<VideoImportRequest[]> {
    const { data, error } = await supabaseService
      .from("video_import_requests")
      .select("*")
      .eq("uploader_id", uploaderId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
  }

  async findPending(limit: number): Promise<VideoImportRequest[]> {
    const { data, error } = await supabaseService
      .from("video_import_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
  }

  async updateStatus(
    id: string,
    status: VideoImportStatus,
    extra?: {
      restaurantPlaceId?: string;
      restaurantName?: string;
      missingFields?: string[];
      errorMessage?: string;
    },
  ): Promise<void> {
    const { error } = await supabaseService
      .from("video_import_requests")
      .update({
        status,
        ...(extra?.restaurantPlaceId && { restaurant_place_id: extra.restaurantPlaceId }),
        ...(extra?.restaurantName && { restaurant_name: extra.restaurantName }),
        ...(extra?.missingFields && { missing_fields: extra.missingFields }),
        ...(extra?.errorMessage && { error_message: extra.errorMessage }),
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  // deno-lint-ignore no-explicit-any
  #mapRow(row: any): VideoImportRequest {
    return {
      id: row.id as string,
      url: row.url as string,
      uploaderId: row.uploader_id as string,
      status: row.status as VideoImportStatus,
      restaurantPlaceId: row.restaurant_place_id as string | null,
      restaurantName: row.restaurant_name as string | null,
      missingFields: (row.missing_fields as string[]) ?? [],
      errorMessage: row.error_message as string | null,
      createdAt: row.created_at as string,
    };
  }
}
