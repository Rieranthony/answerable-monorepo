import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  listUserAuditEvents,
  recordAuditEvent,
  type AuditEventInput,
} from "../__tests__/audit-queries.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createId } from "../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { withDatabaseScope } from "./isolation.ts";
import {
  auditEvents,
  auditEventSubjects,
  members,
  organizations,
  users,
} from "./schema/index.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
afterAll(() => connection.close());
beforeEach(async () => {
  await connection.db.execute(sql`truncate audit_events cascade`);
});
const contracts = [
  ["client.grants_revoked", "client", "grantContexts"],
  ["client.grants_erased", "client", "grantContexts"],
  ["resource.disabled", "resource", "effects"],
  ["resource.erased", "resource", "deletedGrantContexts"],
  ["organization.disabled", "organization", "effects"],
  ["organization.erased", "organization", "deletedGrantContexts"],
] as const;
function input(
  contract: (typeof contracts)[number],
  userId: string,
): AuditEventInput {
  const [action, targetType, field] = contract;
  const targetId = createId();
  const effects = [
    { userId },
    { userId },
    null,
    "bad",
    { userId: 7 },
    { userId: "" },
  ];
  return {
    actorType: "system",
    actorId: "root",
    action,
    targetType,
    targetId,
    organizationId: targetType === "organization" ? targetId : null,
    outcome: "success",
    data: {
      [field]:
        field === "effects" ? { revokedGrantContexts: effects } : effects,
    },
  };
}
for (const contract of contracts) {
  test(`${contract[0]} indexes recorded users once and rejects incompatible event envelopes`, async () => {
    const db = connection.db,
      userId = createId();
    const base = input(contract, userId);
    const valid = await recordAuditEvent(db, base);
    const patches: Partial<AuditEventInput>[] = [
      { action: `${base.action}.unknown` },
      { targetType: "unknown" },
      { outcome: "failure" },
      { organizationId: base.organizationId ? null : createId() },
      {
        data: {
          grantContexts: {},
          deletedGrantContexts: {},
          effects: { revokedGrantContexts: {} },
        },
      },
      { data: { nested: base.data } },
    ];
    if (base.organizationId) patches.push({ targetId: createId() });
    for (const patch of patches)
      await recordAuditEvent(db, { ...base, ...patch });
    await db
      .insert(auditEvents)
      .values({ ...base, id: createId(), schemaVersion: 0 });
    await db
      .insert(auditEvents)
      .values({ ...base, id: createId(), schemaVersion: 2 });
    expect(
      (await listUserAuditEvents(db, userId, {}, { limit: 20 })).items,
    ).toEqual([valid]);
    const subjects = await db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.entityId, userId));
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatchObject({
      eventId: valid.id,
      entityType: "user",
      relationship: "affected",
      organizationId: base.organizationId,
      provenance: "recorded",
    });
  });
}

// These versioned contracts differ from the legacy grant arrays above. Keep their
// validation at the database boundary, beside the other subject contracts.
async function subjectFixture() {
  const principal = async () => {
    const organizationId = createId(),
      userId = createId(),
      memberId = createId();
    await connection.db
      .insert(organizations)
      .values({ id: organizationId, slug: organizationId, name: "Subject" });
    await connection.db.insert(users).values({
      id: userId,
      email: userId + "@subject.example",
      name: "Subject",
    });
    await connection.db
      .insert(members)
      .values({ id: memberId, organizationId, userId });
    return { organizationId, userId, memberId };
  };
  const tenantReader = await principal(),
    outsider = await principal();
  return {
    tenant: tenantReader,
    outsider,
    principals: { tenantReader, outsider },
  };
}

test("global erasure subject capture rejects unrelated versions, outcomes and malformed effect contracts", async () => {
  const fixture = await subjectFixture();
  const person = fixture.principals.tenantReader,
    other = fixture.principals.outsider;
  const effect = { id: createId(), userId: other.userId };
  const base = {
    actorType: "system" as const,
    actorId: "contract-test",
    targetType: "user",
    targetId: person.userId,
    organizationId: null,
    action: "user.erased",
    outcome: "success" as const,
    schemaVersion: 2 as const,
  };
  const data = {
    before: { id: person.userId },
    effects: { deletedAccessTokens: [effect] },
  };
  for (const input of [
    { ...base, schemaVersion: 1 as const, data },
    { ...base, outcome: "failure" as const, data },
    { ...base, organizationId: person.organizationId, data },
    { ...base, action: "user.disabled", data },
    { ...base, data: { ...data, before: { id: other.userId } } },
    { ...base, data: { ...data, effects: { deletedAccessTokens: effect } } },
    {
      ...base,
      data: {
        ...data,
        effects: {
          deletedAccessTokens: [
            { ...effect, id: "" },
            { id: effect.id, userId: null },
          ],
        },
      },
    },
  ]) {
    const event = await recordAuditEvent(connection.db, input);
    const subjects = await connection.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, event.id));
    expect(subjects.filter((row) => row.relationship === "affected")).toEqual(
      [],
    );
  }
});

test("organisation erasure subjects accept only the explicit versioned tenant effect arrays", async () => {
  const fixture = await subjectFixture();
  const organizationId = fixture.tenant.organizationId;
  const person = fixture.principals.tenantReader;
  const effect = { id: person.memberId, userId: person.userId, organizationId };
  const base = {
    actorType: "system" as const,
    actorId: "contract-test",
    organizationId,
    targetId: organizationId,
    targetType: "organization",
    action: "organization.erased",
    outcome: "success" as const,
    schemaVersion: 2 as const,
  };
  for (const input of [
    {
      ...base,
      schemaVersion: 1 as const,
      data: { effects: { removedMembers: [effect] } },
    },
    {
      ...base,
      outcome: "failure" as const,
      data: { effects: { removedMembers: [effect] } },
    },
    {
      ...base,
      targetId: fixture.outsider.organizationId,
      data: { effects: { removedMembers: [effect] } },
    },
    { ...base, data: { effects: { removedMembers: effect } } },
    {
      ...base,
      data: {
        effects: {
          removedMembers: [
            { ...effect, organizationId: fixture.outsider.organizationId },
            { ...effect, id: "" },
          ],
        },
      },
    },
  ]) {
    const event = await recordAuditEvent(connection.db, input);
    const subjects = await connection.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, event.id));
    expect(subjects.filter((row) => row.relationship === "affected")).toEqual(
      [],
    );
  }
  const event = await recordAuditEvent(connection.db, {
    ...base,
    data: {
      effects: { removedMembers: [effect], clearedSessionSelections: [effect] },
      deletedGrantContexts: [effect],
    },
  });
  const subjects = await connection.db
    .select()
    .from(auditEventSubjects)
    .where(eq(auditEventSubjects.eventId, event.id));
  expect(
    subjects.filter((row) => row.relationship === "affected"),
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
  const valid = await recordAuditEvent(connection.db, base);
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
    await recordAuditEvent(connection.db, { ...base, ...patch });
  const rows = await withDatabaseScope(
    connection.db,
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
  const valid = await recordAuditEvent(connection.db, base);
  for (const patch of [
    { schemaVersion: 1 as const },
    { outcome: "failure" as const },
    { action: "group.disable_unchanged" },
    { targetType: "other" },
    { targetId: null },
    { organizationId: null },
    { data: { policySources: { assignments: assignment } } },
  ])
    await recordAuditEvent(connection.db, { ...base, ...patch });
  const references = await withDatabaseScope(
    connection.db,
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

test("entitlement subject capture validates the existing tenant-bound event contract", async () => {
  const fixture = await subjectFixture();
  const person = fixture.principals.tenantReader;
  const organizationId = fixture.tenant.organizationId;
  const targetId = createId();
  const state = { id: targetId, organizationId, memberId: person.memberId };
  const base = {
    schemaVersion: 1 as const,
    actorType: "system" as const,
    actorId: "test",
    organizationId,
    targetId,
    targetType: "entitlement",
    action: "entitlement.removed",
    outcome: "success" as const,
    data: { before: state, after: null },
  };
  const valid = await recordAuditEvent(connection.db, base);
  for (const patch of [
    { schemaVersion: 2 as const },
    { outcome: "failure" as const },
    { action: "entitlement.unknown" },
    { targetType: "other" },
    { targetId: null },
    { organizationId: null },
    { organizationId: fixture.outsider.organizationId },
    {
      data: {
        before: { ...state, organizationId: fixture.outsider.organizationId },
      },
    },
    { data: { before: { ...state, id: createId() } } },
    {
      data: {
        before: { ...state, memberId: fixture.principals.outsider.memberId },
      },
    },
    { data: { before: null } },
    { data: { before: "bad" } },
    { data: { before: { ...state, memberId: null } } },
  ]) {
    const event = await recordAuditEvent(connection.db, { ...base, ...patch });
    const subjects = await withDatabaseScope(
      connection.db,
      { kind: "platform", access: "read" },
      (tx) =>
        tx
          .select()
          .from(auditEventSubjects)
          .where(eq(auditEventSubjects.eventId, event.id)),
    );
    expect(
      subjects.filter((subject) => subject.relationship === "affected"),
    ).toEqual([]);
  }
  const subjects = await withDatabaseScope(
    connection.db,
    { kind: "platform", access: "read" },
    (tx) =>
      tx
        .select()
        .from(auditEventSubjects)
        .where(eq(auditEventSubjects.eventId, valid.id)),
  );
  expect(subjects).toContainEqual(
    expect.objectContaining({
      entityType: "user",
      entityId: person.userId,
      relationship: "affected",
      organizationId,
    }),
  );
});

test("entitlement audience subjects validate version, target, tenant and group without live rows", async () => {
  const userId = createId(),
    organizationId = createId(),
    targetId = createId(),
    groupId = createId();
  for (const targetGroup of [null, groupId]) {
    const state = {
      id: targetId,
      organizationId,
      groupId: targetGroup,
      memberId: null,
    };
    const person = {
      userId,
      organizationId,
      memberId: createId(),
      groupAssignment: targetGroup === null ? null : { groupId: targetGroup },
    };
    const base = {
      schemaVersion: 2 as const,
      actorType: "system" as const,
      actorId: "test",
      organizationId,
      targetId,
      targetType: "entitlement",
      action: "entitlement.created",
      outcome: "success" as const,
      data: {
        before: null,
        after: state,
        audience: [
          person,
          person,
          { ...person, organizationId: createId() },
          { ...person, groupAssignment: { groupId: createId() } },
          { userId: 42 },
          null,
        ],
      },
    };
    const valid = await recordAuditEvent(connection.db, base);
    for (const patch of [
      { schemaVersion: 1 as const },
      { outcome: "failure" as const },
      { action: "entitlement.update_unchanged" },
      { targetType: "other" },
      { organizationId: null },
      { targetId: null },
      { data: { ...base.data, after: { ...state, id: createId() } } },
      {
        data: { ...base.data, after: { ...state, organizationId: createId() } },
      },
      { data: { ...base.data, after: { ...state, memberId: createId() } } },
      { data: { ...base.data, after: { ...state, groupId: 42 } } },
      { data: { ...base.data, audience: person } },
      { data: { ...base.data, audience: [{ ...person, memberId: "" }] } },
    ]) {
      const event = await recordAuditEvent(connection.db, {
        ...base,
        ...patch,
      });
      const refs = await withDatabaseScope(
        connection.db,
        { kind: "platform", access: "read" },
        (tx) =>
          tx
            .select()
            .from(auditEventSubjects)
            .where(eq(auditEventSubjects.eventId, event.id)),
      );
      expect(refs.filter((ref) => ref.relationship === "affected")).toEqual([]);
    }
    const refs = await withDatabaseScope(
      connection.db,
      { kind: "platform", access: "read" },
      (tx) =>
        tx
          .select()
          .from(auditEventSubjects)
          .where(eq(auditEventSubjects.eventId, valid.id)),
    );
    expect(refs.filter((ref) => ref.relationship === "affected")).toEqual([
      expect.objectContaining({
        entityType: "user",
        entityId: userId,
        organizationId,
        provenance: "recorded",
      }),
    ]);
  }
});
