import type { Context } from "hono";
import type { AppEnvironment } from "./context.ts";
import { logEvent } from "../lib/log.ts";
import { federationFailureCodes } from "../services/federation.ts";

const failureCodes = new Set<string>([
  ...federationFailureCodes,
  "invalid_provider",
  "invalid_state",
  "access_denied",
  "invalid_request",
]);

/**
 * Log a refused SSO callback. It verified no identity, provider or tenant, so
 * it is an operational line, not an audit row: a forged state would otherwise
 * write a row per request. The reason is a known code, never the caller's text.
 */
export function logRejectedSignIn(
  context: Context<AppEnvironment>,
  response: Response,
) {
  if (
    context.req.path !== "/auth/sso/callback" ||
    (response.status !== 302 && response.status !== 303)
  )
    return;
  const location = response.headers.get("location");
  if (!location) return;
  const error = new URL(location, context.req.url).searchParams.get("error");
  if (error === null) return;
  logEvent("auth", "signin_rejected", {
    requestId: context.get("requestId"),
    ip: context.get("clientIp"),
    reason: failureCodes.has(error) ? error : "sso_callback_failed",
  });
}
