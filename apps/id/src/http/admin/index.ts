import { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppServices } from "../../app.ts";
import type { AppEnvironment } from "../context.ts";
import {
  createDefaultPrincipalDeps,
  createPrincipalMiddleware,
} from "../principal.ts";
import { problem, ProblemError } from "../problem.ts";
import { register } from "./me.ts";

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
  register(app);
  app.notFound(notFound);
  // Hono does not carry a sub-app's notFound handler across app.route().
  app.all("*", notFound);
  return app;
}
