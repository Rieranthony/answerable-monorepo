import { getIP } from "@better-auth/core/utils/ip";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi";
import { z } from "zod";

import type { Auth } from "./auth.ts";
import type { Database } from "./db/client.ts";
import type { Environment } from "./env.ts";
import { createAdminApp } from "./http/admin/index.ts";
import { adminSecuritySchemes, adminTags } from "./http/admin/openapi.ts";
import { isAllowedAuthRoute } from "./http/auth-allowlist.ts";
import type { AppEnvironment } from "./http/context.ts";
import { buildPublicOpenApiDocument } from "./http/openapi.ts";
import { problemHandler } from "./http/problem.ts";
import { recordRejectedSignIn } from "./http/signin-audit.ts";
import { createId } from "./lib/id.ts";
import { limitRequestBody } from "./http/request-limits.ts";
import { checkReadiness } from "./services/readiness.ts";
import { publicOAuthMetadata } from "./http/oauth-metadata.ts";
import type { OperationalMetrics } from "./operations/metrics.ts";

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

const statusSchema = z.object({ status: z.literal("ok") });
const unavailableSchema = z.object({ status: z.literal("unavailable") });

export type AppServices = {
  auth: Auth;
  db: Database;
  environment: Environment;
  readinessCheck?: typeof checkReadiness;
  ssoTest?: { allowPrivateHosts: boolean };
  metrics?: OperationalMetrics;
};

export function createApp(services: AppServices) {
  const app = new Hono<AppEnvironment>();
  const readinessCheck = services.readinessCheck ?? checkReadiness;

  app.use("*", async (context, next) => {
    const suppliedRequestId = context.req.header("x-request-id");
    const requestId =
      suppliedRequestId && requestIdPattern.test(suppliedRequestId)
        ? suppliedRequestId
        : createId();

    context.set("environment", services.environment);
    context.set("auth", services.auth);
    context.set("db", services.db);
    context.set("ssoTest", services.ssoTest);
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);

    const clientIp = getIP(context.req.raw, services.auth.options);
    context.set("clientIp", clientIp);
    if (
      services.environment.nodeEnv === "production" &&
      clientIp === null &&
      (context.req.path.startsWith("/auth/") ||
        context.req.path.startsWith("/api/admin/"))
    ) {
      context.header("Cache-Control", "no-store");
      return context.json({ error: "untrusted_ingress" }, 403);
    }
    const finish = services.metrics?.begin(context.req.path);
    try {
      await next();
    } finally {
      finish?.(context.res.status);
    }
  });

  app.use("*", limitRequestBody);

  app.use(
    "/auth/*",
    cors({ origin: services.environment.trustedOrigins, credentials: true }),
  );

  app.use(
    "/api/admin/*",
    cors({
      origin: services.environment.trustedOrigins,
      credentials: true,
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "If-Match",
      ],
      exposeHeaders: ["Operation-Id", "Idempotency-Replayed", "ETag"],
    }),
  );
  app.route("/api/admin/v1", createAdminApp(services));

  for (const [path, operationId] of [
    ["/.well-known/openid-configuration", "getOpenIdConfiguration"],
    ["/.well-known/oauth-authorization-server", "getOAuthAuthorizationServer"],
  ] as const)
    app.get(
      path,
      describeRoute({
        operationId,
        summary: "Read the public OAuth provider metadata",
        tags: ["Token"],
        responses: {
          200: {
            description:
              "Native issuer, signing keys and supported public endpoints",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.unknown())),
              },
            },
          },
        },
      }),
      (context) => publicOAuthMetadata(services.auth, context.req.raw),
    );

  app.get(
    "/healthz",
    describeRoute({
      operationId: "getHealth",
      summary: "Liveness check",
      tags: ["Health"],
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
      operationId: "getReadiness",
      summary: "Readiness check",
      tags: ["Health"],
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
    app.get("/openapi.json", async (context) =>
      context.json(
        await buildPublicOpenApiDocument({
          app,
          auth: context.get("auth"),
          environment: services.environment,
        }),
      ),
    );
    app.get(
      "/api/admin/openapi.json",
      openAPIRouteHandler(app, {
        exclude: [/^(?!\/api\/admin(?:\/|$))/],
        documentation: {
          info: {
            title: "Answerable ID Admin API",
            version: "1.0.0",
            description:
              "Platform-tier operations serve Answerable staff and tenant-tier operations serve an organisation, as indicated by x-tier. The six scopes are platform:read, platform:users, platform:write, org:read, org:users and org:write; x-scopes identifies fixed platform or organisation scopes. Self-service routes use handler checks described on the operation; x-scope-alternatives lists acceptable scope alternatives where present. The x-kind extension marks read, write and erase operations; erase requires confirm equal to the target id, and operation ids are the tool names.",
          },
          components: { securitySchemes: adminSecuritySchemes },
          tags: adminTags,
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

  app.all("/auth/*", async (context) => {
    if (!isAllowedAuthRoute(context.req.method, context.req.path)) {
      return context.notFound();
    }

    const headers = new Headers(context.req.raw.headers);
    headers.set("x-request-id", context.get("requestId"));
    const response = await context
      .get("auth")
      .handler(new Request(context.req.raw, { headers }));
    await recordRejectedSignIn(context, response);
    return response;
  });

  app.onError(problemHandler);

  app.notFound((context) => context.json({ error: "not_found" }, 404));

  return app;
}

export type App = ReturnType<typeof createApp>;
