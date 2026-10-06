import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { inPlatformRead } from "../../__tests__/platform-context.ts";
import * as productionAuditQueries from "./audit.ts";

import {
  listAuditEvents,
  listUserAuditEvents,
  recordAuditEvent,
  type AuditEventFilters,
  type AuditEventInput,
} from "../../__tests__/audit-queries.ts";
import { isUuidV7, testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import {
  auditEvents,
  auditEventUsers,
  organizations,
} from "../schema/index.ts";

let connection: DatabaseConnection;
const event: AuditEventInput = {
  actorType: "user",
  actorId: "administrator",
  action: "organization.updated",
  targetType: "organization",
  outcome: "success",
};

beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

async function insertOrganization(slug: string) {
  const [row] = await connection.db
    .insert(organizations)
    .values({
      id: createId(),
      name: slug,
      slug,
    })
    .returning();
  return row!;
}

test("round-trips JSON data and optional fields inside a transaction", async () => {
  const organization = await insertOrganization("first");
  const input: AuditEventInput = {
    ...event,
    organizationId: organization.id,
    targetId: organization.id,
    reason: "Rename requested",
    requestId: "request-1",
    ip: "192.0.2.1",
    userAgent: "admin-cli",
    data: {
      before: { name: "Old" },
      after: { name: "New" },
      tags: ["admin"],
      enabled: true,
    },
  };
  const row = await inPlatformRead(connection.db, async (context) => {
    const tx = context.tx;
    const recorded = await recordAuditEvent(tx, input);
    expect(
      (await productionAuditQueries.listAuditEvents(context, {}, { limit: 10 }))
        .items,
    ).toEqual([recorded]);
    return recorded;
  });
  expect(isUuidV7(row.id)).toBe(true);
  expect(row.occurredAt).toBeInstanceOf(Date);
  expect(row).toMatchObject(input);
  expect(await connection.db.select().from(auditEvents)).toEqual([row]);
  const graph = await connection.db.query.organizations.findFirst({
    where: eq(organizations.id, organization.id),
    with: { auditEvents: true },
  });
  expect(graph?.auditEvents).toEqual([row]);
  const auditGraph = await connection.db.query.auditEvents.findFirst({
    where: eq(auditEvents.id, row.id),
    with: { organization: true },
  });
  expect(auditGraph?.organization?.id).toBe(organization.id);

  for (const optionals of [
    {},
    {
      organizationId: null,
      targetId: null,
      reason: null,
      requestId: null,
      ip: null,
      userAgent: null,
      data: null,
    },
  ]) {
    const minimal = await recordAuditEvent(connection.db, {
      ...event,
      ...optionals,
    });
    expect(minimal).toEqual({
      ...event,
      id: minimal.id,
      occurredAt: minimal.occurredAt,
      schemaVersion: 1,
      operationId: null,
      organizationId: null,
      targetId: null,
      reason: null,
      requestId: null,
      ip: null,
      userAgent: null,
      data: null,
    });
  }
});

test("lists newest first and walks five rows without gaps or repeats", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push((await recordAuditEvent(connection.db, event)).id);
  }
  const expected = ids.sort().reverse();
  const all = await listAuditEvents(connection.db, {}, { limit: 5 });
  expect(all.items.map((row) => row.id)).toEqual(expected);
  expect(all.nextCursor).toBeNull();
  const first = await listAuditEvents(connection.db, {}, { limit: 2 });
  expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 2));
  expect(first.nextCursor).toBe(expected[1]!);
  const second = await listAuditEvents(
    connection.db,
    {},
    { cursor: first.nextCursor!, limit: 2 },
  );
  expect(second.items.map((row) => row.id)).toEqual(expected.slice(2, 4));
  expect(second.nextCursor).toBe(expected[3]!);
  const third = await listAuditEvents(
    connection.db,
    {},
    { cursor: second.nextCursor!, limit: 2 },
  );
  expect(third.items.map((row) => row.id)).toEqual(expected.slice(4));
  expect(third.nextCursor).toBeNull();
});

test("narrows each filter and combines filters", async () => {
  const first = await insertOrganization("first");
  const second = await insertOrganization("second");
  const rows = await connection.db
    .insert(auditEvents)
    .values([
      {
        ...event,
        id: createId(),
        organizationId: first.id,
        targetId: "shared",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        ...event,
        id: createId(),
        organizationId: second.id,
        actorId: "client",
        actorType: "client" as const,
        action: "group.delete",
        targetType: "group",
        targetId: "shared",
        outcome: "denied" as const,
        occurredAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        ...event,
        id: createId(),
        organizationId: first.id,
        actorId: "system",
        actorType: "system" as const,
        targetId: "other",
        outcome: "failure" as const,
        occurredAt: new Date("2026-01-03T00:00:00Z"),
      },
    ])
    .returning();
  const cases: [AuditEventFilters, number[]][] = [
    [{ organizationId: first.id }, [0, 2]],
    [{ actorId: "client" }, [1]],
    [{ action: "group.delete" }, [1]],
    [{ targetType: "organization" }, [0, 2]],
    [{ targetId: "shared" }, [0, 1]],
    [{ targetType: "organization", targetId: "shared" }, [0]],
    [{ from: new Date("2026-01-02T00:00:00Z") }, [1, 2]],
    [{ to: new Date("2026-01-03T00:00:00Z") }, [0, 1]],
    [
      {
        from: new Date("2026-01-02T00:00:00Z"),
        to: new Date("2026-01-03T00:00:00Z"),
      },
      [1],
    ],
    [{ organizationId: first.id, actorId: "client" }, []],
  ];
  for (const [filters, indices] of cases) {
    const result = await listAuditEvents(connection.db, filters, { limit: 10 });
    expect(result.items.map((row) => row.id)).toEqual(
      indices
        .map((i) => rows[i]!.id)
        .sort()
        .reverse(),
    );
    expect(result.nextCursor).toBeNull();
  }
});

test("keeps the event and erased target id when an organisation is erased", async () => {
  const organization = await insertOrganization("erased");
  const row = await recordAuditEvent(connection.db, {
    ...event,
    organizationId: organization.id,
    targetId: organization.id,
  });
  await connection.db
    .delete(organizations)
    .where(eq(organizations.id, organization.id));
  expect(await connection.db.select().from(auditEvents)).toEqual([row]);
});

test("rejects unknown actor and outcome vocabularies through CHECK constraints", async () => {
  for (const [field, constraint] of [
    ["actorType", "audit_events_actor_type_check"],
    ["outcome", "audit_events_outcome_check"],
  ] as const) {
    await expect(
      connection.db
        .insert(auditEvents)
        .values({
          ...event,
          id: createId(),
          [field]: "unknown",
        })
        .execute(),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
  }
});

test("audit users come from the action's manifests, once each, and skip malformed entries", async () => {
  const db = connection.db;
  const target = createId(),
    affected = createId();
  const tokens = [
    { id: createId(), userId: affected },
    { id: createId(), userId: affected },
    { id: createId(), userId: target },
    null,
    "bad",
    { userId: 7 },
    { userId: "" },
    { userId: "not-a-uuid" },
  ];
  const base: AuditEventInput = {
    ...event,
    actorType: "system",
    actorId: "root",
    action: "user.erased",
    targetType: "user",
    targetId: target,
    data: { effects: { deletedAccessTokens: tokens } },
  };
  const users = async (eventId: string) =>
    (
      await db
        .select({ userId: auditEventUsers.userId })
        .from(auditEventUsers)
        .where(eq(auditEventUsers.eventId, eventId))
    )
      .map((row) => row.userId)
      .sort();
  expect(await users((await recordAuditEvent(db, base)).id)).toEqual(
    [target, affected].sort(),
  );
  // Another action does not read the manifest; a malformed one names nobody.
  for (const patch of [
    { action: "user.disabled" as const },
    { data: { effects: { deletedAccessTokens: {} } } },
  ])
    expect(
      await users((await recordAuditEvent(db, { ...base, ...patch })).id),
    ).toEqual([target]);
  expect(
    (await listUserAuditEvents(db, affected, {}, { limit: 20 })).items,
  ).toHaveLength(1);
});

test("one payload shape per action: every event is version 1", async () => {
  await expect(
    connection.db
      .insert(auditEvents)
      .values({ ...event, id: createId(), schemaVersion: 2 })
      .execute(),
  ).rejects.toMatchObject({
    cause: { code: "23514", constraint: "audit_events_schema_version_check" },
  });
});

test("UUID audit lookups retain session subjects and ignore non-UUID member targets", async () => {
  const { users, sessions } = await import("../schema/index.ts");
  const userId = createId(),
    sessionId = createId();
  await connection.db.insert(users).values({
    id: userId,
    name: "Audit subject",
    email: `${userId}@example.com`,
    status: "active",
  });
  await connection.db.insert(sessions).values({
    id: sessionId,
    userId,
    token: createId(),
    expiresAt: new Date(Date.now() + 60000),
  });
  const session = await recordAuditEvent(connection.db, {
    ...event,
    targetType: "session",
    targetId: sessionId,
  });
  expect(
    await connection.db
      .select()
      .from(auditEventUsers)
      .where(eq(auditEventUsers.eventId, session.id)),
  ).toEqual([{ userId, eventId: session.id }]);
  const member = await recordAuditEvent(connection.db, {
    ...event,
    targetType: "member",
    targetId: "not-a-uuid",
  });
  expect(
    await connection.db
      .select()
      .from(auditEventUsers)
      .where(eq(auditEventUsers.eventId, member.id)),
  ).toEqual([]);
  await connection.db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    for (const table of ["members", "sessions", "grant_contexts"]) {
      const plan = await tx.execute(
        sql`explain (format json) select * from ${sql.identifier(table)} where id = public.try_uuid(${sessionId})`,
      );
      // members also has its live key, `(id, live)`; either index serves the lookup.
      expect(JSON.stringify(plan.rows)).toMatch(
        new RegExp(`"Index Name":"${table}_(pkey|id_live_unique)"`),
      );
    }
    expect(
      (
        await tx.execute(
          sql`select public.try_uuid('invalid') as invalid, public.try_uuid(null) as missing`,
        )
      ).rows,
    ).toEqual([{ invalid: null, missing: null }]);
  });
});
