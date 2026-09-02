import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createApp } from "./app.ts";
import { isAllowedAuthRoute } from "./http/auth-allowlist.ts";
import {
  isUuidV7,
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "./__tests__/support.ts";

describe("unit: Hono application", () => {
  test("health is independent from PostgreSQL and creates a UUIDv7 request id", async () => {
    let checks = 0;
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
      readinessCheck: async () => {
        checks += 1;
      },
    });

    const response = await app.request("/healthz");
    const requestId = response.headers.get("x-request-id")!;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(checks).toBe(0);
    expect(isUuidV7(requestId)).toBe(true);
  });

  test("preserves a caller-provided request id", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.request("/healthz", {
      headers: { "x-request-id": "request-from-ingress" },
    });

    expect(response.headers.get("x-request-id")).toBe("request-from-ingress");
  });

  test("readiness uses the database from Hono context", async () => {
    const db = stubDatabase();
    let receivedDatabase: unknown;
    const app = createApp({
      auth: stubAuth(),
      db,
      environment: testEnvironment(),
      readinessCheck: async (contextDatabase) => {
        receivedDatabase = contextDatabase;
      },
    });

    const response = await app.request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(receivedDatabase).toBe(db);
  });

  test("readiness reports an unavailable database", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
      readinessCheck: () => Promise.reject(new Error("offline")),
    });

    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  test("publishes a valid admin OpenAPI contract and reference", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });

    const schemaResponse = await app.request("/api/admin/openapi.json");
    const schema = z
      .object({
        openapi: z.string().startsWith("3."),
        info: z.object({
          title: z.literal("Answerable ID Admin API"),
          version: z.string(),
        }),
        paths: z.record(z.string(), z.unknown()),
      })
      .parse(await schemaResponse.json());
    const docsResponse = await app.request("/api/admin/docs");

    expect(schemaResponse.status).toBe(200);
    expect(schema.openapi).toStartWith("3.");
    expect(Object.keys(schema.paths)).toEqual([]);
    expect(docsResponse.status).toBe(200);
    expect(await docsResponse.text()).toContain("Answerable ID Admin API");
  });

  test("can disable OpenAPI routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({ openApiEnabled: false }),
    });

    expect((await app.request("/api/admin/openapi.json")).status).toBe(404);
    expect((await app.request("/api/admin/docs")).status).toBe(404);
  });

  test("keeps the OpenAPI contract but hides interactive docs in production", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment({ nodeEnv: "production" }),
    });

    expect((await app.request("/api/admin/openapi.json")).status).toBe(200);
    expect((await app.request("/api/admin/docs")).status).toBe(404);
  });

  test("forwards only allowlisted Better Auth routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });

    expect(isAllowedAuthRoute("get", "/auth/ok")).toBe(true);
    expect(isAllowedAuthRoute("POST", "/auth/organization/create")).toBe(false);
    expect((await app.request("/auth/ok")).status).toBe(200);
    expect((await app.request("/auth/organization/create", { method: "POST" })).status).toBe(
      404,
    );
  });

  test("returns structured JSON for unknown routes", async () => {
    const app = createApp({
      auth: stubAuth(),
      db: stubDatabase(),
      environment: testEnvironment(),
    });
    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
