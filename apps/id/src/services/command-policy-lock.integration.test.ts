import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  organizationCapabilities,
  oauthResources,
  sessions,
  users,
} from "../db/schema/index.ts";
import { authorizePlatformUsersCommand } from "./platform-context.ts";
import { updateCapability } from "./capabilities.ts";
import { updateResource } from "./resources.ts";
import { enableUser } from "./users.ts";

let fixture: AdminFixture;
let reader: DatabaseConnection;
let writer: DatabaseConnection;
beforeEach(async () => {
  fixture = await createAdminFixture();
  reader = createDatabase(fixture.environment);
  writer = createDatabase(fixture.environment);
});
afterEach(async () => {
  await reader?.close();
  await writer?.close();
  await fixture?.close();
});

for (const source of ["capability", "resource"] as const)
  for (const order of ["command-first", "revocation-first"] as const)
    test(`${source} revocation and user command are ordered: ${order}`, async () => {
      const userId = fixture.principals.platformAdmin.userId;
      const [session] = await fixture.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId));
      const [capability] = await fixture.db
        .select()
        .from(organizationCapabilities)
        .where(
          and(
            eq(
              organizationCapabilities.organizationId,
              fixture.platform.organizationId,
            ),
            eq(organizationCapabilities.grantKind, "admin_session"),
          ),
        );
      const [resource] = await fixture.db
        .select()
        .from(oauthResources)
        .where(eq(oauthResources.identifier, fixture.platform.adminResource));
      const targetId = fixture.principals.outsider.userId;
      await fixture.db
        .update(users)
        .set({ status: "disabled", disabledAt: new Date() })
        .where(eq(users.id, targetId));
      const caller = {
        principal: {
          type: "user" as const,
          userId,
          sessionId: session!.id,
          email: "admin@example.com",
          grants: [],
        },
        environment: fixture.environment,
      };
      let reached!: () => void;
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let commandPid = 0;
      let writerPid = 0;
      let mutated = false;
      const command = () =>
        reader.db.transaction(async (tx) => {
          const pid = await tx.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
          );
          commandPid = pid.rows[0]!.pid;
          const authority = await authorizePlatformUsersCommand(tx, caller);
          try {
            await authority.run(
              async (context) => {
                if (order === "command-first") {
                  reached();
                  await gate;
                }
                mutated = true;
                return enableUser(context, targetId);
              },
              { requestId: "command-policy-lock" },
            );
          } finally {
            authority.close();
          }
        });
      const change = () =>
        inPlatformWrite(writer.db, async (context) => {
          const pid = await context.tx.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
          );
          writerPid = pid.rows[0]!.pid;
          if (source === "capability")
            await updateCapability(
              context,
              fixture.platform.organizationId,
              capability!.id,
              {
                scopes: capability!.scopes.filter(
                  (scope) => scope !== "platform:users",
                ),
              },
              capability!,
            );
          else
            await updateResource(
              context,
              resource!.identifier,
              {
                allowedScopes: resource!.allowedScopes!.filter(
                  (scope) => scope !== "platform:users",
                ),
              },
              resource!,
            );
          if (order === "revocation-first") {
            reached();
            await gate;
          }
        });
      const settle = (operation: Promise<unknown>) =>
        operation.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
      const first = settle(order === "command-first" ? command() : change());
      await Promise.race([
        ready,
        first.then((result) => {
          throw new Error(
            `First transaction ended before barrier: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      let finished = false;
      const second = settle(
        order === "command-first" ? change() : command(),
      ).then((result) => {
        finished = true;
        return result;
      });
      try {
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (!blocked && !finished && Date.now() < deadline) {
          const firstPid = order === "command-first" ? commandPid : writerPid;
          const secondPid = order === "command-first" ? writerPid : commandPid;
          if (secondPid) {
            const result = await fixture.db.execute<{ blocked: boolean }>(
              sql`select ${firstPid} = any(pg_blocking_pids(${secondPid})) as blocked`,
            );
            blocked = result.rows[0]!.blocked;
          }
          if (!blocked && !finished) await Bun.sleep(10);
        }
        expect(finished).toBe(false);
        expect(blocked).toBe(true);
      } finally {
        release();
        expect(await first).toEqual({ ok: true });
        if (order === "command-first")
          expect(await second).toEqual({ ok: true });
        else
          expect(await second).toMatchObject({
            ok: false,
            error: { code: "insufficient_scope" },
          });
      }
      expect(mutated).toBe(order === "command-first");
      const [target] = await fixture.db
        .select()
        .from(users)
        .where(eq(users.id, targetId));
      expect(target!.status).toBe(
        order === "command-first" ? "active" : "disabled",
      );
      await expect(
        reader.db.transaction(async (tx) => {
          const authority = await authorizePlatformUsersCommand(tx, caller);
          authority.close();
        }),
      ).rejects.toMatchObject({ code: "insufficient_scope" });
    });

test("session expiry during a policy lock wait denies the command before mutation", async () => {
  const userId = fixture.principals.platformAdmin.userId;
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = writer.db.transaction(async (tx) => {
    const { lockOrganization } = await import("../db/organization-lock.ts");
    await lockOrganization(tx, fixture.platform.organizationId);
    reached();
    await gate;
  });
  const settledHolder = holder.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
  await Promise.race([
    ready,
    settledHolder.then((result) => {
      throw new Error(`Lock holder ended: ${JSON.stringify(result)}`);
    }),
  ]);
  await fixture.db
    .update(sessions)
    .set({ expiresAt: sql`statement_timestamp() + interval '1 second'` })
    .where(eq(sessions.id, session!.id));
  let readerPid = 0;
  let mutated = false;
  let finished = false;
  const command = reader.db.transaction(async (tx) => {
    const pid = await tx.execute<{ pid: number }>(
      sql`select pg_backend_pid() as pid`,
    );
    readerPid = pid.rows[0]!.pid;
    const authority = await authorizePlatformUsersCommand(tx, {
      principal: {
        type: "user",
        userId,
        sessionId: session!.id,
        email: "admin@example.com",
        grants: [],
      },
      environment: fixture.environment,
    });
    try {
      await authority.run(
        async () => {
          mutated = true;
        },
        { requestId: "expired-policy-wait" },
      );
    } finally {
      authority.close();
    }
  });
  const settledCommand = command.then(
    () => {
      finished = true;
      return { ok: true };
    },
    (error: unknown) => {
      finished = true;
      return { ok: false, error };
    },
  );
  try {
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (!blocked && !finished && Date.now() < deadline) {
      if (readerPid) {
        const result = await fixture.db.execute<{ blocked: boolean }>(
          sql`select cardinality(pg_blocking_pids(${readerPid})) > 0 as blocked`,
        );
        blocked = result.rows[0]!.blocked;
      }
      if (!blocked && !finished) await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    await fixture.db.execute(
      sql`select pg_sleep(greatest(0, extract(epoch from (expires_at - statement_timestamp()))) + 0.02) from sessions where id = ${session!.id}`,
    );
  } finally {
    release();
    expect(await settledHolder).toEqual({ ok: true });
    expect(await settledCommand).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
  }
  expect(mutated).toBe(false);
});

test("concurrent policy lock upgrades roll back one command and permit same-key recovery", async () => {
  const { executeOperation } = await import("./operations.ts");
  const { authorizePlatformWriteCommand } =
    await import("./platform-context.ts");
  const { updateOrganization } = await import("./organizations.ts");
  const { mapDatabaseError } = await import("../http/problem.ts");
  const { adminOperations, auditEvents } =
    await import("../db/schema/index.ts");
  const userId = fixture.principals.platformAdmin.userId;
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const caller = {
    principal: {
      type: "user" as const,
      userId,
      sessionId: session!.id,
      email: "admin@example.com",
      grants: [],
    },
    environment: fixture.environment,
  };
  let entered = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const name = `test.policy-upgrade.${crypto.randomUUID()}`;
  const attempt = (index: number, rendezvous: boolean) =>
    executeOperation(
      index === 0 ? reader.db : writer.db,
      {
        actorInstance: `user:${userId}`,
        authorityScope: "platform",
        name,
        key: `upgrade-${index}`,
        input: { name: `Changed ${index}` },
      },
      (tx) => authorizePlatformWriteCommand(tx, caller),
      async (_tx, _operationId, authority) =>
        authority.run(
          async (context) => {
            if (rendezvous) {
              if (++entered === 2) release();
              await both;
            }
            const row = await updateOrganization(
              context,
              fixture.platform.organizationId,
              { name: `Changed ${index}` },
            );
            return {
              outcome: "applied" as const,
              statusCode: 200,
              resultReference: {
                type: "organization",
                id: row.organization.id,
              },
            };
          },
          { requestId: name },
        ),
      (authority) => authority.close(),
    );
  const outcomes = await Promise.all(
    [0, 1].map((index) =>
      attempt(index, true).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ),
  );
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  const loser = outcomes.findIndex((outcome) => !outcome.ok);
  const failure = outcomes[loser]!;
  if (failure.ok) throw new Error("Expected one deadlock victim");
  expect(failure.error).toMatchObject({ cause: { code: "40P01" } });
  expect(mapDatabaseError(failure.error)).toMatchObject({
    status: 503,
    code: "database_busy",
    extensions: { retryable: true },
  });
  const operations = () =>
    fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.name, name));
  const events = () =>
    fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.requestId, name));
  expect(await operations()).toHaveLength(1);
  expect(await events()).toHaveLength(1);
  expect((await attempt(loser, false)).replayed).toBe(false);
  expect(await operations()).toHaveLength(2);
  expect(await events()).toHaveLength(2);
  expect((await attempt(loser, false)).replayed).toBe(true);
  expect(await operations()).toHaveLength(2);
  expect(await events()).toHaveLength(2);
});
