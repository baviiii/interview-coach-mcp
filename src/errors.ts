/** Typed errors so the HTTP layer can map them to status codes. */

export class AppError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(message, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404);
  }
}

export class UpstreamError extends AppError {
  constructor(message = "Upstream (Horus) error") {
    super(message, 502);
  }
}

/**
 * The user's plan allowance is spent.
 *
 * Kept separate from UpstreamError because it is not an outage: the upstream
 * answered correctly, and the answer was no. Collapsing it into a 502 would
 * tell the browser "something broke, try again", when retrying is the one
 * thing that cannot help.
 *
 * `details` carries the upstream's quota body through untouched so the client
 * can say which limit, how much is used, and when it resets.
 */
export class QuotaError extends AppError {
  constructor(message = "Usage limit reached", readonly details?: unknown) {
    super(message, 429);
  }
}
