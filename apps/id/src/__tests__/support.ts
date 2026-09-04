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
  } as unknown as Auth;
}

export function stubDatabase(): Database {
  return { marker: "database" } as unknown as Database;
}
