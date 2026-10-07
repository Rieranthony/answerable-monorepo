import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  insertGrantContext,
  insertOriginSession,
} from "../__tests__/grants.ts";
import { inPlatformUsers } from "../__tests__/platform-context.ts";
import { testEnvironment } from "../__tests__/support.ts";
import {
  type Database,
  createDatabase,
  type DatabaseConnection,
} from "../db/client.ts";
import {
  accounts,
  auditEvents,
  grantContexts,
  members,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  organizations,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import type { Actor } from "./actor.ts";
import * as implementation from "./users.ts";
const service = {
  disableUser: (db: Database, actor: Actor, userId: string) =>
    inPlatformUsers(
      db,
      (context) => implementation.disableUser(context, userId),
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
  const authTime = new Date();
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
  await insertOriginSession(db, {
    id: sessionId,
    userId,
    organizationId,
    createdAt: authTime,
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

async function seedGrantContexts() {
  const db = connection.db;
  const userId = await seed();
  await seed();
  const extraOrg = createId();
  await db
    .insert(organizations)
    .values({ id: extraOrg, slug: extraOrg, name: "Second tenant" });
  await db
    .insert(members)
    .values({ id: createId(), organizationId: extraOrg, userId });
  await db.update(oauthClients).set({ scopes: ["read"] });
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, userId));
  for (const membership of await db.select().from(members)) {
    const session = await insertOriginSession(db, membership);
    await insertGrantContext(db, {
      id: createId(),
      organizationId: membership.organizationId,
      memberId: membership.id,
      userId: membership.userId,
      clientInstanceId: client!.id,
      authenticationSessionId: session.id,
      requestedScopes: ["read"],
      expiresAt: new Date(Date.now() + 60000),
    });
  }
  return { db, userId };
}
test("disable reconciles unrevoked contexts on an already-disabled user as an applied effect", async () => {
  const { db, userId } = await seedGrantContexts();
  await db
    .update(users)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(users.id, userId));
  expect((await service.disableUser(db, actor, userId)).changed).toBe(true);
  for (const row of await db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.userId, userId)))
    expect(row.revokedAt).toBeInstanceOf(Date);
  expect((await events(userId))[0]!.data).toMatchObject({
    before: { status: "disabled" },
    after: { status: "disabled" },
  });
  expect((await service.disableUser(db, actor, userId)).changed).toBe(false);
});
