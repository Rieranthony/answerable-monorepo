import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  test,
  setSystemTime,
} from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  adminOperations,
  adminOperationResults,
  auditEvents,
  verifications,
} from "../db/schema/index.ts";
import { recordAuditEvent } from "../__tests__/audit-queries.ts";
import { createOperationCipher } from "./operation-cipher.ts";
import { executeOperation } from "./operations.ts";
import { getAuditOperationStatus } from "./operation-status.ts";

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

test("committed commands replay by canonical input, with current authorisation and isolated keys", async () => {
  let effects = 0;
  const mutate = async () => {
    effects++;
    return result;
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
  expect(replay).toEqual({ operation: first.operation, replayed: true });
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
    expect(
      (
        await executeOperation(
          connection.db,
          { ...command, ...identity },
          allow,
          mutate,
        )
      ).replayed,
    ).toBe(false);
  }
  expect(effects).toBe(4);
  for (const statement of [
    sql`update admin_operations set outcome = 'noop'`,
    sql`delete from admin_operations`,
  ])
    await expect(
      Promise.resolve(connection.db.execute(statement)),
    ).rejects.toThrow();
});

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

test("encrypted responses replay exactly, survive key rotation and never rerun after payload removal", async () => {
  const cipher = createOperationCipher({
    activeKeyId: "one",
    keys: { one: Buffer.alloc(32, 1).toString("base64url") },
  });
  const rotated = createOperationCipher({
    activeKeyId: "two",
    keys: {
      one: Buffer.alloc(32, 1).toString("base64url"),
      two: Buffer.alloc(32, 2).toString("base64url"),
    },
  });
  let effects = 0;
  const mutate = async () => {
    effects++;
    return { ...result, body: { clientSecret: "original-secret" } };
  };
  const original = await executeOperation(
    connection.db,
    command,
    allow,
    mutate,
    { cipher, retention: "secret" },
  );
  const replay = await executeOperation(connection.db, command, allow, mutate, {
    cipher: rotated,
    retention: "secret",
  });
  expect(replay.body).toEqual(original.body);
  expect(replay.replayed).toBe(true);
  expect(effects).toBe(1);
  const [stored] = await connection.db.select().from(adminOperationResults);
  expect(stored!.ciphertext).not.toContain("original-secret");
  expect(
    original.operation.replayExpiresAt!.getTime() - Date.now(),
  ).toBeGreaterThan(23 * 3600_000);
  expect(
    original.operation.replayExpiresAt!.getTime() - Date.now(),
  ).toBeLessThanOrEqual(24 * 3600_000);
  expect(
    (
      await getAuditOperationStatus(connection.db, original.operation.id, {
        principal: { type: "root", grants: [] },
        environment: testEnvironment({
          rootAdminSecret: "test",
          rootAdminBreakGlass: true,
        }),
      })
    ).replay,
  ).toBe("available");
  await connection.db.delete(adminOperationResults);
  await expect(
    executeOperation(connection.db, command, allow, mutate, {
      cipher,
      retention: "secret",
    }),
  ).rejects.toMatchObject({
    status: 410,
    code: "operation_result_expired",
    extensions: { retryable: false },
  });
  expect(
    (
      await getAuditOperationStatus(connection.db, original.operation.id, {
        principal: { type: "root", grants: [] },
        environment: testEnvironment({
          rootAdminSecret: "test",
          rootAdminBreakGlass: true,
        }),
      })
    ).replay,
  ).toBe("expired");
  expect(effects).toBe(1);
  expect(await connection.db.select().from(adminOperations)).toHaveLength(1);
});

test("expiry denies retained ciphertext and ordinary empty responses have a seven-day window", async () => {
  const cipher = createOperationCipher({
    activeKeyId: "one",
    keys: { one: Buffer.alloc(32, 1).toString("base64url") },
  });
  const options = { cipher, retention: "ordinary" as const };
  const original = await executeOperation(
    connection.db,
    command,
    allow,
    async () => result,
    options,
  );
  expect(original.body).toBeNull();
  expect(
    (
      await executeOperation(
        connection.db,
        command,
        allow,
        async () => result,
        options,
      )
    ).body,
  ).toBeNull();
  expect(
    original.operation.replayExpiresAt!.getTime() - Date.now(),
  ).toBeGreaterThan(167 * 3600_000);
  setSystemTime(new Date(Date.now() + 8 * 24 * 3600_000));
  try {
    await expect(
      executeOperation(
        connection.db,
        command,
        allow,
        async () => {
          throw new Error("must not rerun");
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "operation_result_expired" });
  } finally {
    setSystemTime();
  }
});

test("missing keys, corrupt ciphertext and encryption failures never repeat or commit effects", async () => {
  const cipher = createOperationCipher({
    activeKeyId: "one",
    keys: { one: Buffer.alloc(32, 1).toString("base64url") },
  });
  const options = { cipher, retention: "secret" as const };
  await expect(
    executeOperation(connection.db, command, allow, async () => ({
      ...result,
      body: "secret",
    })),
  ).rejects.toThrow("requires replay encryption");
  await expect(
    executeOperation(
      connection.db,
      command,
      allow,
      async (tx, id) => {
        await tx.insert(verifications).values({
          id,
          identifier: "encryption-effect",
          value: "changed",
          expiresAt: new Date(Date.now() + 60_000),
        });
        await recordAuditEvent(tx, {
          actorType: "system",
          actorId: "test",
          action: "test.encrypted",
          targetType: "operation",
          targetId: id,
          outcome: "success",
        });
        return { ...result, body: "x".repeat(1_048_576) };
      },
      options,
    ),
  ).rejects.toThrow("too large");
  expect(await connection.db.select().from(adminOperations)).toHaveLength(0);
  expect(await connection.db.select().from(verifications)).toHaveLength(0);
  expect(await connection.db.select().from(auditEvents)).toHaveLength(0);
  const original = await executeOperation(
    connection.db,
    command,
    allow,
    async () => ({ ...result, body: "secret" }),
    options,
  );
  await expect(
    executeOperation(connection.db, command, allow, async () => result),
  ).rejects.toMatchObject({ code: "operation_replay_unavailable" });
  await connection.db
    .update(adminOperationResults)
    .set({ ciphertext: "corrupt" });
  await expect(
    executeOperation(
      connection.db,
      command,
      allow,
      async () => result,
      options,
    ),
  ).rejects.toMatchObject({ code: "operation_replay_unavailable" });
  await expect(
    executeOperation(
      connection.db,
      command,
      async () => {
        throw new Error("revoked");
      },
      async () => result,
      options,
    ),
  ).rejects.toThrow("revoked");
  expect((await connection.db.select().from(adminOperations))[0]!.id).toBe(
    original.operation.id,
  );
});

test("keyed fingerprints retain rotation recovery, reject changed secrets and never rerun after key retirement", async () => {
  const oldKey = Buffer.alloc(32, 7).toString("base64url");
  const newKey = Buffer.alloc(32, 8).toString("base64url");
  const cipher = createOperationCipher({
    activeKeyId: "old",
    keys: { old: oldKey },
  });
  const rotated = createOperationCipher({
    activeKeyId: "new",
    keys: { old: oldKey, new: newKey },
  });
  const retired = createOperationCipher({
    activeKeyId: "new",
    keys: { new: newKey },
  });
  const secretCommand = {
    ...command,
    input: { clientSecret: "guessable-secret" },
  };
  let effects = 0;
  const mutate = async () => {
    effects++;
    return { ...result, body: { configured: true } };
  };
  const options = { cipher, retention: "ordinary" as const };
  const first = await executeOperation(
    connection.db,
    secretCommand,
    allow,
    mutate,
    options,
  );
  expect(first.operation.fingerprint).toStartWith("hmac-v1.");
  expect(first.operation.fingerprint).not.toContain("guessable-secret");
  const replay = await executeOperation(
    connection.db,
    secretCommand,
    allow,
    mutate,
    { ...options, cipher: rotated },
  );
  expect(replay.replayed).toBe(true);
  expect(replay.body).toEqual(first.body);
  await expect(
    executeOperation(
      connection.db,
      { ...secretCommand, input: { clientSecret: "different-secret" } },
      allow,
      mutate,
      { ...options, cipher: rotated },
    ),
  ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  await expect(
    executeOperation(connection.db, secretCommand, allow, mutate, {
      ...options,
      cipher: retired,
    }),
  ).rejects.toMatchObject({
    status: 503,
    code: "operation_replay_unavailable",
  });
  await expect(
    executeOperation(
      connection.db,
      secretCommand,
      async () => {
        throw new Error("revoked");
      },
      mutate,
      { ...options, cipher: retired },
    ),
  ).rejects.toThrow("revoked");
  await connection.db.delete(adminOperationResults);
  for (const input of [
    secretCommand.input,
    { clientSecret: "different-secret" },
  ])
    await expect(
      executeOperation(
        connection.db,
        { ...secretCommand, input },
        allow,
        mutate,
        { ...options, cipher: retired },
      ),
    ).rejects.toMatchObject({ status: 410, code: "operation_result_expired" });
  expect(effects).toBe(1);
  expect(await connection.db.select().from(adminOperations)).toHaveLength(1);
});

test("legacy encrypted receipts remain recoverable under their original fingerprint", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const legacyCommand = { ...command, input: "legacy-input" };
  const id = crypto.randomUUID();
  const cipher = createOperationCipher({
    activeKeyId: "old",
    keys: { old: Buffer.alloc(32, 9).toString("base64url") },
  });
  await connection.db.insert(adminOperations).values({
    id,
    actorInstance: command.actorInstance,
    authorityScope: command.authorityScope,
    name: command.name,
    keyDigest: hash(command.key),
    fingerprint: hash(JSON.stringify(legacyCommand.input)),
    ...result,
    replayExpiresAt: new Date(Date.now() + 60000),
  });
  await connection.db.insert(adminOperationResults).values({
    operationId: id,
    ciphertext: await cipher.encrypt(id, { legacy: true }),
  });
  const replay = await executeOperation(
    connection.db,
    legacyCommand,
    allow,
    async () => {
      throw new Error("must not rerun");
    },
    { cipher, retention: "ordinary" },
  );
  expect(replay).toMatchObject({ replayed: true, body: { legacy: true } });
  expect(replay.operation.id).toBe(id);
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
          undefined,
          () => {
            released++;
          },
        ),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(released).toBe(phase === "authority" ? 0 : 1);
      expect(await subject.db.execute(sql`show lock_timeout`)).toMatchObject({
        rows: before.rows,
      });
      for (const table of [
        adminOperations,
        adminOperationResults,
        auditEvents,
        verifications,
      ])
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
