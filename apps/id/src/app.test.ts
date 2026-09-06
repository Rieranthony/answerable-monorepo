import { describe, expect, test } from "bun:test";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Database } from "./db/client.ts";

import { ProblemError } from "./http/problem.ts";
import { createApp } from "./app.ts";
import { isAllowedAuthRoute, publicAuthRoutes } from "./http/auth-allowlist.ts";
import { buildPublicOpenApiDocument } from "./http/openapi.ts";
import {
  isUuidV7,
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "./__tests__/support.ts";

describe("unit: Hono application", () => {
  test("health is independent from PostgreSQL and creates a UUIDv7 request id", async () => {
    let checks = 0;
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
      readinessCheck: async () => {
        checks += 1;
      },
    });

    const response = await app.request("/healthz");
    const requestId = response.headers.get("x-request-id")!;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(checks).toBe(0);
    expect(isUuidV7(requestId)).toBe(true);
  });

  test("uses the problem handler for thrown route errors", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    app.get("/boom", () => {
      throw new ProblemError(418, "teapot", "Teapot");
    });
    const response = await app.request("/boom");
    expect(response.status).toBe(418);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Teapot",
      status: 418,
      code: "teapot",
      request_id: response.headers.get("x-request-id"),
    });
  });

  test("preserves a caller-provided request id", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.request("/healthz", {
      headers: { "x-request-id": "request-from-ingress" },
    });

    expect(response.headers.get("x-request-id")).toBe("request-from-ingress");
  });

  test("readiness uses the database from Hono context", async () => {
    const db = stubDatabase();
    let receivedDatabase: unknown;
    const app = createApp({
      auth: stubAuth(),
      db,
      environment: testEnvironment(),
      readinessCheck: async (contextDatabase) => {
        receivedDatabase = contextDatabase;
      },
    });

    const response = await app.request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(receivedDatabase).toBe(db);
  });

  test("readiness reports an unavailable database", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
      readinessCheck: () => Promise.reject(new Error("offline")),
    });

    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  test("publishes a valid admin OpenAPI contract and reference", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });

    const schemaResponse = await app.request("/api/admin/openapi.json");
    const schema = z
      .object({
        openapi: z.string().startsWith("3."),
        info: z.object({
          title: z.literal("Answerable ID Admin API"),
          version: z.literal("1.0.0"),
          description: z.literal(
            "Administrative API. Platform-tier routes are for Answerable staff; tenant-tier routes let an organisation manage itself.",
          ),
        }),
        components: z.object({
          securitySchemes: z.object({
            cookieAuth: z.object({
              type: z.literal("apiKey"),
              in: z.literal("cookie"),
              name: z.literal("better-auth.session_token"),
            }),
            bearerAuth: z.object({
              type: z.literal("http"),
              scheme: z.literal("bearer"),
              bearerFormat: z.literal("JWT"),
            }),
          }),
        }),
        paths: z.record(z.string(), z.unknown()),
      })
      .parse(await schemaResponse.json());
    const docsResponse = await app.request("/api/admin/docs");

    expect(schemaResponse.status).toBe(200);
    expect(schema.openapi).toStartWith("3.");
    expect(Object.keys(schema.paths)).toEqual([
      "/api/admin/v1/me",
      "/api/admin/v1/organizations/{organizationId}/domains",
      "/api/admin/v1/organizations/{organizationId}/domains/{domainId}/disable",
      "/api/admin/v1/organizations/{organizationId}/domains/{domainId}/enable",
      "/api/admin/v1/organizations/{organizationId}/sso-provider",
      "/api/admin/v1/organizations",
      "/api/admin/v1/organizations/{organizationId}",
      "/api/admin/v1/organizations/{organizationId}/disable",
      "/api/admin/v1/organizations/{organizationId}/enable",
    ]);
    expect(schema.paths["/api/admin/v1/me"]).toMatchObject({
      get: {
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        "x-tier": "tenant",
      },
    });
    expect(docsResponse.status).toBe(200);
    expect(await docsResponse.text()).toContain("Answerable ID Admin API");
  });

  test("publishes only reachable routes in the public OpenAPI contract", async () => {
    const environment = testEnvironment();
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment,
    });

    const response = await app.request("/openapi.json");
    const operationSchema = z
      .object({
        operationId: z.string(),
        summary: z.string(),
        tags: z.array(z.string()),
      })
      .loose();
    const schema = z
      .object({
        openapi: z.string().startsWith("3.1"),
        info: z.object({ title: z.literal("Answerable ID API") }).loose(),
        servers: z.array(z.object({ url: z.string() })),
        paths: z.record(z.string(), z.record(z.string(), operationSchema)),
        components: z.object({
          securitySchemes: z.object({
            apiKeyCookie: z.unknown(),
            bearerAuth: z.unknown(),
          }),
        }),
      })
      .parse(await response.json());

    expect(response.status).toBe(200);
    expect(schema.openapi).toStartWith("3.1");
    expect(schema.info.title).toBe("Answerable ID API");
    expect(schema.servers).toEqual([{ url: environment.betterAuthUrl }]);
    expect(Object.keys(schema.paths)).toEqual([
      "/auth/get-session",
      "/auth/oauth2/token",
      "/auth/ok",
      "/auth/sign-in/sso",
      "/auth/sign-out",
      "/auth/sso/callback",
      "/healthz",
      "/readyz",
    ]);
    for (const route of publicAuthRoutes) {
      expect(
        schema.paths[route.path]?.[route.method.toLowerCase()],
      ).toMatchObject({
        operationId: route.operationId,
        summary: route.summary,
        tags: [route.tag],
      });
    }
    expect(schema.paths["/auth/sign-in/sso"]?.post).toMatchObject({
      operationId: "signInWithSso",
      summary: "Start sign-in through the organisation's identity provider",
      tags: ["Sign-in"],
    });
    expect(schema.paths["/healthz"]?.get).toMatchObject({
      operationId: "getHealth",
      summary: "Liveness check",
      tags: ["Health"],
    });
    expect(schema.paths["/auth/organization/create"]).toBeUndefined();
    const tokenRoute = publicAuthRoutes.find(
      (route) => route.operationId === "issueToken",
    )!;
    expect(schema.paths["/auth/oauth2/token"]?.post).toMatchObject({
      description: tokenRoute.description,
      requestBody: tokenRoute.requestBody,
      tags: ["Token"],
    });
    expect(schema.paths["/auth/sso/register"]).toBeUndefined();
    expect(schema.components.securitySchemes).toHaveProperty("apiKeyCookie");
    expect(schema.components.securitySchemes).toHaveProperty("bearerAuth");
  });

  test("builds the public OpenAPI contract with an explicit server", async () => {
    const environment = testEnvironment();
    const auth = stubAuth();
    const app = createApp({ auth, db: stubDatabase(), environment });
    app.post(
      "/healthz",
      describeRoute({
        operationId: "postHealth",
        responses: { 200: { description: "OK" } },
      }),
      (context) => context.json({ status: "ok" }),
    );

    const document = await buildPublicOpenApiDocument({
      app,
      auth,
      environment,
      servers: [{ url: "https://id.example.com" }],
    });

    expect(document.tags).toContainEqual({
      name: "Token",
      description: "Machine access with client credentials",
    });
    expect(document.servers).toEqual([{ url: "https://id.example.com" }]);
    expect(Object.keys(document.paths["/healthz"]!)).toEqual(["get", "post"]);
  });

  test("can disable OpenAPI routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({ openApiEnabled: false }),
    });

    expect((await app.request("/openapi.json")).status).toBe(404);
    expect((await app.request("/api/admin/openapi.json")).status).toBe(404);
    expect((await app.request("/api/admin/docs")).status).toBe(404);
  });

  test("keeps the OpenAPI contract but hides interactive docs in production", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({ nodeEnv: "production" }),
    });

    expect((await app.request("/openapi.json")).status).toBe(200);
    expect((await app.request("/api/admin/openapi.json")).status).toBe(200);
    expect((await app.request("/api/admin/docs")).status).toBe(404);
  });

  test("forwards only allowlisted Better Auth routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });

    expect(isAllowedAuthRoute("get", "/auth/ok")).toBe(true);
    expect(isAllowedAuthRoute("post", "/auth/sign-in/sso")).toBe(true);
    expect(isAllowedAuthRoute("get", "/auth/sso/callback")).toBe(true);
    expect(isAllowedAuthRoute("get", "/auth/get-session")).toBe(true);
    expect(isAllowedAuthRoute("post", "/auth/sign-out")).toBe(true);
    expect(isAllowedAuthRoute("POST", "/auth/organization/create")).toBe(false);
    expect((await app.request("/auth/ok")).status).toBe(200);
    expect(
      (await app.request("/auth/organization/create", { method: "POST" }))
        .status,
    ).toBe(404);
  });

  test("answers trusted SSO preflights without reflecting untrusted origins", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({
        trustedOrigins: ["https://chat.example.com"],
      }),
    });
    const preflight = (origin: string) =>
      app.request("/auth/sign-in/sso", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
        },
      });

    const trusted = await preflight("https://chat.example.com");
    const untrusted = await preflight("https://evil.example.com");
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(
      "https://chat.example.com",
    );
    expect(trusted.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("blocks every unapproved SSO and OAuth provider endpoint", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const blocked = [
      ["POST", "/auth/sso/register"],
      ["GET", "/auth/sso/providers"],
      ["GET", "/auth/sso/get-provider"],
      ["POST", "/auth/sso/update-provider"],
      ["POST", "/auth/sso/delete-provider"],
      ["POST", "/auth/sso/request-domain-verification"],
      ["POST", "/auth/sso/verify-domain"],
      ["GET", "/auth/sso/saml2/sp/metadata"],
      ["POST", "/auth/sso/saml2/sp/acs/x"],
      ["POST", "/auth/sso/saml2/sp/slo/x"],
      ["POST", "/auth/sso/saml2/logout/x"],
      ["GET", "/auth/sso/callback/x"],
      ["GET", "/auth/oauth2/authorize"],
      ["POST", "/auth/oauth2/consent"],
      ["GET", "/auth/oauth2/continue"],
    ] as const;

    for (const [method, path] of blocked) {
      expect((await app.request(path, { method })).status).toBe(404);
    }
  });

  test("returns structured JSON for unknown routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

test("admin CORS allows trusted preflights", async () => {
  const app = createApp({
    auth: stubAuth(),
    db: stubDatabase(),
    environment: testEnvironment({ trustedOrigins: ["https://admin.example"] }),
  });
  for (const origin of ["https://admin.example", "https://evil.example"]) {
    const response = await app.request("/api/admin/v1/me", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization,Content-Type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      origin === "https://admin.example" ? origin : null,
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization,Content-Type",
    );
  }
});

test("unknown admin routes return a problem without requiring credentials", async () => {
  const app = createApp({
    auth: stubAuth(),
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  const response = await app.request("/api/admin/v1/unknown");
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "not_found" });
});

test("mounted me runs principal resolution and the root problem handler", async () => {
  const auth = stubAuth();
  const calls: unknown[] = [];
  auth.api.getSession = (async (input: unknown) => {
    calls.push(input);
    return null;
  }) as typeof auth.api.getSession;
  const app = createApp({
    auth,
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  const response = await app.request("/api/admin/v1/me");
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer realm="answerable-id-admin"',
  );
  expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  expect(calls).toHaveLength(1);
});

test("mounted me returns a client verified through the default dependencies", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "admin-test" };
  const auth = stubAuth();
  auth.api.getJwks = (async () => ({ keys: [jwk] })) as typeof auth.api.getJwks;
  const client = {
    clientId: "client",
    disabled: false,
    clientCredentialsScopes: ["org:read"],
    organizationId: "own",
    organization: { id: "own", slug: "tenant", status: "active" },
  };
  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: () => ({ limit: async () => [client] }) }),
      }),
    }),
  } as unknown as Database;
  const environment = testEnvironment();
  const app = createApp({ auth, db, environment });
  const token = await new SignJWT({
    azp: "client",
    scope: "org:read org:write",
  })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: jwk.kid })
    .setIssuer(environment.betterAuthUrl)
    .setAudience(environment.adminResourceIdentifier)
    .setExpirationTime("5m")
    .sign(privateKey);
  const response = await app.request("/api/admin/v1/me", {
    headers: { Authorization: `bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    principal: { type: "client", clientId: "client", organizationId: "own" },
    grants: [
      {
        organizationId: "own",
        organizationSlug: "tenant",
        scopes: ["org:read"],
      },
    ],
  });
});

test("token requests guard grants and preserve bodies for Better Auth", async () => {
  const auth = stubAuth();
  const received: string[] = [];
  auth.handler = async (request: Request) => {
    received.push(await request.text());
    return Response.json({ handled: true });
  };
  const app = createApp({
    auth,
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  for (const [contentType, body] of [
    ["application/x-www-form-urlencoded", "grant_type=client_credentials"],
    ["application/json", '{"grant_type":"authorization_code"}'],
    ["application/x-www-form-urlencoded", "resource=https%3A%2F%2Fexample.com"],
  ] as const) {
    const response = await app.request("/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: true });
    expect(received.at(-1)).toBe(body);
  }
  const rejected = await app.request("/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=authorization_code",
  });
  expect(rejected.status).toBe(400);
  expect(rejected.headers.get("cache-control")).toBe("no-store");
  expect(await rejected.json()).toEqual({
    error: "unsupported_grant_type",
    error_description: "Only client_credentials is available.",
  });
  expect((await app.request("/auth/oauth2/token")).status).toBe(404);
  expect(received).toHaveLength(3);
});
