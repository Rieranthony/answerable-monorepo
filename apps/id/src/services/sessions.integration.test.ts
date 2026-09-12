import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  accounts,
  grantContexts,
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
import * as implementation from "./sessions.ts";
import {
  inPlatformRead,
  inPlatformUsers,
} from "../__tests__/platform-context.ts";
import type { Database } from "../db/client.ts";
const service = {
  ...implementation,
  revokeUserSession: (
    db: Database,
    actor: Actor,
    userId: string,
    sessionId: string,
  ) =>
    inPlatformUsers(
      db,
      (context) => implementation.revokeUserSession(context, userId, sessionId),
      actor,
    ),
  revokeUserSessions: (db: Database, actor: Actor, userId: string) =>
    inPlatformUsers(
      db,
      (context) => implementation.revokeUserSessions(context, userId),
      actor,
    ),
  listUserSessions: (
    db: Database,
    arg1: Parameters<typeof implementation.listUserSessions>[1],
    arg2: Parameters<typeof implementation.listUserSessions>[2],
  ) =>
    inPlatformRead(db, (context) =>
      implementation.listUserSessions(context, arg1, arg2),
    ),
};

let connection: DatabaseConnection;
const actor: Actor = {
  actorType: "system",
  actorId: "root",
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
    createdAt: new Date(),
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
test("missing users and sessions return 404 without audit", async () => {
  const db = connection.db;
  const id = await seed();
  const [session] = await db.select().from(sessions);
  const missing = createId();
  for (const run of [
    () => service.listUserSessions(db, missing, { limit: 10 }),
    () => service.revokeUserSession(db, actor, missing, session!.id),
    () => service.revokeUserSession(db, actor, id, missing),
    () => service.revokeUserSessions(db, actor, missing),
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
test("platform revocation counts global sessions and includes unbound user tokens", async () => {
  const db = connection.db;
  const id = await seed();
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
    (await service.listUserSessions(db, id, { limit: 1 })).nextCursor,
  ).toBeString();
  expect(await service.revokeUserSessions(db, actor, id)).toEqual({
    revoked: 2,
    changed: true,
  });
  expect(await service.revokeUserSessions(db, actor, id)).toEqual({
    revoked: 0,
    changed: false,
  });
  const audit = await events(id);
  expect(audit).toHaveLength(2);
  expect(audit[0]).toMatchObject({
    ...actor,
    targetType: "user",
    action: "session.revoked_all",
    organizationId: null,
    data: { userId: id, sessions: 2, refreshTokens: 1, accessTokens: 1 },
  });
  expect(audit[1]?.data).toEqual({
    userId: id,
    sessions: 0,
    sessionIds: [],
    revokedGrantContexts: [],
    refreshTokens: 0,
    accessTokens: 0,
    revokedTokens: { access: [], refresh: [] },
  });
});
test("audit failure restores sessions and token state for each revocation variant", async () => {
  const db = connection.db;
  const id = await seed();
  const [session] = await db.select().from(sessions);
  const invalid = { ...actor, requestId: "\0" };
  for (const run of [
    () => service.revokeUserSession(db, invalid, id, session!.id),
    () => service.revokeUserSessions(db, invalid, id),
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

async function seedSessionGrants() {
  const db = connection.db;
  const userId = await seed(),
    otherUserId = await seed();
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const [second] = await db
    .insert(sessions)
    .values({
      id: createId(),
      userId,
      token: createId(),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    })
    .returning();
  await db.update(oauthClients).set({ scopes: ["read"] });
  const contexts = [];
  for (const current of await db.select().from(sessions)) {
    const [member] = await db
      .select()
      .from(members)
      .where(eq(members.userId, current.userId));
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, current.userId));
    const [grant] = await db
      .insert(grantContexts)
      .values({
        id: createId(),
        organizationId: member!.organizationId,
        memberId: member!.id,
        userId: current.userId,
        clientInstanceId: client!.id,
        authenticationSessionId: current.id,
        authTime: current.createdAt,
        requestedScopes: ["read"],
        expiresAt: new Date(Date.now() + 60000),
      })
      .returning();
    contexts.push(grant!);
  }
  return {
    db,
    userId,
    otherUserId,
    session: session!,
    second: second!,
    contexts,
  };
}

test("single administrative session revocation targets its immutable grant origin and audits changed IDs", async () => {
  const { db, userId, session, contexts } = await seedSessionGrants();
  const target = contexts.find(
    (row) => row.authenticationSessionId === session.id,
  )!;
  await service.revokeUserSession(db, actor, userId, session.id);
  const rows = await db.select().from(grantContexts);
  for (const row of rows) {
    if (row.id === target.id) expect(row.revokedAt).toBeInstanceOf(Date);
    else
      expect(row).toEqual(contexts.find((previous) => previous.id === row.id)!);
  }
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "session.revoked"));
  expect(event!.data).toMatchObject({
    revokedGrantContexts: [
      { id: target.id, organizationId: target.organizationId },
    ],
  });
});

test("revoke-all includes persistent grants whose browser sessions have already disappeared", async () => {
  const { db, userId, otherUserId, contexts } = await seedSessionGrants();
  await db.delete(sessions).where(eq(sessions.userId, userId));
  for (const table of [oauthAccessTokens, oauthRefreshTokens])
    await db
      .update(table)
      .set({ revoked: new Date() })
      .where(eq(table.userId, userId));
  expect(await service.revokeUserSessions(db, actor, userId)).toEqual({
    revoked: 0,
    changed: true,
  });
  for (const row of await db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.userId, userId)))
    expect(row.revokedAt).toBeInstanceOf(Date);
  expect(
    await db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.userId, otherUserId)),
  ).toEqual(contexts.filter((row) => row.userId === otherUserId));
  expect(await service.revokeUserSessions(db, actor, userId)).toEqual({
    revoked: 0,
    changed: false,
  });
  const audit = await events(userId);
  expect(audit[0]!.data).toMatchObject({
    revokedGrantContexts: expect.arrayContaining(
      contexts
        .filter((row) => row.userId === userId)
        .map(({ id, organizationId }) => ({ id, organizationId })),
    ),
  });
  expect(audit[1]!.data).toMatchObject({ revokedGrantContexts: [] });
});

test("session audit failure restores grant contexts for single and global revocation", async () => {
  const { db, userId, session, contexts } = await seedSessionGrants();
  const invalid = { ...actor, requestId: "\0" };
  await expect(
    service.revokeUserSession(db, invalid, userId, session.id),
  ).rejects.toThrow();
  expect(await db.select().from(grantContexts)).toEqual(contexts);
  await expect(
    service.revokeUserSessions(db, invalid, userId),
  ).rejects.toThrow();
  expect(await db.select().from(grantContexts)).toEqual(contexts);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
