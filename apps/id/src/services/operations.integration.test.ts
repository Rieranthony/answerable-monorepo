import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  adminOperations,
  auditEvents,
  verifications,
} from "../db/schema/index.ts";
import { recordAuditEvent } from "../__tests__/audit-queries.ts";
import { executeOperation } from "./operations.ts";

let connection: DatabaseConnection;
const command = {
  actorInstance: "user:immutable-user",
  authorityScope: "tenant:immutable-tenant",
  name: "test.change",
  key: "logical-command",
  input: {
    target: "one",
    options: { enabled: true, value: null },
    order: [1, 2],
  },
};
const allow = async () => {};
const result = {
  outcome: "applied" as const,
  statusCode: 200,
  resultReference: { type: "test", id: "one" },
};
beforeAll(() => {
  connection = createDatabase(testEnvironment({ databasePoolMax: 2 }));
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate admin_operations, audit_events, verifications cascade`,
  );
});
afterAll(async () => connection.close());

test.each([200, 201, 204])(
  "status %s: committed commands replay by canonical input, with current authorisation and isolated keys",
  async (statusCode) => {
    const receiptResult = { ...result, statusCode };
    let effects = 0;
    const mutate = async () => {
      effects++;
      return receiptResult;
    };
    const first = await executeOperation(connection.db, command, allow, mutate);
    const replay = await executeOperation(
      connection.db,
      {
        ...command,
        input: {
          order: [1, 2],
          options: { value: null, enabled: true },
          target: "one",
        },
      },
      allow,
      mutate,
    );
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({
      operation: first.operation,
      replayed: true,
      body: { operationId: first.operation.id, ...receiptResult },
    });
    expect(effects).toBe(1);
    await expect(
      executeOperation(
        connection.db,
        command,
        async () => {
          throw new Error("revoked");
        },
        mutate,
      ),
    ).rejects.toThrow("revoked");
    await expect(
      executeOperation(
        connection.db,
        { ...command, input: { target: "two" } },
        allow,
        mutate,
      ),
    ).rejects.toMatchObject({
      code: "idempotency_key_reused",
      extensions: { retryable: false },
    });
    for (const identity of [
      { actorInstance: "user:other" },
      { authorityScope: "tenant:other" },
      { name: "test.other" },
    ]) {
      const isolated = await executeOperation(
        connection.db,
        { ...command, ...identity },
        allow,
        mutate,
      );
      expect(isolated.replayed).toBe(false);
      expect(isolated.operation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(isolated.operation.fingerprint).not.toBe(
        first.operation.fingerprint,
      );
    }
    expect(effects).toBe(4);
    for (const statement of [
      sql`update admin_operations set outcome = 'noop'`,
      sql`delete from admin_operations`,
    ])
      await expect(
        Promise.resolve(connection.db.execute(statement)),
      ).rejects.toThrow();
  },
);

test("failed mutation or journal insertion rolls back its audit and releases the command key", async () => {
  for (const fail of ["mutation", "journal"] as const) {
    await expect(
      executeOperation(connection.db, command, allow, async (tx, id) => {
        await tx.insert(verifications).values({
          id,
          identifier: "operation-effect",
          value: "changed",
          expiresAt: new Date(Date.now() + 60_000),
        });
        await recordAuditEvent(tx, {
          actorType: "system",
          actorId: "test",
          action: "test.changed",
          targetType: "operation",
          targetId: id,
          outcome: "success",
        });
        if (fail === "mutation") throw new Error("interrupted");
        return { ...result, outcome: "invalid" as "applied" };
      }),
    ).rejects.toThrow();
    expect(await connection.db.select().from(adminOperations)).toHaveLength(0);
    expect(await connection.db.select().from(auditEvents)).toHaveLength(0);
    expect(await connection.db.select().from(verifications)).toHaveLength(0);
  }
  const committed = await executeOperation(
    connection.db,
    command,
    allow,
    async (tx, id) => {
      await recordAuditEvent(tx, {
        actorType: "system",
        actorId: "test",
        action: "test.noop",
        targetType: "operation",
        targetId: id,
        outcome: "success",
      });
      return { ...result, outcome: "noop" };
    },
  );
  expect(committed.operation.outcome).toBe("noop");
  expect(await connection.db.select().from(auditEvents)).toHaveLength(1);
});

test("concurrent duplicates receive a retryable response and then recover the single committed operation", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let effects = 0;
  const first = executeOperation(connection.db, command, allow, async () => {
    effects++;
    entered();
    await barrier;
    return result;
  });
  await started;
  try {
    await expect(
      executeOperation(connection.db, command, allow, async () => {
        effects++;
        return result;
      }),
    ).rejects.toMatchObject({
      code: "operation_in_progress",
      extensions: { retryable: true },
    });
  } finally {
    release();
  }
  const committed = await first;
  const replay = await executeOperation(
    connection.db,
    command,
    allow,
    async () => {
      effects++;
      return result;
    },
  );
  expect(replay.operation.id).toBe(committed.operation.id);
  expect(replay.replayed).toBe(true);
  expect(effects).toBe(1);
});

test("invalid keys and non-JSON numbers cannot reserve an operation", () => {
  for (const key of ["", "x".repeat(257)])
    expect(() =>
      executeOperation(
        connection.db,
        { ...command, key },
        allow,
        async () => result,
      ),
    ).toThrow("Idempotency key");
  expect(() =>
    executeOperation(
      connection.db,
      { ...command, input: NaN },
      allow,
      async () => result,
    ),
  ).toThrow("finite JSON");
});

for (const phase of ["authority", "mutation"] as const) {
  test(`lock timeout during ${phase} rolls back every effect and clears pooled settings`, async () => {
    const subject = createDatabase(testEnvironment({ databasePoolMax: 1 }));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = connection.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(8713421)`);
      entered();
      await barrier;
    });
    await started;
    let released = 0;
    const block = async (tx: import("../db/client.ts").Executor) => {
      await tx.insert(verifications).values({
        id: "before-timeout",
        identifier: "rollback",
        value: "test",
        expiresAt: new Date(),
      });
      await recordAuditEvent(tx, {
        actorType: "system",
        actorId: "test",
        action: "test.timeout",
        targetType: "test",
        outcome: "success",
      });
      await tx.execute(sql`select pg_advisory_xact_lock(8713421)`);
    };
    try {
      const before = await subject.db.execute(sql`show lock_timeout`);
      await expect(
        executeOperation(
          subject.db,
          command,
          async (tx) => {
            if (phase === "authority") await block(tx);
          },
          async (tx) => {
            if (phase === "mutation") await block(tx);
            return result;
          },
          () => {
            released++;
          },
        ),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(released).toBe(phase === "authority" ? 0 : 1);
      expect(await subject.db.execute(sql`show lock_timeout`)).toMatchObject({
        rows: before.rows,
      });
      for (const table of [adminOperations, auditEvents, verifications])
        expect(await subject.db.select().from(table)).toHaveLength(0);
    } finally {
      release();
      await holder;
      await subject.close();
    }
    expect(
      (
        await executeOperation(
          connection.db,
          command,
          allow,
          async () => result,
        )
      ).replayed,
    ).toBe(false);
    expect(
      (
        await executeOperation(
          connection.db,
          command,
          allow,
          async () => result,
        )
      ).replayed,
    ).toBe(true);
  });
}
