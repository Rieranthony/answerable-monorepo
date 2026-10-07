import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { assertDisposableTestDatabase } from "../../__tests__/test-database.ts";
import {
  createRuntimeLogin,
  type RuntimeLogin,
} from "../../__tests__/runtime-role.ts";
import {
  adminOperations,
  auditEvents,
  organizations,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
let login: RuntimeLogin;
const children: Bun.Subprocess[] = [];
beforeEach(async () => {
  assertDisposableTestDatabase("administrative process crash proof");
  fixture = await createAdminFixture({ databasePoolMax: 3 });
  login = await createRuntimeLogin(fixture.db, fixture.environment, {
    databasePoolMax: 1,
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  await login.drop();
  await fixture.close();
});
async function worker(holdResponse: boolean) {
  const ready = Promise.withResolvers<{ url: string; databasePid: number }>();
  const responseReady = Promise.withResolvers<number>();
  void ready.promise.catch(() => {});
  void responseReady.promise.catch(() => {});
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../../__tests__/operation-worker.ts", import.meta.url).pathname,
    ],
    {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        const event = message as {
          stage: string;
          url: string;
          databasePid: number;
          status: number;
        };
        if (event.stage === "ready") ready.resolve(event);
        if (event.stage === "response-ready")
          responseReady.resolve(event.status);
      },
    },
  );
  children.push(child);
  child.stdin.write(
    JSON.stringify({
      environment: login.environment,
      holdResponse,
    }),
  );
  await child.stdin.end();
  void child.exited.then((code) => {
    ready.reject(new Error(`Worker exited before readiness (${code})`));
    responseReady.reject(
      new Error(`Worker exited before response barrier (${code})`),
    );
  });
  return {
    child,
    ...(await ready.promise),
    responseReady: responseReady.promise,
  };
}
async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Expected database process state was not observed");
}
// The command is one transaction whatever it changes, so creation stands for
// every command: a crash before commit leaves nothing, after commit a receipt.
for (const phase of ["before-commit", "after-commit"] as const)
  test(`create recovers after SIGKILL ${phase} without repeating effects`, async () => {
    const path = "/organizations";
    const headers = fixture.headers("root", { origin: false });
    const key = `crash-${phase}-${createId()}`;
    const keyDigest = createHash("sha256").update(key).digest("hex");
    headers.set("Idempotency-Key", key);
    headers.set("Content-Type", "application/json");
    const request = {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "crash-target", name: "Crash target" }),
    };
    const targets = async () =>
      fixture.db
        .select()
        .from(organizations)
        .where(eq(organizations.slug, "crash-target"));
    const evidence = async () => {
      const operations = await fixture.db
        .select()
        .from(adminOperations)
        .where(
          and(
            eq(adminOperations.name, "createOrganization"),
            eq(adminOperations.keyDigest, keyDigest),
          ),
        );
      const ids = operations.map((row) => row.id);
      return {
        operations,
        events: await fixture.db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, "organization.created"),
              inArray(auditEvents.operationId, ids),
            ),
          ),
      };
    };
    const before = await targets();
    const first = await worker(phase === "after-commit");
    const release = Promise.withResolvers<void>();
    let barrier: Promise<void> | undefined;
    let pending: Promise<unknown> | undefined;
    let saved: Awaited<ReturnType<typeof evidence>> | undefined;
    let committed: Awaited<ReturnType<typeof targets>> | undefined;
    try {
      if (phase === "before-commit") {
        await fixture.db.execute(
          sql`create function test_operation_commit_pause() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(707310037); return new; end $$`,
        );
        await fixture.db.execute(
          sql`create trigger test_operation_commit_pause before insert on admin_operations for each row execute function test_operation_commit_pause()`,
        );
        const held = Promise.withResolvers<void>();
        barrier = fixture.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(707310037)`);
          held.resolve();
          await release.promise;
        });
        await held.promise;
      }
      pending = fetch(`${first.url}/api/admin/v1${path}`, request).then(
        (response) => ({ status: response.status }),
        () => "connection-lost",
      );
      if (phase === "before-commit") {
        await waitFor(async () => {
          const blocked = await fixture.db.execute(
            sql`select cardinality(pg_blocking_pids(${first.databasePid})) > 0 as blocked`,
          );
          return blocked.rows[0]!.blocked === true;
        });
        expect(await targets()).toEqual(before);
        expect(await evidence()).toEqual({ operations: [], events: [] });
      } else {
        expect(await first.responseReady).toBe(201);
        saved = await evidence();
        committed = await targets();
        expect(saved.operations).toHaveLength(1);
        expect(saved.events).toHaveLength(1);
      }
      first.child.kill("SIGKILL");
      await first.child.exited;
      expect(first.child.signalCode).toBe("SIGKILL");
      expect(await pending).toBe("connection-lost");
      await waitFor(
        async () =>
          (
            await fixture.db.execute(
              sql`select 1 from pg_stat_activity where pid = ${first.databasePid}`,
            )
          ).rows.length === 0,
      );
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      await first.child.exited;
      release.resolve();
      await barrier;
      await pending;
      if (phase === "before-commit") {
        await fixture.db.execute(
          sql`drop trigger test_operation_commit_pause on admin_operations`,
        );
        await fixture.db.execute(
          sql`drop function test_operation_commit_pause()`,
        );
      }
    }
    if (phase === "before-commit") {
      expect(await targets()).toEqual(before);
      expect(await evidence()).toEqual({ operations: [], events: [] });
    } else {
      expect(await targets()).toEqual(committed!);
      expect(await evidence()).toEqual(saved!);
    }
    const restarted = await worker(false);
    const recovered = await fetch(
      `${restarted.url}/api/admin/v1${path}`,
      request,
    );
    expect(recovered.status).toBe(201);
    expect(recovered.headers.get("Idempotency-Replayed")).toBe(
      String(phase === "after-commit"),
    );
    const body = await recovered.json();
    const after = await evidence();
    expect(after.operations).toHaveLength(1);
    expect(after.events).toHaveLength(1);
    expect(recovered.headers.get("Operation-Id")).toBe(after.operations[0]!.id);
    if (phase === "after-commit") {
      const receipt = after.operations[0]!;
      expect(body).toEqual({
        operationId: receipt.id,
        outcome: receipt.outcome,
        statusCode: receipt.statusCode,
        resultReference: receipt.resultReference,
      });
      expect(after).toEqual(saved!);
      expect(await targets()).toEqual(committed!);
    }
    expect(await targets()).toHaveLength(1);
  }, 15000);
