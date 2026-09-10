import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  organizationCapabilities,
  oauthResources,
  members,
  users,
  entitlements,
} from "../db/schema/index.ts";
import { hasPlatformWriter } from "../db/queries/grants.ts";
import { createId } from "../lib/id.ts";
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

for (const source of ["capability", "resource", "user", "new-member"] as const)
  for (const order of ["command-first", "activation-first"] as const)
    test(`root admission and first writer activation are ordered: ${source}, ${order}`, async () => {
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
      let capabilityBefore = capability!;
      let resourceBefore = resource!;
      if (source === "capability")
        [capabilityBefore] = await fixture.db
          .update(organizationCapabilities)
          .set({
            scopes: capability!.scopes.filter(
              (scope) => scope !== "platform:write",
            ),
          })
          .where(eq(organizationCapabilities.id, capability!.id))
          .returning();
      else if (source === "resource")
        [resourceBefore] = await fixture.db
          .update(oauthResources)
          .set({
            allowedScopes: resource!.allowedScopes!.filter(
              (scope) => scope !== "platform:write",
            ),
          })
          .where(eq(oauthResources.id, resource!.id))
          .returning();
      else if (source === "user")
        await fixture.db
          .update(users)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(eq(users.id, fixture.principals.platformAdmin.userId));
      else {
        const platformMembers = await fixture.db
          .select({ userId: members.userId })
          .from(members)
          .where(eq(members.organizationId, fixture.platform.organizationId));
        await fixture.db
          .update(users)
          .set({ status: "disabled", disabledAt: new Date() })
          .where(
            inArray(
              users.id,
              platformMembers.map((row) => row.userId),
            ),
          );
        await fixture.db.insert(entitlements).values({
          id: createId(),
          organizationId: fixture.platform.organizationId,
          resource: fixture.platform.adminResource,
          scopes: ["platform:write"],
        });
      }
      expect(
        await hasPlatformWriter(fixture.db, {
          resource: fixture.platform.adminResource,
        }),
      ).toBe(false);
      const targetId = fixture.principals.outsider.userId;
      await fixture.db
        .update(users)
        .set({ status: "disabled", disabledAt: new Date() })
        .where(eq(users.id, targetId));
      const caller = {
        principal: { type: "root" as const, grants: [] as [] },
        environment: { ...fixture.environment, rootAdminBreakGlass: false },
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
              { requestId: "root-policy-lock" },
            );
          } finally {
            authority.close();
          }
        });
      const activate = () =>
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
              { scopes: capability!.scopes },
              capabilityBefore,
            );
          else if (source === "resource")
            await updateResource(
              context,
              resource!.identifier,
              { allowedScopes: resource!.allowedScopes! },
              resourceBefore,
            );
          else if (source === "user") {
            // Global user activation does not take an organisation lock.
            // Keep the same transaction: obtain the issued users context directly.
            const authority = await authorizePlatformUsersCommand(context.tx, {
              principal: { type: "root", grants: [] },
              environment: {
                ...fixture.environment,
                rootAdminBreakGlass: true,
              },
            });
            try {
              await authority.run(
                (usersContext) =>
                  enableUser(
                    usersContext,
                    fixture.principals.platformAdmin.userId,
                  ),
                { requestId: "activate-platform-user" },
              );
            } finally {
              authority.close();
            }
          } else {
            // Exercise the membership FK rather than relying on a service's explicit lock.
            const id = createId();
            await context.tx.insert(users).values({
              id,
              name: "New writer",
              email: `${id}@example.com`,
              status: "active",
            });
            await context.tx.insert(members).values({
              id: createId(),
              userId: id,
              organizationId: fixture.platform.organizationId,
              status: "active",
            });
          }
          if (order === "activation-first") {
            reached();
            await gate;
          }
        });
      const settle = (operation: Promise<unknown>) =>
        operation.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
      const first = settle(order === "command-first" ? command() : activate());
      await Promise.race([
        ready,
        first.then((result) => {
          throw new Error(
            `First transaction ended before barrier: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      if (order === "command-first") {
        try {
          const { updateOrganization } = await import("./organizations.ts");
          const result = await inPlatformWrite(fixture.db, async (context) => {
            await context.tx.execute(sql`set local lock_timeout = '250ms'`);
            return updateOrganization(context, fixture.tenant.organizationId, {
              name: "Unrelated tenant remains writable",
            });
          });
          expect(result.organization.name).toBe(
            "Unrelated tenant remains writable",
          );
        } catch (error) {
          release();
          await first;
          throw error;
        }
      }
      let finished = false;
      const second = settle(
        order === "command-first" ? activate() : command(),
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
            error: { code: "root_locked" },
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
      expect(
        await hasPlatformWriter(fixture.db, {
          resource: fixture.platform.adminResource,
        }),
      ).toBe(true);
      await expect(
        reader.db.transaction(async (tx) => {
          const authority = await authorizePlatformUsersCommand(tx, caller);
          authority.close();
        }),
      ).rejects.toMatchObject({ code: "root_locked" });
      await reader.db.transaction(async (tx) => {
        const authority = await authorizePlatformUsersCommand(tx, {
          ...caller,
          environment: { ...caller.environment, rootAdminBreakGlass: true },
        });
        authority.close();
      });
    });
