import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import {
  configureRetentionRole,
  assertRuntimeRole,
} from "../db/runtime-role.ts";
import {
  adminOperations,
  adminOperationResults,
  auditEvents,
} from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import { createId } from "../lib/id.ts";
import { createOperationCipher } from "../services/operation-cipher.ts";
import { purgeOperationResults } from "../services/operation-retention.ts";

/** Restore the maintenance capability separately from the application credential. */
export async function prepareRestoredRetention(
  db: Database,
  environment: Environment,
) {
  assert.ok(environment.operationReplay);
  const cipher = createOperationCipher(environment.operationReplay);
  const expired = createId();
  const fresh = createId();
  const ids = [expired, fresh];
  const earliest = await db.execute<{ seconds: number }>(sql`
    select least(coalesce(min(extract(epoch from replay_expires_at)), extract(epoch from now())),
      extract(epoch from now()))::float8 as seconds from admin_operations`);
  for (const [id, expiry] of [
    [expired, new Date((earliest.rows[0]!.seconds - 86400) * 1000)],
    [fresh, new Date(Date.now() + 7 * 86400_000)],
  ] as const) {
    await db.insert(adminOperations).values({
      id,
      actorInstance: "system:restore-retention",
      authorityScope: "platform",
      name: "restore.retention",
      keyDigest: id,
      fingerprint: cipher.fingerprint(id),
      outcome: "applied",
      statusCode: 200,
      resultReference: { type: "test", id },
      replayExpiresAt: expiry,
    });
    await db.insert(adminOperationResults).values({
      operationId: id,
      ciphertext: await cipher.encrypt(id, { synthetic: id }),
    });
  }
  const readReservations = (database: Database) =>
    database
      .select()
      .from(adminOperations)
      .where(inArray(adminOperations.id, ids))
      .orderBy(adminOperations.id);
  const readPayloads = (database: Database) =>
    database
      .select()
      .from(adminOperationResults)
      .where(inArray(adminOperationResults.operationId, ids))
      .orderBy(adminOperationResults.operationId);
  const reservations = await readReservations(db);
  const payloads = await readPayloads(db);
  return async (
    owner: Database,
    runtime: Database,
    restoredEnvironment: Environment,
  ) => {
    assert.deepEqual(await readReservations(owner), reservations);
    assert.deepEqual(await readPayloads(owner), payloads);
    const role = `id_test_retention_${crypto.randomUUID().replaceAll("-", "")}`;
    assert.equal(
      (await owner.execute(sql`select 1 from pg_roles where rolname = ${role}`))
        .rows.length,
      0,
    );
    await configureRetentionRole(owner, role);
    const password = crypto.randomUUID().replaceAll("-", "");
    await owner.execute(
      sql.raw(`alter role "${role}" login password '${password}'`),
    );
    const url = new URL(restoredEnvironment.databaseUrl);
    url.username = role;
    url.password = password;
    const maintenance = createDatabase({
      ...restoredEnvironment,
      databaseUrl: url.toString(),
    });
    try {
      for (const statement of [
        "select * from admin_operation_results",
        "select * from users",
        "delete from admin_operations",
        "delete from admin_operation_results",
        "update audit_events set action = 'forged'",
        `insert into audit_events (id, actor_type, actor_id, action, target_type, outcome) values ('${createId()}', 'system', 'forged', 'forged', 'test', 'success')`,
        "set role answerable",
      ])
        await assert.rejects(() => maintenance.pool.query(statement), {
          code: "42501",
        });
      await assert.rejects(() => purgeOperationResults(runtime, 1));
      await assertRuntimeRole(runtime);
      const collision = createId();
      await owner.insert(auditEvents).values({
        id: collision,
        actorType: "system",
        actorId: "restore-retention",
        action: "test.retention_collision",
        outcome: "success",
        targetType: "test",
      });
      await assert.rejects(
        () =>
          maintenance.pool.query(
            "select public.purge_operation_results($1::uuid, 1)",
            [collision],
          ),
        { code: "23505" },
      );
      assert.deepEqual(await readPayloads(owner), payloads);
      assert.equal(await purgeOperationResults(maintenance.db, 1), 1);
      assert.deepEqual(
        await readPayloads(owner),
        payloads.filter((row) => row.operationId === fresh),
      );
      assert.deepEqual(await readReservations(owner), reservations);
      const events = await owner
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "operation.results_purged"));
      const proof = events.filter((event) =>
        (event.data as { operationIds?: string[] }).operationIds?.includes(
          expired,
        ),
      );
      assert.equal(proof.length, 1);
      assert.equal(proof[0]!.actorId, "operation-retention");
      assert.deepEqual(proof[0]!.data, { count: 1, operationIds: [expired] });
    } finally {
      await maintenance.close();
    }
    // The parent removes the entire temporary cluster, including this role.
  };
}
