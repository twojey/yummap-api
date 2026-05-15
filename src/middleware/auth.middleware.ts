import { type Context, type Next } from "../../deps.ts";
import { supabaseAnon } from "../../config.ts";
import { UnauthorizedError } from "../shared/errors.ts";

declare module "https://deno.land/x/oak@v12.6.1/mod.ts" {
  interface State {
    userId: string;
    role: string;
  }
}

export async function requireAuth(ctx: Context, next: Next) {
  const authHeader = ctx.request.headers.get("Authorization");
  const xUserId = ctx.request.headers.get("X-User-Id");

  if (xUserId) {
    ctx.state.userId = xUserId;
    ctx.state.role = "admin";
    await next();
    return;
  }

  if (!authHeader?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing Bearer token");
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAnon.auth.getUser(token);

  if (error || !user) {
    throw new UnauthorizedError("Invalid or expired token");
  }

  ctx.state.userId = user.id;
  ctx.state.role = user.user_metadata?.role ?? "user";
  await next();
}

export async function guestOrAuth(ctx: Context, next: Next) {
  const authHeader = ctx.request.headers.get("Authorization");
  // L'app envoie X-User-Id (uuid local du user, avant vérif phone).
  // On accepte aussi X-Guest-ID en alias pour la rétrocompat.
  const guestId = ctx.request.headers.get("X-User-Id")
    ?? ctx.request.headers.get("X-Guest-ID");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const { data: { user } } = await supabaseAnon.auth.getUser(token);
    if (user) {
      ctx.state.userId = user.id;
      ctx.state.role = user.user_metadata?.role ?? "user";
      await next();
      return;
    }
  }

  if (guestId) {
    ctx.state.userId = guestId;
    ctx.state.role = "user";
    await next();
    return;
  }

  throw new UnauthorizedError("Missing X-User-Id / X-Guest-ID or Bearer token");
}

export function requireRole(role: string) {
  return async (ctx: Context, next: Next) => {
    if (ctx.state.role !== role && ctx.state.role !== "admin") {
      throw new UnauthorizedError(`Role '${role}' required`);
    }
    await next();
  };
}
