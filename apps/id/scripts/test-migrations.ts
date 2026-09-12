import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { bootstrap, systemActor } from "../src/bootstrap.ts";
import { createDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { migrationCatalog } from "../src/__tests__/migration-catalog.ts";
import approvedCatalog from "../src/__tests__/migration-catalog.json";
import { testEnvironment } from "../src/__tests__/support.ts";
import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";

// Destructive only to the explicitly disposable test database. Run before other DB suites.
assertDisposableTestDatabase(
  "rehearse migration installation and interruption",
);
const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "id-migration-proof-"));
const control = new Pool({ connectionString: testDatabaseUrl, max: 2 });
const connection = createDatabase(testEnvironment({ databasePoolMax: 2 }));
const expectedReceipts = readMigrationFiles({ migrationsFolder: folder }).map(
  (migration) => ({
    hash: migration.hash,
    created_at: String(migration.folderMillis),
  }),
);
async function receipts() {
  return (
    await control.query(
      "select hash, created_at from drizzle.__drizzle_migrations order by created_at",
    )
  ).rows;
}
async function reset() {
  await control.query("drop schema public cascade");
  await control.query("drop schema if exists drizzle cascade");
  await control.query("create schema public");
}
async function emptyAfterFailure() {
  assert.equal(
    (
      await control.query(
        "select count(*)::integer as count from pg_class where relnamespace = 'public'::regnamespace",
      )
    ).rows[0].count,
    0,
  );
  assert.equal((await receipts()).length, 0);
}
async function waitUntil(check: () => Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (!(await check())) {
    assert.ok(
      performance.now() < deadline,
      "Migration worker did not reach the expected database barrier",
    );
    await Bun.sleep(10);
  }
}
async function interrupted(migrationsFolder: string, beforeCommit: boolean) {
  let pid = 0;
  let committed = false;
  const blocker = await control.connect();
  const lock = "519876234091";
  if (beforeCommit)
    await blocker.query("select pg_advisory_lock($1::bigint)", [lock]);
  const worker = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL("../src/__tests__/migration-worker.ts", import.meta.url),
      ),
      migrationsFolder,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      ipc(message: { stage: string; pid?: number }) {
        if (message.stage === "ready") pid = message.pid!;
        if (message.stage === "committed") committed = true;
      },
    },
  );
  try {
    await waitUntil(async () => {
      if (!pid) return false;
      if (!beforeCommit) return committed;
      return (
        (
          await control.query(
            "select 1 from pg_stat_activity where pid = $1 and wait_event = 'advisory'",
            [pid],
          )
        ).rowCount === 1
      );
    });
    worker.kill("SIGKILL");
    await worker.exited;
    // PostgreSQL observes the closed socket after the blocked statement returns.
    if (beforeCommit)
      await blocker.query("select pg_advisory_unlock($1::bigint)", [lock]);
    await waitUntil(
      async () =>
        (
          await control.query("select 1 from pg_stat_activity where pid = $1", [
            pid,
          ])
        ).rowCount === 0,
    );
  } finally {
    worker.kill("SIGKILL");
    await worker.exited;
    if (beforeCommit)
      await blocker.query("select pg_advisory_unlock($1::bigint)", [lock]);
    blocker.release();
  }
}
try {
  await cp(folder, scratch, { recursive: true });
  const journal = await Bun.file(join(scratch, "meta/_journal.json")).json();
  const lastSql = join(scratch, `${journal.entries.at(-1).tag}.sql`);
  const original = await Bun.file(lastSql).text();
  await reset();
  await Bun.write(
    lastSql,
    original + "\n--> statement-breakpoint\nSELECT 1 / 0;\n",
  );
  await assert.rejects(() =>
    migrate(connection.db, { migrationsFolder: scratch }),
  );
  await emptyAfterFailure();
  console.log("Statement failure rolls back the complete schema and receipt");

  await reset();
  await Bun.write(
    lastSql,
    original +
      "\n--> statement-breakpoint\nSELECT pg_advisory_xact_lock(519876234091::bigint);\n",
  );
  await interrupted(scratch, true);
  await emptyAfterFailure();
  await runMigrations(connection.db);
  assert.deepEqual(await receipts(), expectedReceipts);
  assert.deepEqual(await migrationCatalog(connection.db), approvedCatalog);
  assert.equal(
    (
      await control.query(
        "select (select count(*) from audit_events) + (select count(*) from system_bindings) + (select count(*) from admin_operations) as count",
      )
    ).rows[0].count,
    "0",
  );
  console.log(
    "SIGKILL before commit rolls back; the committed migration retries into an empty database",
  );

  await reset();
  await interrupted(folder, false);
  assert.deepEqual(await receipts(), expectedReceipts);
  const options = {
    platformOrganizationSlug: "answerable",
    platformOrganizationName: "Answerable",
    adminResourceIdentifier: "http://localhost:47300/api/admin",
  };
  const seeds = await Promise.all([
    bootstrap(connection.db, systemActor("first-start"), options),
    bootstrap(connection.db, systemActor("concurrent-start"), options),
  ]);
  assert.equal(seeds[0]!.organization.id, seeds[1]!.organization.id);
  const before = (
    await control.query(
      "select (select jsonb_agg(b) from system_bindings b) as bindings, (select jsonb_agg(a order by id) from audit_events a) as audit",
    )
  ).rows;
  await runMigrations(connection.db);
  assert.deepEqual(await receipts(), expectedReceipts);
  assert.deepEqual(
    (
      await control.query(
        "select (select jsonb_agg(b) from system_bindings b) as bindings, (select jsonb_agg(a order by id) from audit_events a) as audit",
      )
    ).rows,
    before,
  );
  assert.deepEqual(await migrationCatalog(connection.db), approvedCatalog);
  console.log(
    "SIGKILL after commit preserves the receipt; concurrent bootstrap and repeated migration preserve real writes",
  );
  // Leave a clean migrated test schema for the serial correctness suite.
  await reset();
  await runMigrations(connection.db);
  console.log(
    `Migration proof passed: ${expectedReceipts.length} committed migration(s)`,
  );
} finally {
  await connection.close();
  await control.end();
  await rm(scratch, { recursive: true, force: true });
}
