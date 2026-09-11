import { register as registerMe } from "./admin/me.ts";
import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "../db/client.ts";
import type { AuditEventInput } from "../__tests__/audit-queries.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { admitRoot, authorize } from "./authorize.ts";
import type { AdminScope } from "./admin/scopes.ts";
import type { AppEnvironment } from "./context.ts";
import type { Principal } from "./principal.ts";
import { problemHandler } from "./problem.ts";

const own = {
  organizationId: "own",
  organizationSlug: "tenant",
  isPlatform: false,
  scopes: ["org:read"],
};
const platform = {
  organizationId: "staff",
  organizationSlug: "answerable",
  isPlatform: true,
  scopes: ["platform:read"],
};
function setup(
  grants: Principal["grants"],
  options: {
    root?: boolean;
    client?: boolean;
    org?: boolean;
    path?: string;
    platform?: AdminScope;
  } = {},
) {
  const rows: AuditEventInput[] = [];
  const insert = mock(() => ({
    values: (row: AuditEventInput) => {
      rows.push(row);
      return { returning: async () => [row] };
    },
  }));
  const app = new Hono<AppEnvironment>();
  app.use("*", async (c, next) => {
    c.set("db", { insert } as unknown as Database);
    c.set("environment", testEnvironment());
    c.set("requestId", "request");
    c.set("clientIp", "192.0.2.1");
    c.set("operationId", "testOperation");
    c.set(
      "principal",
      options.root
        ? { type: "root", grants: [] }
        : options.client
          ? {
              type: "client",
              clientId: "client",
              organizationId: "own",
              grants,
            }
          : {
              type: "user",
              userId: "user",
              email: "person@example.com",
              sessionId: "session",
              grants,
            },
    );
    await next();
  });
  app.get(
    options.path ?? "/:organizationId",
    admitRoot(),
    authorize({
      platform: options.platform ?? "platform:read",
      org: options.org ? "org:read" : undefined,
    }),
    (c) => c.json({ tier: c.get("tier") }),
  );
  app.onError(problemHandler);
  return { app, rows, insert };
}
test("platform grants take precedence and set tier", async () => {
  const { app, rows } = setup([own, platform], { org: true });
  expect(await (await app.request("/other")).json()).toEqual({
    tier: "platform",
  });
  expect(rows).toEqual([]);
});
test("own organisation scope sets tenant tier", async () => {
  const { app, rows } = setup([own], { org: true });
  expect(await (await app.request("/own")).json()).toEqual({ tier: "tenant" });
  expect(rows).toEqual([]);
});
test.each([
  { grants: [own], org: false, path: "/own", code: "insufficient_scope" },
  { grants: [own], org: true, path: "/other", code: "not_found" },
  {
    grants: [platform],
    org: true,
    platform: "platform:write" as const,
    path: "/other",
    code: "insufficient_scope",
  },
  {
    grants: [{ ...own, scopes: ["org:write"] }],
    org: true,
    path: "/own",
    code: "insufficient_scope",
  },
  { grants: [], org: false, path: "/own", code: "insufficient_scope" },
  {
    grants: [{ ...platform, scopes: ["platform:write"] }],
    org: false,
    path: "/own",
    code: "insufficient_scope",
  },
])("denies and audits %#", async ({ grants, org, path, code, platform }) => {
  for (const client of [false, true]) {
    const { app, rows, insert } = setup(grants, { org, client, platform });
    const response = await app.request(path, {
      headers: {
        "x-forwarded-for": " 192.0.2.1, 192.0.2.2",
        "user-agent": "test-agent",
      },
    });
    const status = code === "not_found" ? 404 : 403;
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(response.headers.get("www-authenticate")).toBe(
      client && status === 403 ? 'Bearer error="insufficient_scope"' : null,
    );
    expect(insert).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    const known = grants.some(
      (grant) => grant.organizationId === path.slice(1),
    );
    expect(rows[0]!.ip).toBe("192.0.2.1");
    expect(rows[0]).toMatchObject({
      actorType: client ? "client" : "user",
      actorId: client ? "client" : "user",
      organizationId: known ? path.slice(1) : undefined,
      data: known ? undefined : { organizationId: path.slice(1) },
      action: "admin.denied",
      outcome: "denied",
      targetType: "route",
      targetId: "testOperation",
      reason: code,
      requestId: "request",
      userAgent: "test-agent",
    });
  }
});
test("an org scope without an organisation parameter cannot authorise", async () => {
  const { app, rows } = setup([own], { org: true, path: "/" });
  expect((await app.request("/")).status).toBe(403);
  expect(rows[0]!.ip).toBe("192.0.2.1");
  expect(rows[0]).toMatchObject({
    organizationId: undefined,
    userAgent: undefined,
  });
});

test.each([
  {
    org: true,
    path: "/:organizationId",
    request: "/other",
    data: { organizationId: "other" },
  },
  { path: "/", request: "/", data: undefined },
])("root is audited and admitted at platform tier %#", async (options) => {
  const { app, rows } = setup([], { ...options, root: true });
  expect(
    await (
      await app.request(options.request, {
        headers: {
          "x-forwarded-for": " 192.0.2.1, 192.0.2.2",
          "user-agent": "test-agent",
        },
      })
    ).json(),
  ).toEqual({ tier: "platform" });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.ip).toBe("192.0.2.1");
  expect(rows[0]).toMatchObject({
    actorType: "system",
    actorId: "root",
    organizationId: undefined,
    action: "admin.root_request",
    outcome: "success",
    targetType: "route",
    targetId: "testOperation",
    data: options.data,
    requestId: "request",
    userAgent: "test-agent",
  });
});

test("a zero-grants principal reaches an open admin route", async () => {
  const { app, rows } = setup([], { path: "/protected" });
  registerMe(app);
  const response = await app.request("/me");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ grants: [] });
  expect(rows).toEqual([]);
});
