import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../db/queries/organizations.ts";
import { createId } from "../lib/id.ts";
import { users, members } from "../db/schema/index.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
async function seed() {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const ids: string[] = [];
  for (const [index, organizationId] of [org.id, org.id, other.id].entries()) {
    const userId = createId();
    const id = createId();
    await db.insert(users).values({
      id: userId,
      email: `person${index}@example.com`,
      name: `Person ${index}`,
    });
    await db.insert(members).values({ id, organizationId, userId });
    ids.push(id);
  }
  return { db, org, other, ids };
}
const past = new Date("2000-01-01T00:00:00Z");
const future = new Date("2100-01-01T00:00:00Z");
import {
  auditEvents,
  entitlements,
  groupMembers,
  oauthClients,
} from "../db/schema/index.ts";
import type { Actor } from "./actor.ts";
import { mapDatabaseError } from "../http/problem.ts";
const actor: Actor = {
  actorType: "user",
  actorId: createId(),
  requestId: "service-test",
  ip: "192.0.2.1",
  userAgent: "test",
};
const invalidActor = { ...actor, requestId: "\0" };
async function mapped(promise: Promise<unknown>, status: number, code: string) {
  try {
    await promise;
    throw new Error("Expected a database error");
  } catch (error) {
    expect(mapDatabaseError(error)).toMatchObject({ status, code });
  }
}
async function grant(
  organizationId: string,
  principal: { groupId: string } | { memberId: string },
) {
  const db = connection.db;
  const clientId = createId();
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId, organizationId, redirectUris: [] });
  const id = createId();
  await db
    .insert(entitlements)
    .values({ id, organizationId, clientId, scopes: ["read"], ...principal });
  return id;
}
import * as service from "./groups.ts";
import * as queries from "../db/queries/groups.ts";
test("group lifecycle and membership writes emit one attributed audit each and erasure cascades", async () => {
  const { db, org, ids } = await seed();
  const row = await service.createGroup(db, actor, org.id, {
    slug: "finance",
    name: "Finance",
  });
  expect(await service.getGroup(db, org.id, row.id)).toEqual(row);
  expect(await service.listGroups(db, org.id, { limit: 10 })).toEqual({
    items: [row],
    nextCursor: null,
  });
  expect(
    await service.updateGroup(db, actor, org.id, row.id, {
      name: "Team",
      externalId: null,
    }),
  ).toMatchObject({ name: "Team" });
  await expect(
    service.enableGroup(db, actor, org.id, row.id),
  ).rejects.toMatchObject({ code: "group_already_active", status: 409 });
  await service.disableGroup(db, actor, org.id, row.id);
  await expect(
    service.disableGroup(db, actor, org.id, row.id),
  ).rejects.toMatchObject({ code: "group_already_disabled", status: 409 });
  await service.enableGroup(db, actor, org.id, row.id);
  expect(
    (await service.putMember(db, actor, org.id, row.id, ids[0]!, {})).created,
  ).toBe(true);
  expect(
    (
      await service.putMember(db, actor, org.id, row.id, ids[0]!, {
        validFrom: past,
        validUntil: future,
      })
    ).created,
  ).toBe(false);
  expect(
    (await service.listGroupMembers(db, org.id, row.id, { limit: 1 })).items[0],
  ).toMatchObject({ memberId: ids[0], effective: true });
  await service.removeMember(db, actor, org.id, row.id, ids[0]!);
  await expect(
    service.removeMember(db, actor, org.id, row.id, ids[0]!),
  ).rejects.toMatchObject({ status: 404 });
  await service.putMember(db, actor, org.id, row.id, ids[0]!, {});
  await service.putMember(db, actor, org.id, row.id, ids[1]!, {});
  expect(
    (await service.listGroupMembers(db, org.id, row.id, { limit: 1 }))
      .nextCursor,
  ).toBe(ids[1]!);
  const grantId = await grant(org.id, { groupId: row.id });
  await expect(
    service.eraseGroup(db, actor, org.id, row.id, createId()),
  ).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
  await service.eraseGroup(db, actor, org.id, row.id, row.id);
  expect(await queries.findGroup(db, org.id, row.id)).toBeNull();
  expect(await db.select().from(groupMembers)).toEqual([]);
  expect(
    await db.select().from(entitlements).where(eq(entitlements.id, grantId)),
  ).toEqual([]);
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events.map((e) => e.action)).toEqual([
    "group.created",
    "group.updated",
    "group.disabled",
    "group.enabled",
    "group_member.added",
    "group_member.updated",
    "group_member.removed",
    "group_member.added",
    "group_member.added",
    "group.erased",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      organizationId: org.id,
      outcome: "success",
      targetType: event.action.startsWith("group_member.")
        ? "group_member"
        : "group",
      targetId: event.action.startsWith("group_member.")
        ? expect.any(String)
        : row.id,
    });
  expect(events[1]!.data).toEqual({
    changes: { name: "Team", externalId: null },
  });
  for (const event of events.filter((e) => e.targetType === "group_member"))
    expect(event.data).toEqual({ groupId: row.id });
});
test("group writes reject missing or foreign rows, managed memberships and database constraints", async () => {
  const { db, org, other, ids } = await seed();
  const row = await service.createGroup(db, actor, org.id, {
    slug: "finance",
    name: "Finance",
    externalId: "directory",
  });
  for (const input of [
    { slug: "finance", name: "Duplicate" },
    { slug: "another", name: "Duplicate", externalId: "directory" },
  ])
    await mapped(
      service.createGroup(db, actor, org.id, input),
      409,
      "conflict",
    );
  for (const organizationId of [other.id, createId()]) {
    await expect(
      service.getGroup(db, organizationId, row.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.updateGroup(db, actor, organizationId, row.id, { name: "No" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.disableGroup(db, actor, organizationId, row.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.enableGroup(db, actor, organizationId, row.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.eraseGroup(db, actor, organizationId, row.id, row.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.listGroupMembers(db, organizationId, row.id, { limit: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.putMember(db, actor, organizationId, row.id, ids[0]!, {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.removeMember(db, actor, organizationId, row.id, ids[0]!),
    ).rejects.toMatchObject({ status: 404 });
  }
  await expect(
    service.listGroups(db, createId(), { limit: 1 }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    service.createGroup(db, actor, createId(), { slug: "no", name: "No" }),
  ).rejects.toMatchObject({ status: 404 });
  for (const memberId of [ids[2]!, createId()])
    await expect(
      service.putMember(db, actor, org.id, row.id, memberId, {}),
    ).rejects.toMatchObject({ status: 404 });
  await expect(
    service.putMember(db, actor, org.id, row.id, ids[0]!, {}),
  ).rejects.toMatchObject({ status: 409, code: "group_directory_managed" });
  await expect(
    service.removeMember(db, actor, org.id, row.id, ids[0]!),
  ).rejects.toMatchObject({ status: 409, code: "group_directory_managed" });
  await service.updateGroup(db, actor, org.id, row.id, { externalId: null });
  await mapped(
    service.putMember(db, actor, org.id, row.id, ids[0]!, {
      validFrom: future,
      validUntil: past,
    }),
    400,
    "constraint_violation",
  );
  expect(await queries.findGroupMember(db, org.id, row.id, ids[0]!)).toBeNull();
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});
test("every group write rolls back when audit insertion fails", async () => {
  const { db, org, ids } = await seed();
  const input = { slug: "team", name: "Team" };
  await expect(
    service.createGroup(db, invalidActor, org.id, input),
  ).rejects.toThrow();
  expect((await service.listGroups(db, org.id, { limit: 10 })).items).toEqual(
    [],
  );
  const row = await service.createGroup(db, actor, org.id, input);
  await expect(
    service.updateGroup(db, invalidActor, org.id, row.id, { externalId: "no" }),
  ).rejects.toThrow();
  expect((await service.getGroup(db, org.id, row.id)).externalId).toBeNull();
  await expect(
    service.disableGroup(db, invalidActor, org.id, row.id),
  ).rejects.toThrow();
  expect((await service.getGroup(db, org.id, row.id)).status).toBe("active");
  await service.disableGroup(db, actor, org.id, row.id);
  await expect(
    service.enableGroup(db, invalidActor, org.id, row.id),
  ).rejects.toThrow();
  expect((await service.getGroup(db, org.id, row.id)).status).toBe("disabled");
  await expect(
    service.putMember(db, invalidActor, org.id, row.id, ids[0]!, {}),
  ).rejects.toThrow();
  expect(await queries.findGroupMember(db, org.id, row.id, ids[0]!)).toBeNull();
  await service.putMember(db, actor, org.id, row.id, ids[0]!, {});
  await expect(
    service.putMember(db, invalidActor, org.id, row.id, ids[0]!, {
      validUntil: past,
    }),
  ).rejects.toThrow();
  expect(
    (await queries.findGroupMember(db, org.id, row.id, ids[0]!))!.validUntil,
  ).toBeNull();
  await expect(
    service.removeMember(db, invalidActor, org.id, row.id, ids[0]!),
  ).rejects.toThrow();
  await expect(
    service.eraseGroup(db, invalidActor, org.id, row.id, row.id),
  ).rejects.toThrow();
  expect(
    await queries.findGroupMember(db, org.id, row.id, ids[0]!),
  ).not.toBeNull();
  expect(await service.getGroup(db, org.id, row.id)).toBeDefined();
  expect(await db.select().from(auditEvents)).toHaveLength(3);
});
