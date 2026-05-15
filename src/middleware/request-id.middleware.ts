import { type Context, type Next } from "../../deps.ts";

export async function requestId(ctx: Context, next: Next) {
  const id = crypto.randomUUID();
  ctx.response.headers.set("X-Request-ID", id);
  await next();
}
