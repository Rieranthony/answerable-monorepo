import { expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import type { Database } from "../../db/client.ts";
import { testEnvironment } from "../../__tests__/support.ts";
import type { AppEnvironment } from "../context.ts";
import { problemHandler } from "../problem.ts";
import { registerRoute, tierOf, type AdminRoute } from "./route-table.ts";
import { register as registerMe, meSchema } from "./me.ts";

test("tierOf distinguishes platform, organisation and the me exception", () => {
  expect(tierOf({})).toBe("platform");
  expect(tierOf({ orgScope: "org:read" })).toBe("tenant");
  expect(tierOf({ anyGrant: true })).toBe("tenant");
});
test("registerRoute describes, authorises and handles a route", async () => {
  const app = new Hono<AppEnvironment>();
  const rows: unknown[] = [];
  app.use("*", async (c, next) => {
    c.set("environment", testEnvironment());
    c.set("requestId", "request");
    c.set("db", {
      insert: () => ({
        values: (row: unknown) => {
          rows.push(row);
          return { returning: async () => [row] };
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
    tag: "Organisations",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
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
test.each(["user", "client"] as const)(
  "me serialises a %s principal separately from grants",
  async (type) => {
    const app = new Hono<AppEnvironment>();
    const grants = [
      {
        organizationId: "own",
        organizationSlug: "tenant",
        scopes: ["org:read"],
      },
    ];
    const principal =
      type === "user"
        ? {
            type,
            userId: "user",
            email: "user@example.com",
            sessionId: "session",
          }
        : { type, clientId: "client", organizationId: "own" };
    app.use("*", async (c, next) => {
      c.set("principal", { ...principal, grants });
      await next();
    });
    registerMe(app);
    const response = await app.request("/me");
    expect(response.status).toBe(200);
    expect(meSchema.parse(await response.json())).toEqual({
      principal,
      grants,
    });
  },
);
