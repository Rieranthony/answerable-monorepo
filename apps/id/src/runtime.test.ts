import { describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createConnection } from "node:net";

import { stubAuth, testEnvironment } from "./__tests__/support.ts";
import type { BootstrapResult } from "./bootstrap.ts";
import { createDatabase } from "./db/client.ts";
import { oauthClientAssertions } from "./db/schema/index.ts";
import { startRuntime } from "./runtime.ts";

const seedResult: BootstrapResult = {
  organizationId: "org",
  slug: "custom-platform",
  groupId: "group",
  resourceId: "resource",
  created: true,
};

test("runtime emits bounded operational summaries and stops the reporter on shutdown", async () => {
  const callbacks = new Set<() => void>();
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
  ) => {
    callbacks.add(callback);
    return { unref() {}, callback };
  }) as unknown as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((
    timer: { callback?: () => void } | undefined,
  ) => {
    if (timer?.callback) callbacks.delete(timer.callback);
  }) as typeof clearInterval);
  const tick = () => {
    for (const callback of callbacks) callback();
  };
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
      { allowTestEnvironment: true, seed: async () => seedResult },
    );
    const response = await fetch(new URL("/healthz", runtime.server.url));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    tick();
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({ event: "operational_summary" });
    await runtime.shutdown();
    const count = reports.length;
    tick();
    expect(reports).toHaveLength(count);
  } finally {
    await runtime?.shutdown();
    console.log = log;
    interval.mockRestore();
    clear.mockRestore();
  }
});

test("runtime sweeps expired protocol rows on its interval, unless disabled, and stops the sweep on shutdown", async () => {
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    const timer = { callback, ms, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((
    timer: { cleared: boolean } | undefined,
  ) => {
    if (timer) timer.cleared = true;
  }) as unknown as typeof clearInterval);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const probe = createDatabase(testEnvironment());
  const id = `runtime-sweep-${crypto.randomUUID()}`;
  try {
    const options = {
      allowTestEnvironment: true,
      seed: async () => seedResult,
      authFactory: stubAuth,
    };
    await (
      await startRuntime(testEnvironment({ port: 0 }), options)
    ).shutdown();
    expect(timers).toEqual([]);

    await probe.db
      .insert(oauthClientAssertions)
      .values({ id, expiresAt: new Date(Date.now() - 60_000) });
    const runtime = await startRuntime(
      testEnvironment({
        port: 0,
        protocolSweepIntervalMs: 1_000,
        protocolSweepBatchSize: 10,
      }),
      options,
    );
    expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
    timers[0]!.callback();
    while (!log.mock.calls.some(([line]) => line === "[id] protocol sweep"))
      await Bun.sleep(5);
    await runtime.shutdown();
    expect(timers[0]!.cleared).toBe(true);
    expect(
      await probe.db
        .select()
        .from(oauthClientAssertions)
        .where(eq(oauthClientAssertions.id, id)),
    ).toEqual([]);
  } finally {
    await probe.db
      .delete(oauthClientAssertions)
      .where(eq(oauthClientAssertions.id, id));
    await probe.close();
    interval.mockRestore();
    clear.mockRestore();
    log.mockRestore();
  }
});

test("a deployment cannot start with NODE_ENV=test", async () => {
  const databaseFactory = mock(createDatabase);
  await expect(
    startRuntime(testEnvironment({ port: 0 }), { databaseFactory }),
  ).rejects.toThrow("NODE_ENV=test is for the test suite");
  expect(databaseFactory).not.toHaveBeenCalled();
});

describe("unit: process runtime", () => {
  test("seeds once with environment values, serves, and shuts down idempotently", async () => {
    const environment = testEnvironment({
      port: 0,
      platformOrganizationSlug: "custom-platform",
      platformOrganizationName: "Custom platform",
      adminResourceIdentifier: "https://admin.example.com",
    });
    const database = createDatabase(environment);
    const seed = mock(async () => seedResult);
    const runtime = await startRuntime(environment, {
      allowTestEnvironment: true,
      seed,
      databaseFactory: () => database,
      authFactory: stubAuth,
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
    const response = await fetch(new URL("/healthz", runtime.server.url));
    expect(response.status).toBe(200);
    expect(runtime.database.pool.options.max).toBe(1);
    await runtime.shutdown();
    await runtime.shutdown();
    expect(database.pool.ended).toBe(true);
  });

  test("a failing seed closes the pool and never listens", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop(true);
    const environment = testEnvironment({ port });
    const database = createDatabase(environment);
    const failure = new Error("seed failed");
    const seed = mock(async () => {
      throw failure;
    });
    await expect(
      startRuntime(environment, {
        allowTestEnvironment: true,
        databaseFactory: () => database,
        seed,
      }),
    ).rejects.toBe(failure);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(database.pool.ended).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});

test.each(["production", "development"] as const)(
  "%s refuses the database owner role before seeding or listening",
  async (nodeEnv) => {
    const environment = testEnvironment({ nodeEnv, port: 0 });
    const database = createDatabase(environment);
    const seed = mock(async () => seedResult);
    await expect(
      startRuntime(environment, { databaseFactory: () => database, seed }),
    ).rejects.toThrow("Unsafe database runtime role");
    expect(seed).not.toHaveBeenCalled();
    expect(database.pool.ended).toBe(true);
  },
);

test("runtime caps declared and streamed request bodies before provider work", async () => {
  const accepted: number[] = [];
  const runtime = await startRuntime(testEnvironment({ port: 0 }), {
    allowTestEnvironment: true,
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

test("startup reports only platform application availability after the seed line", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const configured of [false, true]) {
      log.mockClear();
      const runtime = await startRuntime(
        testEnvironment({
          port: 0,
          platformApplications: configured
            ? {
                google: {
                  clientId: "private-google-id",
                  clientSecret: "private-google-secret",
                },
                microsoft: {
                  clientId: "private-microsoft-id",
                  clientSecret: "private-microsoft-secret",
                },
              }
            : {},
        }),
        { allowTestEnvironment: true, seed: async () => seedResult },
      );
      try {
        expect(log.mock.calls[0]![0]).toBe(
          "[id] platform organisation custom-platform: provisioned",
        );
        expect(log.mock.calls[1]).toEqual([
          "[id] platform applications",
          JSON.stringify({ google: configured, microsoft: configured }),
        ]);
        expect(JSON.stringify(log.mock.calls).includes("private-")).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    }
  } finally {
    log.mockRestore();
  }
});
