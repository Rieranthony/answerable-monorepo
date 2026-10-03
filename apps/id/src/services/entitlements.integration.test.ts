import { platformWriteService } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createId } from "../lib/id.ts";
import {
  users,
  members,
  oauthClients,
  oauthResources,
  auditEvents,
} from "../db/schema/index.ts";
import { createGroup, addGroupMember } from "../__tests__/group-queries.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
const past = new Date("2000-01-01T00:00:00Z");
const future = new Date("2100-01-01T00:00:00Z");
async function seed() {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const ids: string[] = [];
  for (const [index, organizationId] of [
    org.id,
    org.id,
    org.id,
    other.id,
  ].entries()) {
    const userId = createId();
    const id = createId();
    await db.insert(users).values({
      id: userId,
      email: `person${index}@example.com`,
      name: `Person ${index}`,
    });
    await db.insert(members).values({
      id,
      organizationId,
      userId,
      validUntil: index === 2 ? past : null,
    });
    ids.push(id);
  }
  const group = await createGroup(db, {
    organizationId: org.id,
    slug: "team",
    name: "Team",
  });
  const foreignGroup = await createGroup(db, {
    organizationId: other.id,
    slug: "team",
    name: "Team",
  });
  await addGroupMember(db, {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  });
  const resource = "https://tutor.example";
  const clientId = "test-client";
  await db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Tutor",
    allowedScopes: ["read", "write", "admin"],
  });
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId, redirectUris: [], scopes: ["openid"] });
  return { db, org, other, ids, group, foreignGroup, resource, clientId };
}
import * as implementation from "./entitlements.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
const service = {
  ...implementation,
  createEntitlement: platformWriteService(implementation.createEntitlement),
  updateEntitlement: platformWriteService(implementation.updateEntitlement),
  disableEntitlement: platformWriteService(implementation.disableEntitlement),
  enableEntitlement: platformWriteService(implementation.enableEntitlement),
  removeEntitlement: platformWriteService(implementation.removeEntitlement),
  listEntitlements: (
    db: Database,
    org: string,
    arg1: Parameters<typeof implementation.listEntitlements>[1],
  ) =>
    inTenantRead(db, org, "directory", (context) =>
      implementation.listEntitlements(context, arg1),
    ),
  getEntitlement: (
    db: Database,
    org: string,
    arg1: Parameters<typeof implementation.getEntitlement>[1],
  ) =>
    inTenantRead(db, org, "directory", (context) =>
      implementation.getEntitlement(context, arg1),
    ),
};
import type { Actor } from "./actor.ts";
const actor: Actor = {
  actorType: "system",
  actorId: "root",
  requestId: "entitlement-test",
  ip: "192.0.2.1",
  userAgent: "test",
};
test("entitlement writes each audit once, keep immutable fields and preserve omitted windows", async () => {
  const { db, org, group, ids, resource, clientId } = await seed();
  const input = { resource, scopes: ["read"] };
  const row = await service.createEntitlement(db, actor, org.id, input);
  const grouped = await service.createEntitlement(db, actor, org.id, {
    ...input,
    groupId: group.id,
  });
  const personal = await service.createEntitlement(db, actor, org.id, {
    ...input,
    memberId: ids[0]!,
    validFrom: past,
    validUntil: future,
  });
  const client = await service.createEntitlement(db, actor, org.id, {
    clientId,
    scopes: ["openid"],
  });
  expect(await service.getEntitlement(db, org.id, row.id)).toEqual(row);
  const page = await service.listEntitlements(db, org.id, { limit: 1 });
  expect(page.items[0]!.id).toBe(client.id);
  expect(page.nextCursor).toBe(client.id);
  expect(
    (await service.listEntitlements(db, org.id, { limit: 10 })).nextCursor,
  ).toBeNull();
  expect(
    await service.updateEntitlement(db, actor, org.id, personal.id, {
      scopes: ["write"],
      validFrom: null,
    }),
  ).toMatchObject({
    changed: true,
    row: { scopes: ["write"], validFrom: null, validUntil: future },
  });
  await service.updateEntitlement(db, actor, org.id, client.id, {
    scopes: ["profile"],
  });
  await service.updateEntitlement(db, actor, org.id, row.id, {
    validUntil: future,
  });
  expect(
    await service.disableEntitlement(db, actor, org.id, grouped.id),
  ).toMatchObject({ changed: true, row: { status: "disabled" } });
  expect(
    await service.disableEntitlement(db, actor, org.id, grouped.id),
  ).toMatchObject({ changed: false, row: { status: "disabled" } });
  expect(
    await service.enableEntitlement(db, actor, org.id, grouped.id),
  ).toMatchObject({ changed: true, row: { status: "active" } });
  expect(
    await service.enableEntitlement(db, actor, org.id, grouped.id),
  ).toMatchObject({ changed: false, row: { status: "active" } });
  await service.removeEntitlement(db, actor, org.id, grouped.id);
  await expect(
    service.getEntitlement(db, org.id, grouped.id),
  ).rejects.toMatchObject({ status: 404 });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(12);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      organizationId: org.id,
      targetType: "entitlement",
      outcome: "success",
    });
  expect(events.map((event) => event.action)).toEqual([
    "entitlement.created",
    "entitlement.created",
    "entitlement.created",
    "entitlement.created",
    "entitlement.updated",
    "entitlement.updated",
    "entitlement.updated",
    "entitlement.disabled",
    "entitlement.disable_unchanged",
    "entitlement.enabled",
    "entitlement.enable_unchanged",
    "entitlement.removed",
  ]);
  for (const [index, created] of [row, grouped, personal, client].entries())
    expect(events[index]).toMatchObject({
      targetId: created.id,
      data: {
        before: null,
        after: {
          memberId: created.memberId,
          groupId: created.groupId,
          clientId: created.clientId,
          resource: created.resource,
          scopes: created.scopes,
        },
      },
    });
  expect(events[4]).toMatchObject({
    targetId: personal.id,
    data: { after: { scopes: ["write"], validFrom: null } },
  });
  expect(events[6]).toMatchObject({
    data: { after: { validUntil: future.toISOString() } },
  });
  expect(events[7]).toMatchObject({
    targetId: grouped.id,
    data: { after: { status: "disabled" } },
  });
  expect(events[9]).toMatchObject({
    targetId: grouped.id,
    data: { after: { status: "active" } },
  });
  expect(events[11]).toMatchObject({
    targetId: grouped.id,
    data: {
      before: { id: grouped.id },
      after: {
        id: grouped.id,
        deletedAt: expect.any(String),
        status: "disabled",
      },
      deletionMode: "soft",
    },
  });
});
