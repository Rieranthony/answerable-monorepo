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
    trustedOrigins: [],
    authPagesUrl: "http://localhost:47100",
    databasePoolMax: 1,
    databasePoolIdleTimeoutMs: 1_000,
    databaseConnectionTimeoutMs: 1_000,
    openApiEnabled: true,
    ...overrides,
  };
}

export function stubAuth(): Auth {
  return {
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

export function stubDatabase(): Database {
  return { marker: "database" } as unknown as Database;
}
