import { supabaseService } from "../../../config.ts";
import type { IInfluencerInvitationRepository } from "../../domain/influencer/invitation.repository.ts";
import type { InfluencerInvitation, PendingInfluencerProfile } from "../../domain/influencer/invitation.types.ts";

export class SupabaseInvitationRepository implements IInfluencerInvitationRepository {
  async create(params: Parameters<IInfluencerInvitationRepository["create"]>[0]): Promise<InfluencerInvitation> {
    const { data, error } = await supabaseService
      .from("influencer_invitations")
      .insert({
        token: crypto.randomUUID(),
        type: params.type,
        created_by_id: params.createdById,
        target_email: params.targetEmail ?? null,
        target_phone: params.targetPhone ?? null,
        linked_influencer_id: params.linkedInfluencerId ?? null,
        status: "pending",
        expires_at: params.expiresAt,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findById(id: string): Promise<InfluencerInvitation | null> {
    const { data, error } = await supabaseService
      .from("influencer_invitations").select("*").eq("id", id).single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findByToken(token: string): Promise<InfluencerInvitation | null> {
    const { data, error } = await supabaseService
      .from("influencer_invitations").select("*").eq("token", token).single();
    if (error?.code === "PGRST116") return null;
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async findByCreator(createdById: string): Promise<InfluencerInvitation[]> {
    const { data, error } = await supabaseService
      .from("influencer_invitations").select("*").eq("created_by_id", createdById)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: unknown) => this.#mapRow(r as Record<string, unknown>));
  }

  async findLatestByLinkedInfluencer(linkedInfluencerId: string): Promise<InfluencerInvitation | null> {
    const { data, error } = await supabaseService
      .from("influencer_invitations").select("*")
      .eq("linked_influencer_id", linkedInfluencerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.#mapRow(data) : null;
  }

  async refresh(id: string, expiresAt: string): Promise<InfluencerInvitation> {
    const { data, error } = await supabaseService
      .from("influencer_invitations")
      .update({ status: "pending", expires_at: expiresAt })
      .eq("id", id).select("*").single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async claim(id: string, claimedById: string): Promise<InfluencerInvitation> {
    const { data, error } = await supabaseService
      .from("influencer_invitations")
      .update({ status: "claimed", claimed_by_id: claimedById })
      .eq("id", id).select("*").single();
    if (error) throw new Error(error.message);
    return this.#mapRow(data);
  }

  async updateStatus(id: string, status: InfluencerInvitation["status"]): Promise<void> {
    const { error } = await supabaseService
      .from("influencer_invitations").update({ status }).eq("id", id);
    if (error) throw new Error(error.message);
  }

  async countActiveByCreator(createdById: string): Promise<number> {
    const { count, error } = await supabaseService
      .from("influencer_invitations")
      .select("id", { count: "exact", head: true })
      .eq("created_by_id", createdById)
      .eq("type", "influencer")
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async createPendingProfile(profile: Omit<PendingInfluencerProfile, "createdAt">): Promise<PendingInfluencerProfile> {
    const { data, error } = await supabaseService
      .from("pending_influencer_profiles")
      .insert({
        user_id: profile.userId,
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        bio: profile.bio,
        social_profiles: profile.socialProfiles,
        invited_by_id: profile.invitedById,
        status: profile.status,
      })
      .select("*").single();
    if (error) throw new Error(error.message);
    return this.#mapPendingRow(data);
  }

  async findPendingProfiles(): Promise<PendingInfluencerProfile[]> {
    const { data, error } = await supabaseService
      .from("pending_influencer_profiles").select("*").eq("status", "pending_review")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: unknown) => this.#mapPendingRow(r as Record<string, unknown>));
  }

  async updatePendingStatus(userId: string, status: PendingInfluencerProfile["status"]): Promise<void> {
    const { error } = await supabaseService
      .from("pending_influencer_profiles").update({ status }).eq("user_id", userId);
    if (error) throw new Error(error.message);
  }

  // deno-lint-ignore no-explicit-any
  #mapRow(row: any): InfluencerInvitation {
    return {
      id: row.id,
      token: row.token,
      type: row.type,
      createdById: row.created_by_id,
      targetEmail: row.target_email ?? null,
      targetPhone: row.target_phone ?? null,
      linkedInfluencerId: row.linked_influencer_id ?? null,
      status: row.status,
      expiresAt: row.expires_at,
      claimedById: row.claimed_by_id ?? null,
      createdAt: row.created_at,
    };
  }

  // deno-lint-ignore no-explicit-any
  #mapPendingRow(row: any): PendingInfluencerProfile {
    return {
      userId: row.user_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url ?? null,
      bio: row.bio ?? null,
      socialProfiles: row.social_profiles ?? [],
      invitedById: row.invited_by_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }
}
