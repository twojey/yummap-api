import { Router } from "../../deps.ts";
import { z } from "../../deps.ts";
import { guestOrAuth } from "../middleware/auth.middleware.ts";
import { ValidationError } from "../shared/errors.ts";
import { analyticsService } from "../infrastructure/analytics/analytics.service.ts";
import type { AppContainer } from "../boot/container.ts";

const OnboardingSchema = z.object({
  experiences: z.array(z.string()).min(1),
  dietaryConstraints: z.array(z.string()),
  influencerIdsToFollow: z.array(z.string().uuid()),
  displayName: z.string().min(1),
  phoneNumber: z.string().min(8),
});

const PushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});

const AnonymousSchema = z.object({
  displayName: z.string().min(1),
});

export function registerUserRoutes(router: Router, container: AppContainer) {
  // POST /users/anonymous — enregistre un user anonyme avec son UUID local.
  // Appelé par l'app au tout premier lancement, avant la vérif phone.
  // Idempotent : un même UUID peut rappeler cette route sans erreur.
  router.post("/users/anonymous", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = AnonymousSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid anonymous user", parsed.error.issues);

    const user = await container.userRepo.createAnonymous({
      id: ctx.state.userId,
      displayName: parsed.data.displayName,
    });
    ctx.response.status = 200;
    ctx.response.body = { id: user.id, isAnonymous: true };
  });

  // POST /users/me/heartbeat — bump last_active_at. Appelé au démarrage app.
  // C'est le signal qui permet d'exclure du compteur de followers les users
  // qui ont désinstallé l'app (last_active_at > 60j).
  router.post("/users/me/heartbeat", guestOrAuth, async (ctx) => {
    await container.userRepo.heartbeat(ctx.state.userId);
    ctx.response.status = 204;
  });

  router.post("/users/onboarding", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = OnboardingSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid onboarding data", parsed.error.issues);

    // Dédup par phone : si un autre user a déjà vérifié ce phone (cas de réinstall
    // sur un nouveau device), on merge l'anon courant dans l'ancien compte.
    const existing = await container.userRepo.findByPhoneNumber(parsed.data.phoneNumber);
    let canonicalUserId = ctx.state.userId;
    if (existing && existing.id !== ctx.state.userId) {
      await container.userRepo.mergeInto(ctx.state.userId, existing.id);
      canonicalUserId = existing.id;
    }

    // Upsert du compte serveur avec displayName + phoneNumber (passe is_anonymous=false)
    await container.userRepo.upsert({
      id: canonicalUserId,
      role: "user",
      displayName: parsed.data.displayName,
      phoneNumber: parsed.data.phoneNumber,
    });
    await container.onboarding.execute({ userId: canonicalUserId, ...parsed.data });
    // L'app reçoit l'id canonique : si merge a eu lieu, elle doit remplacer son UUID local
    ctx.response.status = 200;
    ctx.response.body = { userId: canonicalUserId, merged: canonicalUserId !== ctx.state.userId };
  });

  router.post("/users/me/follow/:influencerId", guestOrAuth, async (ctx) => {
    await container.userRepo.follow(ctx.state.userId, ctx.params.influencerId);
    analyticsService.track({ eventType: "influencer_follow", userId: ctx.state.userId });
    // Notif "nouveau follower" à l'influenceur — best-effort, ne bloque pas la réponse
    container.notifications.dispatch({
      type: "NewFollower",
      influencerId: ctx.params.influencerId,
      followerId: ctx.state.userId,
      // deno-lint-ignore no-explicit-any
    } as any).catch(() => {});
    ctx.response.status = 204;
  });

  router.delete("/users/me/follow/:influencerId", guestOrAuth, async (ctx) => {
    await container.userRepo.unfollow(ctx.state.userId, ctx.params.influencerId);
    analyticsService.track({ eventType: "influencer_unfollow", userId: ctx.state.userId });
    ctx.response.status = 204;
  });

  router.post("/users/me/watchlist/:restaurantId", guestOrAuth, async (ctx) => {
    await container.userRepo.addToWatchlist(ctx.state.userId, ctx.params.restaurantId);
    analyticsService.track({
      eventType: "watchlist_add",
      userId: ctx.state.userId,
      restaurantId: ctx.params.restaurantId,
    });
    ctx.response.status = 204;
  });

  router.delete("/users/me/watchlist/:restaurantId", guestOrAuth, async (ctx) => {
    await container.userRepo.removeFromWatchlist(ctx.state.userId, ctx.params.restaurantId);
    analyticsService.track({
      eventType: "watchlist_remove",
      userId: ctx.state.userId,
      restaurantId: ctx.params.restaurantId,
    });
    ctx.response.status = 204;
  });

  router.post("/users/me/push-token", guestOrAuth, async (ctx) => {
    const body = await ctx.request.body({ type: "json" }).value;
    const parsed = PushTokenSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid push token data", parsed.error.issues);

    await container.userRepo.registerPushToken(ctx.state.userId, parsed.data.token, parsed.data.platform);
    ctx.response.status = 204;
  });
}
