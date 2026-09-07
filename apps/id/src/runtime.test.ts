import { describe, expect, mock, test } from "bun:test";

import { stubAuth, testEnvironment } from "./__tests__/support.ts";
import type { BootstrapResult } from "./bootstrap.ts";
import { createDatabase } from "./db/client.ts";
import { startRuntime } from "./runtime.ts";

const seedResult: BootstrapResult = {
  organization: {
    id: "org",
    slug: "custom-platform",
    created: true,
    updated: false,
  },
  resource: {
    id: "resource",
    identifier: "https://admin.example.com",
    created: false,
    updated: true,
  },
  group: { id: "group", created: true },
  entitlement: { id: "entitlement", created: false, updated: false },
};

describe("unit: process runtime", () => {
  test("seeds once with environment values before listening and shuts down idempotently", async () => {
    const environment = testEnvironment({
      platformOrganizationSlug: "custom-platform",
      platformOrganizationName: "Custom platform",
      adminResourceIdentifier: "https://admin.example.com",
    });
    const database = createDatabase(environment);
    const order: string[] = [];
    const seed = mock(async () => {
      order.push("seed");
      await Promise.resolve();
      order.push("seeded");
      return seedResult;
    });
    const stop = mock(() => {});
    const serve = mock(() => {
      order.push("listen");
      return { stop };
    });
    const runtime = await startRuntime(environment, {
      seed,
      databaseFactory: () => database,
      authFactory: stubAuth,
      serve: serve as unknown as typeof Bun.serve,
    });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledWith(
      database.db,
      {
        actorType: "system",
        actorId: "startup",
        requestId: "startup",
      },
      {
        platformOrganizationSlug: environment.platformOrganizationSlug,
        platformOrganizationName: environment.platformOrganizationName,
        adminResourceIdentifier: environment.adminResourceIdentifier,
      },
    );
    expect(order).toEqual(["seed", "seeded", "listen"]);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(runtime.database.pool.options.max).toBe(1);
    await runtime.shutdown();
    await runtime.shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(false);
    expect(database.pool.ended).toBe(true);
  });

  test("a failing seed closes the pool and prevents listening", async () => {
    const environment = testEnvironment();
    const database = createDatabase(environment);
    const failure = new Error("seed failed");
    const seed = mock(async () => {
      throw failure;
    });
    const serve = mock(() => {
      throw new Error("must not listen");
    });
    await expect(
      startRuntime(environment, {
        databaseFactory: () => database,
        seed,
        serve: serve as unknown as typeof Bun.serve,
      }),
    ).rejects.toBe(failure);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(serve).not.toHaveBeenCalled();
    expect(database.pool.ended).toBe(true);
  });

  test("starts Bun with one database pool and shuts it down idempotently", async () => {
    const runtime = await startRuntime(testEnvironment({ port: 0 }), {
      seed: async () => seedResult,
    });
    try {
      const response = await fetch(new URL("/healthz", runtime.server.url));
      expect(response.status).toBe(200);
      expect(runtime.database.pool.options.max).toBe(1);
    } finally {
      await runtime.shutdown();
      await runtime.shutdown();
    }
    expect(runtime.database.pool.ended).toBe(true);
  });
});
