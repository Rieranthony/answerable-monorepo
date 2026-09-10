import { recordAuditEvent } from "../../__tests__/audit-queries.ts";
import { createId } from "../../lib/id.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import type { AuditEvent } from "../../__tests__/audit-queries.ts";
import { routes } from "./audit-events.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
type Kind = Parameters<AdminFixture["headers"]>[0];
async function read(
  path = "/audit-events",
  query: Record<string, string> = {},
  kind: Kind = "platformAdmin",
) {
  const response = await fixture.app.request(
    `/api/admin/v1${path}?${new URLSearchParams(query)}`,
    { headers: fixture.headers(kind) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    items: (Omit<AuditEvent, "occurredAt"> & { occurredAt: string })[];
    nextCursor: string | null;
  };
}
test("staff filter all audit events and walk pages without gaps", async () => {
  await fixture.app.request("/api/admin/v1/audit-events", {
    headers: fixture.headers("tenantReader"),
  });
  const all = await read("/audit-events", { limit: "200" });
  for (const action of [
    "bootstrap.applied",
    "client.created",
    "auth.signin.succeeded",
    "admin.denied",
  ])
    expect(all.items.some((row) => row.action === action)).toBe(true);
  const target = all.items.find((row) => row.targetId !== null)!;
  for (const [query, predicate] of [
    [
      { organizationId: fixture.tenant.organizationId },
      (row: AuditEvent) => row.organizationId === fixture.tenant.organizationId,
    ],
    [
      { action: "auth.signin.succeeded" },
      (row: AuditEvent) => row.action === "auth.signin.succeeded",
    ],
    [
      { actorId: fixture.principals.tenantReader.userId },
      (row: AuditEvent) =>
        row.actorId === fixture.principals.tenantReader.userId,
    ],
    [
      {
        targetType: target.targetType,
        targetId: target.targetId!,
      },
      (row: AuditEvent) =>
        row.targetType === target.targetType &&
        row.targetId === target.targetId,
    ],
  ] as const) {
    const filtered = await read("/audit-events", query);
    expect(filtered.items).toEqual(
      all.items.filter((row) =>
        predicate({ ...row, occurredAt: new Date(row.occurredAt) }),
      ),
    );
    expect(filtered.items.length).toBeGreaterThan(0);
  }
  expect(
    (
      await read("/audit-events", {
        from: "2000-01-01T00:00:00Z",
        to: "2100-01-01T00:00:00Z",
        limit: "200",
      })
    ).items,
  ).toEqual(all.items);
  expect(
    (await read("/audit-events", { to: "2000-01-01T00:00:00Z" })).items,
  ).toEqual([]);
  expect(
    (await read("/audit-events", { from: "2100-01-01T00:00:00Z" })).items,
  ).toEqual([]);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await read("/audit-events", {
      limit: "5",
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toEqual(all.items.map((row) => row.id));
  const bearer = await fixture.mintMachineToken(["platform:read"]);
  const afterIssuance = await read("/audit-events", { limit: "200" });
  const issuance = afterIssuance.items.filter(
    (row) => !all.items.some((previous) => previous.id === row.id),
  );
  expect(issuance).toHaveLength(1);
  expect(issuance[0]).toMatchObject({
    action: "oauth.token.issued",
    actorType: "client",
    targetType: "access_token",
    targetId: decodeJwt(bearer).jti,
    outcome: "success",
  });
  expect(
    afterIssuance.items.filter((row) => row.id !== issuance[0]!.id),
  ).toEqual(all.items);
  expect(
    (await read("/audit-events", { limit: "200" }, { bearer })).items,
  ).toEqual(afterIssuance.items);
});
test("tenant readers see their sign-ins and denied attempts only", async () => {
  const org = fixture.tenant.organizationId;
  const path = `/organizations/${org}/audit-events`;
  await fixture.app.request(`/api/admin/v1/organizations/${org}`, {
    method: "PATCH",
    headers: fixture.headers("tenantReader"),
  });
  const result = await read(path, {}, "tenantReader");
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.items.every((row) => row.organizationId === org)).toBe(true);
  expect(
    result.items.some((row) => row.action === "auth.signin.succeeded"),
  ).toBe(true);
  expect(
    result.items.some(
      (row) =>
        row.action === "admin.denied" &&
        row.actorId === fixture.principals.tenantReader.userId,
    ),
  ).toBe(true);
  expect(
    (
      await fixture.app.request(
        `/api/admin/v1/organizations/${fixture.outsider.organizationId}/audit-events`,
        { headers: fixture.headers("tenantReader") },
      )
    ).status,
  ).toBe(404);
});

test("tenant audit reads recheck membership after middleware admission", async () => {
  const { members } = await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const original = fixture.db.transaction.bind(fixture.db);
  fixture.db.transaction = afterBrokerRead(original, (async (
    ...args: Parameters<typeof original>
  ) => {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, fixture.principals.tenantReader.memberId));
    return original(...args);
  }) as typeof original);
  try {
    const response = await fixture.app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/audit-events`,
      { headers: fixture.headers("tenantReader") },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "insufficient_scope" });
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, fixture.principals.tenantReader.memberId));
  }
});

test("staff read retained tenant history after erasure without opening unknown history", async () => {
  const { createOrganization } =
    await import("../../__tests__/organization-queries.ts");
  const { recordAuditEvent } = await import("../../__tests__/audit-queries.ts");
  const { organizations } = await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const { createId } = await import("../../lib/id.ts");
  const org = await createOrganization(fixture.db, {
    slug: "erased-history",
    name: "Erased",
  });
  const event = await recordAuditEvent(fixture.db, {
    actorType: "system",
    actorId: "root",
    organizationId: org.id,
    targetType: "organization",
    targetId: org.id,
    action: "history.test",
    outcome: "success",
    data: {},
  });
  await fixture.db.delete(organizations).where(eq(organizations.id, org.id));
  const path = (id: string) => `/api/admin/v1/organizations/${id}/audit-events`;
  const response = await fixture.app.request(path(org.id), {
    headers: fixture.headers("platformReader"),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(
    (await response.json()).items.map((row: { id: string }) => row.id),
  ).toContain(event.id);
  expect(
    (
      await fixture.app.request(path(createId()), {
        headers: fixture.headers("platformReader"),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fixture.app.request(path(org.id), {
        headers: fixture.headers("tenantReader"),
      })
    ).status,
  ).toBe(404);
});

test("platform audit reads reject authority revoked after middleware", async () => {
  const { members } = await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  for (const path of [
    "/audit-events",
    `/users/${fixture.principals.tenantReader.userId}/audit-events`,
  ]) {
    const original = fixture.db.transaction.bind(fixture.db);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, fixture.principals.platformReader.memberId));
      return original(...args);
    }) as typeof original);
    try {
      const response = await fixture.app.request(`/api/admin/v1${path}`, {
        headers: fixture.headers("platformReader"),
      });
      expect(response.status).toBe(403);
    } finally {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, fixture.principals.platformReader.memberId));
    }
  }
});

test("indirect global erasure history is visible to staff but not through tenant history", async () => {
  const userId = fixture.principals.tenantReader.userId;
  const row = await recordAuditEvent(fixture.db, {
    actorType: "system",
    actorId: "root",
    action: "user.erased",
    targetType: "user",
    targetId: createId(),
    outcome: "success",
    data: {
      deletedGrantContexts: [
        {
          id: createId(),
          userId,
          organizationId: fixture.tenant.organizationId,
        },
        {
          id: createId(),
          userId: fixture.principals.outsider.userId,
          organizationId: fixture.outsider.organizationId,
        },
      ],
    },
  });
  const staff = await read(`/users/${userId}/audit-events`, {
    action: "user.erased",
  });
  expect(staff.items.map((event) => event.id)).toContain(row.id);
  const tenant = await read(
    `/organizations/${fixture.tenant.organizationId}/audit-events`,
    { action: "user.erased" },
    "tenantReader",
  );
  expect(tenant.items.map((event) => event.id)).not.toContain(row.id);
  const denied = await fixture.app.request(
    `/api/admin/v1/users/${userId}/audit-events`,
    { headers: fixture.headers("tenantReader") },
  );
  expect(denied.status).toBe(403);
});
