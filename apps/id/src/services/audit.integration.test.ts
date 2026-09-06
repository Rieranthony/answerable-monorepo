import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import { createOrganization } from "../db/queries/organizations.ts";
import { createId } from "../lib/id.ts";
import * as service from "./audit.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
afterAll(async () => {
  await connection.close();
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
