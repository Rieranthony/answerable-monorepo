import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  insertGrantContext,
  insertOriginSession,
} from "../__tests__/grants.ts";
import { testEnvironment } from "../__tests__/support.ts";
import {
  createDatabase,
  type DatabaseConnection,
  type Database,
} from "../db/client.ts";
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
import { inPlatformUsers } from "../__tests__/platform-context.ts";
const service = {
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
  await insertOriginSession(db, { id: sessionId, userId, organizationId });
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

async function seedSessionGrants() {
  const db = connection.db;
  const userId = await seed(),
    otherUserId = await seed();
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const [membership] = await db
    .select()
    .from(members)
    .where(eq(members.userId, userId));
  const second = await insertOriginSession(db, membership!);
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
    contexts.push(
      await insertGrantContext(db, {
        id: createId(),
        organizationId: member!.organizationId,
        memberId: member!.id,
        userId: current.userId,
        clientInstanceId: client!.id,
        authenticationSessionId: current.id,
        requestedScopes: ["read"],
        expiresAt: new Date(Date.now() + 60000),
      }),
    );
  }
  return {
    db,
    userId,
    otherUserId,
    session: session!,
    second,
    contexts,
  };
}
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
