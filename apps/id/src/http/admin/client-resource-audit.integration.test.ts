import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import {
  auditEvents,
  oauthClients,
  oauthClientResources,
  oauthResources,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
const clientId = "resource-audit-client";
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_link_audit_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = { ...fixture.environment, databaseUrl: url.toString() };
  runtime = createDatabase(environment);
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, environment),
    environment,
  });
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    organizationId: fixture.tenant.organizationId,
    redirectUris: [],
  });
});
afterEach(async () => {
  await runtime?.close();
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
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
  return app.request(
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
  const response = await app.request(
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
      schemaVersion: 3,
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
        schemaVersion: 3,
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
        await app.request(
          `/api/admin/v1/resources/${encodeURIComponent(target.identifier)}?confirm=${encodeURIComponent(target.identifier)}`,
          { method: "DELETE", headers },
        )
      ).status,
    ).toBe(204);
    expect((await history("tenantReader")).items).toEqual(events);
    expect((await history("outsider")).items).toEqual([]);
  });
}

test("legacy link events remain available to staff but cannot leak through tenant filters or pagination", async () => {
  const foreign = await resource("foreign");
  const shared = await resource("shared");
  const legacy = [];
  for (const [version, action] of [0, 1, 4].flatMap(
    (version) =>
      [
        [version, "client.resource_linked"],
        [version, "client.resource_unlinked"],
        [version, "client.resource_unchanged"],
      ] as const,
  )) {
    const [event] = await fixture.db
      .insert(auditEvents)
      .values({
        id: createId(),
        schemaVersion: version,
        actorType: "system",
        actorId: "root",
        organizationId: fixture.tenant.organizationId,
        action,
        targetType: "client",
        targetId: clientId,
        outcome: "success",
        data: {
          resource: foreign.identifier,
          before: { linked: false },
          after: { linked: true },
        },
      })
      .returning();
    legacy.push(event!);
  }
  expect((await history("tenantReader")).items).toEqual([]);
  expect((await command(shared.identifier, "PUT")).status).toBe(201);
  const visible = await history("tenantReader", { limit: "1" });
  expect(visible.items).toHaveLength(1);
  expect(visible.nextCursor).toBeNull();
  expect(visible.items[0]!.schemaVersion).toBe(3);
  expect(
    (
      await history("tenantReader", {
        action: "client.resource_linked",
        cursor: visible.items[0]!.id,
      })
    ).items,
  ).toEqual([]);
  const retained = (await history("platformReader")).items;
  expect(retained).toHaveLength(legacy.length + 1);
  for (const event of legacy)
    expect(retained.find((row) => row.id === event.id)?.data).toEqual(
      event.data,
    );
});

test("unlink of an unclassified missing target stays platform-only", async () => {
  const target = "https://missing.private-resource.example";
  expect((await command(target, "DELETE")).status).toBe(204);
  expect((await history("tenantReader")).items).toEqual([]);
  expect((await history("platformReader")).items).toMatchObject([
    {
      schemaVersion: 3,
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

for (const method of ["PUT", "DELETE"] as const) {
  test(`${method} link audit failure rolls back before same-key recovery`, async () => {
    const target = await resource("foreign");
    if (method === "DELETE")
      expect((await command(target.identifier, "PUT")).status).toBe(201);
    const before = await fixture.db
      .select()
      .from(oauthClientResources)
      .where(eq(oauthClientResources.clientId, clientId));
    const key = createId();
    await fixture.db.execute(
      sql`alter table audit_events add constraint link_audit_failure check (target_id <> 'resource-audit-client') not valid`,
    );
    try {
      expect((await command(target.identifier, method, key)).status).toBe(400);
      expect(
        await fixture.db
          .select()
          .from(oauthClientResources)
          .where(eq(oauthClientResources.clientId, clientId)),
      ).toEqual(before);
    } finally {
      await fixture.db.execute(
        sql`alter table audit_events drop constraint link_audit_failure`,
      );
    }
    const recovered = await command(target.identifier, method, key);
    expect(recovered.status).toBe(method === "PUT" ? 201 : 204);
    expect(
      (await command(target.identifier, method, key)).headers.get(
        "Idempotency-Replayed",
      ),
    ).toBe("true");
    expect((await history("tenantReader")).items).toEqual([]);
  });
}
