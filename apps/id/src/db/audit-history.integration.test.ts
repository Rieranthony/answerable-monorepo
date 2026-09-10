import { inPlatformRead } from "../__tests__/platform-context.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "./client.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createId } from "../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { auditEvents, members, organizations, users } from "./schema/index.ts";
import { recordAuditEvent } from "../__tests__/audit-queries.ts";
import {
  listOrganizationAuditEvents as readOrganizationAudit,
  listUserAuditEvents as readUserAudit,
} from "../services/audit.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
afterAll(async () => connection.close());

test("person and tenant audit history survive membership and identity erasure", async () => {
  const db = connection.db;
  await db.execute(
    sql`truncate security_identifiers, audit_events, users, organizations cascade`,
  );
  const organizationId = createId(),
    userId = createId(),
    memberId = createId();
  await db
    .insert(organizations)
    .values({ id: organizationId, slug: "history", name: "History" });
  await db
    .insert(users)
    .values({ id: userId, name: "Person", email: "history@example.com" });
  await db.insert(members).values({ id: memberId, userId, organizationId });
  const event = await recordAuditEvent(db, {
    actorType: "system",
    actorId: "admin",
    organizationId,
    targetType: "member",
    targetId: memberId,
    action: "member.updated",
    outcome: "success",
  });
  await db.delete(members).where(eq(members.id, memberId));
  expect(
    (await listUserAuditEvents(db, userId, {}, { limit: 10 })).items.map(
      (row) => row.id,
    ),
  ).toEqual([event.id]);
  await db.delete(users).where(eq(users.id, userId));
  expect(
    (await listUserAuditEvents(db, userId, {}, { limit: 10 })).items.map(
      (row) => row.id,
    ),
  ).toEqual([event.id]);
  await db.delete(organizations).where(eq(organizations.id, organizationId));
  expect((await db.select().from(auditEvents))[0]!.organizationId).toBe(
    organizationId,
  );
  expect(
    (
      await listOrganizationAuditEvents(db, organizationId, {}, { limit: 10 })
    ).items.map((row) => row.id),
  ).toEqual([event.id]);
});

test("subject-write failure rolls back the audit fact", async () => {
  const db = connection.db;
  await db.execute(
    sql`alter table audit_event_subjects add constraint test_subject_failure check (entity_id <> 'fail-subject')`,
  );
  try {
    await expect(
      recordAuditEvent(db, {
        actorType: "system",
        actorId: "fail-subject",
        action: "test",
        targetType: "route",
        outcome: "success",
      }),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actorId, "fail-subject")),
    ).toHaveLength(0);
  } finally {
    await db.execute(
      sql`alter table audit_event_subjects drop constraint test_subject_failure`,
    );
  }
});

test("legacy derivation is labelled and does not invent a removed membership's user", async () => {
  const db = connection.db;
  const eventId = createId(),
    missingMemberId = createId();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`alter table audit_events disable trigger audit_events_capture_subjects`,
    );
    await tx.insert(auditEvents).values({
      id: eventId,
      actorType: "system",
      actorId: "legacy",
      action: "legacy",
      targetType: "member",
      targetId: missingMemberId,
      outcome: "success",
    });
    await tx.execute(sql`set constraints all immediate`);
    await tx.execute(
      sql`alter table audit_events enable trigger audit_events_capture_subjects`,
    );
    await tx.execute(
      sql`select capture_audit_subjects(event, 'legacy_derived') from audit_events event where id = ${eventId}`,
    );
  });
  const subjects = await db.execute(
    sql`select entity_type, entity_id, provenance from audit_event_subjects where event_id = ${eventId} order by entity_type`,
  );
  expect(subjects.rows).toEqual([
    {
      entity_type: "member",
      entity_id: missingMemberId,
      provenance: "legacy_derived",
    },
    {
      entity_type: "system",
      entity_id: "legacy",
      provenance: "legacy_derived",
    },
  ]);
});

const listOrganizationAuditEvents = (
  db: Database,
  org: string,
  filters: Parameters<typeof readOrganizationAudit>[1],
  page: Parameters<typeof readOrganizationAudit>[2],
) =>
  inTenantRead(db, org, "history", (context) =>
    readOrganizationAudit(context, filters, page),
  );

const listUserAuditEvents = (
  db: Database,
  id: string,
  filters: Parameters<typeof readUserAudit>[2],
  page: Parameters<typeof readUserAudit>[3],
) => inPlatformRead(db, (context) => readUserAudit(context, id, filters, page));
