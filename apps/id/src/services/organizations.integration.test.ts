import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
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
import * as service from "./organizations.ts";

let connection: DatabaseConnection;
const actor: Actor = {
  actorType: "user",
  actorId: createId(),
  requestId: "service-test",
  ip: "192.0.2.1",
  userAgent: "test",
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
  ).toMatchObject(patch);
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    ...actor,
    organizationId: row.id,
    targetId: row.id,
    targetType: "organization",
    action: "organization.created",
    outcome: "success",
    data: input,
  });
  expect(events[1]).toMatchObject({
    action: "organization.updated",
    data: { changes: patch },
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

test("kill switch covers two members and an owned client without double counting; enable restores no sessions", async () => {
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
  await expect(
    service.enableOrganization(db, actor, row.id),
  ).rejects.toMatchObject({ code: "organization_already_active", status: 409 });
  expect(await service.disableOrganization(db, actor, row.id)).toMatchObject({
    status: "disabled",
    disabledAt: expect.any(Date),
  });
  await expect(
    service.disableOrganization(db, actor, row.id),
  ).rejects.toMatchObject({
    code: "organization_already_disabled",
    status: 409,
  });
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "organization.disabled"));
  expect(event?.data).toEqual({
    sessions: 2,
    refreshTokens: 5,
    accessTokens: 6,
  });
  expect((await db.select().from(sessions)).map((r) => r.userId)).toEqual([
    userIds[2],
  ]);
  for (const table of [oauthRefreshTokens, oauthAccessTokens]) {
    const rows = await db.select().from(table);
    expect(rows.filter((r) => r.revoked === null)).toHaveLength(1);
    expect(rows.find((r) => r.revoked === null)).toMatchObject({
      userId: userIds[2],
      clientId: "other",
    });
  }
  expect(await service.enableOrganization(db, actor, row.id)).toMatchObject({
    status: "active",
    disabledAt: null,
  });
  expect(await db.select().from(sessions)).toHaveLength(1);
  expect(await db.select().from(auditEvents)).toHaveLength(3);
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
  expect(await db.select().from(organizations)).toHaveLength(0);
  expect(await db.select().from(members)).toHaveLength(0);
  expect(await db.select().from(organizationDomains)).toHaveLength(0);
  expect(await db.select().from(users)).toHaveLength(1);
  const events = await db.select().from(auditEvents);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e.organizationId === null)).toBe(true);
  expect(events.find((e) => e.action === "organization.erased")).toMatchObject({
    targetId: row.id,
    organizationId: null,
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
  await expect(
    service.disableOrganization(db, invalidActor, row.id),
  ).rejects.toThrow();
  expect(await service.getOrganization(db, row.id)).toMatchObject({
    name: "Original",
    status: "active",
  });
  expect(await db.select().from(sessions)).toHaveLength(1);
  expect((await db.select().from(oauthRefreshTokens))[0]?.revoked).toBeNull();
  expect((await db.select().from(oauthAccessTokens))[0]?.revoked).toBeNull();
  await service.disableOrganization(db, actor, row.id);
  await expect(
    service.enableOrganization(db, invalidActor, row.id),
  ).rejects.toThrow();
  expect(await service.getOrganization(db, row.id)).toMatchObject({
    status: "disabled",
  });
  await expect(
    service.eraseOrganization(db, invalidActor, row.id, row.id),
  ).rejects.toThrow();
  expect(await db.select().from(organizations)).toHaveLength(1);
  expect(await db.select().from(members)).toHaveLength(1);
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});
