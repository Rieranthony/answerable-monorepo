import type { Hono, Handler } from "hono";
import type { DescribeRouteOptions } from "hono-openapi";
import { authorize } from "../authorize.ts";
import type { AppEnvironment } from "../context.ts";
import { adminRoute } from "./openapi.ts";
import type { AdminScope } from "./scopes.ts";

export type AdminRoute = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  platformScope: AdminScope;
  orgScope?: AdminScope;
  kind: "read" | "write" | "erase";
  responses: DescribeRouteOptions["responses"];
  parameters?: DescribeRouteOptions["parameters"];
  requestBody?: DescribeRouteOptions["requestBody"];
  paginated?: true;
  example?: { body?: unknown; query?: Record<string, string> };
  /** Only /me accepts any effective grant. */
  anyGrant?: true;
};

export type AdminRouteTable = Record<string, AdminRoute>;

export function tierOf(route: Pick<AdminRoute, "orgScope" | "anyGrant">) {
  return route.orgScope || route.anyGrant ? "tenant" : "platform";
}

export function registerRoute(
  app: Hono<AppEnvironment>,
  route: AdminRoute,
  ...handlers: Handler<AppEnvironment>[]
) {
  return app[route.method](
    route.path,
    adminRoute(route),
    authorize({ platform: route.platformScope, org: route.orgScope }),
    ...handlers,
  );
}
