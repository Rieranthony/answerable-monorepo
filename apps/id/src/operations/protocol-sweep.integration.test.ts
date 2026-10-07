import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { asc, count, sql } from "drizzle-orm";

import { openRuntimeRole } from "../__tests__/runtime-role.ts";
import { testEnvironment } from "../__tests__/support.ts";
import type { Database, DatabaseConnection } from "../db/client.ts";
import {
  auditEvents,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClients,
  oauthRefreshTokens,
  sessions,
  users,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  startProtocolSweep,
  sweepExpiredProtocolRows,
} from "./protocol-sweep.ts";

let roles: Awaited<ReturnType<typeof openRuntimeRole>>;
let owner: DatabaseConnection;
let runtime: DatabaseConnection;
const userId = createId();
const clientId = `sweep-${userId}`;
const hours = (offset: number) => new Date(Date.now() + offset * 3_600_000);
const none = {
  oauth_access_tokens: 0,
  oauth_refresh_tokens: 0,
  oauth_client_assertions: 0,
  sessions: 0,
};

beforeAll(async () => {
  roles = await openRuntimeRole(testEnvironment());
  ({ owner, runtime } = roles);
  await owner.db
    .insert(users)
    .values({ id: userId, name: "Sweep", email: `${userId}@example.com` });
  await owner.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    name: "Sweep",
    redirectUris: [],
  });
});
afterAll(() => roles?.close());
beforeEach(async () => {
  await owner.db.delete(sessions);
  await owner.db.delete(oauthClientAssertions);
});

async function insertSession(expiresAt: Date) {
  const id = createId();
  await owner.db
    .insert(sessions)
    .values({ id, userId, token: createId(), expiresAt });
  return id;
}
async function insertToken(
  table: typeof oauthRefreshTokens | typeof oauthAccessTokens,
  expiresAt: Date,
  values: { sessionId?: string; refreshId?: string; revoked?: Date } = {},
) {
  const id = createId();
  await owner.db.insert(table).values({
    id,
    token: createId(),
    clientId,
    userId,
    scopes: ["openid"],
    expiresAt,
    ...values,
  });
  return id;
}
async function insertAssertions(...expiries: Date[]) {
  const ids = expiries.map(() => createId());
  await owner.db
    .insert(oauthClientAssertions)
    .values(ids.map((id, index) => ({ id, expiresAt: expiries[index]! })));
  return ids;
}
async function remaining(
  table: typeof sessions | typeof oauthClientAssertions,
) {
  const rows = await owner.db
    .select({ id: table.id })
    .from(table)
    .orderBy(asc(table.expiresAt));
  return rows.map((row) => row.id);
}
async function remainingTokens(
  table: typeof oauthRefreshTokens | typeof oauthAccessTokens,
) {
  const rows = await owner.db
    .select({ id: table.id, sessionId: table.sessionId })
    .from(table);
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}
async function auditCount() {
  const [row] = await owner.db.select({ events: count() }).from(auditEvents);
  return row!.events;
}

test("the runtime role deletes expired protocol rows, keeps live ones and records no audit", async () => {
  const expiredSession = await insertSession(hours(-1));
  const liveSession = await insertSession(hours(1));
  await insertToken(oauthRefreshTokens, hours(-1));
  const rotated = await insertToken(oauthRefreshTokens, hours(1), {
    revoked: hours(-2),
  });
  await owner.db
    .update(oauthRefreshTokens)
    .set({ rotatedAt: hours(-2) })
    .where(sql`${oauthRefreshTokens.id} = ${rotated}`);
  const outlivesSession = await insertToken(oauthRefreshTokens, hours(1), {
    sessionId: expiredSession,
  });
  await insertToken(oauthAccessTokens, hours(-1));
  const liveAccess = await insertToken(oauthAccessTokens, hours(1), {
    refreshId: outlivesSession,
    sessionId: expiredSession,
  });
  const [, liveAssertion] = await insertAssertions(hours(-1), hours(1));
  const audit = await auditCount();

  expect(await sweepExpiredProtocolRows(runtime.db, 1_000)).toEqual({
    oauth_access_tokens: 1,
    oauth_refresh_tokens: 1,
    oauth_client_assertions: 1,
    sessions: 1,
  });

  expect(await remaining(sessions)).toEqual([liveSession]);
  expect(await remaining(oauthClientAssertions)).toEqual([liveAssertion!]);
  expect(await remainingTokens(oauthRefreshTokens)).toEqual(
    [
      { id: rotated, sessionId: null },
      { id: outlivesSession, sessionId: null },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  expect(await remainingTokens(oauthAccessTokens)).toEqual([
    { id: liveAccess, sessionId: null },
  ]);
  expect(await auditCount()).toBe(audit);
  expect(await sweepExpiredProtocolRows(runtime.db, 1_000)).toEqual(none);
});

test("each batch deletes at most the batch size, oldest first, and the sweep loops until a batch is short", async () => {
  const assertions = await insertAssertions(
    hours(-5),
    hours(-4),
    hours(-3),
    hours(-2),
    hours(-1),
  );
  // Stop after the first assertion batch: access and refresh tokens come first.
  let checks = 0;
  expect(
    await sweepExpiredProtocolRows(runtime.db, 2, () => checks++ === 3),
  ).toEqual({ ...none, oauth_client_assertions: 2 });
  expect(await remaining(oauthClientAssertions)).toEqual(assertions.slice(2));

  expect(await sweepExpiredProtocolRows(runtime.db, 2)).toEqual({
    ...none,
    oauth_client_assertions: 3,
  });
  expect(await remaining(oauthClientAssertions)).toEqual([]);

  for (const expiry of [-4, -3, -2, -1]) await insertSession(hours(expiry));
  expect(await sweepExpiredProtocolRows(runtime.db, 2)).toEqual({
    ...none,
    sessions: 4,
  });
});

test("a sweep that cannot take the lock deletes nothing, so only one runs at a time", async () => {
  const assertions = await insertAssertions(hours(-1));
  await owner.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('answerable:protocol-sweep'))`,
    );
    expect(await sweepExpiredProtocolRows(runtime.db, 1_000)).toEqual(none);
  });
  expect(await remaining(oauthClientAssertions)).toEqual(assertions);
  expect(await sweepExpiredProtocolRows(runtime.db, 1_000)).toEqual({
    ...none,
    oauth_client_assertions: 1,
  });
});

type Timer = { callback: () => void; ms: number; cleared: boolean };
async function withTimers(
  run: (captured: {
    timers: Timer[];
    log: ReturnType<typeof spyOn>;
    error: ReturnType<typeof spyOn>;
  }) => Promise<void>,
) {
  const timers: Timer[] = [];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    const timer = { callback, ms, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((
    timer: Timer,
  ) => {
    timer.cleared = true;
  }) as unknown as typeof clearInterval);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await run({ timers, log, error });
  } finally {
    interval.mockRestore();
    clear.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
}
async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(5);
}

test("the timer sweeps on its interval, skips a tick while a sweep runs and logs the counts", () =>
  withTimers(async ({ timers, log, error }) => {
    const assertions = await insertAssertions(hours(-1));
    const sweep = startProtocolSweep(runtime.db, {
      intervalMs: 60_000,
      batchSize: 1_000,
    });
    expect(timers.map((timer) => timer.ms)).toEqual([60_000]);
    const transaction = spyOn(runtime.db, "transaction");
    try {
      timers[0]!.callback();
      timers[0]!.callback();
      await until(() => log.mock.calls.length > 0);
      expect(transaction).toHaveBeenCalledTimes(4);
    } finally {
      transaction.mockRestore();
    }
    expect(log.mock.calls).toEqual([
      [
        "[id] protocol sweep",
        JSON.stringify({
          event: "protocol_sweep",
          deleted: { ...none, oauth_client_assertions: 1 },
        }),
      ],
    ]);
    expect(await remaining(oauthClientAssertions)).not.toContain(
      assertions[0]!,
    );
    await sweep.stop();
    expect(timers[0]!.cleared).toBe(true);
    expect(error).not.toHaveBeenCalled();
  }));

test("stopping clears the timer, waits for the running batch and ends the sweep before the next", () =>
  withTimers(async ({ timers, log }) => {
    const assertions = await insertAssertions(hours(-1));
    const sweep = startProtocolSweep(runtime.db, {
      intervalMs: 1_000,
      batchSize: 1_000,
    });
    const transaction = spyOn(runtime.db, "transaction");
    try {
      timers[0]!.callback();
      await sweep.stop();
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(await transaction.mock.results[0]!.value).toBe(0);
    } finally {
      transaction.mockRestore();
    }
    expect(timers[0]!.cleared).toBe(true);
    expect(await remaining(oauthClientAssertions)).toEqual(assertions);
    expect(log).not.toHaveBeenCalled();
  }));

test("a failed sweep logs only its event and the next tick sweeps again", () =>
  withTimers(async ({ timers, error }) => {
    const failing = {
      transaction: async () => {
        throw new Error("private database detail");
      },
    } as unknown as Database;
    const sweep = startProtocolSweep(failing, {
      intervalMs: 1_000,
      batchSize: 1,
    });
    timers[0]!.callback();
    await until(() => error.mock.calls.length === 1);
    timers[0]!.callback();
    await until(() => error.mock.calls.length === 2);
    await sweep.stop();
    expect(error.mock.calls).toEqual(
      Array(2).fill([
        "[id] protocol sweep",
        JSON.stringify({ level: "error", event: "protocol_sweep_failed" }),
      ]),
    );
  }));

test("a failed sweep logs the database error's SQLSTATE and nothing else", () =>
  withTimers(async ({ timers, error }) => {
    const failing = {
      transaction: async () => {
        throw new Error("Failed query: private statement", {
          cause: Object.assign(new Error("private database detail"), {
            code: "57014",
          }),
        });
      },
    } as unknown as Database;
    const sweep = startProtocolSweep(failing, {
      intervalMs: 1_000,
      batchSize: 1,
    });
    timers[0]!.callback();
    await until(() => error.mock.calls.length === 1);
    await sweep.stop();
    expect(error.mock.calls).toEqual([
      [
        "[id] protocol sweep",
        JSON.stringify({
          level: "error",
          event: "protocol_sweep_failed",
          code: "57014",
        }),
      ],
    ]);
  }));

test("a zero interval starts no timer", () =>
  withTimers(async ({ timers }) => {
    await startProtocolSweep(runtime.db, {
      intervalMs: 0,
      batchSize: 1_000,
    }).stop();
    expect(timers).toEqual([]);
  }));
