import { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppServices } from "../../app.ts";
import type { AppEnvironment } from "../context.ts";
import {
  createDefaultPrincipalDeps,
  createPrincipalMiddleware,
} from "../principal.ts";
import { problem, ProblemError } from "../problem.ts";
import * as domains from "./domains.ts";
import * as ssoProviders from "./sso-providers.ts";
import * as me from "./me.ts";
import * as organizations from "./organizations.ts";
import type { AdminRouteTable } from "./route-table.ts";
import * as resources from "./resources.ts";
import * as clients from "./clients.ts";
import * as groups from "./groups.ts";
import * as members from "./members.ts";

import * as entitlements from "./entitlements.ts";
import * as access from "./access.ts";

const families = new Map<AdminRouteTable, typeof me.register>([
  [me.routes, me.register],
  [entitlements.routes, entitlements.register],
  [access.routes, access.register],
  [groups.routes, groups.register],
  [members.routes, members.register],
  [resources.routes, resources.register],
  [clients.routes, clients.register],
  [domains.routes, domains.register],
  [ssoProviders.routes, ssoProviders.register],
  [organizations.routes, organizations.register],
]);
export const adminRouteTables: AdminRouteTable[] = [...families.keys()];

export function createAdminApp(services: AppServices) {
  const app = new Hono<AppEnvironment>();
  const notFound = (context: Parameters<typeof problem>[0]) =>
    problem(context, new ProblemError(404, "not_found", "Not found"));
  // Unknown routes have no protected handler and should consistently return 404.
  app.use("*", async (context, next) => {
    if (!matchedRoutes(context).some((route) => route.method !== "ALL"))
      return notFound(context);
    await next();
  });
  app.use("*", createPrincipalMiddleware(createDefaultPrincipalDeps(services)));
  for (const table of adminRouteTables) families.get(table)!(app);
  app.notFound(notFound);
  // Hono does not carry a sub-app's notFound handler across app.route().
  app.all("*", notFound);
  return app;
}
