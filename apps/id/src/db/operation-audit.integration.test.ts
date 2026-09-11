import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import {
  recordAuditEvent,
  listAuditEvents,
} from "../__tests__/audit-queries.ts";
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
