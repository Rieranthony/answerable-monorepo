import { windowDates, windowSchema } from "./schemas.ts";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import type { Database } from "../../db/client.ts";
import { testEnvironment } from "../../__tests__/support.ts";
import type { AppEnvironment } from "../context.ts";
import { problemHandler } from "../problem.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { adminScopes } from "./scopes.ts";
import { register as registerMe } from "./me.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
const meSchema = responseSchema("getAdminMe", 200);
test("registerRoute describes, authorises and handles a route", async () => {
  const app = new Hono<AppEnvironment>();
  const rows: unknown[] = [];
  app.use("*", async (c, next) => {
    c.set("environment", testEnvironment());
    c.set("requestId", "request");
    c.set("db", {
      execute: async () => ({ rows: [{ occurredAt: "2026-09-11T00:00:00Z" }] }),
      insert: () => ({
        values: (row: unknown) => {
          rows.push(row);
          return Promise.resolve();
        },
      }),
    } as unknown as Database);
    c.set("principal", {
      type: "user",
      userId: "user",
      email: "user@example.com",
      sessionId: "session",
      grants: [
        {
          organizationId: "own",
          organizationSlug: "tenant",
          isPlatform: false,
          scopes: ["org:read"],
        },
      ],
    });
    await next();
  });
  const route = {
    method: "get",
    path: "/orgs/:organizationId",
    operationId: "getOrg",
    summary: "Get organisation",
    description:
      "Return the organisation. Raises not_found when it is unavailable.",
    tag: "Organisations",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    responses: { 200: { description: "OK" } },
    parameters: [
      {
        name: "organizationId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
  } satisfies AdminRoute;
  let handled = 0;
  registerRoute(app, route, (c) => {
    handled++;
    return c.json({ tier: c.get("tier") });
  });
  app.onError(problemHandler);
  expect(await (await app.request("/orgs/own")).json()).toEqual({
    tier: "tenant",
  });
  expect((await app.request("/orgs/other")).status).toBe(404);
  expect(handled).toBe(1);
  expect(rows).toEqual([
    expect.objectContaining({ targetId: "getOrg", reason: "not_found" }),
  ]);
  const spec = await generateSpecs(app);
  expect(spec.paths?.["/orgs/{organizationId}"]?.get).toMatchObject({
    operationId: "getOrg",
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    "x-tier": "tenant",
    responses: {
      "200": { description: "OK" },
      "401": {},
      "403": {},
      "404": {},
    },
    parameters: route.parameters,
  });
});

test("me serialises root scopes without phantom grants", async () => {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (c, next) => {
    c.set("principal", { type: "root", grants: [] });
    c.set("requestId", "request");
    c.set("db", {
      execute: async () => ({ rows: [{ occurredAt: "2026-09-11T00:00:00Z" }] }),
      insert: () => ({
        values: async () => {},
      }),
    } as unknown as Database);
    await next();
  });
  registerMe(app);
  const response = await app.request("/me");
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: { type: "root", scopes: [...adminScopes] },
    grants: [],
  });
});

test("validity windows preserve omitted and cleared boundaries", () => {
  expect(windowDates(windowSchema.parse({}))).toEqual({
    validFrom: undefined,
    validUntil: undefined,
  });
  expect(
    windowDates(windowSchema.parse({ validFrom: null, validUntil: null })),
  ).toEqual({ validFrom: null, validUntil: null });
  const validFrom = "2026-01-01T00:00:00.000Z";
  const validUntil = "2027-01-01T00:00:00.000Z";
  expect(windowDates(windowSchema.parse({ validFrom, validUntil }))).toEqual({
    validFrom: new Date(validFrom),
    validUntil: new Date(validUntil),
  });
});
