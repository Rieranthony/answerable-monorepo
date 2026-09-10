import { expect, test } from "bun:test";
import { createApp } from "../app.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../__tests__/support.ts";

for (const fail of [false, true])
  test(`admission refuses excess work before auth and releases a slot after handler failure=${fail}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0,
      readiness = 0;
    const app = createApp({
      db: stubDatabase(),
      environment: testEnvironment({ maxConcurrentRequests: 1 }),
      readinessCheck: async () => {
        readiness++;
      },
      auth: {
        ...stubAuth(),
        handler: async () => {
          calls++;
          if (calls === 1) {
            entered.resolve();
            await release.promise;
            if (fail) throw new Error("synthetic failure");
          }
          return new Response("ok");
        },
      },
    });
    const first = app.request("/auth/ok");
    try {
      await entered.promise;
      for (const path of [
        "/auth/ok",
        "/api/admin/v1/me",
        "/readyz",
        "/unknown",
        "/openapi.json",
      ]) {
        const rejected = await app.request(path);
        expect(rejected.status).toBe(503);
        expect(rejected.headers.get("retry-after")).toBe("1");
        expect(rejected.headers.get("cache-control")).toBe("no-store");
        expect(rejected.headers.get("x-request-id")).toBeString();
        expect(await rejected.text()).toBe("Service Busy");
      }
      expect((await app.request("/healthz")).status).toBe(200);
      expect((await app.request("/healthz", { method: "HEAD" })).status).toBe(
        200,
      );
      expect((await app.request("/healthz", { method: "POST" })).status).toBe(
        503,
      );
      expect(calls).toBe(1);
      expect(readiness).toBe(0);
      let cancelled = false;
      const response = await app.request("/auth/sign-out", {
        method: "POST",
        body: new ReadableStream({
          cancel() {
            cancelled = true;
            if (fail) throw new Error("synthetic cancellation failure");
          },
        }),
      });
      expect(response.status).toBe(503);
      expect(cancelled).toBe(true);
    } finally {
      release.resolve();
      await first;
    }
    expect((await app.request("/auth/ok")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    expect(readiness).toBe(1);
  });

test("admission counts body acquisition and is isolated between app instances", async () => {
  let finish!: ReadableStreamDefaultController<Uint8Array>;
  const environment = testEnvironment({ maxConcurrentRequests: 1 });
  const app = createApp({ db: stubDatabase(), auth: stubAuth(), environment });
  const other = createApp({
    db: stubDatabase(),
    auth: stubAuth(),
    environment,
  });
  const first = app.request("/auth/sign-out", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        finish = controller;
      },
    }),
  });
  try {
    expect((await app.request("/auth/ok")).status).toBe(503);
    expect((await other.request("/auth/ok")).status).toBe(200);
  } finally {
    finish.close();
    await first;
  }
  expect((await app.request("/auth/ok")).status).toBe(200);
});

test("real HTTP admission holds both slots until handlers finish, even after disconnect", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const app = createApp({
    db: stubDatabase(),
    environment: testEnvironment({ maxConcurrentRequests: 2 }),
    auth: {
      ...stubAuth(),
      handler: async () => {
        calls++;
        if (calls <= 2) {
          if (calls === 2) entered.resolve();
          await release.promise;
        }
        return new Response("ok");
      },
    },
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
  const url = `http://127.0.0.1:${server.port}/auth/ok`;
  const abort = new AbortController();
  const first = fetch(url, { signal: abort.signal }).catch(() => null);
  const second = fetch(url);
  try {
    await entered.promise;
    abort.abort();
    await first;
    const rejected = await fetch(url);
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).toBe("Service Busy");
    expect(calls).toBe(2);
    release.resolve();
    const response = await second;
    expect(response.status).toBe(200);
    await response.text();
    const recovered = await fetch(url);
    expect(recovered.status).toBe(200);
    await recovered.text();
  } finally {
    release.resolve();
    await first;
    await second;
    server.stop(true);
  }
});

test("published overload responses preserve existing JSON errors and the liveness exemption", async () => {
  const app = createApp({
    db: stubDatabase(),
    auth: stubAuth(),
    environment: testEnvironment(),
  });
  const admin = await (await app.request("/api/admin/openapi.json")).json();
  const response =
    admin.paths["/api/admin/v1/organizations"].post.responses[503];
  expect(response.content).toHaveProperty("application/problem+json");
  expect(response.content).toHaveProperty("text/plain");
  expect(response.headers).toHaveProperty("Retry-After");
  const publicApi = await (await app.request("/openapi.json")).json();
  expect(publicApi.paths["/readyz"].get.responses[503].content).toHaveProperty(
    "application/json",
  );
  expect(publicApi.paths["/readyz"].get.responses[503].content).toHaveProperty(
    "text/plain",
  );
  expect(publicApi.paths["/healthz"].get.responses[503]).toBeUndefined();
  expect(publicApi.paths["/auth/ok"].get.responses[503].content).toHaveProperty(
    "text/plain",
  );
});

for (const poolMax of [1, 2, 4]) {
  test(`authentication admission follows the actual ${poolMax}-connection pool through aliases and disconnect`, async () => {
    const db = stubDatabase(poolMax),
      alias = stubDatabase(poolMax);
    alias.$client = db.$client;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0;
    const slots = Math.max(1, poolMax - 1);
    const auth = {
      ...stubAuth(),
      handler: async () => {
        calls++;
        if (calls === slots) entered.resolve();
        await release.promise;
        return new Response("ok");
      },
    };
    const environment = testEnvironment({ databasePoolMax: 99 });
    const first = createApp({ db, auth, environment });
    const second = createApp({
      db: alias,
      auth,
      environment,
      readinessCheck: async () => {},
    });
    const independent = createApp({
      db: stubDatabase(poolMax),
      auth: stubAuth(),
      environment,
    });
    const abort = new AbortController();
    const pending = Array.from({ length: slots }, (_, i) =>
      first.request("/auth/ok", i === 0 ? { signal: abort.signal } : {}),
    );
    try {
      await entered.promise;
      let cancelled = false;
      const rejected = await second.request("/auth/sign-out", {
        method: "POST",
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      });
      expect(rejected.status).toBe(503);
      expect(cancelled).toBe(true);
      expect(calls).toBe(slots);
      expect((await independent.request("/auth/ok")).status).toBe(200);
      expect((await second.request("/readyz")).status).toBe(200);
      abort.abort();
      expect((await second.request("/auth/ok")).status).toBe(503);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
    expect((await second.request("/auth/ok")).status).toBe(200);
  });
}
