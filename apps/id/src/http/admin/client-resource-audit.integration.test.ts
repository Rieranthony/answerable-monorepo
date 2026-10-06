import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  auditEvents,
  oauthClients,
  oauthResources,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
const clientId = "resource-audit-client";
beforeEach(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    organizationId: fixture.tenant.organizationId,
    redirectUris: [],
  });
});
afterEach(async () => {
  await fixture?.close();
});
async function resource(kind: "shared" | "own" | "foreign") {
  const [row] = await fixture.db
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier: `https://${kind}.private-resource.example`,
      name: `${kind} resource`,
      allowedScopes: ["read"],
      classification: kind === "shared" ? "platform_shared" : "tenant_owned",
      organizationId:
        kind === "shared"
          ? null
          : kind === "own"
            ? fixture.tenant.organizationId
            : fixture.outsider.organizationId,
    })
    .returning();
  return row!;
}
function command(target: string, method: "PUT" | "DELETE", key = createId()) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return fixture.app.request(
    `/api/admin/v1/clients/${clientId}/resources/${encodeURIComponent(target)}`,
    { method, headers },
  );
}
async function history(
  kind: "tenantReader" | "outsider" | "platformReader",
  query: Record<string, string> = {},
) {
  const path =
    kind === "platformReader"
      ? "/audit-events"
      : `/organizations/${kind === "outsider" ? fixture.outsider.organizationId : fixture.tenant.organizationId}/audit-events`;
  const response = await fixture.app.request(
    `/api/admin/v1${path}?${new URLSearchParams({ targetType: "client", targetId: clientId, limit: "200", ...query })}`,
    { headers: fixture.headers(kind) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    items: (typeof auditEvents.$inferSelect)[];
    nextCursor: string | null;
  };
}

test("private foreign link evidence is platform-only for creation, no-op, unlink and replay", async () => {
  const target = await resource("foreign");
  for (const [method, expected] of [
    ["PUT", 201],
    ["PUT", 200],
    ["DELETE", 204],
    ["DELETE", 204],
  ] as const) {
    const key = createId();
    const response = await command(target.identifier, method, key);
    expect(response.status).toBe(expected);
    // Check the real tenant disclosure before asserting the new event format.
    expect((await history("tenantReader")).items).toEqual([]);
    expect((await history("outsider")).items).toEqual([]);
    const staff = await history("platformReader");
    const event = staff.items.find(
      (row) => row.operationId === response.headers.get("Operation-Id"),
    )!;
    expect(event).toMatchObject({
      schemaVersion: 1,
      organizationId: null,
      data: {
        resource: target.identifier,
        resourceInstanceId: target.id,
        resourceClassification: "tenant_owned",
        resourceOrganizationId: fixture.outsider.organizationId,
      },
    });
    const replay = await command(target.identifier, method, key);
    expect(replay.status).toBe(expected);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await history("platformReader")).items).toHaveLength(
      staff.items.length,
    );
  }
});

for (const kind of ["shared", "own"] as const) {
  test(`${kind} resource link evidence stays visible after unlink and resource erasure`, async () => {
    const target = await resource(kind);
    expect((await command(target.identifier, "PUT")).status).toBe(201);
    expect((await command(target.identifier, "DELETE")).status).toBe(204);
    const events = (await history("tenantReader")).items;
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(event).toMatchObject({
        schemaVersion: 1,
        organizationId: fixture.tenant.organizationId,
        data: {
          resourceInstanceId: target.id,
          resourceClassification: target.classification,
          resourceOrganizationId: target.organizationId,
        },
      });
    const headers = fixture.headers("root");
    headers.set("Idempotency-Key", createId());
    expect(
      (
        await fixture.app.request(
          `/api/admin/v1/resources/${encodeURIComponent(target.identifier)}?confirm=${encodeURIComponent(target.identifier)}`,
          { method: "DELETE", headers },
        )
      ).status,
    ).toBe(204);
    expect((await history("tenantReader")).items).toEqual(events);
    expect((await history("outsider")).items).toEqual([]);
  });
}

test("unlink of an unclassified missing target stays platform-only", async () => {
  const target = "https://missing.private-resource.example";
  expect((await command(target, "DELETE")).status).toBe(204);
  expect((await history("tenantReader")).items).toEqual([]);
  expect((await history("platformReader")).items).toMatchObject([
    {
      schemaVersion: 1,
      organizationId: null,
      action: "client.resource_unchanged",
      data: {
        resource: target,
        resourceInstanceId: null,
        resourceClassification: null,
        resourceOrganizationId: null,
      },
    },
  ]);
});
