import { expect, mock, test } from "bun:test";

import { testEnvironment } from "./__tests__/support.ts";
import { assertDisposableTestDatabase } from "./__tests__/test-database.ts";
import { createAuth } from "./auth.ts";
import type { BootstrapResult } from "./bootstrap.ts";
import { createDatabase } from "./db/client.ts";
import { jwks } from "./db/schema/index.ts";
import { startRuntime } from "./runtime.ts";

const seedResult: BootstrapResult = {
  organizationId: "org",
  slug: "custom-platform",
  groupId: "group",
  resourceId: "resource",
  created: true,
};

async function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

test("startup refuses secrets that cannot decrypt the newest signing key, before listening", async () => {
  assertDisposableTestDatabase("startup signing-key check");
  const owner = createDatabase(testEnvironment());
  const log = mock(() => {});
  const original = console.log;
  console.log = log;
  try {
    await owner.db.delete(jwks);
    const start = async (betterAuthSecret: string) => {
      const environment = testEnvironment({
        port: await freePort(),
        betterAuthSecret,
      });
      const database = createDatabase(environment);
      const started = startRuntime(environment, {
        allowTestEnvironment: true,
        seed: async () => seedResult,
        databaseFactory: () => database,
      });
      return { environment, database, started };
    };
    // A new installation has no key yet: any secret starts.
    const empty = await start("a-different-secret-of-at-least-32-chars");
    await (await empty.started).shutdown();

    const environment = testEnvironment();
    await createAuth(owner.db, environment).api.getJwks();
    const wrong = await start("a-different-secret-of-at-least-32-chars");
    const failure = await wrong.started.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: "SigningKeyCustodyError",
      message:
        "The configured application secrets cannot decrypt the newest signing key",
    });
    expect(wrong.database.pool.ended).toBe(true);
    await expect(
      fetch(`http://127.0.0.1:${wrong.environment.port}/healthz`),
    ).rejects.toThrow();

    const right = await start(environment.betterAuthSecret);
    const runtime = await right.started;
    expect((await fetch(new URL("/healthz", runtime.server.url))).status).toBe(
      200,
    );
    await runtime.shutdown();
  } finally {
    console.log = original;
    await owner.db.delete(jwks);
    await owner.close();
  }
});
