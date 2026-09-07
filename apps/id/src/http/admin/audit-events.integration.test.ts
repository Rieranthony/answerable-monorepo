import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import type { AuditEvent } from "../../db/queries/audit.ts";
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
      { organization: fixture.tenant.organizationId },
      (row: AuditEvent) => row.organizationId === fixture.tenant.organizationId,
    ],
    [
      { action: "auth.signin.succeeded" },
      (row: AuditEvent) => row.action === "auth.signin.succeeded",
    ],
    [
      { actor: fixture.principals.tenantReader.userId },
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
  expect(
    (
      await read(
        "/audit-events",
        { limit: "200" },
        { bearer: await fixture.mintMachineToken(["platform:read"]) },
      )
    ).items,
  ).toEqual(all.items);
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
