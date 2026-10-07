import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  inPlatformWrite,
  inPlatformRead,
} from "../__tests__/platform-context.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import {
  insertGrantContext,
  insertOriginSession,
} from "../__tests__/grants.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  grantContexts,
  members,
  oauthClients,
  organizations,
  sessions,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  rotateSecret,
  disableClient,
  enableClient,
  eraseClient,
} from "./clients.ts";
import { listAuditEvents } from "../db/queries/audit.ts";
import { listUserAuditEvents, listOrganizationAuditEvents } from "./audit.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
afterAll(() => connection.close());
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
});
async function seed() {
  const db = connection.db;
  const tenants = await db
    .insert(organizations)
    .values(["a", "b"].map((name) => ({ id: createId(), name, slug: name })))
    .returning();
  const clients = await db
    .insert(oauthClients)
    .values(
      ["target", "other"].map((clientId) => ({
        id: createId(),
        clientId,
        organizationId: tenants[0]!.id,
        redirectUris: [],
        scopes: ["read"],
      })),
    )
    .returning();
  const contexts = [];
  for (const tenant of tenants) {
    const userId = createId(),
      memberId = createId();
    await db.insert(users).values({
      id: userId,
      name: "User",
      email: `${userId}@example.com`,
      status: "active",
    });
    await db
      .insert(members)
      .values({ id: memberId, organizationId: tenant.id, userId });
    const session = await insertOriginSession(db, {
      userId,
      organizationId: tenant.id,
    });
    for (const client of clients)
      contexts.push(
        await insertGrantContext(db, {
          id: createId(),
          organizationId: tenant.id,
          memberId,
          userId,
          clientInstanceId: client.id,
          authenticationSessionId: session.id,
          requestedScopes: ["read"],
          expiresAt: new Date(Date.now() + 60000),
        }),
      );
  }
  return {
    db,
    target: clients[0]!,
    contexts,
    ownerId: tenants[0]!.id,
    otherTenantId: tenants[1]!.id,
  };
}

for (const mode of ["disable", "erase"] as const) {
  test(`client ${mode} records complete effects without exposing foreign grants to its owner`, async () => {
    const { db, target, contexts, ownerId, otherTenantId } = await seed();
    const affected = contexts.filter(
      (row) => row.clientInstanceId === target.id,
    );
    await inPlatformWrite(db, async (context) => {
      if (mode === "disable") await disableClient(context, target.clientId);
      else await eraseClient(context, target.clientId, target.clientId);
    });
    const after = await db
      .select()
      .from(grantContexts)
      .orderBy(grantContexts.id);
    const unaffected = contexts.filter(
      (row) => row.clientInstanceId !== target.id,
    );
    expect(after.filter((row) => row.clientInstanceId !== target.id)).toEqual(
      unaffected.sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      after.filter((row) => row.clientInstanceId === target.id),
    ).toHaveLength(2);
    for (const row of after.filter((row) => row.clientInstanceId === target.id))
      expect(row.revokedAt).not.toBeNull();
    const all = await inPlatformRead(db, (context) =>
      listAuditEvents(context, { targetId: target.clientId }, { limit: 20 }),
    );
    const effect = all.items.find(
      (row) =>
        row.action ===
        (mode === "disable" ? "client.grants_revoked" : "client.grants_erased"),
    );
    expect(effect).toBeDefined();
    expect(effect!.organizationId).toBeNull();
    expect(effect!.data).toEqual({
      clientInstanceId: target.id,
      ...(mode === "disable"
        ? { revokedTokens: { access: [], refresh: [] } }
        : {
            deletionMode: "soft",
            effects: {
              deletedAccessTokens: [],
              deletedRefreshTokens: [],
              softDeletedConsents: [],
              softDeletedClientResources: [],
            },
          }),
      grantContexts: expect.arrayContaining(
        affected.map(({ id, organizationId, userId }) => ({
          id,
          organizationId,
          userId,
        })),
      ),
    });
    expect(effect!.data!.grantContexts).toHaveLength(2);
    const owner = await inTenantRead(db, ownerId, "history", (context) =>
      listOrganizationAuditEvents(
        context,
        { targetId: target.clientId },
        { limit: 20 },
      ),
    );
    expect(owner.items).toHaveLength(1);
    expect(owner.items[0]!.data!.grantEffectsEventId).toBe(effect!.id);
    for (const row of affected)
      expect(JSON.stringify(owner)).not.toContain(row.id);
    expect(JSON.stringify(owner)).not.toContain(otherTenantId);
    expect(JSON.stringify(owner)).not.toContain(
      affected.find((row) => row.organizationId === otherTenantId)!.userId,
    );
    expect(await db.select().from(sessions)).toHaveLength(2);
    if (mode === "disable") {
      expect(
        await inPlatformWrite(db, (context) =>
          disableClient(context, target.clientId),
        ),
      ).toMatchObject({ changed: false });
      await inPlatformWrite(db, (context) =>
        enableClient(context, target.clientId),
      );
      expect(
        await db.select().from(grantContexts).orderBy(grantContexts.id),
      ).toEqual(after);
      expect(
        await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "client.grants_revoked")),
      ).toHaveLength(1);
    }
    const erasedUserId = affected.find(
      (row) => row.organizationId === otherTenantId,
    )!.userId;
    expect(
      (
        await inPlatformRead(db, (context) =>
          listUserAuditEvents(context, erasedUserId, {}, { limit: 20 }),
        )
      ).items,
    ).toEqual([effect!]);
  });
}
test("already-disabled client reconciles remaining contexts before reporting a no-op", async () => {
  const { db, target } = await seed();
  await db
    .update(oauthClients)
    .set({ disabled: true })
    .where(eq(oauthClients.id, target.id));
  expect(
    await inPlatformWrite(db, (context) =>
      disableClient(context, target.clientId),
    ),
  ).toMatchObject({ changed: true });
  expect(
    await inPlatformWrite(db, (context) =>
      disableClient(context, target.clientId),
    ),
  ).toMatchObject({ changed: false });
});

for (const failAudit of [false, true]) {
  test(`secret rotation ${failAudit ? "rolls back" : "revokes"} existing client contexts atomically`, async () => {
    const { db, target, contexts, ownerId } = await seed();
    const [before] = await db
      .update(oauthClients)
      .set({
        tokenEndpointAuthMethod: "client_secret_basic",
        clientSecret: "old-digest",
      })
      .where(eq(oauthClients.id, target.id))
      .returning();
    const command = inPlatformWrite(
      db,
      (context) => rotateSecret(context, target.clientId),
      { requestId: failAudit ? "\0" : "rotate-contexts" },
    );
    if (failAudit) {
      await expect(command).rejects.toThrow();
      expect(
        await db.select().from(grantContexts).orderBy(grantContexts.id),
      ).toEqual(contexts.sort((a, b) => a.id.localeCompare(b.id)));
      expect(
        await db
          .select()
          .from(oauthClients)
          .where(eq(oauthClients.id, target.id)),
      ).toEqual([before!]);
      expect(await db.select().from(auditEvents)).toHaveLength(0);
      return;
    }
    const result = await command;
    const after = await db.select().from(grantContexts);
    for (const row of after)
      expect(row.revokedAt !== null).toBe(row.clientInstanceId === target.id);
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, target.id));
    expect(client!.authorizationVersion).toBe(before!.authorizationVersion + 1);
    expect(client!.clientSecret).not.toBe(before!.clientSecret);
    const events = await db.select().from(auditEvents);
    const effect = events.find(
      (row) => row.action === "client.grants_revoked",
    )!;
    expect(effect).toBeDefined();
    expect(effect.organizationId).toBeNull();
    expect(effect.data!.grantContexts).toHaveLength(2);
    expect(
      events.find((row) => row.action === "client.secret_rotated"),
    ).toMatchObject({
      organizationId: ownerId,
      data: { grantEffectsEventId: effect.id },
    });
    expect(JSON.stringify(events)).not.toContain(result.clientSecret);
    expect(JSON.stringify(events)).not.toContain("old-digest");
    expect(await db.select().from(sessions)).toHaveLength(2);
  });
}

test("client creation waits for organisation erasure and returns not_found after it commits", async () => {
  const { createClient } = await import("./clients.ts");
  const blocker = createDatabase(testEnvironment());
  const organizationId = createId();
  await connection.db.insert(organizations).values({
    id: organizationId,
    slug: "creation-race",
    name: "Creation race",
  });
  const backend = await connection.db.execute<{ pid: number }>(
    sql`select pg_backend_pid() as pid`,
  );
  const pid = backend.rows[0]!.pid;
  let creation: Promise<unknown> | undefined;
  try {
    await blocker.db.transaction(async (tx) => {
      await tx
        .delete(organizations)
        .where(eq(organizations.id, organizationId));
      creation = inPlatformWrite(connection.db, (context) =>
        createClient(context, {
          organizationId,
          clientId: "creation-race",
          name: "Creation race",
          grantTypes: ["client_credentials"],
          redirectUris: [],
          tokenEndpointAuthMethod: "client_secret_basic",
          clientCredentialsScopes: ["read"],
        }),
      ).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const state = await tx.execute<{ waiting: boolean }>(
          sql`select cardinality(pg_blocking_pids(${pid})) > 0 as waiting`,
        );
        waiting = state.rows[0]!.waiting;
        if (waiting) break;
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
    });
    expect(await creation).toMatchObject({
      error: { status: 404, code: "not_found" },
    });
    expect(await connection.db.select().from(oauthClients)).toEqual([]);
    expect(await connection.db.select().from(auditEvents)).toEqual([]);
  } finally {
    await creation;
    await blocker.close();
  }
});
