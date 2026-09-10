import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { assertDisposableTestDatabase } from "../../__tests__/test-database.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import {
  adminOperations,
  adminOperationResults,
  auditEvents,
  organizations,
  oauthClients,
  members,
  groups,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { createOperationCipher } from "../../services/operation-cipher.ts";

let fixture: AdminFixture;
let roleName: string;
let databaseUrl: string;
const children: Bun.Subprocess[] = [];
beforeEach(async () => {
  assertDisposableTestDatabase("administrative process crash proof");
  fixture = await createAdminFixture({ databasePoolMax: 3 });
  roleName = `id_test_crash_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, roleName);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${roleName}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = roleName;
  url.password = password;
  databaseUrl = url.toString();
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  await fixture.db.execute(sql`drop owned by ${sql.identifier(roleName)}`);
  await fixture.db.execute(sql`drop role ${sql.identifier(roleName)}`);
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
      environment: { ...fixture.environment, databaseUrl, databasePoolMax: 1 },
      holdResponse,
    }),
  );
  child.stdin.end();
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
for (const action of ["create", "rotate", "erase"] as const)
  for (const phase of ["before-commit", "after-commit"] as const)
    test(`${action} recovers after SIGKILL ${phase} without repeating effects`, async () => {
      const id = createId();
      const memberId = createId();
      const groupId = createId();
      const clientId = fixture.platform.client.clientId;
      if (action === "erase") {
        await fixture.db
          .insert(organizations)
          .values({ id, slug: "crash-target", name: "Crash target" });
        await fixture.db.insert(members).values({
          id: memberId,
          organizationId: id,
          userId: fixture.principals.tenantAdmin.userId,
        });
        await fixture.db.insert(groups).values({
          id: groupId,
          organizationId: id,
          slug: "erased-group",
          name: "Erased group",
        });
      }
      const path =
        action === "create"
          ? "/organizations"
          : action === "rotate"
            ? `/clients/${clientId}/rotate-secret`
            : `/organizations/${id}?confirm=${id}`;
      const operationName =
        action === "create"
          ? "createOrganization"
          : action === "rotate"
            ? "rotateClientSecret"
            : "eraseOrganization";
      const auditAction =
        action === "create"
          ? "organization.created"
          : action === "rotate"
            ? "client.secret_rotated"
            : "organization.erased";
      const expectedStatus =
        action === "create" ? 201 : action === "rotate" ? 200 : 204;
      const headers = fixture.headers("root", { origin: false });
      const key = `crash-${action}-${phase}-${createId()}`;
      const keyDigest = createHash("sha256").update(key).digest("hex");
      headers.set("Idempotency-Key", key);
      headers.set("Content-Type", "application/json");
      const request = {
        method: action === "erase" ? "DELETE" : "POST",
        headers,
        body:
          action === "create"
            ? JSON.stringify({ slug: "crash-target", name: "Crash target" })
            : undefined,
      };
      const targets = async () => ({
        organizations: await fixture.db
          .select()
          .from(organizations)
          .where(eq(organizations.slug, "crash-target")),
        clients: await fixture.db
          .select()
          .from(oauthClients)
          .where(eq(oauthClients.clientId, clientId)),
        members: await fixture.db
          .select()
          .from(members)
          .where(eq(members.id, memberId)),
        groups: await fixture.db
          .select()
          .from(groups)
          .where(eq(groups.id, groupId)),
      });
      const evidence = async () => {
        const operations = await fixture.db
          .select()
          .from(adminOperations)
          .where(
            and(
              eq(adminOperations.name, operationName),
              eq(adminOperations.keyDigest, keyDigest),
            ),
          );
        const ids = operations.map((row) => row.id);
        return {
          operations,
          results: await fixture.db
            .select()
            .from(adminOperationResults)
            .where(inArray(adminOperationResults.operationId, ids)),
          events: await fixture.db
            .select()
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.action, auditAction),
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
          expect(await evidence()).toEqual({
            operations: [],
            results: [],
            events: [],
          });
        } else {
          expect(await first.responseReady).toBe(expectedStatus);
          saved = await evidence();
          committed = await targets();
          expect(saved.operations).toHaveLength(1);
          expect(saved.results).toHaveLength(1);
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
        expect(await evidence()).toEqual({
          operations: [],
          results: [],
          events: [],
        });
      } else {
        expect(await targets()).toEqual(committed!);
        expect(await evidence()).toEqual(saved!);
      }
      const restarted = await worker(false);
      const recovered = await fetch(
        `${restarted.url}/api/admin/v1${path}`,
        request,
      );
      expect(recovered.status).toBe(expectedStatus);
      expect(recovered.headers.get("Idempotency-Replayed")).toBe(
        String(phase === "after-commit"),
      );
      const body = expectedStatus === 204 ? null : await recovered.json();
      const after = await evidence();
      expect(after.operations).toHaveLength(1);
      expect(after.results).toHaveLength(1);
      expect(after.events).toHaveLength(1);
      expect(recovered.headers.get("Operation-Id")).toBe(
        after.operations[0]!.id,
      );
      expect(body).toEqual(
        await createOperationCipher(
          fixture.environment.operationReplay!,
        ).decrypt(after.operations[0]!.id, after.results[0]!.ciphertext),
      );
      if (phase === "after-commit") {
        expect(after).toEqual(saved!);
        expect(await targets()).toEqual(committed!);
      }
      const final = await targets();
      if (action === "create") expect(final.organizations).toHaveLength(1);
      if (action === "rotate") {
        expect(final.clients[0]!.authorizationVersion).toBe(
          before.clients[0]!.authorizationVersion + 1,
        );
        expect(final.clients[0]!.clientSecret).not.toBe(
          before.clients[0]!.clientSecret,
        );
        const mint = (secret: string) =>
          fetch(`${restarted.url}/auth/oauth2/token`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              resource: fixture.platform.adminResource,
              scope: "platform:read",
            }),
          });
        const rejected = await mint(fixture.platform.client.secret);
        expect(rejected.status).toBe(401);
        expect(await rejected.json()).toMatchObject({
          error: "invalid_client",
        });
        const accepted = await mint(body.clientSecret);
        expect(accepted.status).toBe(200);
        const token = await accepted.json();
        expect(token.access_token).toBeString();
        const authorised = await fetch(`${restarted.url}/api/admin/v1/me`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        expect(authorised.status).toBe(200);
        await authorised.arrayBuffer();
      }
      if (action === "erase") {
        for (const key of ["organizations", "members", "groups"] as const) {
          expect(final[key]).toHaveLength(before[key].length);
          expect(final[key].every((row) => row.deletedAt !== null)).toBe(true);
        }
      }
    }, 15000);
