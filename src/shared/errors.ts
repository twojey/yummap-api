export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 404, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(message: string, public readonly details?: unknown) {
    super(message, 400, "VALIDATION_ERROR");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

// Signale qu'un quota tiers (Gemini daily) est épuisé : le pipeline doit pauser
// le job courant et le reprendre quand le quota refait surface.
export class DailyQuotaExceededError extends Error {
  constructor(
    public readonly provider: string,
    public readonly resumeAfter: Date,
    message?: string,
  ) {
    super(message ?? `${provider} daily quota exceeded, resume after ${resumeAfter.toISOString()}`);
    this.name = "DailyQuotaExceededError";
  }
}
