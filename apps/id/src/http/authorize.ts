import type { Context, MiddlewareHandler } from "hono";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { actorFromContext } from "../services/actor.ts";
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
    ...actorFromContext(context),
    organizationId: known ? organizationId : undefined,
    data:
      organizationId !== undefined && !known ? { organizationId } : undefined,
    action: "admin.denied",
    outcome: "denied",
    targetType: "route",
    targetId: context.get("operationId"),
    reason: code,
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

/**
 * Runs before authorisation on every route, open ones included, so each root
 * request leaves exactly one `admin.root_request` row. Non-root principals
 * pass through untouched.
 */
export function admitRoot(): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    if (context.get("principal")!.type !== "root") return next();
    const organizationId = context.req.param("organizationId");
    await recordAuditEvent(context.get("db"), {
      ...actorFromContext(context),
      organizationId: undefined,
      action: "admin.root_request",
      outcome: "success",
      targetType: "route",
      targetId: context.get("operationId"),
      data: organizationId ? { organizationId } : undefined,
    });
    context.set("tier", "platform");
    await next();
  };
}

export function authorize({
  platform,
  org,
}: {
  platform: AdminScope;
  org?: AdminScope;
}): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    if (context.get("principal")!.type === "root") {
      context.set("tier", "platform");
      return next();
    }
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
      if (grant?.scopes.includes(org)) {
        context.set("tier", "tenant");
        return next();
      }
      // Staff can read every organisation, so a platform grant without the
      // required scope is a scope problem, never a hidden organisation.
      if (!grant && !platformGrant) return deny(context, "not_found");
    }
    return deny(context, "insufficient_scope");
  };
}
