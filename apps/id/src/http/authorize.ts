import type { Context, MiddlewareHandler } from "hono";
import { recordAuditEvent } from "../db/queries/audit.ts";
import type { AdminScope } from "./admin/scopes.ts";
import type { AppEnvironment } from "./context.ts";
import { problem, ProblemError } from "./problem.ts";

async function deny(
  context: Context<AppEnvironment>,
  code: "not_found" | "insufficient_scope",
) {
  const principal = context.get("principal")!;
  const status = code === "not_found" ? 404 : 403;
  // The path value is untrusted and the column is a foreign key: only an
  // organisation the principal holds a grant for is attributed by id.
  const organizationId = context.req.param("organizationId");
  const known =
    organizationId !== undefined &&
    principal.grants.some((grant) => grant.organizationId === organizationId);
  await recordAuditEvent(context.get("db"), {
    actorType: principal.type,
    actorId: principal.type === "user" ? principal.userId : principal.clientId,
    organizationId: known ? organizationId : undefined,
    data:
      organizationId !== undefined && !known ? { organizationId } : undefined,
    action: "admin.denied",
    outcome: "denied",
    targetType: "route",
    targetId: context.get("operationId"),
    reason: code,
    requestId: context.get("requestId"),
    ip: context.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: context.req.header("user-agent"),
  });
  if (principal.type === "client" && status === 403) {
    context.header("WWW-Authenticate", 'Bearer error="insufficient_scope"');
  }
  return problem(
    context,
    new ProblemError(
      status,
      code,
      status === 404 ? "Not found" : "Insufficient scope",
    ),
  );
}

export function authorize({
  platform,
  org,
}: {
  platform: AdminScope;
  org?: AdminScope;
}): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const grants = context.get("principal")!.grants;
    const platformGrant = grants.find(
      (grant) =>
        grant.organizationSlug ===
        context.get("environment").platformOrganizationSlug,
    );
    if (platformGrant?.scopes.includes(platform)) {
      context.set("tier", "platform");
      return next();
    }
    const organizationId = context.req.param("organizationId");
    if (org && organizationId) {
      const grant = grants.find(
        (grant) => grant.organizationId === organizationId,
      );
      if (!grant) return deny(context, "not_found");
      if (grant.scopes.includes(org)) {
        context.set("tier", "tenant");
        return next();
      }
    }
    return deny(context, "insufficient_scope");
  };
}

/** /me requires an effective grant, with no particular scope or organisation. */
export function authorizeAny(): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    if (!context.get("principal")!.grants.length)
      return deny(context, "insufficient_scope");
    context.set("tier", "tenant");
    await next();
  };
}
