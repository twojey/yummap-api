import { config, supabaseService } from "../../../config.ts";

export class SupabaseStorageAdapter {
  // Upload sur un bucket nommé. Par défaut "videos".
  async upload(
    key: string,
    data: Uint8Array,
    contentType: string,
    bucket = "videos",
  ): Promise<string> {
    const { error } = await supabaseService.storage
      .from(bucket)
      .upload(key, data, { contentType, upsert: true });

    if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);

    const { data: publicData } = supabaseService.storage
      .from(bucket)
      .getPublicUrl(key);

    return publicData.publicUrl;
  }
}
