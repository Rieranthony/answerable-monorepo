import { afterAll, beforeAll, expect, test } from "bun:test";

import { testEnvironment } from "./__tests__/support.ts";
import { createAuth } from "./auth.ts";
import { createDatabase, type DatabaseConnection } from "./db/client.ts";

let connection: DatabaseConnection;

beforeAll(() => {
  connection = createDatabase(testEnvironment());
});

afterAll(async () => {
  await connection.close();
});

test("never links an upstream identity to an existing user by email", async () => {
  const environment = testEnvironment({
    trustedOrigins: ["https://chat.example.com"],
  });
  const auth = createAuth(connection.db, environment);

  expect(auth.options.account?.accountLinking?.enabled).toBe(false);
  expect(auth.options.trustedOrigins).toEqual(environment.trustedOrigins);
  const context = await auth.$context;
  expect(typeof context.adapter.options?.adapterConfig.transaction).toBe(
    "function",
  );

  const schema = await auth.api.generateOpenAPISchema();
  expect(Object.keys(schema.paths)).toContain("/sign-in/sso");
  expect(Object.keys(schema.paths)).toContain("/sso/callback");
});

test("missing SSO callback state returns to the ID-owned error page", async () => {
  const environment = testEnvironment();
  const auth = createAuth(connection.db, environment);
  const response = await auth.handler(new Request(`${environment.betterAuthUrl}/auth/sso/callback`));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${environment.betterAuthUrl}/error?error=state_not_found`);
});
