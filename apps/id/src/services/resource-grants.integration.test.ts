import { listUserAuditEvents } from "./audit.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  inPlatformWrite,
  inPlatformRead,
} from "../__tests__/platform-context.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  grantContexts,
  members,
  oauthClients,
  oauthResources,
  organizations,
  sessions,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { disableResource, enableResource, eraseResource } from "./resources.ts";

let connection: DatabaseConnection;
const environment = testEnvironment();
beforeAll(() => {
  connection = createDatabase(environment);
});
afterAll(() => connection.close());
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
});
async function seed() {
  const db = connection.db;
  const userId = createId();
  const authTime = new Date();
  const sessionId = createId();
  await db.insert(users).values({
    id: userId,
    name: "User",
    email: `${userId}@example.com`,
    status: "active",
  });
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token: createId(),
    createdAt: authTime,
    expiresAt: new Date(Date.now() + 60000),
  });
  const [client] = await db
    .insert(oauthClients)
    .values({
      id: createId(),
      clientId: "resource-grants",
      redirectUris: [],
      scopes: ["read"],
    })
    .returning();
  const resources = await db
    .insert(oauthResources)
    .values(
      ["target", "other"].map((name) => ({
        id: createId(),
        identifier: `https://${name}.example`,
        name,
        allowedScopes: ["read"],
      })),
    )
    .returning();
  const contexts = [];
  for (const name of ["a", "b"]) {
    const organizationId = createId();
    const memberId = createId();
    await db
      .insert(organizations)
      .values({ id: organizationId, slug: name, name });
    await db.insert(members).values({ id: memberId, organizationId, userId });
    for (const resource of resources) {
      const [context] = await db
        .insert(grantContexts)
        .values({
          id: createId(),
          organizationId,
          memberId,
          userId,
          clientInstanceId: client!.id,
          resourceInstanceId: resource.id,
          authenticationSessionId: sessionId,
          authTime,
          requestedScopes: ["read"],
          expiresAt: new Date(Date.now() + 60000),
        })
        .returning();
      contexts.push(context!);
    }
  }
  return { db, target: resources[0]!, contexts, sessionId };
}

test("resource disable revokes its contexts across tenants, preserves other resources and never revives old authority", async () => {
  const { db, target, contexts, sessionId } = await seed();
  expect(
    await inPlatformWrite(db, (context) =>
      disableResource(context, target.identifier),
    ),
  ).toMatchObject({ changed: true });
  const after = await db.select().from(grantContexts);
  for (const row of after)
    expect(row.revokedAt !== null).toBe(row.resourceInstanceId === target.id);
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "resource.disabled"));
  expect(event!.organizationId).toBeNull();
  expect(event!.data!.effects).toEqual({
    revokedGrantContexts: expect.arrayContaining(
      contexts
        .filter((row) => row.resourceInstanceId === target.id)
        .map(({ id, organizationId, userId }) => ({
          id,
          organizationId,
          userId,
        })),
    ),
  });
  expect(
    (event!.data!.effects as { revokedGrantContexts: unknown[] })
      .revokedGrantContexts,
  ).toHaveLength(2);
  expect(
    await inPlatformWrite(db, (context) =>
      disableResource(context, target.identifier),
    ),
  ).toMatchObject({ changed: false });
  await inPlatformWrite(db, (context) =>
    enableResource(context, target.identifier),
  );
  expect(
    await db.select().from(grantContexts).orderBy(grantContexts.id),
  ).toEqual(after.sort((a, b) => a.id.localeCompare(b.id)));
  expect(
    await db.select().from(sessions).where(eq(sessions.id, sessionId)),
  ).toHaveLength(1);
});

test("already-disabled resource reconciles remaining contexts and then becomes a no-op", async () => {
  const { db, target } = await seed();
  await db
    .update(oauthResources)
    .set({ disabled: true })
    .where(eq(oauthResources.id, target.id));
  expect(
    await inPlatformWrite(db, (context) =>
      disableResource(context, target.identifier),
    ),
  ).toMatchObject({ changed: true });
  expect(
    await inPlatformWrite(db, (context) =>
      disableResource(context, target.identifier),
    ),
  ).toMatchObject({ changed: false });
});

test("resource deletion records every revoked context, preserving unrelated authority", async () => {
  const { db, target, contexts } = await seed();
  await inPlatformWrite(db, (context) =>
    eraseResource(context, target.identifier, target.identifier),
  );
  expect(
    await db.select().from(grantContexts).orderBy(grantContexts.id),
  ).toEqual(
    contexts
      .map((row) =>
        row.resourceInstanceId === target.id
          ? { ...row, revokedAt: expect.any(Date) }
          : row,
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "resource.erased"));
  expect(event!.organizationId).toBeNull();
  expect(event!.data!.revokedGrantContexts).toEqual(
    expect.arrayContaining(
      contexts
        .filter((row) => row.resourceInstanceId === target.id)
        .map(({ id, organizationId, userId }) => ({
          id,
          organizationId,
          userId,
        })),
    ),
  );
  expect(event!.data!.revokedGrantContexts).toHaveLength(2);
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

for (const mode of ["disable", "erase"] as const) {
  test(`resource ${mode} rolls back context effects when audit fails`, async () => {
    const { db, target, contexts } = await seed();
    await expect(
      inPlatformWrite(
        db,
        async (context) => {
          if (mode === "disable")
            await disableResource(context, target.identifier);
          else
            await eraseResource(context, target.identifier, target.identifier);
        },
        { requestId: "\0" },
      ),
    ).rejects.toThrow();
    expect(
      await db.select().from(grantContexts).orderBy(grantContexts.id),
    ).toEqual(contexts.sort((a, b) => a.id.localeCompare(b.id)));
    expect(
      await db
        .select()
        .from(oauthResources)
        .where(eq(oauthResources.id, target.id)),
    ).toEqual([target]);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });
}
