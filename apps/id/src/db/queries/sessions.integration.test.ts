import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createId } from "../../lib/id.ts";
import { users, sessions } from "../schema/index.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(sql`truncate table organizations, users cascade`);
});
afterAll(async () => {
  await connection.close();
});

import { deleteUserSessions } from "./sessions.ts";

test("deletes all selected users' sessions, preserving other users and counting empty matches", async () => {
  const db = connection.db;
  const ids = [createId(), createId(), createId()];
  for (const id of ids) {
    await db
      .insert(users)
      .values({ id, name: "User", email: id + "@example.com" });
    for (let i = 0; i < 2; i++)
      await db.insert(sessions).values({
        id: createId(),
        token: createId(),
        userId: id,
        expiresAt: new Date(Date.now() + 60000),
      });
  }
  expect(await deleteUserSessions(db, [])).toBe(0);
  expect(await deleteUserSessions(db, ids.slice(0, 2))).toBe(4);
  expect(await deleteUserSessions(db, ids.slice(0, 2))).toBe(0);
  expect(
    await db.select().from(sessions).where(eq(sessions.userId, ids[2])),
  ).toHaveLength(2);
});
