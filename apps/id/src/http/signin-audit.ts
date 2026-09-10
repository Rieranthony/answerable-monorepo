import type { Context } from "hono";
import { recordAuditEvent } from "../db/queries/audit.ts";
import type { AppEnvironment } from "./context.ts";
import { boundedUserAgent } from "../lib/user-agent.ts";
import { federationFailureCodes } from "../services/federation.ts";

const failureCodes = new Set<string>([
  ...federationFailureCodes,
  "sso_provider_changed",
  "invalid_provider",
  "invalid_state",
  "access_denied",
  "invalid_request",
]);

export async function recordRejectedSignIn(
  context: Context<AppEnvironment>,
  response: Response,
) {
  if (
    context.req.path !== "/auth/sso/callback" ||
    (response.status !== 302 && response.status !== 303)
  )
    return;
  const requestId = context.get("requestId");
  try {
    const location = response.headers.get("location");
    if (!location) return;
    const params = new URL(location, context.req.url).searchParams;
    const error = params.get("error");
    if (error === null) return;
    await recordAuditEvent(context.get("db"), {
      actorType: "system",
      actorId: "sso-callback",
      action: "auth.signin.rejected",
      schemaVersion: 2,
      targetType: "sso_provider",
      // Neither the query nor an opaque callback state verifies a provider identity.
      targetId: null,
      outcome: "failure",
      reason: failureCodes.has(error) ? error : "sso_callback_failed",
      requestId,
      // No trusted ingress-to-client IP rule is configured.
      ip: null,
      userAgent: boundedUserAgent(context.req.header("user-agent")),
    });
  } catch {
    console.error(
      `Sign-in audit failed for request ${JSON.stringify(requestId)}`,
    );
  }
}
