import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError } from "../shared/errors.ts";
import type { AppContainer } from "../boot/container.ts";

const CreateInvitationSchema = z.object({
  targetPhone: z.string().min(8).optional(),
  targetEmail: z.string().email().optional(),
});

const ClaimSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1),
  avatarUrl: z.string().url().optional(),
  bio: z.string().max(500).optional(),
  socialProfiles: z.array(z.object({
    platform: z.enum(["instagram", "tiktok"]),
    profileUrl: z.string().url(),
  })).optional(),
});

export function registerInvitationRoutes(router: Router, container: AppContainer) {

  // ── Créer une invitation influenceur→influenceur (max 3 actives) ───────────
  // POST /influencers/me/invitations
  router.post("/influencers/me/invitations", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = CreateInvitationSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid invitation params", parsed.error.issues);

    const result = await container.createInfluencerInvitation.execute({
      influencerId: ctx.state.userId,
      targetPhone: parsed.data.targetPhone,
      targetEmail: parsed.data.targetEmail,
    });

    ctx.response.status = 201;
    ctx.response.body = result;
  });

  // ── Lister ses invitations ─────────────────────────────────────────────────
  // GET /influencers/me/invitations
  router.get("/influencers/me/invitations", guestOrAuth, async (ctx) => {
    const invitations = await container.invitationRepo.findByCreator(ctx.state.userId);
    ctx.response.body = invitations;
  });

  // ── Revendiquer une invitation (via deep link yummap-influencer://invite?token=...) ──
  // POST /invitations/:token/claim
  router.post("/invitations/:token/claim", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = ClaimSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid claim data", parsed.error.issues);

    const result = await container.claimInvitation.execute({
      token: ctx.params.token,
      userId: parsed.data.userId,
      displayName: parsed.data.displayName,
      avatarUrl: parsed.data.avatarUrl,
      bio: parsed.data.bio,
      socialProfiles: parsed.data.socialProfiles,
    });

    ctx.response.status = result.outcome === "active" ? 200 : 202;
    ctx.response.body = result;
  });

  // ── Vérifier le statut d'une invitation (avant de l'ouvrir dans l'app) ────
  // GET /invitations/:token
  router.get("/invitations/:token", async (ctx) => {
    const invitation = await container.invitationRepo.findByToken(ctx.params.token);
    if (!invitation) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Invitation not found" };
      return;
    }
    // Retourner info minimale (pas de données sensibles)
    ctx.response.body = {
      type: invitation.type,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    };
  });
}
