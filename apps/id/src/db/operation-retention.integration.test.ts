import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { assertDisposableTestDatabase } from "../__tests__/test-database.ts";
import { createId } from "../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { configureRetentionRole } from "./runtime-role.ts";
import {
  adminOperations,
  adminOperationResults,
  auditEvents,
} from "./schema/index.ts";
import { purgeOperationResults } from "../services/operation-retention.ts";

let owner: DatabaseConnection;
let maintenance: DatabaseConnection;
const roleName = `id_test_retention_${crypto.randomUUID().replaceAll("-", "")}`;
const expired = createId();
const fresh = createId();
const laterExpired = createId();
beforeAll(async () => {
  assertDisposableTestDatabase("operation retention proof");
  const environment = testEnvironment();
  owner = createDatabase(environment);
  await owner.db.execute(sql`truncate admin_operations, audit_events cascade`);
  await configureRetentionRole(owner.db, roleName);
  const password = crypto.randomUUID().replaceAll("-", "");
  await owner.db.execute(
    sql.raw(`alter role "${roleName}" login password '${password}'`),
  );
  const url = new URL(environment.databaseUrl);
  url.username = roleName;
  url.password = password;
  maintenance = createDatabase({ ...environment, databaseUrl: url.toString() });
  for (const [id, expiry] of [
    [expired, new Date(Date.now() - 1000)],
    [fresh, new Date(Date.now() + 86400_000)],
    [laterExpired, new Date(Date.now() - 500)],
  ] as const) {
    await owner.db.insert(adminOperations).values({
      id,
      actorInstance: "system:test",
      authorityScope: "platform",
      name: "test.retention",
      keyDigest: id,
      fingerprint: id,
      outcome: "applied",
      statusCode: 200,
      resultReference: { type: "test", id },
      replayExpiresAt: expiry,
    });
    await owner.db
      .insert(adminOperationResults)
      .values({ operationId: id, ciphertext: "encrypted-result" });
  }
});
afterAll(async () => {
  await maintenance?.close();
  await owner.db.execute(sql`drop owned by ${sql.identifier(roleName)}`);
  await owner.db.execute(sql`drop role ${sql.identifier(roleName)}`);
  await owner.close();
});

test("retention login cannot read or mutate tables or forge audit evidence", async () => {
  await configureRetentionRole(owner.db, roleName);
  for (const statement of [
    "select * from admin_operation_results",
    "delete from admin_operation_results",
    "delete from admin_operations",
    "select * from users",
    "update audit_events set action = 'forged'",
    "create table public.forgery (id integer)",
    "set role answerable",
  ])
    await expect(
      Promise.resolve(maintenance.db.execute(sql.raw(statement))),
    ).rejects.toThrow();
  for (const size of [0, 1001])
    await expect(purgeOperationResults(maintenance.db, size)).rejects.toThrow();
});

test("expired result purge is bounded, atomic with audit and preserves permanent keys and fresh payloads", async () => {
  const collision = createId();
  await owner.db.insert(auditEvents).values({
    id: collision,
    actorType: "system",
    actorId: "test",
    action: "test.collision",
    outcome: "success",
    targetType: "test",
  });
  await expect(
    Promise.resolve(
      maintenance.db.execute(
        sql`select public.purge_operation_results(${collision}::uuid, 1)`,
      ),
    ),
  ).rejects.toThrow();
  expect(await owner.db.select().from(adminOperationResults)).toHaveLength(3);
  expect(await purgeOperationResults(maintenance.db, 1)).toBe(1);
  expect(
    (await owner.db.select().from(adminOperationResults)).map(
      (row) => row.operationId,
    ),
  ).toEqual([fresh, laterExpired]);
  expect(await owner.db.select().from(adminOperations)).toHaveLength(3);
  const events = await owner.db.select().from(auditEvents);
  expect(
    events.find((row) => row.action === "operation.results_purged"),
  ).toMatchObject({
    actorType: "system",
    actorId: "operation-retention",
    data: { count: 1, operationIds: [expired] },
  });
  expect(await purgeOperationResults(maintenance.db)).toBe(1);
  expect(await purgeOperationResults(maintenance.db)).toBe(0);
  expect(await owner.db.select().from(auditEvents)).toHaveLength(
    events.length + 1,
  );
});
