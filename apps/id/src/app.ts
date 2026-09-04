import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi";
import { z } from "zod";

import type { Auth } from "./auth.ts";
import type { Database } from "./db/client.ts";
import type { Environment } from "./env.ts";
import { isAllowedAuthRoute } from "./http/auth-allowlist.ts";
import type { AppEnvironment } from "./http/context.ts";
import { createId } from "./lib/id.ts";
import { checkReadiness } from "./services/readiness.ts";

const statusSchema = z.object({ status: z.literal("ok") });
const unavailableSchema = z.object({ status: z.literal("unavailable") });

export type AppServices = {
  auth: Auth;
  db: Database;
  environment: Environment;
  readinessCheck?: typeof checkReadiness;
};

export function createApp(services: AppServices) {
  const app = new Hono<AppEnvironment>();
  const readinessCheck = services.readinessCheck ?? checkReadiness;

  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? createId();

    context.set("auth", services.auth);
    context.set("db", services.db);
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);

    await next();
  });

  app.use(
    "/auth/*",
    cors({ origin: services.environment.trustedOrigins, credentials: true }),
  );

  app.get(
    "/healthz",
    describeRoute({
      description: "Process liveness check",
      responses: {
        200: {
          description: "The process is alive",
          content: { "application/json": { schema: resolver(statusSchema) } },
        },
      },
    }),
    (context) => context.json({ status: "ok" as const }),
  );

  app.get(
    "/readyz",
    describeRoute({
      description: "PostgreSQL readiness check",
      responses: {
        200: {
          description: "The service is ready",
          content: { "application/json": { schema: resolver(statusSchema) } },
        },
        503: {
          description: "PostgreSQL is unavailable",
          content: {
            "application/json": { schema: resolver(unavailableSchema) },
          },
        },
      },
    }),
    async (context) => {
      try {
        await readinessCheck(context.get("db"));
        return context.json({ status: "ok" as const }, 200);
      } catch {
        return context.json({ status: "unavailable" as const }, 503);
      }
    },
  );

  if (services.environment.openApiEnabled) {
    app.get(
      "/api/admin/openapi.json",
      openAPIRouteHandler(app, {
        exclude: [/^(?!\/api\/admin(?:\/|$))/],
        documentation: {
          info: {
            title: "Answerable ID Admin API",
            version: "0.0.0",
            description:
              "Administrative API contract. Write operations are intentionally deferred until the schema is approved.",
          },
          servers: [{ url: services.environment.betterAuthUrl }],
        },
      }),
    );
    if (services.environment.nodeEnv !== "production") {
      app.get(
        "/api/admin/docs",
        Scalar({
          pageTitle: "Answerable ID Admin API",
          url: "/api/admin/openapi.json",
        }),
      );
    }
  }

  app.all("/auth/*", (context) => {
    if (!isAllowedAuthRoute(context.req.method, context.req.path)) {
      return context.notFound();
    }

    return context.get("auth").handler(context.req.raw);
  });

  app.notFound((context) => context.json({ error: "not_found" }, 404));

  return app;
}

export type App = ReturnType<typeof createApp>;
