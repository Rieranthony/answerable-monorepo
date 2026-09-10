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
  role = `id_test_user_cascade_${crypto.randomUUID().replaceAll("-", "")}`;
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

import {
  members,
  groups,
  groupMembers,
  grantContexts,
} from "../../db/schema/index.ts";
for (const parent of ["client", "refresh", "session", "member"] as const) {
  test(`global user erasure records children committed while waiting for a ${parent} parent`, async () => {
    const db = fixture.db,
      userId = createId(),
      parentId = createId(),
      lateId = createId(),
      grantId = createId();
    const other = fixture.principals.outsider;
    await db.insert(users).values({
      id: userId,
      name: "Erased",
      email: `${userId}@cascade.example`,
    });
    const clientId = createId(),
      groupId = createId(),
      expiresAt = new Date(Date.now() + 60000);
    if (parent === "client")
      await db.insert(oauthClients).values({
        id: parentId,
        clientId,
        userId,
        organizationId: fixture.tenant.organizationId,
        redirectUris: [],
        scopes: ["read"],
      });
    if (parent === "refresh")
      await db.insert(oauthRefreshTokens).values({
        id: parentId,
        clientId: fixture.platform.client.clientId,
        userId,
        token: createId(),
        scopes: [],
        expiresAt,
      });
    if (parent === "session")
      await db
        .insert(sessions)
        .values({ id: parentId, userId, token: createId(), expiresAt });
    if (parent === "member") {
      await db.insert(members).values({
        id: parentId,
        userId,
        organizationId: fixture.tenant.organizationId,
      });
      await db.insert(groups).values({
        id: groupId,
        organizationId: fixture.tenant.organizationId,
        slug: "cascade-group",
        name: "Preserved",
      });
    }
    const [otherSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, other.userId))
      .limit(1);
    const blocker = createDatabase(fixture.environment);
    let erasure: Promise<Response> | undefined;
    const key = createId();
    const path = `/users/${userId}?confirm=${userId}`;
    try {
      await blocker.db.transaction(async (tx) => {
        const state = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        const pid = state.rows[0]!.pid;
        const table =
          parent === "client"
            ? oauthClients
            : parent === "refresh"
              ? oauthRefreshTokens
              : parent === "session"
                ? sessions
                : members;
        await tx
          .select({ id: table.id })
          .from(table)
          .where(eq(table.id, parentId))
          .for("key share");
        erasure = Promise.resolve(request(path, "DELETE", key));
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
        if (parent === "member")
          await tx.insert(groupMembers).values({
            id: lateId,
            groupId,
            memberId: parentId,
            organizationId: fixture.tenant.organizationId,
          });
        else
          await tx.insert(oauthAccessTokens).values({
            id: lateId,
            userId: other.userId,
            clientId:
              parent === "client" ? clientId : fixture.platform.client.clientId,
            refreshId: parent === "refresh" ? parentId : null,
            sessionId: parent === "session" ? parentId : null,
            scopes: [],
            expiresAt,
          });
        if (parent === "client")
          await tx.insert(grantContexts).values({
            id: grantId,
            userId: other.userId,
            organizationId: other.organizationId,
            memberId: other.memberId,
            clientInstanceId: parentId,
            authenticationSessionId: otherSession!.id,
            authTime: otherSession!.createdAt,
            requestedScopes: ["read"],
            expiresAt,
          });
      });
      const response = await erasure!;
      expect(response.status).toBe(204);
      const operationId = response.headers.get("Operation-Id")!;
      const events = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, operationId));
      expect(events).toHaveLength(1);
      const effect = events[0]!.data!.effects as Record<
        string,
        { id: string }[]
      >;
      const field =
        parent === "member"
          ? "removedAssignments"
          : parent === "session"
            ? "clearedAccessTokenSessions"
            : "deletedAccessTokens";
      expect(effect[field]!.map((row) => row.id)).toContain(lateId);
      if (parent === "client")
        expect(events[0]!.data!.deletedGrantContexts).toEqual([
          expect.objectContaining({ id: grantId, userId: other.userId }),
        ]);
      if (parent === "session") {
        expect(effect[field]).toEqual([
          expect.objectContaining({
            id: lateId,
            userId: other.userId,
            beforeSessionId: parentId,
            afterSessionId: null,
          }),
        ]);
        expect(
          await db
            .select()
            .from(oauthAccessTokens)
            .where(eq(oauthAccessTokens.id, lateId)),
        ).toMatchObject([{ id: lateId, sessionId: null, revoked: null }]);
      } else if (parent === "member")
        expect(
          await db
            .select()
            .from(groupMembers)
            .where(eq(groupMembers.id, lateId)),
        ).toEqual([]);
      else
        expect(
          await db
            .select()
            .from(oauthAccessTokens)
            .where(eq(oauthAccessTokens.id, lateId)),
        ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, other.userId)),
      ).toHaveLength(1);
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
    } finally {
      await erasure;
      await blocker.close();
    }
  });
}
