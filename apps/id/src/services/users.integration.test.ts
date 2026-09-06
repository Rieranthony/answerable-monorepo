import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  accounts,
  auditEvents,
  members,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  organizations,
  sessions,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import type { Actor } from "./actor.ts";
import * as service from "./users.ts";

let connection: DatabaseConnection;
const actor: Actor = {
  actorType: "user",
  actorId: createId(),
  requestId: "users-service",
};
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
async function seed(status: "active" | "inert" = "active") {
  const db = connection.db;
  const userId = createId();
  const organizationId = createId();
  const sessionId = createId();
  await db.insert(users).values({
    id: userId,
    email: userId + "@example.com",
    name: "User",
    status,
  });
  await db
    .insert(organizations)
    .values({ id: organizationId, slug: organizationId, name: "Org" });
  await db.insert(members).values({ id: createId(), userId, organizationId });
  await db.insert(accounts).values({
    id: createId(),
    userId,
    issuer: "https://example.com",
    providerId: "test",
    accountId: userId,
  });
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token: createId(),
    expiresAt: new Date(Date.now() + 60000),
  });
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId: userId, redirectUris: [] });
  const values = {
    id: createId(),
    token: createId(),
    userId,
    sessionId,
    clientId: userId,
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  };
  await db.insert(oauthRefreshTokens).values(values);
  await db.insert(oauthAccessTokens).values({ ...values, id: createId() });
  return userId;
}
async function events(userId: string) {
  return connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, userId))
    .orderBy(auditEvents.id);
}
test("all missing user paths return 404 without audit", async () => {
  const db = connection.db;
  const id = createId();
  for (const run of [
    () => service.getUser(db, id),
    () => service.disableUser(db, actor, id),
    () => service.enableUser(db, actor, id),
    () => service.retireUserEmail(db, actor, id),
    () => service.eraseUser(db, actor, id, id),
  ])
    await expect(run()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  expect(await db.select().from(auditEvents)).toEqual([]);
});
test("lifecycle conflicts, kill switch counts, retired-email CHECK and erasure audit", async () => {
  const db = connection.db;
  const id = await seed();
  const other = await seed("inert");
  expect((await service.listUsers(db, { limit: 1 })).nextCursor).toBeString();
  expect((await service.getUser(db, id)).sessionCount).toBe(1);
  await expect(service.enableUser(db, actor, id)).rejects.toMatchObject({
    status: 409,
    code: "user_already_active",
  });
  await expect(service.enableUser(db, actor, other)).rejects.toMatchObject({
    status: 409,
    code: "user_inert",
  });
  for (const userId of [id, other])
    await expect(
      service.retireUserEmail(db, actor, userId),
    ).rejects.toMatchObject({ status: 409, code: "user_not_disabled" });
  expect(await service.disableUser(db, actor, id)).toMatchObject({
    status: "disabled",
    disabledAt: expect.any(Date),
  });
  await expect(service.disableUser(db, actor, id)).rejects.toMatchObject({
    status: 409,
    code: "user_already_disabled",
  });
  expect((await service.getUser(db, id)).sessionCount).toBe(0);
  for (const table of [oauthRefreshTokens, oauthAccessTokens]) {
    expect(
      (await db.select().from(table).where(eq(table.userId, id)))[0]?.revoked,
    ).toBeInstanceOf(Date);
    expect(
      (await db.select().from(table).where(eq(table.userId, other)))[0]
        ?.revoked,
    ).toBeNull();
  }
  expect(await events(id)).toMatchObject([
    {
      ...actor,
      targetType: "user",
      targetId: id,
      organizationId: null,
      action: "user.disabled",
      outcome: "success",
      data: { sessions: 1, refreshTokens: 1, accessTokens: 1 },
    },
  ]);
  expect(await service.enableUser(db, actor, id)).toMatchObject({
    status: "active",
    disabledAt: null,
  });
  expect((await service.getUser(db, id)).sessionCount).toBe(0);
  await service.disableUser(db, actor, id);
  expect(await service.retireUserEmail(db, actor, id)).toMatchObject({
    email: id + "@retired.invalid",
    retiredEmail: id + "@example.com",
  });
  await expect(service.retireUserEmail(db, actor, id)).rejects.toMatchObject({
    status: 409,
    code: "user_email_already_retired",
  });
  await expect(service.enableUser(db, actor, id)).rejects.toMatchObject({
    status: 409,
    code: "user_email_retired",
  });
  await expect(service.eraseUser(db, actor, id, other)).rejects.toMatchObject({
    status: 400,
    code: "confirmation_mismatch",
  });
  await service.eraseUser(db, actor, id, id);
  await expect(service.getUser(db, id)).rejects.toMatchObject({ status: 404 });
  const audit = await events(id);
  expect(audit.map((e) => e.action)).toEqual([
    "user.disabled",
    "user.enabled",
    "user.disabled",
    "user.email_retired",
    "user.erased",
  ]);
  expect(audit[1]?.data).toEqual({ status: "active" });
  expect(audit[2]?.data).toEqual({
    sessions: 0,
    refreshTokens: 0,
    accessTokens: 0,
  });
  expect(audit[3]?.data).toEqual({ retiredEmail: id + "@example.com" });
  expect(audit[4]).toMatchObject({
    targetId: id,
    organizationId: null,
    data: {},
  });
  expect(await service.disableUser(db, actor, other)).toMatchObject({
    status: "disabled",
  });
});
test("erase cascades live memberships, accounts, sessions and tokens", async () => {
  const db = connection.db;
  const id = await seed();
  await service.eraseUser(db, actor, id, id);
  for (const table of [
    members,
    accounts,
    sessions,
    oauthRefreshTokens,
    oauthAccessTokens,
  ])
    expect(
      await db.select().from(table).where(eq(table.userId, id)),
    ).toHaveLength(0);
  expect(await events(id)).toMatchObject([
    { action: "user.erased", targetId: id, organizationId: null },
  ]);
});
test("audit failure rolls back every lifecycle write and all kill-switch side effects", async () => {
  const db = connection.db;
  const id = await seed();
  const invalid = { ...actor, requestId: "\0" };
  await expect(service.disableUser(db, invalid, id)).rejects.toThrow();
  expect(await service.getUser(db, id)).toMatchObject({
    status: "active",
    sessionCount: 1,
  });
  for (const table of [oauthRefreshTokens, oauthAccessTokens])
    expect((await db.select().from(table))[0]?.revoked).toBeNull();
  await expect(service.eraseUser(db, invalid, id, id)).rejects.toThrow();
  expect((await service.getUser(db, id)).accounts).toHaveLength(1);
  await service.disableUser(db, actor, id);
  await expect(service.enableUser(db, invalid, id)).rejects.toThrow();
  await expect(service.retireUserEmail(db, invalid, id)).rejects.toThrow();
  expect(await service.getUser(db, id)).toMatchObject({
    status: "disabled",
    retiredEmail: null,
    email: id + "@example.com",
  });
  expect(await events(id)).toHaveLength(1);
});
