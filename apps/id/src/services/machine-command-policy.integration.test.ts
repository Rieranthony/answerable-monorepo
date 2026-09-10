import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  organizationCapabilities,
  oauthResources,
  users,
} from "../db/schema/index.ts";
import { authorizePlatformUsersCommand } from "./platform-context.ts";
import { updateCapability } from "./capabilities.ts";
import { updateResource } from "./resources.ts";
import { createAuth } from "../auth.ts";
import { createDefaultPrincipalDeps } from "../http/principal.ts";
import { disableClient } from "./clients.ts";
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

for (const source of ["capability", "resource", "client"] as const)
  for (const order of ["command-first", "revocation-first"] as const)
    test(`${source} revocation and machine command are ordered: ${order}`, async () => {
      const claims = await createDefaultPrincipalDeps({
        auth: createAuth(fixture.db, fixture.environment),
        environment: fixture.environment,
      }).verifyBearer(await fixture.mintMachineToken());
      const [capability] = await fixture.db
        .select()
        .from(organizationCapabilities)
        .where(
          and(
            eq(
              organizationCapabilities.organizationId,
              fixture.platform.organizationId,
            ),
            eq(organizationCapabilities.grantKind, "client_credentials"),
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
          type: "client" as const,
          clientId: claims.clientId,
          organizationId: claims.organizationId,
          grants: [],
        },
        claims,
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
          else if (source === "client")
            await disableClient(context, claims.clientId);
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
            error: {
              code:
                source === "client" ? "invalid_token" : "insufficient_scope",
            },
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
      ).rejects.toMatchObject({
        code: source === "client" ? "invalid_token" : "insufficient_scope",
      });
    });

test("machine token expiry during a policy wait is checked before command admission", async () => {
  const { setSystemTime } = await import("bun:test");
  const deps = createDefaultPrincipalDeps({
    auth: createAuth(fixture.db, fixture.environment),
    environment: fixture.environment,
  });
  const token = await fixture.mintMachineToken();
  const claims = await deps.verifyBearer(token);
  const caller = {
    principal: {
      type: "client" as const,
      clientId: claims.clientId,
      organizationId: claims.organizationId,
      grants: [],
    },
    claims,
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
  let readerPid = 0;
  let mutated = false;
  let finished = false;
  const command = reader.db.transaction(async (tx) => {
    const pid = await tx.execute<{ pid: number }>(
      sql`select pg_backend_pid() as pid`,
    );
    readerPid = pid.rows[0]!.pid;
    const authority = await authorizePlatformUsersCommand(tx, caller);
    try {
      await authority.run(
        async () => {
          mutated = true;
        },
        { requestId: "expired-machine-policy-wait" },
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
    // The token was verified before waiting; advance the same clock used by JOSE.
    setSystemTime(new Date((claims.expiresAt + 1) * 1000));
    release();
    expect(await settledHolder).toEqual({ ok: true });
    expect(await settledCommand).toMatchObject({
      ok: false,
      error: { code: "invalid_token" },
    });
  } finally {
    release();
    await Promise.all([settledHolder, settledCommand]);
    setSystemTime();
  }
  expect(mutated).toBe(false);
  const admit = (currentClaims: typeof claims) =>
    reader.db.transaction(async (tx) => {
      const authority = await authorizePlatformUsersCommand(tx, {
        ...caller,
        claims: currentClaims,
      });
      authority.close();
    });
  await admit(await deps.verifyBearer(token));
  await expect(
    admit({ ...claims, expiresAt: Number.NaN }),
  ).rejects.toMatchObject({ code: "invalid_token" });
});
