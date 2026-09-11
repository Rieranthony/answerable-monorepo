import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { recordAuditEvent } from "../__tests__/audit-queries.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { inPlatformRead } from "../__tests__/platform-context.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import * as auditQueries from "../db/queries/audit.ts";
import { createId } from "../lib/id.ts";
import * as implementation from "./audit.ts";
const service = {
  ...implementation,
  listAuditEvents: (
    db: Database,
    filters: Parameters<typeof implementation.listAuditEvents>[1],
    page: Parameters<typeof implementation.listAuditEvents>[2],
  ) =>
    inPlatformRead(db, (context) =>
      implementation.listAuditEvents(context, filters, page),
    ),
  listOrganizationAuditEvents: (
    db: Database,
    org: string,
    filters: Parameters<typeof implementation.listOrganizationAuditEvents>[1],
    page: Parameters<typeof implementation.listOrganizationAuditEvents>[2],
  ) =>
    inTenantRead(db, org, "history", (context) =>
      implementation.listOrganizationAuditEvents(context, filters, page),
    ),
};
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
afterAll(async () => {
  await connection.close();
});
test("audit queries bind authority and reject caller-supplied tenant substitution", async () => {
  const db = connection.db;
  const a = createId();
  const b = createId();
  const userId = createId();
  const rows: auditQueries.AuditEvent[] = [];
  for (const organizationId of [a, b, null])
    rows.push(
      await recordAuditEvent(db, {
        actorType: "system",
        actorId: "history-test",
        organizationId,
        action: "history.boundary",
        targetType: "user",
        targetId: userId,
        outcome: "success",
      }),
    );
  await inTenantRead(db, a, "history", async (context) => {
    expect(
      (
        await auditQueries.listOrganizationAuditEvents(
          context,
          { organizationId: b } as never,
          { limit: 10 },
        )
      ).items,
    ).toEqual([rows[0]!]);
  });
  await inPlatformRead(db, async (context) => {
    expect(
      (
        await auditQueries.listUserAuditEvents(
          context,
          userId,
          {},
          { limit: 10 },
        )
      ).items
        .map((row) => row.id)
        .sort(),
    ).toEqual(rows.map((row) => row.id).sort());
  });
});
test("audit reads filter, paginate, force the organisation and reject missing organisations", async () => {
  const db = connection.db;
  await db.execute(sql`truncate table audit_events, organizations cascade`);
  const org = await createOrganization(db, { slug: "audit", name: "Audit" });
  const other = await createOrganization(db, { slug: "other", name: "Other" });
  const rows = [];
  for (const organizationId of [org.id, org.id, other.id]) {
    rows.push(
      await recordAuditEvent(db, {
        actorType: "system",
        actorId: organizationId,
        organizationId,
        action: "test",
        targetType: "organization",
        targetId: organizationId,
        outcome: "success",
        data: { nested: { retained: true } },
      }),
    );
  }
  const page = { limit: 1 };
  const first = await service.listAuditEvents(db, {}, page);
  expect(first.items).toEqual([rows[2]!]);
  expect(first.nextCursor).toBe(rows[2]!.id);
  expect(
    (
      await service.listAuditEvents(
        db,
        {},
        { ...page, cursor: first.nextCursor! },
      )
    ).items,
  ).toEqual([rows[1]!]);
  const expected = [rows[1]!, rows[0]!];
  for (const filters of [
    { organizationId: org.id },
    { actorId: org.id },
    { targetType: "organization", targetId: org.id },
  ]) {
    expect(
      (await service.listAuditEvents(db, filters, { limit: 10 })).items,
    ).toEqual(expected);
  }
  expect(
    (await service.listAuditEvents(db, { action: "missing" }, page)).items,
  ).toEqual([]);
  expect(
    (
      await service.listAuditEvents(
        db,
        {
          action: "test",
          from: new Date("2000-01-01"),
          to: new Date("2100-01-01"),
        },
        { limit: 10 },
      )
    ).items,
  ).toHaveLength(3);
  expect(
    (await service.listAuditEvents(db, { to: rows[0]!.occurredAt }, page))
      .items,
  ).toEqual([]);
  expect(
    (await service.listAuditEvents(db, { from: new Date("2100-01-01") }, page))
      .items,
  ).toEqual([]);
  expect(
    await service.listOrganizationAuditEvents(
      db,
      org.id,
      { action: "test", ...{ organizationId: other.id } },
      { limit: 10 },
    ),
  ).toEqual({ items: expected, nextCursor: null });
  await expect(
    service.listOrganizationAuditEvents(db, createId(), {}, page),
  ).rejects.toMatchObject({ status: 404 });
});
