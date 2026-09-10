import * as productionAuditQueries from "./queries/audit.ts";
import { inPlatformRead } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createId } from "../lib/id.ts";
import { auditEvents, auditEventSubjects } from "./schema/index.ts";
import {
  recordAuditEvent,
  listUserAuditEvents,
  type AuditEventInput,
} from "../__tests__/audit-queries.ts";
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

test("populated lifecycle backfill is repeatable, excludes malformed contracts and preserves original facts", async () => {
  const legacy = await Bun.file(
    new URL("../../drizzle/0031_grant_effect_subjects.sql", import.meta.url),
  ).text();
  const migration = await Bun.file(
    new URL("../../drizzle/0032_lifecycle_grant_subjects.sql", import.meta.url),
  ).text();
  await inPlatformRead(connection.db, async (context) => {
    const tx = context.tx;
    const current = await tx.execute<{ definition: string }>(
      sql`select pg_get_functiondef('capture_audit_subjects(audit_events, text)'::regprocedure) as definition`,
    );
    await tx.execute(sql.raw(legacy.split("--> statement-breakpoint")[0]!));
    const userId = createId();
    const valid = [];
    for (const contract of contracts) {
      const base = input(contract, userId);
      valid.push(await recordAuditEvent(tx, base));
      await recordAuditEvent(tx, { ...base, outcome: "failure" });
      await recordAuditEvent(tx, {
        ...base,
        data: {
          grantContexts: "bad",
          deletedGrantContexts: false,
          effects: [],
        },
      });
      await tx
        .insert(auditEvents)
        .values({ ...base, id: createId(), schemaVersion: 0 });
    }
    const before = await tx.select().from(auditEvents).orderBy(auditEvents.id);
    expect(
      (
        await productionAuditQueries.listUserAuditEvents(
          context,
          userId,
          {},
          { limit: 30 },
        )
      ).items,
    ).toEqual([]);
    for (let run = 0; run < 2; run++) {
      for (const statement of migration.split("--> statement-breakpoint"))
        await tx.execute(sql.raw(statement));
      expect(
        (
          await productionAuditQueries.listUserAuditEvents(
            context,
            userId,
            {},
            { limit: 30 },
          )
        ).items,
      ).toEqual([...valid].sort((a, b) => b.id.localeCompare(a.id)));
      expect(
        await tx.select().from(auditEvents).orderBy(auditEvents.id),
      ).toEqual(before);
      expect(
        await tx
          .select()
          .from(auditEventSubjects)
          .where(eq(auditEventSubjects.entityId, userId)),
      ).toHaveLength(6);
    }
    await tx.execute(sql.raw(current.rows[0]!.definition));
  });
});
