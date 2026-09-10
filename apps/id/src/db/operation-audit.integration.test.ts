import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { recordAuditEvent, listAuditEvents } from "../__tests__/audit-queries.ts";
import { executeOperation } from "../services/operations.ts";
import { adminOperations, auditEvents, verifications } from "./schema/index.ts";
import { createId } from "../lib/id.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate admin_operations, audit_events, verifications cascade`,
  );
});
afterAll(async () => connection.close());

test("an audit event can precede its operation inside the transaction and be queried by operation", async () => {
  const committed = await executeOperation(
    connection.db,
    {
      actorInstance: "system:test",
      authorityScope: "platform",
      name: "test.operation",
      key: "one",
      input: {},
    },
    async () => {},
    async (tx, operationId) => {
      await recordAuditEvent(tx, {
        actorType: "system",
        actorId: "test",
        action: "test.applied",
        targetType: "operation",
        targetId: operationId,
        operationId,
        outcome: "success",
      });
      return {
        outcome: "applied",
        statusCode: 200,
        resultReference: { type: "test", id: operationId },
      };
    },
  );
  const history = await listAuditEvents(
    connection.db,
    { operationId: committed.operation.id },
    { limit: 10 },
  );
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({
    operationId: committed.operation.id,
    schemaVersion: 1,
  });
  expect(
    (
      await listAuditEvents(
        connection.db,
        { operationId: createId() },
        { limit: 10 },
      )
    ).items,
  ).toHaveLength(0);
});

test("a dangling operation link rejects commit and rolls back its local data and audit", async () => {
  await expect(
    connection.db.transaction(async (tx) => {
      const id = createId();
      await tx.insert(verifications).values({
        id,
        identifier: "audit-effect",
        value: "changed",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await recordAuditEvent(tx, {
        actorType: "system",
        actorId: "test",
        action: "test.applied",
        targetType: "operation",
        operationId: id,
        outcome: "success",
      });
    }),
  ).rejects.toThrow();
  expect(await connection.db.select().from(verifications)).toHaveLength(0);
  expect(await connection.db.select().from(auditEvents)).toHaveLength(0);
  expect(await connection.db.select().from(adminOperations)).toHaveLength(0);
});

test("the committed migration labels existing events as legacy without inventing operation links", async () => {
  const probe = `audit_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const migration = await Bun.file(
    new URL("../../drizzle/0013_operation_audit.sql", import.meta.url),
  ).text();
  await connection.db.transaction(async (tx) => {
    await tx.execute(sql`create schema ${sql.identifier(probe)}`);
    await tx.execute(sql`set local search_path to ${sql.identifier(probe)}`);
    await tx.execute(sql`create table audit_events (id uuid primary key)`);
    await tx.execute(sql`create table admin_operations (id uuid primary key)`);
    const legacy = createId();
    await tx.execute(sql`insert into audit_events (id) values (${legacy})`);
    for (const statement of migration.split("--> statement-breakpoint"))
      await tx.execute(
        sql.raw(
          statement.replaceAll(
            '"public"."admin_operations"',
            `"${probe}"."admin_operations"`,
          ),
        ),
      );
    const newer = createId();
    await tx.execute(sql`insert into audit_events (id) values (${newer})`);
    const result = await tx.execute(
      sql`select id, schema_version, operation_id from audit_events order by id`,
    );
    expect(result.rows).toEqual([
      { id: legacy, schema_version: 0, operation_id: null },
      { id: newer, schema_version: 1, operation_id: null },
    ]);
    await tx.execute(sql`set constraints all immediate`);
    await tx.execute(sql`drop schema ${sql.identifier(probe)} cascade`);
  });
});
