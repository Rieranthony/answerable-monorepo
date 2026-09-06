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
import * as service from "./members.ts";
import { createGroup, addGroupMember } from "../db/queries/groups.ts";
test("member windows and removal audit, cascade grants and memberships, and retain users", async () => {
  const { db, org, ids } = await seed();
  const row = await service.getMember(db, org.id, ids[0]!);
  expect((await service.listMembers(db, org.id, { limit: 1 })).nextCursor).toBe(
    ids[1]!,
  );
  expect(
    await service.updateWindow(db, actor, org.id, ids[0]!, {
      validFrom: past,
      validUntil: future,
    }),
  ).toMatchObject({ effective: true });
  const group = await createGroup(db, {
    organizationId: org.id,
    slug: "team",
    name: "Team",
  });
  await addGroupMember(db, {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  });
  const grantId = await grant(org.id, { memberId: ids[0]! });
  await service.remove(db, actor, org.id, ids[0]!);
  expect(await db.select().from(groupMembers)).toEqual([]);
  expect(
    await db.select().from(entitlements).where(eq(entitlements.id, grantId)),
  ).toEqual([]);
  expect(
    await db.select().from(users).where(eq(users.id, row.userId)),
  ).toHaveLength(1);
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(2);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      organizationId: org.id,
      targetType: "member",
      targetId: ids[0],
      outcome: "success",
    });
  expect(events[0]).toMatchObject({
    action: "member.updated",
    data: {
      changes: {
        validFrom: past.toISOString(),
        validUntil: future.toISOString(),
      },
    },
  });
  expect(events[1]).toMatchObject({
    action: "member.removed",
    data: { userId: row.userId },
  });
});
test("member missing rows, CHECK failures and audit failures leave no writes", async () => {
  const { db, org, other, ids } = await seed();
  for (const organizationId of [other.id, createId()]) {
    await expect(
      service.getMember(db, organizationId, ids[0]!),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.updateWindow(db, actor, organizationId, ids[0]!, {
        validUntil: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.remove(db, actor, organizationId, ids[0]!),
    ).rejects.toMatchObject({ status: 404 });
  }
  await expect(
    service.listMembers(db, createId(), { limit: 1 }),
  ).rejects.toMatchObject({ status: 404 });
  await mapped(
    service.updateWindow(db, actor, org.id, ids[0]!, {
      validFrom: future,
      validUntil: past,
    }),
    400,
    "constraint_violation",
  );
  await expect(
    service.updateWindow(db, invalidActor, org.id, ids[0]!, {
      validUntil: past,
    }),
  ).rejects.toThrow();
  await expect(
    service.remove(db, invalidActor, org.id, ids[0]!),
  ).rejects.toThrow();
  expect(await service.getMember(db, org.id, ids[0]!)).toMatchObject({
    validUntil: null,
  });
  expect(await db.select().from(auditEvents)).toEqual([]);
});
