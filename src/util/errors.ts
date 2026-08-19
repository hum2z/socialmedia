/** Raised for malformed or incomplete configuration. Safe to show the user. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Raised when a platform API rejects a call. Carries enough to act on. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly meta: {
      platform: string;
      status?: number;
      code?: string | number;
      /** Body excerpt, already truncated. */
      body?: string;
      retryable?: boolean;
    },
  ) {
    super(message);
  }
}

/** Raised when content cannot satisfy a platform's hard constraints. */
export class ValidationError extends Error {
  override name = "ValidationError";
}

/** Renders any thrown value as a single readable line. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const bits = [err.message];
    if (err.meta.status) bits.push(`HTTP ${err.meta.status}`);
    if (err.meta.code !== undefined) bits.push(`code ${err.meta.code}`);
    return bits.join(" · ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
