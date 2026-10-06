import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import {
  adminOperations,
  auditEvents,
  auditEventUsers,
  entitlements,
  groupMembers,
  groups,
  members,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 4 },
    { restrictedRole: true },
  );
});
afterEach(async () => {
  await fixture?.close();
});

async function seedGroup(organizationId: string, memberId: string) {
  const [group] = await fixture.db
    .insert(groups)
    .values({
      id: createId(),
      organizationId,
      slug: "audit-cascade",
      name: "Audit cascade",
    })
    .returning();
  const [assignment] = await fixture.db
    .insert(groupMembers)
    .values({
      id: createId(),
      organizationId,
      groupId: group!.id,
      memberId,
      validUntil: new Date("2000-01-01"),
    })
    .returning();
  const grants = await fixture.db
    .insert(entitlements)
    .values([
      {
        id: createId(),
        organizationId,
        groupId: group!.id,
        clientId: "answerable-bootstrap",
        scopes: ["org:read"],
      },
      {
        id: createId(),
        organizationId,
        groupId: group!.id,
        resource: fixture.platform.adminResource,
        scopes: ["org:read"],
        status: "disabled" as const,
      },
      {
        id: createId(),
        organizationId,
        groupId: group!.id,
        clientId: "answerable-bootstrap",
        resource: fixture.platform.adminResource,
        scopes: ["org:read"],
        validFrom: new Date("2100-01-01"),
      },
    ])
    .returning();
  return { group: group!, assignment: assignment!, grants };
}
function erase(group: { id: string; organizationId: string }, key: string) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return fixture.app.request(
    `/api/admin/v1/organizations/${group.organizationId}/groups/${group.id}?confirm=${group.id}`,
    { method: "DELETE", headers },
  );
}
async function snapshot() {
  return {
    groups: await fixture.db.select().from(groups).orderBy(groups.id),
    assignments: await fixture.db
      .select()
      .from(groupMembers)
      .orderBy(groupMembers.id),
    entitlements: await fixture.db
      .select()
      .from(entitlements)
      .orderBy(entitlements.id),
    events: await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "group.erased"))
      .orderBy(auditEvents.id),
    subjects: await fixture.db
      .select()
      .from(auditEventUsers)
      .where(
        inArray(
          auditEventUsers.eventId,
          fixture.db
            .select({ id: auditEvents.id })
            .from(auditEvents)
            .where(eq(auditEvents.action, "group.erased")),
        ),
      )
      .orderBy(auditEventUsers.eventId, auditEventUsers.userId),
    operations: await fixture.db
      .select()
      .from(adminOperations)
      .orderBy(adminOperations.id),
  };
}

test("group erasure records actual removed policy rows, preserves another tenant and survives user erasure", async () => {
  const person = fixture.principals.tenantReader;
  const [otherMember] = await fixture.db
    .insert(members)
    .values({
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      userId: person.userId,
    })
    .returning();
  const a = await seedGroup(fixture.tenant.organizationId, person.memberId);
  const b = await seedGroup(fixture.outsider.organizationId, otherMember!.id);
  const [live] = await fixture.db
    .insert(groupMembers)
    .values({
      id: createId(),
      organizationId: a.group.organizationId,
      groupId: a.group.id,
      memberId: fixture.principals.tenantAdmin.memberId,
    })
    .returning();
  const key = crypto.randomUUID();
  const response = await erase(a.group, key);
  expect(response.status).toBe(204);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  expect(structuredClone(event)).toMatchObject({
    action: "group.erased",
    schemaVersion: 1,
    organizationId: a.group.organizationId,
    targetId: a.group.id,
    data: {
      before: { id: a.group.id },
      after: { deletedAt: expect.any(String) },
    },
  });
  const effects = event!.data!.effects as {
    softDeletedAssignments: Record<string, unknown>[];
    softDeletedEntitlements: Record<string, unknown>[];
  };
  expect(effects.softDeletedAssignments).toEqual(
    [
      { ...a.assignment, userId: person.userId },
      { ...live!, userId: fixture.principals.tenantAdmin.userId },
    ]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((row) => ({
        id: row.id,
        revision: row.revision + 1,
        deletedAt: expect.any(String),
        organizationId: row.organizationId,
        groupId: row.groupId,
        memberId: row.memberId,
        userId: row.userId,
        validFrom: row.validFrom?.toISOString() ?? null,
        validUntil: row.validUntil?.toISOString() ?? null,
      })),
  );
  expect(effects.softDeletedEntitlements).toEqual(
    a.grants
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((row) => ({
        id: row.id,
        revision: row.revision + 1,
        deletedAt: expect.any(String),
        organizationId: row.organizationId,
        groupId: row.groupId,
        memberId: row.memberId,
        clientId: row.clientId,
        resource: row.resource,
        scopes: row.scopes,
        status: "disabled",
        validFrom: row.validFrom?.toISOString() ?? null,
        validUntil: row.validUntil?.toISOString() ?? null,
      })),
  );
  const state = await snapshot();
  expect(state.assignments.filter((row) => row.groupId === a.group.id)).toEqual(
    [a.assignment, live!]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((row) => ({
        ...row,
        revision: row.revision + 1,
        deletedAt: expect.any(Date),
        live: null,
      })),
  );
  expect(
    state.entitlements.filter((row) => row.groupId === a.group.id),
  ).toEqual(
    a.grants
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((row) => ({
        ...row,
        status: "disabled",
        revision: row.revision + 1,
        deletedAt: expect.any(Date),
        live: null,
        updatedAt: expect.any(Date),
      })),
  );
  expect(state.assignments.filter((row) => row.groupId === b.group.id)).toEqual(
    [b.assignment],
  );
  expect(
    state.entitlements.filter((row) => row.groupId === b.group.id),
  ).toEqual(b.grants.sort((x, y) => x.id.localeCompare(y.id)));
  expect(
    state.subjects
      .filter((row) => row.eventId === event!.id)
      .map((row) => row.userId),
  ).toEqual([person.userId, fixture.principals.tenantAdmin.userId].sort());
  const replay = await erase(a.group, key);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await snapshot()).toEqual(state);
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", crypto.randomUUID());
  expect(
    (
      await fixture.app.request(
        `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
        { method: "DELETE", headers },
      )
    ).status,
  ).toBe(204);
  const history = await fixture.app.request(
    `/api/admin/v1/users/${person.userId}/audit-events?action=group.erased`,
    { headers },
  );
  expect(history.status).toBe(200);
  expect((await history.json()).items).toEqual([
    JSON.parse(JSON.stringify(event)),
  ]);
});

async function statusGroup(
  group: { id: string; organizationId: string },
  status: "enable" | "disable",
  key = crypto.randomUUID(),
) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return fixture.app.request(
    `/api/admin/v1/organizations/${group.organizationId}/groups/${group.id}/${status}`,
    { method: "POST", headers },
  );
}

test("group status changes retain their policy sources and affected users after erasure", async () => {
  const person = fixture.principals.tenantReader;
  const [otherMember] = await fixture.db
    .insert(members)
    .values({
      id: createId(),
      userId: person.userId,
      organizationId: fixture.outsider.organizationId,
    })
    .returning();
  const a = await seedGroup(fixture.tenant.organizationId, person.memberId);
  const b = await seedGroup(fixture.outsider.organizationId, otherMember!.id);
  const [live] = await fixture.db
    .insert(groupMembers)
    .values({
      id: createId(),
      organizationId: a.group.organizationId,
      groupId: a.group.id,
      memberId: fixture.principals.tenantAdmin.memberId,
    })
    .returning();
  const before = await snapshot();
  const events = [];
  for (const status of ["disable", "enable"] as const) {
    const key = crypto.randomUUID();
    const response = await statusGroup(a.group, status, key);
    expect(response.status).toBe(200);
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        eq(auditEvents.operationId, response.headers.get("Operation-Id")!),
      );
    expect(event).toMatchObject({
      schemaVersion: 1,
      action: status === "disable" ? "group.disabled" : "group.enabled",
      data: {
        before: { status: status === "disable" ? "active" : "disabled" },
        after: { status: status === "disable" ? "disabled" : "active" },
      },
    });
    const sources = event!.data!.policySources as {
      assignments: Record<string, unknown>[];
      entitlements: Record<string, unknown>[];
    };
    expect(sources.assignments).toEqual(
      [
        { ...a.assignment, userId: person.userId },
        { ...live!, userId: fixture.principals.tenantAdmin.userId },
      ]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((row) => ({
          id: row.id,
          revision: row.revision,
          organizationId: row.organizationId,
          groupId: row.groupId,
          memberId: row.memberId,
          userId: row.userId,
          validFrom: row.validFrom?.toISOString() ?? null,
          validUntil: row.validUntil?.toISOString() ?? null,
        })),
    );
    expect(sources.entitlements).toEqual(
      a.grants
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((row) => ({
          id: row.id,
          revision: row.revision,
          organizationId: row.organizationId,
          groupId: row.groupId,
          memberId: row.memberId,
          clientId: row.clientId,
          resource: row.resource,
          scopes: row.scopes,
          status: row.status,
          validFrom: row.validFrom?.toISOString() ?? null,
          validUntil: row.validUntil?.toISOString() ?? null,
        })),
    );
    const replay = await statusGroup(a.group, status, key);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expectReceipt(fixture.db, replay);
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, event!.operationId!)),
    ).toHaveLength(1);
    const noop = await statusGroup(a.group, status);
    expect(noop.status).toBe(200);
    const [unchanged] = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, noop.headers.get("Operation-Id")!));
    expect(unchanged!.schemaVersion).toBe(1);
    expect(unchanged!.data!.policySources).toBeUndefined();
    events.push(event!);
  }
  const after = await snapshot();
  expect(after.assignments).toEqual(before.assignments);
  expect(after.entitlements).toEqual(before.entitlements);
  expect(after.groups.find((row) => row.id === b.group.id)).toEqual(b.group);
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", crypto.randomUUID());
  expect(
    (
      await fixture.app.request(
        `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
        { method: "DELETE", headers },
      )
    ).status,
  ).toBe(204);
  for (const event of events) {
    const history = await fixture.app.request(
      `/api/admin/v1/users/${person.userId}/audit-events?action=${event.action}`,
      { headers },
    );
    expect(history.status).toBe(200);
    expect((await history.json()).items).toEqual([
      JSON.parse(JSON.stringify(event)),
    ]);
  }
});
