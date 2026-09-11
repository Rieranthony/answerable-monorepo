import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { testEnvironment } from "../../__tests__/support.ts";
import {
  retiredEmailFor,
  retireUserEmail,
  UserNotRetirableError,
} from "../../__tests__/user-queries.ts";
import { createAuth } from "../../auth.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { users } from "../schema/index.ts";

let connection: DatabaseConnection;

beforeAll(() => {
  connection = createDatabase(testEnvironment());
});

beforeEach(async () => {
  await connection.db.execute(sql`truncate table users cascade`);
});

afterAll(async () => {
  await connection.close();
});

async function insertUser(
  email: string,
  status: "active" | "inert" = "active",
) {
  const [user] = await connection.db
    .insert(users)
    .values({ id: createId(), name: "Test User", email, status })
    .returning();
  return user!;
}

test("retires a disabled user's email and releases the address", async () => {
  const oldEmail = "recycled@example.com";
  const user = await insertUser(oldEmail);
  await connection.db
    .update(users)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(users.id, user.id));

  const retired = await retireUserEmail(connection.db, user.id);

  expect(retired.email).toBe(retiredEmailFor(user.id));
  expect(retired.retiredEmail).toBe(oldEmail);

  const replacement = await insertUser(oldEmail);
  const auth = createAuth(connection.db, testEnvironment());
  const found = await (
    await auth.$context
  ).internalAdapter.findUserByEmail(oldEmail);
  expect(found?.user.id).toBe(replacement.id);
});

test("refuses to retire an active, inert, or already retired user", async () => {
  const active = await insertUser("active@example.com");
  const inert = await insertUser("inert@example.com", "inert");

  await expect(
    retireUserEmail(connection.db, active.id),
  ).rejects.toBeInstanceOf(UserNotRetirableError);
  await expect(retireUserEmail(connection.db, inert.id)).rejects.toBeInstanceOf(
    UserNotRetirableError,
  );

  const retired = await insertUser("already-retired@example.com");
  await connection.db
    .update(users)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(users.id, retired.id));
  await retireUserEmail(connection.db, retired.id);
  const [beforeSecondCall] = await connection.db
    .select()
    .from(users)
    .where(eq(users.id, retired.id));

  await expect(
    retireUserEmail(connection.db, retired.id),
  ).rejects.toBeInstanceOf(UserNotRetirableError);
  const [afterSecondCall] = await connection.db
    .select()
    .from(users)
    .where(eq(users.id, retired.id));
  expect(afterSecondCall).toEqual(beforeSecondCall);
});

import {
  deleteUser,
  findUser,
  listUsers,
  lockUser,
  setUserStatus,
} from "../../__tests__/user-queries.ts";
import { accounts, members, organizations, sessions } from "../schema/index.ts";

test("lists users by email, name, status, organisation and cursor; details expose only account identity", async () => {
  const db = connection.db;
  const a = await insertUser("alpha@example.com");
  const b = await insertUser("beta@example.com", "inert");
  const organizationId = createId();
  await db
    .insert(organizations)
    .values({ id: organizationId, slug: organizationId, name: "Org" });
  const otherOrg = createId();
  await db
    .insert(organizations)
    .values({ id: otherOrg, slug: otherOrg, name: "Other" });
  await db.insert(members).values([
    { id: createId(), organizationId, userId: a.id },
    {
      id: createId(),
      organizationId: otherOrg,
      userId: a.id,
      validUntil: new Date("2000-01-01"),
    },
  ]);
  await db.insert(accounts).values({
    id: createId(),
    userId: a.id,
    issuer: "https://issuer.example",
    providerId: "test",
    accountId: "subject",
    accessToken: "secret",
    refreshToken: "secret",
    idToken: "secret",
  });
  await db.insert(sessions).values({
    id: createId(),
    userId: a.id,
    token: "secret",
    expiresAt: new Date(Date.now() + 60000),
  });
  expect((await listUsers(db, { limit: 10 })).map((r) => r.id)).toEqual(
    [b.id, a.id].sort().reverse(),
  );
  expect(await listUsers(db, { limit: 10, q: "ALPHA" })).toEqual([a]);
  expect(
    await listUsers(db, { limit: 10, q: "TEST USER", status: "inert" }),
  ).toEqual([b]);
  expect(await listUsers(db, { limit: 10, organizationId })).toEqual([a]);
  expect(
    await listUsers(db, { limit: 10, organizationId: createId() }),
  ).toEqual([]);
  expect(
    await listUsers(db, { limit: 10, cursor: [a.id, b.id].sort()[0] }),
  ).toEqual([]);
  const detail = await findUser(db, a.id);
  expect(detail?.sessionCount).toBe(1);
  expect(detail?.memberships.map((m) => m.effective).sort()).toEqual([
    false,
    true,
  ]);
  expect(
    detail?.memberships.find((m) => m.organizationId === organizationId),
  ).toMatchObject({ slug: organizationId, validFrom: null, validUntil: null });
  expect(detail?.accounts).toEqual([
    {
      issuer: "https://issuer.example",
      providerId: "test",
      directoryId: null,
      directoryUserId: null,
    },
  ]);
  expect((await findUser(db, b.id))?.sessionCount).toBe(0);
  expect(await findUser(db, createId())).toBeNull();
});

test("locks, changes status with the disabled CHECK, deletes, and returns null for missing rows", async () => {
  const db = connection.db;
  const user = await insertUser("status@example.com");
  expect(await lockUser(db, user.id)).toEqual(user);
  expect(await lockUser(db, createId())).toBeNull();
  expect(await setUserStatus(db, user.id, "disabled")).toMatchObject({
    status: "disabled",
    disabledAt: expect.any(Date),
  });
  expect(await setUserStatus(db, user.id, "active")).toMatchObject({
    status: "active",
    disabledAt: null,
  });
  await setUserStatus(db, user.id, "disabled");
  await retireUserEmail(db, user.id);
  await expect(setUserStatus(db, user.id, "active")).rejects.toThrow();
  expect(await deleteUser(db, user.id)).toMatchObject({ id: user.id });
  expect(await deleteUser(db, user.id)).toBeNull();
  expect(await setUserStatus(db, user.id, "active")).toBeNull();
  await expect(retireUserEmail(db, user.id)).rejects.toBeInstanceOf(
    UserNotRetirableError,
  );
});
