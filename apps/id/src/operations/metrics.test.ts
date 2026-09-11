import { expect, test } from "bun:test";
import { createApp } from "../app.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../__tests__/support.ts";
import { createOperationalMetrics } from "./metrics.ts";

test("operational summaries retain in-flight work across windows without request identifiers or payloads", async () => {
  const db = stubDatabase();
  const metrics = createOperationalMetrics(db.$client);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = createApp({
    db,
    metrics,
    environment: testEnvironment(),
    auth: {
      ...stubAuth(),
      handler: async () => {
        entered.resolve();
        await release.promise;
        return new Response("secret-body");
      },
    },
  });
  const pending = app.request("/auth/ok?secret-query=private", {
    headers: {
      "x-request-id": "private-request",
      Authorization: "Bearer private-token",
    },
  });
  await entered.promise;
  expect(metrics.snapshot().active).toBe(1);
  const refused = await app.request("/private-client");
  expect(refused.status).toBe(404);
  const during = metrics.snapshot();
  expect(during.active).toBe(1);
  expect(during.requests).toContainEqual(
    expect.objectContaining({ route: "other", status: 404, count: 1 }),
  );
  release.resolve();
  await pending;
  const after = metrics.snapshot();
  expect(after.active).toBe(0);
  expect(after.requests).toContainEqual(
    expect.objectContaining({ route: "authentication", status: 200, count: 1 }),
  );
  expect(JSON.stringify([during, after])).not.toMatch(/private|secret/);
  expect(metrics.snapshot().requests).toEqual([]);
});

test("operational dimensions are finite and pool values are instantaneous observations", async () => {
  const pool = { totalCount: 4, idleCount: 1, waitingCount: 2 };
  const metrics = createOperationalMetrics(pool);
  for (const path of [
    "/healthz",
    "/readyz",
    "/.well-known/openid-configuration",
    "/auth/oauth2/token",
    "/auth/sso/callback/provider",
    "/untrusted/one",
    "/untrusted/two",
  ])
    metrics.begin(path)(path === "/readyz" ? 503 : 200);
  const snapshot = metrics.snapshot();
  expect(snapshot.pool).toEqual({ total: 4, idle: 1, waiting: 2 });
  expect(snapshot.requests.find((r) => r.route === "other")?.count).toBe(2);
  expect(snapshot.requests.map((r) => r.route).sort()).toEqual([
    "authentication",
    "health",
    "metadata",
    "other",
    "readiness",
    "token",
  ]);
  expect(snapshot.active).toBe(0);
  expect(snapshot.peakActive).toBe(1);
  expect(snapshot.requests.every((r) => r.totalMs >= 0 && r.maxMs >= 0)).toBe(
    true,
  );
});
