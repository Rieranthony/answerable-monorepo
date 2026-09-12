import type { Auth } from "../auth.ts";
import type { Database } from "../db/client.ts";
import type { Environment } from "../env.ts";
import { testDatabaseUrl } from "./test-database.ts";

export { testDatabaseUrl };

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return uuidV7Pattern.test(value);
}

export function testEnvironment(
  overrides: Partial<Environment> = {},
): Environment {
  return {
    nodeEnv: "test",
    port: 47_300,
    databaseUrl: testDatabaseUrl,
    betterAuthUrl: "http://localhost:47300",
    betterAuthSecret: "test-secret-that-is-at-least-32-characters",
    betterAuthSecrets: undefined,
    upstreamTokenSecrets: [
      { version: 1, value: Buffer.alloc(32, 73).toString("base64url") },
    ],
    trustedOrigins: [],
    trustedProxyCidrs: [],
    authPagesUrl: "http://localhost:47100",
    oauthRefreshReuseIntervalSeconds: 0,
    operationalLogIntervalMs: 0,
    databasePoolMax: 1,
    databasePoolIdleTimeoutMs: 1_000,
    databaseConnectionTimeoutMs: 1_000,
    databaseStatementTimeoutMs: 10_000,
    databaseLockTimeoutMs: 2_000,
    databaseIdleInTransactionTimeoutMs: 15_000,
    rootAdminSecret: undefined,
    rootAdminBreakGlass: false,
    openApiEnabled: true,
    platformOrganizationSlug: "answerable",
    platformOrganizationName: "Answerable",
    adminResourceIdentifier: "http://localhost:47300/api/admin",
    ...overrides,
  };
}

export function stubAuth(): Auth {
  return {
    options: { session: { additionalFields: {} } },
    handler: () => Response.json({ status: "ok" }),
    api: {
      generateOpenAPISchema: async () => ({
        openapi: "3.1.1",
        info: {
          title: "Better Auth",
          description: "Authentication endpoints",
          version: "1.1.0",
        },
        servers: [{ url: "http://localhost:47300/auth" }],
        tags: [
          { name: "Sso", description: "Single sign-on endpoints" },
          { name: "Organization", description: "Organization endpoints" },
        ],
        security: [{ apiKeyCookie: [], bearerAuth: [] }],
        components: {
          schemas: {
            Session: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
          securitySchemes: {
            apiKeyCookie: {
              type: "apiKey",
              in: "cookie",
              name: "better-auth.session_token",
              description: "Session cookie",
            },
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description: "Bearer token",
            },
          },
        },
        paths: {
          "/jwks": { get: { responses: { "200": { description: "OK" } } } },
          "/oauth2/authorize": {
            get: { responses: { "302": { description: "Redirect" } } },
          },
          "/oauth2/flow": {
            post: { responses: { "200": { description: "OK" } } },
          },
          "/oauth2/continue": {
            post: { responses: { "200": { description: "OK" } } },
          },
          "/oauth2/consent": {
            post: { responses: { "200": { description: "OK" } } },
          },
          "/oauth2/userinfo": {
            get: { responses: { "200": { description: "OK" } } },
            post: { responses: { "200": { description: "OK" } } },
          },
          "/oauth2/revoke": {
            post: { responses: { "200": { description: "OK" } } },
          },
          "/sso/reauthenticate": {
            post: { responses: { "200": { description: "OK" } } },
          },
          "/sso/link": {
            post: { responses: { "200": { description: "OK" } } },
          },
          "/ok": {
            get: {
              operationId: "betterAuthOk",
              responses: { "200": { description: "OK" } },
            },
          },
          "/sign-in/sso": {
            post: {
              operationId: "betterAuthSignInSso",
              tags: ["Sso"],
              responses: { "200": { description: "OK" } },
            },
          },
          "/sso/callback": {
            get: {
              operationId: "betterAuthSsoCallback",
              responses: { "200": { description: "OK" } },
            },
          },
          "/get-session": {
            get: {
              operationId: "betterAuthGetSession",
              responses: {
                "200": {
                  description: "Current session",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Session" },
                    },
                  },
                },
              },
            },
          },
          "/sign-out": {
            post: {
              operationId: "betterAuthSignOut",
              responses: { "200": { description: "OK" } },
            },
          },
          "/organization/create": {
            post: {
              operationId: "createOrganization",
              responses: { "200": { description: "OK" } },
            },
          },
          "/oauth2/token": {
            post: {
              operationId: "oauthToken",
              responses: { "200": { description: "OK" } },
            },
          },
          "/sso/register": {
            post: {
              operationId: "registerSsoProvider",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
    },
  } as unknown as Auth;
}

export function stubDatabase(poolMax = 10): Database {
  return {
    marker: "database",
    $client: { options: { max: poolMax } },
  } as unknown as Database;
}
