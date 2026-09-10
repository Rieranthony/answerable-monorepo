import { listUserAuditEvents } from "./audit.ts";
import {
  inPlatformRead,
  inPlatformWrite,
} from "../__tests__/platform-context.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql, isNull } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  grantContexts,
  members,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  organizationDomains,
  organizations,
  sessions,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import type { Actor } from "./actor.ts";
import * as implementation from "./organizations.ts";
const service = {
  ...implementation,
  createOrganization: (
    db: Database,
    actor: Actor,
    input: Parameters<typeof implementation.createOrganization>[1],
  ) =>
    inPlatformWrite(
      db,
      (context) => implementation.createOrganization(context, input),
      actor,
    ),
  updateOrganization: (
    db: Database,
    actor: Actor,
    id: string,
    patch: Parameters<typeof implementation.updateOrganization>[2],
    expected?: Parameters<typeof implementation.updateOrganization>[3],
  ) =>
    inPlatformWrite(
      db,
      (context) =>
        implementation.updateOrganization(context, id, patch, expected),
      actor,
    ),
  disableOrganization: (db: Database, actor: Actor, id: string) =>
    inPlatformWrite(
      db,
      (context) => implementation.disableOrganization(context, id),
      actor,
    ),
  enableOrganization: (db: Database, actor: Actor, id: string) =>
    inPlatformWrite(
      db,
      (context) => implementation.enableOrganization(context, id),
      actor,
    ),
  eraseOrganization: (
    db: Database,
    actor: Actor,
    id: string,
    confirm: string,
  ) =>
    inPlatformWrite(
      db,
      (context) => implementation.eraseOrganization(context, id, confirm),
      actor,
    ),
  listOrganizations: (
    db: Database,
    query: Parameters<typeof implementation.listOrganizations>[1],
  ) =>
    inPlatformRead(db, (context) =>
      implementation.listOrganizations(context, query),
    ),
  getOrganization: (db: Database, org: string) =>
    inTenantRead(db, org, "directory", implementation.getOrganization),
};

let connection: DatabaseConnection;
const actor: Actor = {
  actorType: "system",
  actorId: "root",
  requestId: "service-test",
  ip: "192.0.2.1",
  userAgent: "test",
};
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

test("creates, lists, gets and updates with exactly one attributed audit per write", async () => {
  const db = connection.db;
  const input = { slug: "acme", name: "Acme" };
  const row = await service.createOrganization(db, actor, input);
  expect(await service.getOrganization(db, row.id)).toEqual(row);
  expect(await service.listOrganizations(db, { limit: 2 })).toEqual({
    items: [row],
    nextCursor: null,
  });
  const patch = { name: "Acme Ltd", logo: null, metadata: "{}" };
  expect(
    await service.updateOrganization(db, actor, row.id, patch),
  ).toMatchObject({ organization: patch, changed: true });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    ...actor,
    organizationId: row.id,
    targetId: row.id,
    targetType: "organization",
    action: "organization.created",
    outcome: "success",
    data: { before: null, after: input },
  });
  expect(events[1]).toMatchObject({
    action: "organization.updated",
    data: {
      before: { name: "Acme" },
      after: { name: "Acme Ltd", logo: null },
      metadataChanged: true,
    },
  });
});

test("all missing organisation paths return 404 and write no audit", async () => {
  const db = connection.db;
  const id = createId();
  for (const run of [
    () => service.getOrganization(db, id),
    () => service.updateOrganization(db, actor, id, { name: "Missing" }),
    () => service.disableOrganization(db, actor, id),
    () => service.enableOrganization(db, actor, id),
    () => service.eraseOrganization(db, actor, id, id),
  ])
    await expect(run()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

test("tenant kill switch revokes only machine rows and preserves global sessions and unbound user grants", async () => {
  const db = connection.db;
  const row = await service.createOrganization(db, actor, {
    slug: "kill",
    name: "Kill switch",
  });
  const userIds = [createId(), createId(), createId()];
  for (const id of userIds) {
    await db
      .insert(users)
      .values({ id, name: "User", email: id + "@example.com" });
    await db.insert(sessions).values({
      id: createId(),
      token: createId(),
      userId: id,
      expiresAt: new Date(Date.now() + 60000),
    });
  }
  for (const userId of userIds.slice(0, 2))
    await db
      .insert(members)
      .values({ id: createId(), organizationId: row.id, userId });
  for (const clientId of ["owned", "other"])
    await db.insert(oauthClients).values({
      id: createId(),
      clientId,
      redirectUris: [],
      organizationId: clientId === "owned" ? row.id : null,
    });
  for (const userId of userIds)
    for (const clientId of ["owned", "other"]) {
      const values = {
        id: createId(),
        token: createId(),
        clientId,
        userId,
        scopes: [],
        expiresAt: new Date(Date.now() + 60000),
      };
      await db.insert(oauthRefreshTokens).values(values);
      await db
        .insert(oauthAccessTokens)
        .values({ ...values, id: createId(), token: createId() });
    }
  await db.insert(oauthAccessTokens).values({
    id: createId(),
    clientId: "owned",
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  });
  expect(await service.enableOrganization(db, actor, row.id)).toMatchObject({
    organization: row,
    changed: false,
  });
  expect(await service.disableOrganization(db, actor, row.id)).toMatchObject({
    organization: { status: "disabled", disabledAt: expect.any(Date) },
    changed: true,
  });
  expect(await service.disableOrganization(db, actor, row.id)).toMatchObject({
    organization: { status: "disabled", authorizationVersion: 2 },
    changed: false,
  });
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "organization.disabled"));
  expect(event?.data).toMatchObject({
    before: { status: "active", authorizationVersion: 1 },
    after: { status: "disabled", authorizationVersion: 2 },
  });
  expect(
    (event!.data as { effects: { revokedMachineAccessTokenIds: string[] } })
      .effects.revokedMachineAccessTokenIds,
  ).toHaveLength(1);
  expect((await db.select().from(sessions)).map((r) => r.userId)).toEqual(
    userIds,
  );
  expect(
    (await db.select().from(oauthRefreshTokens)).every(
      (r) => r.revoked === null,
    ),
  ).toBe(true);
  const access = await db.select().from(oauthAccessTokens);
  expect(access.filter((r) => r.revoked !== null)).toHaveLength(1);
  expect(access.find((r) => r.revoked !== null)).toMatchObject({
    userId: null,
    clientId: "owned",
  });
  expect(await service.enableOrganization(db, actor, row.id)).toMatchObject({
    organization: { status: "active", disabledAt: null },
    changed: true,
  });
  expect(await db.select().from(sessions)).toHaveLength(3);
  expect(await service.getOrganization(db, row.id)).toMatchObject({
    authorizationVersion: 2,
  });
  expect(await db.select().from(auditEvents)).toHaveLength(5);
});

test("erase rejects confirmation and clients, cascades members and domains and retains audit", async () => {
  const db = connection.db;
  const row = await service.createOrganization(db, actor, {
    slug: "erase",
    name: "Erase",
  });
  await expect(
    service.eraseOrganization(db, actor, row.id, createId()),
  ).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
  const userId = createId();
  await db
    .insert(users)
    .values({ id: userId, name: "User", email: "erase@example.com" });
  await db
    .insert(members)
    .values({ id: createId(), userId, organizationId: row.id });
  await db.insert(organizationDomains).values({
    id: createId(),
    organizationId: row.id,
    domain: "erase.example.com",
  });
  await db.insert(oauthClients).values({
    id: createId(),
    clientId: "owned",
    organizationId: row.id,
    redirectUris: [],
  });
  await expect(
    service.eraseOrganization(db, actor, row.id, row.id),
  ).rejects.toMatchObject({ status: 409, code: "organization_has_clients" });
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  await db.delete(oauthClients).where(eq(oauthClients.clientId, "owned"));
  await service.eraseOrganization(db, actor, row.id, row.id);
  expect(await db.select().from(organizations)).toMatchObject([
    { deletedAt: expect.any(Date) },
  ]);
  expect(await db.select().from(members)).toMatchObject([
    { deletedAt: expect.any(Date) },
  ]);
  expect(await db.select().from(organizationDomains)).toMatchObject([
    { deletedAt: expect.any(Date) },
  ]);
  expect(await db.select().from(users)).toHaveLength(1);
  const events = await db.select().from(auditEvents);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e.organizationId === row.id)).toBe(true);
  expect(events.find((e) => e.action === "organization.erased")).toMatchObject({
    targetId: row.id,
    organizationId: row.id,
  });
});

test("audit failure rolls back each write and kill switch side effects", async () => {
  const db = connection.db;
  const row = await service.createOrganization(db, actor, {
    slug: "rollback",
    name: "Original",
  });
  // PostgreSQL text rejects NUL, causing the audit insert to fail after the mutation.
  const invalidActor = { ...actor, requestId: "\0" };
  await expect(
    service.createOrganization(db, invalidActor, {
      slug: "failed",
      name: "Failed",
    }),
  ).rejects.toThrow();
  await expect(
    service.updateOrganization(db, invalidActor, row.id, { name: "Failed" }),
  ).rejects.toThrow();
  const userId = createId();
  await db
    .insert(users)
    .values({ id: userId, name: "User", email: "rollback@example.com" });
  await db
    .insert(members)
    .values({ id: createId(), userId, organizationId: row.id });
  await db.insert(sessions).values({
    id: createId(),
    token: createId(),
    userId,
    expiresAt: new Date(Date.now() + 60000),
  });
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId: "external", redirectUris: [] });
  const token = {
    id: createId(),
    token: createId(),
    userId,
    clientId: "external",
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  };
  await db.insert(oauthRefreshTokens).values(token);
  await db.insert(oauthAccessTokens).values({ ...token, id: createId() });
  await db.insert(oauthClients).values({
    id: createId(),
    clientId: "owned-machine",
    organizationId: row.id,
    redirectUris: [],
  });
  const machineTokenId = createId();
  await db.insert(oauthAccessTokens).values({
    id: machineTokenId,
    clientId: "owned-machine",
    scopes: [],
    expiresAt: token.expiresAt,
  });
  await expect(
    service.disableOrganization(db, invalidActor, row.id),
  ).rejects.toThrow();
  expect(await service.getOrganization(db, row.id)).toMatchObject({
    name: "Original",
    status: "active",
    authorizationVersion: 1,
  });
  expect(await db.select().from(sessions)).toHaveLength(1);
  expect((await db.select().from(oauthRefreshTokens))[0]?.revoked).toBeNull();
  expect(
    (await db.select().from(oauthAccessTokens)).every(
      (row) => row.revoked === null,
    ),
  ).toBe(true);
  await service.disableOrganization(db, actor, row.id);
  expect(
    (
      await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.id, machineTokenId))
    )[0]!.revoked,
  ).toBeInstanceOf(Date);
  await db
    .delete(oauthClients)
    .where(eq(oauthClients.clientId, "owned-machine"));
  await expect(
    service.enableOrganization(db, invalidActor, row.id),
  ).rejects.toThrow();
  expect(await service.getOrganization(db, row.id)).toMatchObject({
    status: "disabled",
    authorizationVersion: 2,
  });
  await expect(
    service.eraseOrganization(db, invalidActor, row.id, row.id),
  ).rejects.toThrow();
  expect(await db.select().from(organizations)).toHaveLength(1);
  expect(await db.select().from(members)).toHaveLength(1);
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});

test("disabling tenant A preserves a shared person's global session and tenant B tokens", async () => {
  const db = connection.db;
  const a = await service.createOrganization(db, actor, {
    slug: "tenant-a",
    name: "A",
  });
  const b = await service.createOrganization(db, actor, {
    slug: "tenant-b",
    name: "B",
  });
  const userId = createId();
  await db.insert(users).values({
    id: userId,
    email: "shared@example.com",
    name: "Shared",
    status: "active",
  });
  for (const organizationId of [a.id, b.id])
    await db.insert(members).values({ id: createId(), organizationId, userId });
  const sessionId = createId();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token: createId(),
    expiresAt: new Date(Date.now() + 60000),
  });
  for (const [clientId, organizationId] of [
    ["a-client", a.id],
    ["b-client", b.id],
  ] as const)
    await db
      .insert(oauthClients)
      .values({ id: createId(), clientId, organizationId, redirectUris: [] });
  const tokenId = createId();
  await db.insert(oauthAccessTokens).values({
    id: tokenId,
    clientId: "b-client",
    userId,
    sessionId,
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  });
  const machineIds = [createId(), createId()];
  for (const [index, clientId] of ["a-client", "b-client"].entries())
    await db.insert(oauthAccessTokens).values({
      id: machineIds[index]!,
      clientId,
      scopes: [],
      expiresAt: new Date(Date.now() + 60000),
    });
  await service.disableOrganization(db, actor, a.id);
  const tokenRows = await db.select().from(oauthAccessTokens);
  expect(
    tokenRows.find((row) => row.id === machineIds[0])!.revoked,
  ).toBeInstanceOf(Date);
  expect(tokenRows.find((row) => row.id === machineIds[1])!.revoked).toBeNull();
  expect(
    await db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
  expect(
    (
      await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.id, tokenId))
    )[0]!.revoked,
  ).toBeNull();
});

async function seedTenantGrantContexts() {
  const db = connection.db;
  const a = await service.createOrganization(db, actor, {
    slug: "context-a",
    name: "A",
  });
  const b = await service.createOrganization(db, actor, {
    slug: "context-b",
    name: "B",
  });
  const userId = createId(),
    sessionId = createId(),
    clientInstanceId = createId();
  const authTime = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: "Shared",
    status: "active",
  });
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token: createId(),
    createdAt: authTime,
    expiresAt: new Date(Date.now() + 60000),
  });
  await db.insert(oauthClients).values({
    id: clientInstanceId,
    clientId: createId(),
    organizationId: b.id,
    redirectUris: [],
    scopes: ["read"],
  });
  const contexts = [];
  for (const org of [a, b]) {
    const memberId = createId();
    await db
      .insert(members)
      .values({ id: memberId, organizationId: org.id, userId });
    const [grant] = await db
      .insert(grantContexts)
      .values({
        id: createId(),
        organizationId: org.id,
        memberId,
        userId,
        clientInstanceId,
        authenticationSessionId: sessionId,
        authTime,
        requestedScopes: ["read"],
        expiresAt: new Date(Date.now() + 60000),
      })
      .returning();
    contexts.push(grant!);
  }
  return { db, a, b, userId, sessionId, contexts };
}

test("organisation disable irreversibly revokes only its tenant contexts and audits actual IDs", async () => {
  const { db, a, b, sessionId, contexts } = await seedTenantGrantContexts();
  expect((await service.disableOrganization(db, actor, a.id)).changed).toBe(
    true,
  );
  const [revoked] = await db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.organizationId, a.id));
  expect(revoked!.revokedAt).toBeInstanceOf(Date);
  expect(
    await db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.organizationId, b.id)),
  ).toEqual([contexts[1]!]);
  expect(
    await db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "organization.disabled"));
  expect(event!.data).toMatchObject({
    effects: {
      revokedGrantContexts: [
        { id: contexts[0]!.id, userId: contexts[0]!.userId },
      ],
    },
  });
  expect((await service.disableOrganization(db, actor, a.id)).changed).toBe(
    false,
  );
  await service.enableOrganization(db, actor, a.id);
  expect(
    await db
      .select()
      .from(grantContexts)
      .where(eq(grantContexts.organizationId, a.id)),
  ).toEqual([revoked!]);
});

test("organisation erasure records deleted contexts without deleting a shared user's other tenant", async () => {
  const { db, a, contexts } = await seedTenantGrantContexts();
  await service.eraseOrganization(db, actor, a.id, a.id);
  expect(
    await db
      .select()
      .from(grantContexts)
      .where(isNull(grantContexts.revokedAt)),
  ).toEqual([contexts[1]!]);
  expect(await db.select().from(grantContexts)).toHaveLength(2);
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "organization.erased"));
  expect(event!.data).toMatchObject({
    revokedGrantContexts: [
      { id: contexts[0]!.id, userId: contexts[0]!.userId },
    ],
  });
  const erasedUserId = contexts[0]!.userId;
  await db.delete(users).where(eq(users.id, erasedUserId));
  expect(
    (
      await inPlatformRead(db, (context) =>
        listUserAuditEvents(context, erasedUserId, {}, { limit: 10 }),
      )
    ).items,
  ).toEqual([event!]);
});

test("organisation audit failure rolls back context revocation and erasure", async () => {
  const { db, a, contexts } = await seedTenantGrantContexts();
  const invalid = { ...actor, requestId: "\0" };
  await expect(
    service.disableOrganization(db, invalid, a.id),
  ).rejects.toThrow();
  expect(await db.select().from(grantContexts)).toEqual(contexts);
  await expect(
    service.eraseOrganization(db, invalid, a.id, a.id),
  ).rejects.toThrow();
  expect(await db.select().from(grantContexts)).toEqual(contexts);
  await db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(organizations.id, a.id));
  expect((await service.disableOrganization(db, actor, a.id)).changed).toBe(
    true,
  );
  expect((await service.disableOrganization(db, actor, a.id)).changed).toBe(
    false,
  );
});
