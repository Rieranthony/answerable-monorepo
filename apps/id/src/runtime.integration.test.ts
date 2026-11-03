import { createMemoryTransport } from "@answerable/emails/testing";
import { expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import { browser, client } from "./__tests__/magic-link-requests.ts";
import { createRuntimeLogin } from "./__tests__/runtime-role.ts";
import { testEnvironment } from "./__tests__/support.ts";
import { assertDisposableTestDatabase } from "./__tests__/test-database.ts";
import { createAuth } from "./auth.ts";
import type { BootstrapResult } from "./bootstrap.ts";
import { createDatabase } from "./db/client.ts";
import {
  jwks,
  magicLinkRequests,
  members,
  organizationDomains,
  organizations,
  users,
} from "./db/schema/index.ts";
import { createId } from "./lib/id.ts";
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

test("shutdown finishes queued mail, row and all, before the database closes", async () => {
  assertDisposableTestDatabase("shutdown drain");
  const owner = createDatabase(testEnvironment());
  const login = await createRuntimeLogin(owner.db, testEnvironment(), {
    port: await freePort(),
    databasePoolMax: 2,
  });
  const organizationId = createId();
  const domain = `drain-${organizationId}.example.com`;
  await owner.db.insert(organizations).values({
    id: organizationId,
    slug: `drain-${organizationId}`,
    name: "Drain",
  });
  await owner.db.insert(organizationDomains).values({
    id: createId(),
    organizationId,
    domain,
  });
  const emails = Array.from(
    { length: 12 },
    (_, index) => `person${index}@${domain}`,
  );
  for (const email of emails) {
    const userId = createId();
    await owner.db
      .insert(users)
      .values({ id: userId, name: email, email, status: "active" });
    await owner.db
      .insert(members)
      .values({ id: createId(), organizationId, userId });
  }
  const memory = createMemoryTransport();
  const { log } = console;
  console.log = () => {};
  try {
    const runtime = await startRuntime(login.environment, {
      allowTestEnvironment: true,
      seed: async () => seedResult,
      mailTransport: () => ({
        // Slow enough that most of these are still queued when the shutdown starts.
        send: async (message) => {
          await Bun.sleep(40);
          return memory.send(message);
        },
      }),
    });
    for (const address of emails)
      expect(
        runtime.magicLinks.request({
          address,
          browser,
          client,
          pendingQuery: null,
        }),
      ).toBe(true);
    await runtime.shutdown();

    expect(runtime.database.pool.ended).toBe(true);
    expect(memory.sent.map(({ to }) => to).sort()).toEqual([...emails].sort());
    const rows = await owner.db
      .select({ sendStatus: magicLinkRequests.sendStatus })
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.organizationId, organizationId));
    expect(rows).toEqual(emails.map(() => ({ sendStatus: "sent" })));
    // The server has gone, and so has the queue.
    expect(
      runtime.magicLinks.request({
        address: emails[0]!,
        browser,
        client,
        pendingQuery: null,
      }),
    ).toBe(false);
  } finally {
    console.log = log;
    await login.drop();
    await owner.close();
  }
});
