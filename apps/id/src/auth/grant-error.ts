import { APIError } from "better-auth/api";

/** PostgreSQL lock contention and statement cancellation are retryable; preserve unrelated failures. */
export function rethrowGrantError(error: unknown): never {
  const cause = error instanceof Error ? error.cause : undefined;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "55P03" || cause.code === "57014")
  )
    throw new APIError(
      "SERVICE_UNAVAILABLE",
      {
        error: "temporarily_unavailable",
        error_description:
          "Authorization state is busy. Retry the token request.",
      },
      { "Retry-After": "1" },
    );
  throw error;
}
