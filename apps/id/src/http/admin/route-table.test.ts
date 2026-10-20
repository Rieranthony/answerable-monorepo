import { windowDates, windowSchema } from "./schemas.ts";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import type { Database } from "../../db/client.ts";
import { testEnvironment } from "../../__tests__/support.ts";
import type { AppEnvironment } from "../context.ts";
import { problemHandler } from "../problem.ts";
import { AuthorityDenied } from "../../services/command-authority.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { adminScopes } from "./scopes.ts";
import { register as registerMe } from "./me.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
const meSchema = responseSchema("getAdminMe", 200);
test("registerRoute describes and handles a route, audits root, and records a refusal by current authority", async () => {
  const app = new Hono<AppEnvironment>();
  const rows: unknown[] = [];
  const grants = [
    {
      organizationId: "own",
      organizationSlug: "tenant",
      isPlatform: false,
      scopes: ["org:read"],
    },
  ];
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
    const kind = c.req.header("x-principal");
    c.set(
      "principal",
      kind === "root"
        ? { type: "root", grants: [] }
        : kind === "client"
          ? {
              type: "client",
              clientId: "client",
              organizationId: "own",
              grants,
            }
          : {
              type: "user",
              userId: "user",
              email: "user@example.com",
              sessionId: "session",
              grants,
            },
    );
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
  // As authorizeCommand answers: its own organisation admitted, another
  // hidden, and a write refused for want of scope.
  registerRoute(app, route, (c) => {
    if (c.req.query("write") !== undefined) throw new AuthorityDenied(false);
    if (c.req.param("organizationId") !== "own")
      throw new AuthorityDenied(true);
    return c.json({ ok: true });
  });
  app.onError(problemHandler);
  const send = (path: string, principal = "user") =>
    app.request(path, { headers: { "x-principal": principal } });
  expect(await (await send("/orgs/own")).json()).toEqual({ ok: true });
  expect(rows).toEqual([]);

  const hidden = await send("/orgs/other");
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toMatchObject({ code: "not_found" });
  const refused = await send("/orgs/own?write", "client");
  expect(refused.status).toBe(403);
  expect(refused.headers.get("WWW-Authenticate")).toBe(
    'Bearer error="insufficient_scope"',
  );
  expect((await send("/orgs/own?write")).headers.get("WWW-Authenticate")).toBe(
    null,
  );
  expect(rows).toEqual([
    expect.objectContaining({
      action: "admin.denied",
      outcome: "denied",
      actorType: "user",
      organizationId: null,
      data: { organizationId: "other" },
      targetType: "route",
      targetId: "getOrg",
      reason: "not_found",
    }),
    expect.objectContaining({
      action: "admin.denied",
      actorType: "client",
      organizationId: "own",
      data: null,
      reason: "insufficient_scope",
    }),
    expect.objectContaining({ actorType: "user", organizationId: "own" }),
  ]);

  rows.length = 0;
  expect((await send("/orgs/own", "root")).status).toBe(200);
  expect(rows).toEqual([
    expect.objectContaining({
      action: "admin.root_request",
      outcome: "success",
      actorType: "system",
      actorId: "root",
      organizationId: null,
      data: { organizationId: "own" },
      targetId: "getOrg",
    }),
  ]);

  const spec = await generateSpecs(app);
  expect(spec.paths?.["/orgs/{organizationId}"]?.get).toMatchObject({
    operationId: "getOrg",
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    responses: {
      "200": { description: "OK" },
      "401": {},
      "403": {},
      "404": {},
    },
    parameters: route.parameters,
  });
});

test("an answer drops a row's soft-deletion markers, and its page's rows', but keeps evidence's and other answers", async () => {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (c, next) => {
    c.set("principal", {
      type: "user",
      userId: "u",
      email: "e",
      sessionId: "s",
      grants: [],
    });
    await next();
  });
  const minimalRoute = {
    method: "get",
    path: "/",
    operationId: "",
    summary: "Read",
    description: "Read.",
    tag: "Test",
    platformScope: "platform:read",
    kind: "read",
    responses: { 200: { description: "OK" } },
  } satisfies AdminRoute;
  const row = { id: "row", name: "Row", deletedAt: null, live: true };
  const evidence = {
    id: "event",
    data: { deletedAt: "2026-10-20T00:00:00.000Z" },
  };
  const answers: Record<string, () => Response> = {
    row: () => Response.json(row, { headers: { ETag: '"row:1"' } }),
    page: () => Response.json({ items: [row, evidence], nextCursor: null }),
    evidence: () => Response.json({ items: [evidence], nextCursor: null }),
    text: () => new Response("plain"),
    empty: () => new Response(null, { status: 204 }),
  };
  for (const name of Object.keys(answers))
    registerRoute(
      app,
      { ...minimalRoute, path: `/${name}`, operationId: name },
      () => answers[name]!(),
    );
  const row200 = await app.request("/row");
  expect(row200.headers.get("ETag")).toBe('"row:1"');
  expect(await row200.json()).toEqual({ id: "row", name: "Row" });
  expect(await (await app.request("/page")).json()).toEqual({
    items: [{ id: "row", name: "Row" }, evidence],
    nextCursor: null,
  });
  expect(await (await app.request("/evidence")).json()).toEqual({
    items: [evidence],
    nextCursor: null,
  });
  expect(await (await app.request("/text")).text()).toBe("plain");
  expect((await app.request("/empty")).status).toBe(204);
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
