import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  adminOperations,
  auditEvents,
  entitlements,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { createDatabase } from "../../db/client.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import {
  oauthAccessTokens,
  oauthRefreshTokens,
} from "../../db/schema/index.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({ databasePoolMax: 2 });
});
afterAll(async () => fixture?.close());
async function seed() {
  const id = createId();
  await fixture.db.insert(users).values({
    id,
    email: `${id}@user-replay.example.com`,
    name: "Private display name",
    status: "active",
  });
  await fixture.db.insert(sessions).values({
    id: createId(),
    userId: id,
    token: createId(),
    expiresAt: new Date(Date.now() + 60000),
  });
  return id;
}
function command(
  key: string,
  id: string,
  action: string,
  kind: "platformAdmin" | "platformReader" = "platformAdmin",
  confirm = id,
) {
  const headers = fixture.headers(kind);
  headers.set("Idempotency-Key", key);
  return fixture.app.request(
    `/api/admin/v1/users/${id}${action === "erase" ? `?confirm=${confirm}` : `/${action}`}`,
    { method: action === "erase" ? "DELETE" : "POST", headers },
  );
}
test("user commands return receipts after erasure without repeating effects", async () => {
  const id = await seed();
  const saved: {
    key: string;
    action: string;
    status: number;
    operation: string;
  }[] = [];
  for (const [key, action] of [
    ["disable", "disable"],
    ["enable", "enable"],
    ["disable-again", "disable"],
    ["retire", "retire-email"],
    ["erase", "erase"],
  ]) {
    const response = await command(key!, id, action!);
    expect(response.status).toBe(action === "erase" ? 204 : 200);
    saved.push({
      key: key!,
      action: action!,
      status: response.status,
      operation: response.headers.get("Operation-Id")!,
    });
  }
  for (const item of saved) {
    const replay = await command(item.key, id, item.action);
    expect(replay.status).toBe(item.status);
    await expectReceipt(fixture.db, replay);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(item.operation);
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, item.operation));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "user",
      actorId: fixture.principals.platformAdmin.userId,
    });
    expect(JSON.stringify(events)).not.toContain(
      `${id}@user-replay.example.com`,
    );
    expect(JSON.stringify(events)).not.toContain("Private display name");
  }
  expect(
    (await command("erase", id, "erase", "platformAdmin", createId())).status,
  ).toBe(409);
  expect(
    await fixture.db.select().from(users).where(eq(users.id, id)),
  ).toMatchObject([{ status: "disabled", deletedAt: expect.any(Date) }]);
});
test("new-key user lifecycle noops preserve state and timestamps", async () => {
  const id = await seed();
  const initial = await fixture.db.select().from(users).where(eq(users.id, id));
  const active = await command("active-noop", id, "enable");
  expect(active.status).toBe(200);
  expect(await fixture.db.select().from(users).where(eq(users.id, id))).toEqual(
    initial,
  );
  for (const action of ["disable", "retire-email"]) {
    const first = await command(`first-${action}`, id, action);
    expect(first.status).toBe(200);
    const body = await first.json();
    const noop = await command(`noop-${action}`, id, action);
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual(body);
    const [operation] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, noop.headers.get("Operation-Id")!));
    expect(operation?.outcome).toBe("noop");
  }
});

test("restricted disable reconciliation distinguishes replay from a new command and rolls back on audit failure", async () => {
  const role = `id_test_disable_reconcile_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = { ...fixture.environment, databaseUrl: url.toString() };
  const runtime = createDatabase(environment);
  try {
    const app = createApp({
      db: runtime.db,
      auth: createAuth(runtime.db, environment),
      environment,
    });
    const id = await seed();
    const originalKey = createId(),
      nextKey = createId();
    const disable = (key: string) => {
      const headers = fixture.headers("platformAdmin");
      headers.set("Idempotency-Key", key);
      return app.request(`/api/admin/v1/users/${id}/disable`, {
        method: "POST",
        headers,
      });
    };
    expect((await disable(originalKey)).status).toBe(200);
    const before = await fixture.db
      .select()
      .from(users)
      .where(eq(users.id, id));
    const sessionId = createId();
    const secret = createId();
    await fixture.db.insert(sessions).values({
      id: sessionId,
      userId: id,
      token: secret,
      expiresAt: new Date(Date.now() + 60000),
    });
    for (const table of [oauthAccessTokens, oauthRefreshTokens])
      await fixture.db.insert(table).values({
        id: createId(),
        userId: id,
        clientId: fixture.platform.client.clientId,
        token: createId(),
        scopes: [],
        expiresAt: new Date(Date.now() + 60000),
      });
    const replay = await disable(originalKey);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const assertRemaining = async () => {
      expect(
        await fixture.db.select().from(users).where(eq(users.id, id)),
      ).toEqual(before);
      expect(
        await fixture.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId)),
      ).toHaveLength(1);
      for (const table of [oauthAccessTokens, oauthRefreshTokens]) {
        const rows = await fixture.db
          .select()
          .from(table)
          .where(eq(table.userId, id));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.revoked).toBeNull();
      }
    };
    await assertRemaining();
    const operations = await fixture.db
      .select()
      .from(adminOperations)
      .orderBy(adminOperations.id);
    await fixture.db.execute(
      sql`alter table audit_events add constraint disable_reconcile_fault check (action <> 'user.disabled') not valid`,
    );
    try {
      expect((await disable(nextKey)).status).toBe(400);
      await assertRemaining();
      expect(
        await fixture.db
          .select()
          .from(adminOperations)
          .orderBy(adminOperations.id),
      ).toEqual(operations);
    } finally {
      await fixture.db.execute(
        sql`alter table audit_events drop constraint disable_reconcile_fault`,
      );
    }
    const recovered = await disable(nextKey);
    expect(recovered.status).toBe(200);
    const operationId = recovered.headers.get("Operation-Id")!;
    const [operation] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, operationId));
    expect(operation!.outcome).toBe("applied");
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId));
    expect(event).toMatchObject({
      action: "user.disabled",
      data: {
        sessions: 1,
        sessionIds: [sessionId],
        accessTokens: 1,
        refreshTokens: 1,
        revokedGrantContexts: [],
      },
    });
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(
      await fixture.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
    ).toHaveLength(0);
    for (const table of [oauthAccessTokens, oauthRefreshTokens]) {
      const [token] = await fixture.db
        .select()
        .from(table)
        .where(eq(table.userId, id));
      expect(token!.revoked).toBeInstanceOf(Date);
    }
    expect((await disable(nextKey)).headers.get("Idempotency-Replayed")).toBe(
      "true",
    );
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, operationId)),
    ).toHaveLength(1);
    const noop = await disable(createId());
    expect(noop.status).toBe(200);
    const [noopOperation] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, noop.headers.get("Operation-Id")!));
    expect(noopOperation!.outcome).toBe("noop");
    expect(
      await fixture.db.select().from(users).where(eq(users.id, id)),
    ).toEqual(before);
  } finally {
    await runtime.close();
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
  }
});

test("user lifecycle and erasure retain distinct scopes and recheck before recovery", async () => {
  const id = await seed();
  const actor = fixture.principals.platformReader;
  const predicate = eq(entitlements.memberId, actor.memberId);
  const original = fixture.db.transaction.bind(fixture.db);
  try {
    await fixture.db
      .update(entitlements)
      .set({ scopes: ["platform:users"] })
      .where(predicate);
    expect(
      (await command("scope-disable", id, "disable", "platformReader")).status,
    ).toBe(200);
    expect(
      (await command("scope-erase-denied", id, "erase", "platformReader"))
        .status,
    ).toBe(403);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      await fixture.db
        .update(entitlements)
        .set({ scopes: ["platform:read"] })
        .where(predicate);
      return original(...args);
    }) as typeof original);
    expect(
      (await command("scope-disable", id, "disable", "platformReader")).status,
    ).toBe(403);
    await fixture.db
      .update(entitlements)
      .set({ scopes: ["platform:write"] })
      .where(predicate);
    expect(
      (await command("scope-enable-denied", id, "enable", "platformReader"))
        .status,
    ).toBe(403);
    expect(
      (await command("scope-erase", id, "erase", "platformReader")).status,
    ).toBe(204);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      await fixture.db
        .update(entitlements)
        .set({ scopes: ["platform:users"] })
        .where(predicate);
      return original(...args);
    }) as typeof original);
    expect(
      (await command("scope-erase", id, "erase", "platformReader")).status,
    ).toBe(403);
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(entitlements)
      .set({ scopes: ["platform:read"] })
      .where(predicate);
  }
});

test.each([false, true])(
  "pool exhaustion after authentication=%s permits same-key recovery without a partial command",
  async (afterAuthentication) => {
    const id = await seed();
    const before = await fixture.db.select().from(adminOperations);
    const entered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const log = spyOn(console, "error").mockImplementation(() => {});
    const release = Promise.withResolvers<void>();
    const original = fixture.db.transaction.bind(fixture.db);
    let holders: Promise<unknown>[] = [];
    const occupyPool = async () => {
      holders = entered.map((ready) =>
        original(async () => {
          ready.resolve();
          await release.promise;
        }),
      );
      await Promise.all(entered.map((ready) => ready.promise));
    };
    try {
      if (afterAuthentication) {
        fixture.db.transaction = afterBrokerRead(original, (async (
          ...args: Parameters<typeof original>
        ) => {
          fixture.db.transaction = original;
          await occupyPool();
          return original(...args);
        }) as typeof original);
      } else await occupyPool();
      const response = await command(
        `pool-exhausted-${afterAuthentication}`,
        id,
        "disable",
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(await response.json()).toMatchObject({
        code: afterAuthentication
          ? "database_busy"
          : "authentication_unavailable",
        retryable: true,
      });
      if (!afterAuthentication) {
        expect(log.mock.calls).toEqual([
          [
            "[id] auth",
            JSON.stringify({ level: "error", event: "provider_diagnostic" }),
          ],
        ]);
      }
    } finally {
      log.mockRestore();
      fixture.db.transaction = original;
      release.resolve();
      await Promise.all(holders);
    }
    expect(await fixture.db.select().from(adminOperations)).toEqual(before);
    expect(
      (await fixture.db.select().from(users).where(eq(users.id, id)))[0]
        ?.status,
    ).toBe("active");
    const retry = await command(
      `pool-exhausted-${afterAuthentication}`,
      id,
      "disable",
    );
    expect(retry.status).toBe(200);
    const replay = await command(
      `pool-exhausted-${afterAuthentication}`,
      id,
      "disable",
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(
      retry.headers.get("Operation-Id"),
    );
  },
);

test("global user offboarding retains the last-writer safeguard", async () => {
  const id = fixture.principals.platformAdmin.userId;
  const receipts = await fixture.db.$count(adminOperations);
  for (const action of ["disable", "erase"]) {
    const response = await command(createId(), id, action);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "last_platform_administrator",
    });
    const [person] = await fixture.db
      .select()
      .from(users)
      .where(eq(users.id, id));
    expect(person).toMatchObject({ status: "active", deletedAt: null });
    expect(await fixture.db.$count(adminOperations)).toBe(receipts);
  }
});
