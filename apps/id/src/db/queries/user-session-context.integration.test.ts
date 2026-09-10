import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  inPlatformRead,
  inPlatformUsers,
  inPlatformWrite,
} from "../../__tests__/platform-context.ts";
import { inTenantRead } from "../../__tests__/tenant-command.ts";
import * as users from "./users.ts";
import * as sessions from "./sessions.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});

test("global user and session queries require exact issued platform authority", async () => {
  const userId = fixture.principals.platformAdmin.userId;
  const sessionId = crypto.randomUUID();
  const reads = [
    [users.listUsers, [{ limit: 10 }]],
    [users.findUser, [userId]],
    [users.userExists, [userId]],
    [sessions.listUserSessions, [userId, { limit: 10 }]],
  ] as const;
  const userWrites = [
    [users.retireUserEmail, [userId]],
    [users.setUserStatus, [userId, "disabled"]],
    [sessions.deleteUserSessionIds, [userId]],
    [sessions.deleteSession, [userId, sessionId]],
    [sessions.findUserSession, [userId, sessionId]],
  ] as const;
  const erasure = [[users.deleteUser, [userId]]] as const;
  const lock = [[users.lockUser, [userId]]] as const;
  const all = [...reads, ...userWrites, ...erasure, ...lock];
  async function reject(context: unknown, cases: Readonly<typeof all>) {
    for (const [fn, args] of cases)
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(fn, undefined, [context, ...args]),
        ),
      ).rejects.toThrow("Invalid or expired");
  }
  await reject(fixture.db, all);
  await reject(null, all);
  let expired: unknown;
  await inPlatformRead(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...userWrites, ...erasure, ...lock]);
    expect(await users.userExists(context, userId)).toBe(true);
  });
  await reject(expired, all);
  await inPlatformUsers(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...reads, ...erasure]);
    expect((await users.lockUser(context, userId))?.id).toBe(userId);
  });
  await reject(expired, all);
  await inPlatformWrite(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context }, all);
    await reject(context, [...reads, ...userWrites]);
    expect((await users.lockUser(context, userId))?.id).toBe(userId);
  });
  await reject(expired, all);
  for (const access of [
    "directory",
    "configuration",
    "memberAccess",
    "history",
  ] as const)
    await inTenantRead(
      fixture.db,
      fixture.tenant.organizationId,
      access,
      (context) => reject(context, all),
    );
});
