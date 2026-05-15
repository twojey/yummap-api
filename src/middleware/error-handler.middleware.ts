import { type Context, isHttpError } from "../../deps.ts";
import { AppError, ValidationError } from "../shared/errors.ts";
import { z } from "../../deps.ts";

export async function errorHandler(ctx: Context, next: () => Promise<unknown>) {
  try {
    await next();
  } catch (err) {
    const requestId = ctx.response.headers.get("X-Request-ID") ?? "unknown";

    if (err instanceof ValidationError) {
      ctx.response.status = 400;
      ctx.response.body = {
        error: err.errorCode,
        message: err.message,
        details: err.details,
        request_id: requestId,
      };
    } else if (err instanceof AppError) {
      ctx.response.status = err.statusCode;
      ctx.response.body = {
        error: err.errorCode,
        message: err.message,
        request_id: requestId,
      };
    } else if (err instanceof z.ZodError) {
      ctx.response.status = 400;
      ctx.response.body = {
        error: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: err.issues,
        request_id: requestId,
      };
    } else if (isHttpError(err)) {
      ctx.response.status = (err as { status: number }).status;
      ctx.response.body = {
        error: "HTTP_ERROR",
        message: (err as Error).message,
        request_id: requestId,
      };
    } else {
      console.error("[ErrorHandler] Unhandled exception", err);
      ctx.response.status = 500;
      ctx.response.body = {
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
        request_id: requestId,
      };
    }
  }
}
