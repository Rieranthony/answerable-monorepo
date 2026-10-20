import type { Context, Hono, Handler, MiddlewareHandler } from "hono";
import type { DescribeRouteOptions } from "hono-openapi";
import { recordAuditEvent } from "../../db/queries/audit.ts";
import { actorFromContext } from "../../services/actor.ts";
import { AuthorityDenied } from "../../services/command-authority.ts";
import type { AppEnvironment } from "../context.ts";
import { recordAdministrativeDenial } from "../denial-audit.ts";
import { adminRoute } from "./openapi.ts";
import type { AdminScope } from "./scopes.ts";

export type AdminRoute = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  platformScope: AdminScope;
  orgScope?: AdminScope;
  kind: "read" | "write" | "erase";
  /** Server-owned policy, false when absent; field exceptions are display-only JSON patches. */
  freshAuthentication?: boolean | { unlessOnly: readonly string[] };
  responses: DescribeRouteOptions["responses"];
  parameters?: DescribeRouteOptions["parameters"];
  requestBody?: DescribeRouteOptions["requestBody"];
  example?: { body?: unknown; query?: Record<string, string> };
  /** `/me`: any authenticated principal. */
  open?: true;
};

export type AdminRouteTable = Record<string, AdminRoute>;

/**
 * Runs on every route, open ones included, so each root request leaves
 * exactly one `admin.root_request` row. Non-root principals pass through.
 */
function admitRoot(): MiddlewareHandler<AppEnvironment> {
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
    await next();
  };
}

/** `admin.denied` for a refusal by current authority, on the pool: the command's transaction has rolled back. */
async function recordDenial(
  context: Context<AppEnvironment>,
  denied: AuthorityDenied,
) {
  const principal = context.get("principal")!;
  // The path value is untrusted and the column is a foreign key: only an
  // organisation the principal holds a grant for is attributed by id.
  const organizationId = context.req.param("organizationId");
  const known =
    organizationId !== undefined &&
    principal.grants.some((grant) => grant.organizationId === organizationId);
  await recordAdministrativeDenial(context.get("db"), {
    ...actorFromContext(context),
    organizationId: known ? organizationId : undefined,
    data:
      organizationId !== undefined && !known ? { organizationId } : undefined,
    action: "admin.denied",
    targetType: "route",
    targetId: context.get("operationId"),
    reason: denied.code,
  });
  if (principal.type === "client" && denied.status === 403)
    context.header("WWW-Authenticate", 'Bearer error="insufficient_scope"');
}

export function registerRoute(
  app: Hono<AppEnvironment>,
  route: AdminRoute,
  ...handlers: Handler<AppEnvironment>[]
) {
  return app[route.method](
    route.path,
    async (context, next) => {
      context.set("operationId", route.operationId);
      context.set("freshAuthentication", route.freshAuthentication ?? false);
      await next();
      if (context.error instanceof AuthorityDenied)
        await recordDenial(context, context.error);
    },
    admitRoot(),
    ...handlers,
    // Metadata comes last so validator schemas cannot overwrite explicit examples.
    adminRoute(route),
  );
}
