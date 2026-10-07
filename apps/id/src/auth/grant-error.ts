import { APIError } from "better-auth/api";
import { isRetryableDatabaseError } from "../http/problem.ts";

/** An OAuth 503 the client may retry after a second. */
export function temporarilyUnavailable(description: string) {
  return new APIError(
    "SERVICE_UNAVAILABLE",
    { error: "temporarily_unavailable", error_description: description },
    { "Retry-After": "1" },
  );
}

/** A lock or statement timeout, a deadlock or a pool checkout timeout is
 * retryable, as in the admin API; every other failure passes through. */
export function rethrowGrantError(error: unknown): never {
  if (isRetryableDatabaseError(error))
    throw temporarilyUnavailable(
      "Authorization state is busy. Retry the token request.",
    );
  throw error;
}
