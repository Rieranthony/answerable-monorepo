import { describe, expect, mock, test } from "bun:test";
import { createConnection } from "node:net";

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

test("runtime emits bounded operational summaries and stops the reporter on shutdown", async () => {
  const log = console.log;
  const reports: unknown[] = [];
  console.log = (...args: unknown[]) => {
    if (args[0] === "[id] operations")
      reports.push(JSON.parse(String(args[1])));
  };
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime(
      testEnvironment({ port: 0, operationalLogIntervalMs: 10 }),
      { seed: async () => seedResult, authFactory: stubAuth },
    );
    const response = await fetch(new URL("/healthz", runtime.server.url));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const deadline = Date.now() + 1000;
    while (!reports.length && Date.now() < deadline) await Bun.sleep(10);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({ event: "operational_summary" });
    await runtime.shutdown();
    const count = reports.length;
    await Bun.sleep(30);
    expect(reports).toHaveLength(count);
  } finally {
    await runtime?.shutdown();
    console.log = log;
  }
});

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

test("production refuses an unsafe database role before seeding or listening", async () => {
  const database = createDatabase(testEnvironment());
  const seed = mock(async () => seedResult);
  const serve = mock(() => {
    throw new Error("must not listen");
  });
  const verifyDatabaseRole = mock(async () => {
    throw new Error("unsafe role");
  });
  await expect(
    startRuntime(testEnvironment({ nodeEnv: "production" }), {
      databaseFactory: () => database,
      seed,
      serve: serve as unknown as typeof Bun.serve,
      verifyDatabaseRole,
    }),
  ).rejects.toThrow("unsafe role");
  expect(verifyDatabaseRole).toHaveBeenCalledWith(database.db);
  expect(seed).not.toHaveBeenCalled();
  expect(serve).not.toHaveBeenCalled();
  expect(database.pool.ended).toBe(true);
});

test("runtime caps declared and streamed request bodies before provider work", async () => {
  const accepted: number[] = [];
  const runtime = await startRuntime(testEnvironment({ port: 0 }), {
    seed: async () => seedResult,
    authFactory: () => ({
      ...stubAuth(),
      handler: async (request) => {
        const bytes = (await request.arrayBuffer()).byteLength;
        accepted.push(bytes);
        return Response.json({ bytes });
      },
    }),
  });
  const limit = 256 * 1024;
  try {
    for (const size of [limit, limit + 1]) {
      const response = await fetch(
        new URL("/auth/sign-out", runtime.server.url),
        {
          method: "POST",
          body: new Uint8Array(size),
        },
      );
      expect(response.status).toBe(size === limit ? 200 : 413);
      await response.arrayBuffer();
    }
    let remaining = limit + 1;
    const response = await fetch(
      new URL("/auth/sign-out", runtime.server.url),
      {
        method: "POST",
        // Bun 1.3.1 can reuse a rejected chunked upload before finishing its
        // framing. Keep this deliberately aborted upload out of its client pool.
        // Evidence: reports/answerable-id-request-reuse.md.
        keepalive: false,
        body: new ReadableStream({
          pull(controller) {
            if (!remaining) {
              controller.close();
              return;
            }
            const count = Math.min(16384, remaining);
            remaining -= count;
            controller.enqueue(new Uint8Array(count));
          },
        }),
      },
    );
    expect(response.status).toBe(413);
    await response.arrayBuffer();
    expect(accepted).toEqual([limit]);
    const stalled = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: runtime.server.port!,
      });
      let response = "";
      socket.setTimeout(7_000, () => {
        socket.destroy();
        reject(
          new Error("Body deadline did not return a complete HTTP response"),
        );
      });
      socket.once("connect", () =>
        socket.write(
          "POST /auth/sign-out HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nConnection: close\r\n\r\nx",
        ),
      );
      socket.on("data", (chunk) => {
        response += chunk.toString();
        if (response.includes("\r\n\r\nRequest Timeout")) {
          socket.destroy();
          resolve(response);
        }
      });
      socket.once("end", () => {
        socket.destroy();
        resolve(response);
      });
      socket.once("error", reject);
    });
    expect(stalled).toStartWith("HTTP/1.1 408");
    expect(stalled).toEndWith("Request Timeout");
    expect(accepted).toEqual([limit]);
    expect((await fetch(new URL("/healthz", runtime.server.url))).status).toBe(
      200,
    );
  } finally {
    await runtime.shutdown();
  }
});

for (const stage of ["auth", "app"] as const)
  test(`startup closes its pool when ${stage} construction fails after seeding`, async () => {
    const environment = testEnvironment();
    const database = createDatabase(environment);
    const failure = new Error(`${stage} construction failed`);
    const serve = mock(() => {
      throw new Error("must not listen");
    });
    try {
      await expect(
        startRuntime(environment, {
          databaseFactory: () => database,
          seed: async () => seedResult,
          authFactory: () => {
            if (stage === "auth") throw failure;
            return stubAuth();
          },
          appFactory: () => {
            throw failure;
          },
          serve: serve as unknown as typeof Bun.serve,
        }),
      ).rejects.toBe(failure);
      expect(serve).not.toHaveBeenCalled();
      expect(database.pool.ended).toBe(true);
    } finally {
      if (!database.pool.ended) await database.close();
    }
  });

test("a real occupied listen port closes the seeded runtime's database pool", async () => {
  const blocker = Bun.serve({
    port: 0,
    fetch: () => new Response("occupied"),
  });
  const environment = testEnvironment({ port: blocker.port! });
  const database = createDatabase(environment);
  let started: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    await expect(
      startRuntime(environment, {
        databaseFactory: () => database,
        seed: async () => seedResult,
        authFactory: stubAuth,
      }).then((value) => {
        started = value;
        return value;
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(database.pool.ended).toBe(true);
  } finally {
    await started?.shutdown();
    blocker.stop(true);
    if (!database.pool.ended) await database.close();
  }
});
