import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createDatabase } from "../../db/client.ts";
import {
  auditEvents,
  oauthAccessTokens,
  oauthRefreshTokens,
  sessions,
  users,
  members,
  groups,
  groupMembers,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
});
afterEach(async () => {
  await fixture?.close();
});
function request(
  path: string,
  method = "GET",
  key = createId(),
  kind: "platformAdmin" | "platformReader" | "tenantReader" = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  headers.set("Idempotency-Key", key);
  return fixture.app.request(`/api/admin/v1${path}`, { method, headers });
}

for (const parent of ["refresh", "session", "member"] as const) {
  test(`global user erasure records children committed while waiting for a ${parent} parent`, async () => {
    const db = fixture.db,
      userId = createId(),
      parentId = createId(),
      lateId = createId();
    const other = fixture.principals.outsider;
    await db.insert(users).values({
      id: userId,
      name: "Erased",
      email: `${userId}@cascade.example`,
    });
    const groupId = createId(),
      expiresAt = new Date(Date.now() + 60000);
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
          parent === "refresh"
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
            clientId: fixture.platform.client.clientId,
            refreshId: parent === "refresh" ? parentId : null,
            sessionId: parent === "session" ? parentId : null,
            scopes: [],
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
          ? "softDeletedAssignments"
          : parent === "session"
            ? "clearedAccessTokenSessions"
            : "deletedAccessTokens";
      expect(effect[field]!.map((row) => row.id)).toContain(lateId);
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
        ).toMatchObject([{ id: lateId, deletedAt: expect.any(Date) }]);
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
