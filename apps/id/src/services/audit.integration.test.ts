import { inPlatformRead } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { recordAuditEvent } from "../__tests__/audit-queries.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createId } from "../lib/id.ts";
import * as implementation from "./audit.ts";
import * as auditQueries from "../db/queries/audit.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
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
  const queries = [
    [
      auditQueries.listAuditEvents,
      [{ action: "history.boundary" }, { limit: 10 }],
    ],
    [auditQueries.listOrganizationAuditEvents, [{}, { limit: 10 }]],
    [auditQueries.listUserAuditEvents, [userId, {}, { limit: 10 }]],
  ] as const;
  async function reject(
    context: unknown,
    cases: ReadonlyArray<(typeof queries)[number]>,
  ) {
    for (const [query, args] of cases)
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(query, undefined, [context, ...args]),
        ),
      ).rejects.toThrow("Invalid or expired");
  }
  await reject(db, queries);
  let expired: unknown;
  await inTenantRead(db, a, "history", async (context) => {
    expired = context;
    expect(
      (
        await auditQueries.listOrganizationAuditEvents(
          context,
          { organizationId: b } as never,
          { limit: 10 },
        )
      ).items,
    ).toEqual([rows[0]!]);
    await reject(context, [queries[0], queries[2]]);
    await reject({ ...context }, queries);
  });
  await reject(expired, queries);
  await inPlatformRead(db, async (context) => {
    expired = context;
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
    await reject(context, [queries[1]]);
    await reject({ ...context }, queries);
  });
  await reject(expired, queries);
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

test("history contexts cannot be copied, reused or substituted with directory authority", async () => {
  const db = connection.db;
  const org = await createOrganization(db, {
    slug: "history-context",
    name: "History",
  });
  let saved!: import("./tenant-context.ts").TenantReadContext<"history">;
  await inTenantRead(db, org.id, "history", async (context) => {
    saved = context;
    await expect(
      implementation.listOrganizationAuditEvents(
        { ...context },
        {},
        { limit: 1 },
      ),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(
    implementation.listOrganizationAuditEvents(saved, {}, { limit: 1 }),
  ).rejects.toThrow("Invalid or expired");
  await inTenantRead(db, org.id, "directory", async (context) => {
    await expect(
      implementation.listOrganizationAuditEvents(
        context as unknown as typeof saved,
        {},
        { limit: 1 },
      ),
    ).rejects.toThrow("Invalid or expired");
  });
  const { getOrganization } = await import("./organizations.ts");
  await inTenantRead(db, createId(), "history", async (context) => {
    await expect(
      getOrganization(
        context as unknown as import("./tenant-context.ts").TenantReadContext<"directory">,
      ),
    ).rejects.toThrow("Invalid or expired");
  });
});

test("platform audit contexts reject copies, expired handles and tenant history contexts", async () => {
  const db = connection.db;
  const { listUserAuditEvents } = implementation;
  let saved!: import("./platform-context.ts").PlatformReadContext;
  await inPlatformRead(db, async (context) => {
    saved = context;
    expect(() =>
      implementation.listAuditEvents({ ...context }, {}, { limit: 1 }),
    ).toThrow("Invalid or expired");
    await expect(
      listUserAuditEvents({ ...context }, createId(), {}, { limit: 1 }),
    ).rejects.toThrow("Invalid or expired");
  });
  expect(() => implementation.listAuditEvents(saved, {}, { limit: 1 })).toThrow(
    "Invalid or expired",
  );
  await expect(
    inPlatformRead(db, async (context) => {
      saved = context;
      throw new Error("read failed");
    }),
  ).rejects.toThrow("read failed");
  await expect(
    listUserAuditEvents(saved, createId(), {}, { limit: 1 }),
  ).rejects.toThrow("Invalid or expired");
  await inTenantRead(db, createId(), "history", async (context) => {
    expect(() =>
      implementation.listAuditEvents(
        context as unknown as typeof saved,
        {},
        { limit: 1 },
      ),
    ).toThrow("Invalid or expired");
  });
});
