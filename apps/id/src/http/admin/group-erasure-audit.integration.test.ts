import { withDatabaseScope } from "../../db/isolation.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import {
  adminOperations,
  auditEvents,
  entitlements,
  groupMembers,
  groups,
  members,
  auditEventSubjects,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { recordAuditEvent } from "../../db/queries/audit.ts";
let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_group_audit_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = {
    ...fixture.environment,
    databaseUrl: url.toString(),
    databasePoolMax: 4,
  };
  runtime = createDatabase(environment);
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, environment),
    environment,
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
  return app.request(
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
      .from(auditEventSubjects)
      .where(
        inArray(
          auditEventSubjects.eventId,
          fixture.db
            .select({ id: auditEvents.id })
            .from(auditEvents)
            .where(eq(auditEvents.action, "group.erased")),
        ),
      )
      .orderBy(
        auditEventSubjects.eventId,
        auditEventSubjects.entityType,
        auditEventSubjects.entityId,
        auditEventSubjects.relationship,
      ),
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
    schemaVersion: 3,
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
    state.subjects.filter(
      (row) => row.eventId === event!.id && row.entityType === "user",
    ),
  ).toEqual(
    [person.userId, fixture.principals.tenantAdmin.userId]
      .sort()
      .map((entityId) =>
        expect.objectContaining({
          entityId,
          relationship: "affected",
          organizationId: a.group.organizationId,
          provenance: "recorded",
        }),
      ),
  );
  const replay = await erase(a.group, key);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await snapshot()).toEqual(state);
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", crypto.randomUUID());
  expect(
    (
      await app.request(
        `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
        { method: "DELETE", headers },
      )
    ).status,
  ).toBe(204);
  const history = await app.request(
    `/api/admin/v1/users/${person.userId}/audit-events?action=group.erased`,
    { headers },
  );
  expect(history.status).toBe(200);
  expect((await history.json()).items).toEqual([
    JSON.parse(JSON.stringify(event)),
  ]);
});

test("group erasure audit failure restores assignments, entitlements and receipt before same-key recovery", async () => {
  const a = await seedGroup(
    fixture.tenant.organizationId,
    fixture.principals.tenantReader.memberId,
  );
  const key = crypto.randomUUID();
  const before = await snapshot();
  await fixture.db.execute(
    sql`create function fail_group_erasure_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'group.erased' then raise exception 'injected audit failure'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger fail_group_erasure_audit before insert on audit_events for each row execute function fail_group_erasure_audit()`,
  );
  try {
    expect((await erase(a.group, key)).status).toBe(500);
    expect(await snapshot()).toEqual(before);
  } finally {
    await fixture.db.execute(
      sql`drop trigger fail_group_erasure_audit on audit_events`,
    );
    await fixture.db.execute(sql`drop function fail_group_erasure_audit()`);
  }
  expect((await erase(a.group, key)).status).toBe(204);
  const after = await snapshot();
  expect(after.operations.length).toBe(before.operations.length + 1);
  expect(
    after.events.filter((row) => row.action === "group.erased"),
  ).toHaveLength(1);
});

test("group erasure user indexing accepts only its versioned tenant-bound effect contract", async () => {
  const userId = createId(),
    organizationId = createId(),
    groupId = createId();
  const assignment = { userId, organizationId, groupId };
  const base = {
    schemaVersion: 2 as const,
    actorType: "system" as const,
    actorId: "test",
    action: "group.erased",
    targetType: "group",
    targetId: groupId,
    organizationId,
    outcome: "success" as const,
    data: {
      effects: {
        removedAssignments: [
          assignment,
          assignment,
          null,
          "bad",
          { userId: "" },
          { ...assignment, organizationId: createId() },
          { ...assignment, groupId: createId() },
        ],
      },
    },
  };
  const valid = await recordAuditEvent(runtime.db, base);
  for (const patch of [
    { schemaVersion: 1 as const },
    { action: "group.disabled" },
    { targetType: "organization" },
    { outcome: "failure" as const },
    { organizationId: null },
    { targetId: null },
    { data: { effects: { removedAssignments: { userId } } } },
    {
      data: {
        effects: {
          removedAssignments: [{ userId: 42, organizationId, groupId }],
        },
      },
    },
  ])
    await recordAuditEvent(runtime.db, { ...base, ...patch });
  const rows = await withDatabaseScope(
    runtime.db,
    { kind: "platform", access: "read" },
    (tx) =>
      tx
        .select()
        .from(auditEventSubjects)
        .where(eq(auditEventSubjects.entityId, userId)),
  );
  expect(rows).toEqual([
    expect.objectContaining({
      eventId: valid.id,
      entityType: "user",
      relationship: "affected",
      organizationId,
      provenance: "recorded",
    }),
  ]);
});

for (const order of ["assignment-first", "user-first"] as const) {
  test(`assignment removal history and global user erasure are ordered: ${order}`, async () => {
    const person = fixture.principals.tenantReader;
    const a = await seedGroup(fixture.tenant.organizationId, person.memberId);
    const auditAction =
      order === "assignment-first" ? "group_member.removed" : "user.erased";
    const gateKey = Math.floor(Math.random() * 1_000_000_000);
    await fixture.db.execute(
      sql.raw(
        `create function pause_assignment_history() returns trigger language plpgsql as $$ begin if NEW.action = '${auditAction}' then perform pg_advisory_xact_lock(${gateKey}); end if; return NEW; end $$`,
      ),
    );
    await fixture.db.execute(
      sql`create trigger pause_assignment_history before insert on audit_events for each row execute function pause_assignment_history()`,
    );
    let entered!: () => void;
    let release!: () => void;
    let blockerPid = 0;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = fixture.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${gateKey})`);
      blockerPid = Number(
        (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      entered();
      await resume;
    });
    const assignmentHeaders = fixture.headers("root");
    assignmentHeaders.set("Idempotency-Key", crypto.randomUUID());
    const userHeaders = fixture.headers("root");
    userHeaders.set("Idempotency-Key", crypto.randomUUID());
    const removeAssignment = () =>
      app.request(
        `/api/admin/v1/organizations/${a.group.organizationId}/groups/${a.group.id}/members/${person.memberId}`,
        { method: "DELETE", headers: assignmentHeaders },
      );
    const eraseUser = () =>
      app.request(
        `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
        { method: "DELETE", headers: userHeaders },
      );
    async function waitingOn(pid: number) {
      const deadline = Date.now() + 1500;
      while (true) {
        const waiting = await runtime.db.execute(
          sql`select pid from pg_stat_activity where usename = ${role} and ${pid} = any(pg_blocking_pids(pid))`,
        );
        if (waiting.rows.length) return Number(waiting.rows[0]!.pid);
        if (Date.now() > deadline)
          throw new Error("Expected command did not reach its database lock");
        await Bun.sleep(10);
      }
    }
    let first: ReturnType<typeof app.request> | undefined;
    let second: ReturnType<typeof app.request> | undefined;
    await held;
    try {
      first = order === "assignment-first" ? removeAssignment() : eraseUser();
      const firstPid = await waitingOn(blockerPid);
      second = order === "assignment-first" ? eraseUser() : removeAssignment();
      await waitingOn(firstPid);
    } finally {
      release();
      await blocker;
      // Finish both real requests before removing the test barrier or closing pools.
      await Promise.allSettled([first, second]);
      await fixture.db.execute(
        sql`drop trigger pause_assignment_history on audit_events`,
      );
      await fixture.db.execute(sql`drop function pause_assignment_history()`);
    }
    const firstResponse = await first!;
    const secondResponse = await second!;
    expect(firstResponse.status).toBe(204);
    expect(secondResponse.status).toBe(
      order === "assignment-first" ? 204 : 404,
    );
    const history = await app.request(
      `/api/admin/v1/users/${person.userId}/audit-events?action=group_member.removed`,
      { headers: fixture.headers("root") },
    );
    if (order === "assignment-first") {
      expect(history.status).toBe(200);
      const items = (await history.json()).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        action: "group_member.removed",
        schemaVersion: 3,
        organizationId: a.group.organizationId,
        targetId: person.memberId,
        data: {
          groupId: a.group.id,
          before: { id: a.assignment.id },
          after: { deletedAt: expect.any(String) },
        },
      });
      const references = await withDatabaseScope(
        runtime.db,
        { kind: "platform", access: "read" },
        (tx) =>
          tx
            .select()
            .from(auditEventSubjects)
            .where(eq(auditEventSubjects.eventId, items[0].id)),
      );
      expect(references).toContainEqual(
        expect.objectContaining({
          entityType: "user",
          entityId: person.userId,
          relationship: "affected",
          provenance: "recorded",
        }),
      );
      const replay = await removeAssignment();
      expect(replay.status).toBe(204);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    } else {
      expect(history.status).toBe(200);
      expect((await history.json()).items).toEqual([]);
      expect((await removeAssignment()).status).toBe(404);
      expect(
        await withDatabaseScope(
          runtime.db,
          { kind: "platform", access: "read" },
          (tx) =>
            tx
              .select()
              .from(auditEvents)
              .where(eq(auditEvents.action, "group_member.removed")),
        ),
      ).toEqual([]);
    }
  });
}

async function statusGroup(
  group: { id: string; organizationId: string },
  status: "enable" | "disable",
  key = crypto.randomUUID(),
) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return app.request(
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
      schemaVersion: 2,
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
    expect(await replay.json()).toEqual(await response.json());
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
      await app.request(
        `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
        { method: "DELETE", headers },
      )
    ).status,
  ).toBe(204);
  for (const event of events) {
    const history = await app.request(
      `/api/admin/v1/users/${person.userId}/audit-events?action=${event.action}`,
      { headers },
    );
    expect(history.status).toBe(200);
    expect((await history.json()).items).toEqual([
      JSON.parse(JSON.stringify(event)),
    ]);
  }
});
for (const order of ["status-first", "user-first"] as const) {
  test(`group status history and global user erasure are ordered: ${order}`, async () => {
    const person = fixture.principals.tenantReader;
    const a = await seedGroup(fixture.tenant.organizationId, person.memberId);
    const auditAction =
      order === "status-first" ? "group.disabled" : "user.erased";
    const gateKey = Math.floor(Math.random() * 1_000_000_000);
    await fixture.db.execute(
      sql.raw(
        `create function pause_group_status_history() returns trigger language plpgsql as $$ begin if NEW.action = '${auditAction}' then perform pg_advisory_xact_lock(${gateKey}); end if; return NEW; end $$`,
      ),
    );
    await fixture.db.execute(
      sql`create trigger pause_group_status_history before insert on audit_events for each row execute function pause_group_status_history()`,
    );
    let entered!: () => void;
    let release!: () => void;
    let blockerPid = 0;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = fixture.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${gateKey})`);
      blockerPid = Number(
        (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      entered();
      await resume;
    });
    const assignmentHeaders = fixture.headers("root");
    assignmentHeaders.set("Idempotency-Key", crypto.randomUUID());
    const userHeaders = fixture.headers("root");
    userHeaders.set("Idempotency-Key", crypto.randomUUID());
    const disableGroup = () =>
      app.request(
        `/api/admin/v1/organizations/${a.group.organizationId}/groups/${a.group.id}/disable`,
        { method: "POST", headers: assignmentHeaders },
      );
    const eraseUser = () =>
      app.request(
        `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
        { method: "DELETE", headers: userHeaders },
      );
    async function waitingOn(pid: number) {
      const deadline = Date.now() + 1500;
      while (true) {
        const waiting = await runtime.db.execute(
          sql`select pid from pg_stat_activity where usename = ${role} and ${pid} = any(pg_blocking_pids(pid))`,
        );
        if (waiting.rows.length) return Number(waiting.rows[0]!.pid);
        if (Date.now() > deadline)
          throw new Error("Expected command did not reach its database lock");
        await Bun.sleep(10);
      }
    }
    let first: ReturnType<typeof app.request> | undefined;
    let second: ReturnType<typeof app.request> | undefined;
    await held;
    try {
      first = order === "status-first" ? disableGroup() : eraseUser();
      const firstPid = await waitingOn(blockerPid);
      second = order === "status-first" ? eraseUser() : disableGroup();
      await waitingOn(firstPid);
    } finally {
      release();
      await blocker;
      // Finish both real requests before removing the test barrier or closing pools.
      await Promise.allSettled([first, second]);
      await fixture.db.execute(
        sql`drop trigger pause_group_status_history on audit_events`,
      );
      await fixture.db.execute(sql`drop function pause_group_status_history()`);
    }
    const firstResponse = await first!;
    const secondResponse = await second!;
    expect(firstResponse.status).toBe(order === "status-first" ? 200 : 204);
    expect(secondResponse.status).toBe(order === "status-first" ? 204 : 200);
    const history = await app.request(
      `/api/admin/v1/users/${person.userId}/audit-events?action=group.disabled`,
      { headers: fixture.headers("root") },
    );
    if (order === "status-first") {
      expect(history.status).toBe(200);
      const items = (await history.json()).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        action: "group.disabled",
        schemaVersion: 2,
        organizationId: a.group.organizationId,
        targetId: a.group.id,
        data: {
          before: { status: "active" },
          after: { status: "disabled" },
          policySources: {
            assignments: [
              expect.objectContaining({
                id: a.assignment.id,
                userId: person.userId,
              }),
            ],
          },
        },
      });
      const references = await withDatabaseScope(
        runtime.db,
        { kind: "platform", access: "read" },
        (tx) =>
          tx
            .select()
            .from(auditEventSubjects)
            .where(eq(auditEventSubjects.eventId, items[0].id)),
      );
      expect(references).toContainEqual(
        expect.objectContaining({
          entityType: "user",
          entityId: person.userId,
          relationship: "affected",
          provenance: "recorded",
        }),
      );
      const replay = await disableGroup();
      expect(replay.status).toBe(200);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    } else {
      expect(history.status).toBe(200);
      expect((await history.json()).items).toEqual([]);
      const [event] = await withDatabaseScope(
        runtime.db,
        { kind: "platform", access: "read" },
        (tx) =>
          tx
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.action, "group.disabled")),
      );
      expect(event!.data!.policySources).toMatchObject({ assignments: [] });
      const replay = await disableGroup();
      expect(replay.status).toBe(200);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    }
  });
}

test("group status subject failure rolls back status and receipt before same-key recovery", async () => {
  const a = await seedGroup(
    fixture.tenant.organizationId,
    fixture.principals.tenantReader.memberId,
  );
  const before = await snapshot();
  const key = crypto.randomUUID();
  await fixture.db.execute(
    sql`create function reject_status_subject() returns trigger language plpgsql as $$ begin if NEW.relationship = 'affected' then raise exception 'test subject failure'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger reject_status_subject before insert on audit_event_subjects for each row execute function reject_status_subject()`,
  );
  try {
    expect((await statusGroup(a.group, "disable", key)).status).toBe(500);
  } finally {
    await fixture.db.execute(
      sql`drop trigger reject_status_subject on audit_event_subjects`,
    );
    await fixture.db.execute(sql`drop function reject_status_subject()`);
  }
  expect(await snapshot()).toEqual(before);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "group.disabled")),
  ).toEqual([]);
  expect((await statusGroup(a.group, "disable", key)).status).toBe(200);
});

test("group status subjects accept only matching versioned tenant/group source records", async () => {
  const userId = createId(),
    organizationId = createId(),
    groupId = createId();
  const assignment = { userId, organizationId, groupId };
  const base = {
    schemaVersion: 2 as const,
    actorType: "system" as const,
    actorId: "test",
    organizationId,
    targetId: groupId,
    targetType: "group",
    action: "group.disabled",
    outcome: "success" as const,
    data: {
      policySources: {
        assignments: [
          assignment,
          assignment,
          { ...assignment, groupId: createId() },
          { ...assignment, organizationId: createId() },
          null,
          { userId: 42 },
        ],
      },
    },
  };
  const valid = await recordAuditEvent(runtime.db, base);
  for (const patch of [
    { schemaVersion: 1 as const },
    { outcome: "failure" as const },
    { action: "group.disable_unchanged" },
    { targetType: "other" },
    { targetId: null },
    { organizationId: null },
    { data: { policySources: { assignments: assignment } } },
  ])
    await recordAuditEvent(runtime.db, { ...base, ...patch });
  const references = await withDatabaseScope(
    runtime.db,
    { kind: "platform", access: "read" },
    (tx) =>
      tx
        .select()
        .from(auditEventSubjects)
        .where(eq(auditEventSubjects.entityId, userId)),
  );
  expect(references).toEqual([
    expect.objectContaining({
      eventId: valid.id,
      entityType: "user",
      relationship: "affected",
      organizationId,
      provenance: "recorded",
    }),
  ]);
});
