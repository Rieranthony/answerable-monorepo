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
import * as service from "./sessions.ts";

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
test("missing users, sessions and cross-organisation members return 404 without audit", async () => {
  const db = connection.db;
  const id = await seed();
  const [member] = await db.select().from(members);
  const [session] = await db.select().from(sessions);
  const missing = createId();
  for (const run of [
    () => service.listUserSessions(db, missing, { limit: 10 }),
    () => service.revokeUserSession(db, actor, missing, session!.id),
    () => service.revokeUserSession(db, actor, id, missing),
    () => service.revokeUserSessions(db, actor, missing),
    () => service.listMemberSessions(db, missing, member!.id, { limit: 10 }),
    () =>
      service.listMemberSessions(db, member!.organizationId, missing, {
        limit: 10,
      }),
    () => service.revokeMemberSessions(db, actor, missing, member!.id),
    () =>
      service.revokeMemberSessions(db, actor, member!.organizationId, missing),
  ])
    await expect(run()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
test("single revocation checks ownership, revokes linked tokens before deleting and audits exactly once", async () => {
  const db = connection.db;
  const id = await seed();
  const other = await seed();
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, id));
  await expect(
    service.revokeUserSession(db, actor, other, session!.id),
  ).rejects.toMatchObject({ status: 404 });
  await service.revokeUserSession(db, actor, id, session!.id);
  expect(await service.listUserSessions(db, id, { limit: 10 })).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(
    (await service.listUserSessions(db, other, { limit: 10 })).items,
  ).toHaveLength(1);
  for (const table of [oauthRefreshTokens, oauthAccessTokens]) {
    expect(
      (await db.select().from(table).where(eq(table.userId, id)))[0],
    ).toMatchObject({ sessionId: null, revoked: expect.any(Date) });
    expect(
      (await db.select().from(table).where(eq(table.userId, other)))[0]
        ?.revoked,
    ).toBeNull();
  }
  expect(await events(session!.id)).toMatchObject([
    {
      ...actor,
      action: "session.revoked",
      targetType: "session",
      organizationId: null,
      data: { userId: id },
    },
  ]);
  await expect(
    service.revokeUserSession(db, actor, id, session!.id),
  ).rejects.toMatchObject({ status: 404 });
});
test("platform and member-scoped revocation count sessions, include unbound tokens and attribute the organisation", async () => {
  const db = connection.db;
  for (const memberScoped of [false, true]) {
    const id = await seed();
    const [member] = await db
      .select()
      .from(members)
      .where(eq(members.userId, id));
    await db.insert(sessions).values({
      id: createId(),
      userId: id,
      token: createId(),
      expiresAt: new Date(Date.now() + 60000),
    });
    await db
      .update(oauthRefreshTokens)
      .set({ sessionId: null })
      .where(eq(oauthRefreshTokens.userId, id));
    expect(
      (
        await service.listMemberSessions(
          db,
          member!.organizationId,
          member!.id,
          { limit: 1 },
        )
      ).nextCursor,
    ).toBeString();
    const run = () =>
      memberScoped
        ? service.revokeMemberSessions(
            db,
            actor,
            member!.organizationId,
            member!.id,
          )
        : service.revokeUserSessions(db, actor, id);
    expect(await run()).toEqual({ revoked: 2 });
    expect(await run()).toEqual({ revoked: 0 });
    const audit = await events(id);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      ...actor,
      targetType: "session",
      action: "session.revoked_all",
      organizationId: memberScoped ? member!.organizationId : null,
      data: { userId: id, sessions: 2, refreshTokens: 1, accessTokens: 1 },
    });
    expect(audit[1]?.data).toEqual({
      userId: id,
      sessions: 0,
      refreshTokens: 0,
      accessTokens: 0,
    });
  }
});
test("audit failure restores sessions and token state for each revocation variant", async () => {
  const db = connection.db;
  const id = await seed();
  const [member] = await db.select().from(members);
  const [session] = await db.select().from(sessions);
  const invalid = { ...actor, requestId: "\0" };
  for (const run of [
    () => service.revokeUserSession(db, invalid, id, session!.id),
    () => service.revokeUserSessions(db, invalid, id),
    () =>
      service.revokeMemberSessions(
        db,
        invalid,
        member!.organizationId,
        member!.id,
      ),
  ]) {
    await expect(run()).rejects.toThrow();
    expect(
      (await service.listUserSessions(db, id, { limit: 10 })).items,
    ).toHaveLength(1);
    for (const table of [oauthRefreshTokens, oauthAccessTokens])
      expect((await db.select().from(table))[0]).toMatchObject({
        sessionId: session!.id,
        revoked: null,
      });
  }
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
