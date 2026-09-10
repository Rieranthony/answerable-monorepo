import { expect, test } from "bun:test";
import type { GenericEndpointContext } from "better-auth";

import type { Database } from "../db/client.ts";
import {
  attributeSignIn,
  isSsoCallbackPath,
  signInAudit,
} from "./signin-audit-plugin.ts";

function harness(
  memberships: { organizationId: string }[],
  organizations: { id: string }[],
  session: Record<string, unknown> | null,
  headers?: Headers,
) {
  const rows: unknown[] = [];
  const updates: unknown[] = [];
  const db = {
    insert: () => ({
      values: (row: unknown) => {
        rows.push(row);
        return { returning: async () => [row] };
      },
    }),
  } as unknown as Database;
  const ctx = {
    headers,
    context: {
      newSession: session ? { session, user: { id: "user" } } : null,
      adapter: {
        findMany: async (query: { model: string }) =>
          query.model === "member" ? memberships : organizations,
      },
      internalAdapter: {
        updateSession: async (token: string, patch: unknown) => {
          updates.push([token, patch]);
        },
      },
    },
  } as unknown as GenericEndpointContext;
  return { db, ctx, rows, updates };
}
const session = {
  id: "session",
  token: "token",
  ipAddress: "192.0.2.1",
  userAgent: "agent",
};

test("does nothing without a new session", async () => {
  const h = harness([], [], null);
  expect(await attributeSignIn(h.db, h.ctx)).toBeNull();
  expect(h.rows).toEqual([]);
});

test("attributes the single active organisation, stamps the session and audits", async () => {
  const h = harness(
    [{ organizationId: "org" }, { organizationId: "org" }],
    [{ id: "org" }],
    session,
    new Headers({ "x-request-id": "request" }),
  );
  expect(await attributeSignIn(h.db, h.ctx)).toBe("org");
  expect(h.updates).toEqual([["token", { activeOrganizationId: "org" }]]);
  expect(h.rows).toEqual([
    {
      id: expect.any(String),
      actorType: "user",
      actorId: "user",
      organizationId: "org",
      action: "auth.signin.succeeded",
      targetType: "session",
      targetId: "session",
      outcome: "success",
      requestId: "request",
      ip: null,
      userAgent: "agent",
    },
  ]);
});

test("leaves the session alone when it already carries the organisation", async () => {
  const h = harness([{ organizationId: "org" }], [{ id: "org" }], {
    ...session,
    activeOrganizationId: "org",
  });
  expect(await attributeSignIn(h.db, h.ctx)).toBe("org");
  expect(h.updates).toEqual([]);
});

test("records an unattributed sign-in without memberships or with several organisations", async () => {
  const none = harness([], [], { id: "s", token: "t" });
  expect(await attributeSignIn(none.db, none.ctx)).toBeNull();
  expect(none.rows).toHaveLength(1);
  expect(none.rows[0]).toMatchObject({
    organizationId: null,
    requestId: null,
    ip: null,
    userAgent: null,
  });
  const several = harness(
    [{ organizationId: "a" }, { organizationId: "b" }],
    [{ id: "a" }, { id: "b" }],
    session,
  );
  expect(await attributeSignIn(several.db, several.ctx)).toBeNull();
  expect(several.updates).toEqual([]);
});

test("the plugin matches only SSO callback paths", () => {
  const plugin = signInAudit({} as Database);
  expect(plugin.id).toBe("answerable-signin-audit");
  const [hook] = plugin.hooks!.after!;
  for (const [path, expected] of [
    ["/sso/callback", true],
    ["/sso/callback/acme", true],
    ["/callback/google", true],
    ["/sign-in/sso", false],
    ["/get-session", false],
  ] as const) {
    expect(isSsoCallbackPath(path)).toBe(expected);
    expect(hook!.matcher({ path } as GenericEndpointContext)).toBe(expected);
  }
});
