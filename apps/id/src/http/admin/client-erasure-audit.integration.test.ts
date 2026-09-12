import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import {
  adminOperations,
  auditEvents,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthClients,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_client_erasure_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = { ...fixture.environment, databaseUrl: url.toString() };
  runtime = createDatabase(environment);
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, environment),
    environment,
  });
});
afterEach(async () => {
  await runtime?.close();
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});
function request(
  path: string,
  method = "GET",
  key = createId(),
  kind: "platformAdmin" | "platformReader" | "tenantReader" = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  headers.set("Idempotency-Key", key);
  return app.request(`/api/admin/v1${path}`, { method, headers });
}
const sorted = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

import {
  oauthConsents,
  oauthClientResources,
  oauthResources,
} from "../../db/schema/index.ts";

test("restricted client erasure records exact cascades with private cross-client effects and atomic recovery", async () => {
  const db = fixture.db;
  const clientId = createId(),
    clientInstanceId = createId();
  const userId = createId(),
    indirectUserId = createId();
  for (const id of [userId, indirectUserId])
    await db
      .insert(users)
      .values({ id, name: "Private name", email: `${id}@private.example` });
  await db.insert(oauthClients).values({
    id: clientInstanceId,
    clientId,
    organizationId: fixture.tenant.organizationId,
    redirectUris: [],
    clientSecret: "private-digest",
  });
  const sessionId = createId();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token: "private-session",
    expiresAt: new Date(Date.now() + 60000),
  });
  const refreshId = createId(),
    accessId = createId(),
    indirectId = createId(),
    consentId = createId(),
    linkId = createId(),
    resourceId = createId();
  const expiresAt = new Date(Date.now() + 60000);
  await db.insert(oauthRefreshTokens).values({
    id: refreshId,
    clientId,
    userId,
    sessionId,
    token: "private-refresh",
    scopes: ["read"],
    expiresAt,
    revoked: new Date("2020-01-01"),
  });
  await db.insert(oauthAccessTokens).values([
    {
      id: accessId,
      clientId,
      userId: null,
      token: "private-access",
      scopes: ["read"],
      expiresAt,
    },
    {
      id: indirectId,
      clientId: fixture.platform.client.clientId,
      userId: indirectUserId,
      refreshId,
      token: "private-indirect",
      scopes: ["read"],
      expiresAt,
    },
  ]);
  await db
    .insert(oauthConsents)
    .values({ id: consentId, clientId, userId, scopes: ["read"] });
  await db.insert(oauthResources).values({
    id: resourceId,
    identifier: "https://private-erasure.example/mcp",
    name: "Private resource",
    allowedScopes: ["read"],
    classification: "tenant_owned",
    organizationId: fixture.outsider.organizationId,
  });
  await db.insert(oauthClientResources).values({
    id: linkId,
    clientId,
    resourceId: "https://private-erasure.example/mcp",
  });
  const snapshot = async () => ({
    access: sorted(await db.select().from(oauthAccessTokens)),
    refresh: sorted(await db.select().from(oauthRefreshTokens)),
    consents: sorted(await db.select().from(oauthConsents)),
    links: sorted(await db.select().from(oauthClientResources)),
    sessions: sorted(await db.select().from(sessions)),
    users: sorted(await db.select().from(users)),
    clients: sorted(await db.select().from(oauthClients)),
    operations: sorted(await db.select().from(adminOperations)),
    events: sorted(await db.select().from(auditEvents)),
  });
  const before = await snapshot(),
    key = createId();
  const path = `/clients/${clientId}?confirm=${clientId}`;
  for (const fault of ["subject", "owner"]) {
    await db.execute(
      sql.raw(
        fault === "subject"
          ? `alter table audit_event_subjects add constraint client_erasure_fault check (entity_id <> '${indirectUserId}') not valid`
          : `alter table audit_events add constraint client_erasure_fault check (action <> 'client.erased') not valid`,
      ),
    );
    try {
      expect((await request(path, "DELETE", key)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.execute(
        sql.raw(
          `alter table ${fault === "subject" ? "audit_event_subjects" : "audit_events"} drop constraint client_erasure_fault`,
        ),
      );
    }
  }
  const response = await request(path, "DELETE", key);
  expect(response.status).toBe(204);
  const operationId = response.headers.get("Operation-Id")!;
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, operationId));
  expect(events).toHaveLength(2);
  const effect = events.find((row) => row.action === "client.grants_erased")!;
  expect(effect).toMatchObject({
    schemaVersion: 3,
    organizationId: null,
    data: { clientInstanceId, grantContexts: [] },
  });
  const effects = effect.data!.effects as Record<string, { id: string }[]>;
  expect(Object.keys(effects).sort()).toEqual([
    "deletedAccessTokens",
    "deletedRefreshTokens",
    "softDeletedClientResources",
    "softDeletedConsents",
  ]);
  expect(effects.deletedAccessTokens!.map((row) => row.id).sort()).toEqual(
    [accessId, indirectId].sort(),
  );
  expect(effects.deletedRefreshTokens!.map((row) => row.id)).toEqual([
    refreshId,
  ]);
  expect(effects.softDeletedConsents!.map((row) => row.id)).toEqual([
    consentId,
  ]);
  expect(effects.softDeletedClientResources!.map((row) => row.id)).toEqual([
    linkId,
  ]);
  expect(effects.deletedAccessTokens).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: indirectId,
        userId: indirectUserId,
        clientId: fixture.platform.client.clientId,
        refreshId,
      }),
    ]),
  );
  const after = await snapshot();
  expect(after.access).toEqual(
    before.access.filter((row) => ![accessId, indirectId].includes(row.id)),
  );
  expect(after.refresh).toEqual(
    before.refresh.filter((row) => row.id !== refreshId),
  );
  expect(after.consents).toEqual(
    before.consents.map((row) =>
      row.id === consentId
        ? { ...row, deletedAt: expect.any(Date), updatedAt: expect.any(Date) }
        : row,
    ),
  );
  expect(after.links).toEqual(
    before.links.map((row) =>
      row.id === linkId ? { ...row, deletedAt: expect.any(Date) } : row,
    ),
  );
  expect(after.clients).toHaveLength(before.clients.length);
  expect(after.clients.filter((row) => row.id !== clientInstanceId)).toEqual(
    before.clients.filter((row) => row.id !== clientInstanceId),
  );
  expect(
    after.clients.find((row) => row.id === clientInstanceId),
  ).toMatchObject({
    disabled: true,
    deletedAt: expect.any(Date),
    clientSecret: null,
  });
  expect(after.users).toEqual(before.users);
  expect(after.sessions).toEqual(before.sessions);
  const owner = await request(
    `/organizations/${fixture.tenant.organizationId}/audit-events?targetId=${clientId}`,
    "GET",
    createId(),
    "tenantReader",
  );
  expect(owner.status).toBe(200);
  const ownerBody = await owner.text();
  expect(ownerBody).toContain(effect.id);
  for (const privateValue of [
    userId,
    indirectUserId,
    accessId,
    indirectId,
    refreshId,
    consentId,
    linkId,
    "https://private-erasure.example/mcp",
  ])
    expect(ownerBody).not.toContain(privateValue);
  for (const secret of [
    "private-digest",
    "private-session",
    "private-refresh",
    "private-access",
    "private-indirect",
    "Private name",
  ])
    expect(JSON.stringify(events)).not.toContain(secret);
  await db.delete(users).where(eq(users.id, indirectUserId));
  const history = await request(
    `/users/${indirectUserId}/audit-events`,
    "GET",
    createId(),
    "platformReader",
  );
  expect(history.status).toBe(200);
  expect(
    (await history.json()).items.map((row: { id: string }) => row.id),
  ).toContain(effect.id);
  const replay = await request(path, "DELETE", key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(replay.headers.get("Operation-Id")).toBe(operationId);
  expect(
    await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId)),
  ).toEqual(events);
});

test("client erasure captures a cross-client token committed while waiting for its refresh parent", async () => {
  const db = fixture.db;
  const userId = createId(),
    clientId = createId(),
    refreshId = createId(),
    lateId = createId();
  await db
    .insert(users)
    .values({ id: userId, name: "User", email: `${userId}@race.example` });
  await db.insert(oauthClients).values({
    id: createId(),
    clientId,
    organizationId: fixture.tenant.organizationId,
    redirectUris: [],
  });
  await db.insert(oauthRefreshTokens).values({
    id: refreshId,
    userId,
    clientId,
    token: createId(),
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  });
  const blocker = createDatabase(fixture.environment);
  let erasure: Promise<Response> | undefined;
  try {
    await blocker.db.transaction(async (tx) => {
      const result = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      const pid = result.rows[0]!.pid;
      await tx
        .select({ id: oauthRefreshTokens.id })
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.id, refreshId))
        .for("key share");
      erasure = Promise.resolve(
        request(`/clients/${clientId}?confirm=${clientId}`, "DELETE"),
      );
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        await tx.execute(sql`select pg_stat_clear_snapshot()`);
        const state = await tx.execute<{ waiting: boolean }>(
          sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as waiting`,
        );
        if (state.rows[0]!.waiting) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await tx.insert(oauthAccessTokens).values({
        id: lateId,
        clientId: fixture.platform.client.clientId,
        userId,
        refreshId,
        scopes: [],
        expiresAt: new Date(Date.now() + 60000),
      });
    });
    const response = await erasure!;
    expect(response.status).toBe(204);
    const events = await db
      .select()
      .from(auditEvents)
      .where(
        eq(auditEvents.operationId, response.headers.get("Operation-Id")!),
      );
    const effect = events.find((row) => row.action === "client.grants_erased");
    expect(effect?.data).toMatchObject({
      effects: {
        deletedAccessTokens: [
          expect.objectContaining({
            id: lateId,
            refreshId,
            userId,
            clientId: fixture.platform.client.clientId,
          }),
        ],
      },
    });
    expect(
      await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.id, lateId)),
    ).toEqual([]);
  } finally {
    await erasure;
    await blocker.close();
  }
});
