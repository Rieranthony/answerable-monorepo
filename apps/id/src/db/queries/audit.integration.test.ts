import * as productionAuditQueries from "./audit.ts";
import { inPlatformRead } from "../../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { isUuidV7, testEnvironment } from "../../__tests__/support.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import {
  auditEvents,
  auditEventSubjects,
  organizations,
} from "../schema/index.ts";
import {
  listAuditEvents,
  listUserAuditEvents,
  recordAuditEvent,
  type AuditEventInput,
  type AuditEventFilters,
} from "../../__tests__/audit-queries.ts";

let connection: DatabaseConnection;
test("audit query entry rejects a raw database handle", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(productionAuditQueries.listAuditEvents, undefined, [
        connection.db,
        {},
        { limit: 1 },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});
const event: AuditEventInput = {
  actorType: "user",
  actorId: "administrator",
  action: "organization.update",
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

test("rolls back the administrative change and its audit event together", async () => {
  await expect(
    connection.db.transaction(async (tx) => {
      const id = createId();
      await tx
        .insert(organizations)
        .values({ id, name: "Rollback", slug: "rollback" });
      await recordAuditEvent(tx, { ...event, organizationId: id });
      throw new Error("Abort change");
    }),
  ).rejects.toThrow("Abort change");
  expect(await connection.db.select().from(organizations)).toEqual([]);
  expect(await listAuditEvents(connection.db, {}, { limit: 2 })).toEqual({
    items: [],
    nextCursor: null,
  });
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

test("grant effect subjects accept only the global successful erasure contract and deduplicate users", async () => {
  const db = connection.db;
  const affected = createId();
  const organization = await insertOrganization("effect-tenant");
  const base: AuditEventInput = {
    ...event,
    actorType: "system",
    actorId: "root",
    action: "user.erased",
    targetType: "user",
    targetId: createId(),
    data: {
      deletedGrantContexts: [
        { userId: affected },
        { userId: affected },
        null,
        "bad",
        { userId: 7 },
        { userId: "" },
      ],
    },
  };
  const valid = await recordAuditEvent(db, base);
  for (const patch of [
    { action: "user.disabled" },
    { targetType: "client" },
    { outcome: "failure" as const },
    { organizationId: organization.id },
    { data: { deletedGrantContexts: {} } },
  ])
    await recordAuditEvent(db, { ...base, ...patch });
  await db
    .insert(auditEvents)
    .values({ ...base, id: createId(), schemaVersion: 0 });
  expect(
    (await listUserAuditEvents(db, affected, {}, { limit: 20 })).items.map(
      (row) => row.id,
    ),
  ).toEqual([valid.id]);
  expect(
    await db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.entityId, affected)),
  ).toMatchObject([
    {
      eventId: valid.id,
      relationship: "affected",
      organizationId: null,
      provenance: "recorded",
    },
  ]);
});

test("client erasure subjects accept only the explicit global v2 cascade contract", async () => {
  const db = connection.db,
    affected = createId(),
    ignored = createId();
  const organization = await insertOrganization("client-erasure-subjects");
  const base: AuditEventInput = {
    ...event,
    actorType: "system",
    actorId: "root",
    targetType: "client",
    targetId: "erased-client",
    action: "client.grants_erased",
    schemaVersion: 2,
    organizationId: null,
    data: {
      clientInstanceId: createId(),
      grantContexts: [],
      effects: {
        deletedAccessTokens: [
          { id: createId(), userId: affected },
          { id: createId(), userId: null },
          null,
          "bad",
          { userId: ignored },
          { id: "", userId: ignored },
        ],
        deletedRefreshTokens: [],
        deletedConsents: [{ id: createId(), userId: affected }],
        deletedClientResources: [{ id: createId(), userId: ignored }],
      },
    },
  };
  const valid = await recordAuditEvent(db, base);
  for (const patch of [
    { schemaVersion: 1 as const },
    { schemaVersion: 3 as const },
    { organizationId: organization.id },
    { targetType: "resource" },
    { action: "client.erased" },
    { outcome: "failure" as const },
    { targetId: null },
    { data: { ...base.data, clientInstanceId: "" } },
    {
      data: {
        ...base.data,
        effects: { deletedAccessTokens: { id: createId(), userId: affected } },
      },
    },
  ])
    await recordAuditEvent(db, { ...base, ...patch });
  expect(
    (await listUserAuditEvents(db, affected, {}, { limit: 30 })).items.map(
      (row) => row.id,
    ),
  ).toEqual([valid.id]);
  expect(
    (await listUserAuditEvents(db, ignored, {}, { limit: 30 })).items,
  ).toEqual([]);
  expect(
    await db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.entityId, affected)),
  ).toMatchObject([
    {
      eventId: valid.id,
      relationship: "affected",
      organizationId: null,
      provenance: "recorded",
    },
  ]);
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
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, session.id)),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entityType: "user",
        entityId: userId,
        relationship: "affected",
      }),
    ]),
  );
  const member = await recordAuditEvent(connection.db, {
    ...event,
    targetType: "member",
    targetId: "not-a-uuid",
  });
  expect(
    await connection.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, member.id)),
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ relationship: "affected" }),
    ]),
  );
  await connection.db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    for (const table of ["members", "sessions", "grant_contexts"]) {
      const plan = await tx.execute(
        sql`explain (format json) select * from ${sql.identifier(table)} where id = public.try_uuid(${sessionId})`,
      );
      expect(JSON.stringify(plan.rows)).toContain(`${table}_pkey`);
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
