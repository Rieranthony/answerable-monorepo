import {
  listUserAuditEvents,
  listAuditEvents,
} from "../__tests__/audit-queries.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql, isNull } from "drizzle-orm";
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
import * as implementation from "./users.ts";
import {
  inPlatformRead,
  inPlatformUsers,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import type { Database } from "../db/client.ts";
const service = {
  ...implementation,
  eraseUser: (db: Database, actor: Actor, id: string, confirm: string) =>
    inPlatformWrite(
      db,
      (context) => implementation.eraseUser(context, id, confirm),
      actor,
    ),
  disableUser: (db: Database, actor: Actor, userId: string) =>
    inPlatformUsers(
      db,
      (context) => implementation.disableUser(context, userId),
      actor,
    ),
  enableUser: (db: Database, actor: Actor, userId: string) =>
    inPlatformUsers(
      db,
      (context) => implementation.enableUser(context, userId),
      actor,
    ),
  retireUserEmail: (db: Database, actor: Actor, userId: string) =>
    inPlatformUsers(
      db,
      (context) => implementation.retireUserEmail(context, userId),
      actor,
    ),
  listUsers: (
    db: Database,
    arg1: Parameters<typeof implementation.listUsers>[1],
  ) => inPlatformRead(db, (context) => implementation.listUsers(context, arg1)),
  getUser: (db: Database, arg1: Parameters<typeof implementation.getUser>[1]) =>
    inPlatformRead(db, (context) => implementation.getUser(context, arg1)),
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
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token: createId(),
    createdAt: authTime,
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
for (const kind of ["session", "access", "refresh"] as const) {
  test(`disabling an already-disabled user reconciles remaining ${kind} state`, async () => {
    const db = connection.db;
    const id = await seed();
    const other = await seed();
    await service.disableUser(db, actor, id);
    const before = await db.select().from(users).where(eq(users.id, id));
    const lateId = createId();
    if (kind === "session") {
      await db.insert(sessions).values({
        id: lateId,
        userId: id,
        token: createId(),
        expiresAt: new Date(Date.now() + 60000),
      });
    } else {
      await db
        .insert(kind === "access" ? oauthAccessTokens : oauthRefreshTokens)
        .values({
          id: lateId,
          userId: id,
          clientId: id,
          token: createId(),
          scopes: [],
          expiresAt: new Date(Date.now() + 60000),
        });
    }
    expect(await service.disableUser(db, actor, id)).toMatchObject({
      changed: true,
    });
    expect(await db.select().from(users).where(eq(users.id, id))).toEqual(
      before,
    );
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, id)),
    ).toHaveLength(0);
    for (const table of [oauthAccessTokens, oauthRefreshTokens]) {
      const rows = await db.select().from(table).where(eq(table.userId, id));
      expect(rows.every((row) => row.revoked !== null)).toBe(true);
      const retained = await db
        .select()
        .from(table)
        .where(eq(table.userId, other));
      expect(retained.every((row) => row.revoked === null)).toBe(true);
    }
    const evidence = (await events(id)).at(-1)!;
    expect(evidence).toMatchObject({
      action: "user.disabled",
      data: {
        before: { status: "disabled" },
        after: { status: "disabled" },
        sessions: kind === "session" ? 1 : 0,
        sessionIds: kind === "session" ? [lateId] : [],
        accessTokens: kind === "access" ? 1 : 0,
        refreshTokens: kind === "refresh" ? 1 : 0,
        revokedGrantContexts: [],
      },
    });
    expect(await service.disableUser(db, actor, id)).toMatchObject({
      changed: false,
    });
    expect(await db.select().from(users).where(eq(users.id, id))).toEqual(
      before,
    );
  });
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
  expect(await service.enableUser(db, actor, id)).toMatchObject({
    changed: false,
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
    changed: true,
    row: { status: "disabled", disabledAt: expect.any(Date) },
  });
  expect(await service.disableUser(db, actor, id)).toMatchObject({
    changed: false,
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
  expect(
    (await events(id)).filter((event) => event.action === "user.disabled"),
  ).toMatchObject([
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
    changed: true,
    row: { status: "active", disabledAt: null },
  });
  expect((await service.getUser(db, id)).sessionCount).toBe(0);
  await service.disableUser(db, actor, id);
  expect(await service.retireUserEmail(db, actor, id)).toMatchObject({
    changed: true,
    row: { email: id + "@retired.invalid", retiredEmail: id + "@example.com" },
  });
  expect(await service.retireUserEmail(db, actor, id)).toMatchObject({
    changed: false,
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
    "user.enable_unchanged",
    "user.disabled",
    "user.disable_unchanged",
    "user.enabled",
    "user.disabled",
    "user.email_retired",
    "user.email_retirement_unchanged",
    "user.erased",
  ]);
  expect(audit[3]?.data).toMatchObject({
    before: { status: "disabled" },
    after: { status: "active" },
  });
  expect(audit[4]?.data).toMatchObject({
    sessions: 0,
    sessionIds: [],
    refreshTokens: 0,
    accessTokens: 0,
  });
  expect(audit[5]?.data).toMatchObject({
    before: { emailRetired: false },
    after: { emailRetired: true },
  });
  expect(JSON.stringify(audit)).not.toContain(id + "@example.com");
  expect(audit[7]).toMatchObject({
    targetId: id,
    organizationId: null,
    data: {
      before: { id },
      after: { id, status: "disabled", deletedAt: expect.any(String) },
      deletionMode: "soft",
    },
  });
  expect(await service.disableUser(db, actor, other)).toMatchObject({
    row: { status: "disabled" },
    changed: true,
  });
});
test("erase cascades live memberships, accounts, sessions and tokens", async () => {
  const db = connection.db;
  const id = await seed();
  await service.eraseUser(db, actor, id, id);
  for (const table of [members, accounts])
    expect(
      await db.select().from(table).where(eq(table.userId, id)),
    ).toMatchObject([{ deletedAt: expect.any(Date) }]);
  for (const table of [sessions, oauthRefreshTokens, oauthAccessTokens])
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

async function seedGrantContexts() {
  const db = connection.db;
  const userId = await seed();
  const otherUserId = await seed();
  const extraOrg = createId();
  await db
    .insert(organizations)
    .values({ id: extraOrg, slug: extraOrg, name: "Second tenant" });
  await db
    .insert(members)
    .values({ id: createId(), organizationId: extraOrg, userId });
  await db.update(oauthClients).set({ scopes: ["read"] });
  await db
    .update(oauthClients)
    .set({ userId })
    .where(eq(oauthClients.clientId, userId));
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, userId));
  const contexts: (typeof grantContexts.$inferSelect)[] = [];
  for (const membership of await db.select().from(members)) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, membership.userId));
    const [grant] = await db
      .insert(grantContexts)
      .values({
        id: createId(),
        organizationId: membership.organizationId,
        memberId: membership.id,
        userId: membership.userId,
        clientInstanceId: client!.id,
        authenticationSessionId: session!.id,
        authTime: session!.createdAt,
        requestedScopes: ["read"],
        expiresAt: new Date(Date.now() + 60000),
      })
      .returning();
    contexts.push(grant!);
  }
  const [otherClient] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, otherUserId));
  const template = contexts.find((row) => row.userId === otherUserId)!;
  const [independent] = await db
    .insert(grantContexts)
    .values({ ...template, id: createId(), clientInstanceId: otherClient!.id })
    .returning();
  return { db, userId, otherUserId, contexts, independent: independent! };
}

test("global disable irreversibly revokes that user's contexts across tenants without disabling another user", async () => {
  const { db, userId, otherUserId, contexts } = await seedGrantContexts();
  const expected = contexts
    .filter((row) => row.userId === userId)
    .map(({ id, organizationId }) => ({ id, organizationId }));
  expect(expected).toHaveLength(2);
  expect((await service.disableUser(db, actor, userId)).changed).toBe(true);
  const revoked = await db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.userId, userId));
  for (const row of revoked) expect(row.revokedAt).toBeInstanceOf(Date);
  for (const row of await db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.userId, otherUserId)))
    expect(row.revokedAt).toBeNull();
  expect((await events(userId))[0]!.data).toMatchObject({
    revokedGrantContexts: expect.arrayContaining(expected),
  });
  expect((await service.disableUser(db, actor, userId)).changed).toBe(false);
  expect((await events(userId))[1]!.data).toMatchObject({
    revokedGrantContexts: [],
  });
  await service.enableUser(db, actor, userId);
  expect(
    await db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.userId, userId)),
  ).toEqual(revoked);
});

test("user erasure audits all deleted contexts including another user's grant through its owned client", async () => {
  const { db, userId, contexts, independent } = await seedGrantContexts();
  await service.eraseUser(db, actor, userId, userId);
  expect(
    await db
      .select()
      .from(grantContexts)
      .where(isNull(grantContexts.revokedAt)),
  ).toEqual([independent]);
  const retainedContexts = await db.select().from(grantContexts);
  expect(retainedContexts).toHaveLength(contexts.length + 1);
  for (const context of contexts)
    expect(
      retainedContexts.find((row) => row.id === context.id)?.revokedAt,
    ).toBeInstanceOf(Date);
  const [event] = await events(userId);
  expect(event!.data).toMatchObject({
    revokedGrantContexts: expect.arrayContaining(
      contexts.map(({ id, organizationId, userId }) => ({
        id,
        organizationId,
        userId,
      })),
    ),
  });
  expect(
    (
      await listUserAuditEvents(db, independent.userId, {}, { limit: 10 })
    ).items.map((row) => row.id),
  ).toEqual([event!.id]);
  expect(
    (await listUserAuditEvents(db, userId, {}, { limit: 10 })).items.map(
      (row) => row.id,
    ),
  ).toEqual([event!.id]);
  expect(
    (
      await listAuditEvents(
        db,
        { organizationId: independent.organizationId },
        { limit: 10 },
      )
    ).items,
  ).toEqual([]);
  await db.delete(users).where(eq(users.id, independent.userId));
  expect(
    (
      await listUserAuditEvents(db, independent.userId, {}, { limit: 10 })
    ).items.map((row) => row.id),
  ).toEqual([event!.id]);
});

test("global user audit failure restores grant contexts for disable and erasure", async () => {
  const { db, userId } = await seedGrantContexts();
  const before = await db.select().from(grantContexts);
  const invalid = { ...actor, requestId: "\0" };
  await expect(service.disableUser(db, invalid, userId)).rejects.toThrow();
  expect(await db.select().from(grantContexts)).toEqual(before);
  await expect(
    service.eraseUser(db, invalid, userId, userId),
  ).rejects.toThrow();
  expect(await db.select().from(grantContexts)).toEqual(before);
  expect(await events(userId)).toHaveLength(0);
});

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
