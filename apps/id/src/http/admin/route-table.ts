import type { Hono, Handler } from "hono";
import type { DescribeRouteOptions } from "hono-openapi";
import { admitRoot, authorize } from "../authorize.ts";
import type { AppEnvironment } from "../context.ts";
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
  responses: DescribeRouteOptions["responses"];
  parameters?: DescribeRouteOptions["parameters"];
  requestBody?: DescribeRouteOptions["requestBody"];
  example?: { body?: unknown; query?: Record<string, string> };
  /** Only /me skips authorisation; principal middleware still authenticates. */
  open?: true;
};

export type AdminRouteTable = Record<string, AdminRoute>;

export function tierOf(route: Pick<AdminRoute, "orgScope" | "open">) {
  return route.orgScope || route.open ? "tenant" : "platform";
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
      await next();
    },
    admitRoot(),
    ...(route.open
      ? []
      : [authorize({ platform: route.platformScope, org: route.orgScope })]),
    ...handlers,
    // Metadata comes last so validator schemas cannot overwrite explicit examples.
    adminRoute(route),
  );
}
