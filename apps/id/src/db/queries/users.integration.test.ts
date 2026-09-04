import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { testEnvironment } from "../../__tests__/support.ts";
import { createAuth } from "../../auth.ts";
import { createId } from "../../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { users } from "../schema/index.ts";
import {
  retiredEmailFor,
  retireUserEmail,
  UserNotRetirableError,
} from "./users.ts";

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

async function insertUser(email: string, status: "active" | "inert" = "active") {
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
  const found = await (await auth.$context).internalAdapter.findUserByEmail(
    oldEmail,
  );
  expect(found?.user.id).toBe(replacement.id);
});

test("refuses to retire an active, inert, or already retired user", async () => {
  const active = await insertUser("active@example.com");
  const inert = await insertUser("inert@example.com", "inert");

  await expect(
    retireUserEmail(connection.db, active.id),
  ).rejects.toBeInstanceOf(UserNotRetirableError);
  await expect(
    retireUserEmail(connection.db, inert.id),
  ).rejects.toBeInstanceOf(UserNotRetirableError);

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
