import type { Context } from "hono";
import { recordAuditEvent } from "../db/queries/audit.ts";
import type { AppEnvironment } from "./context.ts";

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
      targetType: "sso_provider",
      // Better Auth's state is an opaque reference, not a provider id.
      targetId: context.req.query("providerId") ?? null,
      outcome: "failure",
      reason: error,
      requestId,
      ip: context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: context.req.header("user-agent") ?? null,
      data: { errorDescription: params.get("error_description") },
    });
  } catch {
    console.error(
      `Sign-in audit failed for request ${JSON.stringify(requestId)}`,
    );
  }
}
