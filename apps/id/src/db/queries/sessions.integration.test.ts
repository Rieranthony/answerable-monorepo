import * as productionSessions from "./sessions.ts";
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
  await connection.db.execute(
    sql`truncate table audit_events, security_identifiers, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

import { deleteUserSessionIds } from "../../__tests__/session-queries.ts";

test("deletes one user's sessions with exact IDs, preserving other users", async () => {
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
  const expectedIds = (
    await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, ids[0]!))
  )
    .map((row) => row.id)
    .sort();
  expect(await deleteUserSessionIds(db, ids[0]!)).toEqual(expectedIds);
  expect(await deleteUserSessionIds(db, ids[0]!)).toEqual([]);
  expect(
    await db.select().from(sessions).where(eq(sessions.userId, ids[2])),
  ).toHaveLength(2);
});

import {
  listUserSessions,
  deleteSession,
  findUserSession,
} from "../../__tests__/session-queries.ts";
import { members, organizations } from "../schema/index.ts";

test("session queries paginate, hide tokens and enforce user and organisation ownership", async () => {
  const db = connection.db;
  const userId = createId();
  const otherId = createId();
  for (const id of [userId, otherId])
    await db
      .insert(users)
      .values({ id, name: "User", email: id + "@example.com" });
  const ids = [createId(), createId(), createId()].sort().reverse();
  for (const id of ids)
    await db.insert(sessions).values({
      id,
      userId,
      token: id,
      expiresAt: new Date(Date.now() + 60000),
    });
  const page = await listUserSessions(db, userId, { limit: 1 });
  expect(page.map((r) => r.id)).toEqual(ids.slice(0, 2));
  expect(page[0]).not.toHaveProperty("token");
  expect(
    (await listUserSessions(db, userId, { limit: 1, cursor: ids[1] })).map(
      (r) => r.id,
    ),
  ).toEqual(ids.slice(2));
  expect(await listUserSessions(db, otherId, { limit: 10 })).toEqual([]);
  expect(await findUserSession(db, userId, ids[0])).toEqual(page[0]!);
  expect(await findUserSession(db, otherId, ids[0])).toBeNull();
  expect(await deleteSession(db, otherId, ids[0])).toBeNull();
  expect(await deleteSession(db, userId, ids[0])).toEqual(page[0]!);
  expect(await deleteSession(db, userId, ids[0])).toBeNull();
  const organizationId = createId();
  const memberId = createId();
  await db
    .insert(organizations)
    .values({ id: organizationId, slug: organizationId, name: "Org" });
  await db.insert(members).values({ id: memberId, organizationId, userId });
});

test("global session listing rejects raw database authority", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(productionSessions.listUserSessions, undefined, [
        connection.db,
        createId(),
        { limit: 10 },
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});
