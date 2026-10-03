import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  adminOperations,
  auditEvents,
  oauthAccessTokens,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
});
afterAll(async () => fixture?.close());
async function seed() {
  const userId = createId();
  await fixture.db.insert(users).values({
    id: userId,
    email: `${userId}@session-replay.example.com`,
    name: "Session",
  });
  return { userId, sessionId: await addSession(userId) };
}
async function addSession(userId: string) {
  const id = createId();
  await fixture.db.insert(sessions).values({
    id,
    userId,
    token: `secret-${id}`,
    expiresAt: new Date(Date.now() + 60000),
  });
  return id;
}
function command(
  key: string,
  userId: string,
  sessionId?: string,
  kind: "platformAdmin" | "platformReader" = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  headers.set("Idempotency-Key", key);
  return fixture.app.request(
    `/api/admin/v1/users/${userId}/sessions${sessionId ? `/${sessionId}` : ""}`,
    { method: "DELETE", headers },
  );
}
test("single session revocation replays after removal and records exact secret-free effects", async () => {
  const target = await seed();
  const response = await command("single", target.userId, target.sessionId);
  expect(response.status).toBe(204);
  const later = await addSession(target.userId);
  const replay = await command("single", target.userId, target.sessionId);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(replay.headers.get("Operation-Id")).toBe(
    response.headers.get("Operation-Id"),
  );
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorType: "user",
    actorId: fixture.principals.platformAdmin.userId,
  });
  expect(events[0]?.data).toMatchObject({
    userId: target.userId,
    before: { id: target.sessionId },
    after: null,
    sessionIds: [target.sessionId],
  });
  expect(JSON.stringify(events)).not.toContain(`secret-${target.sessionId}`);
  expect(
    await fixture.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, target.userId)),
  ).toEqual([{ id: later }]);
  expect((await command("single", target.userId, later)).status).toBe(409);
});
test("revoke-all replay preserves later sessions and new empty commands are noops", async () => {
  const target = await seed();
  const first = await command("all", target.userId);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ revoked: 1 });
  const later = await addSession(target.userId);
  const replay = await command("all", target.userId);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  await expectReceipt(fixture.db, replay);
  expect(
    await fixture.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, target.userId)),
  ).toEqual([{ id: later }]);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorType: "user",
    actorId: fixture.principals.platformAdmin.userId,
  });
  expect(events[0]).toMatchObject({
    targetType: "user",
    targetId: target.userId,
    data: { sessionIds: [target.sessionId] },
  });
  await command("all-new", target.userId);
  const empty = await command("empty", target.userId);
  expect(await empty.json()).toEqual({ revoked: 0 });
  const [operation] = await fixture.db
    .select()
    .from(adminOperations)
    .where(eq(adminOperations.id, empty.headers.get("Operation-Id")!));
  expect(operation?.outcome).toBe("noop");
  await fixture.db.insert(oauthAccessTokens).values({
    id: createId(),
    userId: target.userId,
    clientId: fixture.platform.client.clientId,
    token: createId(),
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  });
  const tokenOnly = await command("token-only", target.userId);
  expect(await tokenOnly.json()).toEqual({ revoked: 0 });
  const [applied] = await fixture.db
    .select()
    .from(adminOperations)
    .where(eq(adminOperations.id, tokenOnly.headers.get("Operation-Id")!));
  expect(applied?.outcome).toBe("applied");
  await fixture.db.delete(users).where(eq(users.id, target.userId));
  const erasedReplay = await command("all", target.userId);
  expect(erasedReplay.headers.get("Idempotency-Replayed")).toBe("true");
  await expectReceipt(fixture.db, erasedReplay);
});
