import { APIError } from "better-auth/api";

/** An OAuth 503 the client may retry after a second. */
export function temporarilyUnavailable(description: string) {
  return new APIError(
    "SERVICE_UNAVAILABLE",
    { error: "temporarily_unavailable", error_description: description },
    { "Retry-After": "1" },
  );
}

/** PostgreSQL lock contention and statement cancellation are retryable; preserve unrelated failures. */
export function rethrowGrantError(error: unknown): never {
  const cause = error instanceof Error ? error.cause : undefined;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "55P03" || cause.code === "57014")
  )
    throw temporarilyUnavailable(
      "Authorization state is busy. Retry the token request.",
    );
  throw error;
}
