import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "../auth.ts";
import { upstreamCutoverFixture } from "../__tests__/upstream-cutover.ts";
import { isUuidV7, testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import {
  accounts,
  auditEvents,
  auditEventSubjects,
  users,
  sessions,
  organizations,
  members,
  oauthClients,
  oauthAccessTokens,
  oauthRefreshTokens,
  grantContexts,
} from "./schema/index.ts";
import { createId } from "../lib/id.ts";

let connection: DatabaseConnection;
let cutover: Awaited<ReturnType<typeof upstreamCutoverFixture>>;
const children: Bun.Subprocess[] = [];
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  cutover = await upstreamCutoverFixture();
  await connection.db.execute(
    sql`truncate audit_events, users, organizations cascade`,
  );
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  await cutover.close(connection.db);
});
afterAll(async () => {
  await connection.close();
});

async function seed() {
  const userId = createId();
  const otherId = createId();
  const sessionId = createId();
  const orgA = createId(),
    orgB = createId();
  const memberA = createId(),
    memberB = createId();
  const clientId = createId();
  const publicClientId = `cutover-${clientId}`;
  const expiry = new Date(Date.now() + 3_600_000);
  const authTime = new Date();
  await connection.db.insert(users).values([
    {
      id: userId,
      name: "One",
      email: `${userId}@example.com`,
      status: "active",
    },
    {
      id: otherId,
      name: "Two",
      email: `${otherId}@example.com`,
      status: "active",
    },
  ]);
  await connection.db.insert(organizations).values([
    { id: orgA, name: "A", slug: `a-${orgA}` },
    { id: orgB, name: "B", slug: `b-${orgB}` },
  ]);
  await connection.db.insert(members).values([
    { id: memberA, userId, organizationId: orgA },
    { id: memberB, userId, organizationId: orgB },
  ]);
  await connection.db.insert(sessions).values({
    id: sessionId,
    userId,
    token: `session-${sessionId}`,
    expiresAt: expiry,
    createdAt: authTime,
  });
  await connection.db.insert(oauthClients).values({
    id: clientId,
    clientId: publicClientId,
    redirectUris: ["https://example.com/callback"],
    organizationId: orgA,
    scopes: ["read"],
  });
  const refreshId = createId();
  await connection.db.insert(oauthRefreshTokens).values({
    id: refreshId,
    token: "answerable-refresh",
    clientId: publicClientId,
    userId,
    sessionId,
    scopes: ["read"],
    expiresAt: expiry,
  });
  await connection.db.insert(oauthAccessTokens).values({
    id: createId(),
    token: "answerable-access",
    clientId: publicClientId,
    userId,
    sessionId,
    refreshId,
    scopes: ["read"],
    expiresAt: expiry,
  });
  await connection.db.insert(grantContexts).values([
    {
      id: createId(),
      organizationId: orgA,
      memberId: memberA,
      userId,
      clientInstanceId: clientId,
      authenticationSessionId: sessionId,
      authTime,
      requestedScopes: ["read"],
      expiresAt: expiry,
    },
    {
      id: createId(),
      organizationId: orgB,
      memberId: memberB,
      userId,
      clientInstanceId: clientId,
      authenticationSessionId: sessionId,
      authTime,
      requestedScopes: ["read"],
      expiresAt: expiry,
    },
  ]);
  const ids = [createId(), createId(), createId(), createId()];
  const base = { providerId: "legacy", issuer: "https://legacy.example.com" };
  await connection.db.insert(accounts).values([
    {
      ...base,
      id: ids[0]!,
      userId,
      accountId: "all",
      directoryId: "directory",
      directoryUserId: "object",
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      idToken: "legacy-id",
      accessTokenExpiresAt: expiry,
      refreshTokenExpiresAt: expiry,
      scope: "openid profile",
    },
    {
      ...base,
      id: ids[1]!,
      userId: otherId,
      accountId: "odd-format",
      refreshToken: "$ba$unknown-do-not-guess",
    },
    { ...base, id: ids[2]!, userId, accountId: "empty" },
    {
      ...base,
      id: ids[3]!,
      userId,
      accountId: "expiry-only",
      accessTokenExpiresAt: expiry,
    },
  ]);
  return { userId, otherId, ids };
}

async function unaffected() {
  return {
    users: await connection.db.select().from(users).orderBy(users.id),
    sessions: await connection.db.select().from(sessions).orderBy(sessions.id),
    members: await connection.db.select().from(members).orderBy(members.id),
    clients: await connection.db
      .select()
      .from(oauthClients)
      .orderBy(oauthClients.id),
    access: await connection.db
      .select()
      .from(oauthAccessTokens)
      .orderBy(oauthAccessTokens.id),
    refresh: await connection.db
      .select()
      .from(oauthRefreshTokens)
      .orderBy(oauthRefreshTokens.id),
    grants: await connection.db
      .select()
      .from(grantContexts)
      .orderBy(grantContexts.id),
  };
}

test("cutover retires only upstream credentials with durable redacted effects and safe runner replay", async () => {
  const fixture = await seed();
  const before = await connection.db
    .select()
    .from(accounts)
    .orderBy(accounts.id);
  const retained = await unaffected();
  await cutover.run(connection.db);
  expect(await cutover.receipts(connection.db)).toBe(1);
  const after = await connection.db
    .select()
    .from(accounts)
    .orderBy(accounts.id);
  for (let index = 0; index < before.length; index++) {
    expect(after[index]).toEqual({
      ...before[index]!,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      updatedAt: after[index]!.updatedAt,
    });
  }
  expect(after.find((row) => row.id === fixture.ids[2])).toEqual(
    before.find((row) => row.id === fixture.ids[2]),
  );
  expect(await unaffected()).toEqual(retained);
  const events = await connection.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "account.upstream_credentials.retired"));
  expect(events).toHaveLength(3);
  expect(new Set(events.map((event) => event.targetId))).toEqual(
    new Set([fixture.ids[0]!, fixture.ids[1]!, fixture.ids[3]!]),
  );
  for (const event of events) {
    expect(isUuidV7(event.id)).toBe(true);
    expect(event).toMatchObject({
      actorType: "system",
      actorId: "migration:0037_retire_legacy_upstream_tokens",
      targetType: "account",
      organizationId: null,
      outcome: "success",
      schemaVersion: 1,
    });
    const original = before.find((row) => row.id === event.targetId)!;
    expect(event.data).toMatchObject({
      userId: original.userId,
      before: {
        accessTokenPresent: original.accessToken !== null,
        refreshTokenPresent: original.refreshToken !== null,
        idTokenPresent: original.idToken !== null,
        accessExpiryPresent: original.accessTokenExpiresAt !== null,
        refreshExpiryPresent: original.refreshTokenExpiresAt !== null,
      },
      after: {
        accessTokenPresent: false,
        refreshTokenPresent: false,
        idTokenPresent: false,
        accessExpiryPresent: false,
        refreshExpiryPresent: false,
      },
    });
    const subjects = await connection.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, event.id));
    expect(subjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "account",
          entityId: event.targetId,
          relationship: "target",
        }),
        expect.objectContaining({
          entityType: "user",
          entityId: event.data!.userId,
          relationship: "affected",
        }),
      ]),
    );
  }
  const recorded = JSON.stringify(events);
  for (const secret of [
    "legacy-access",
    "legacy-refresh",
    "legacy-id",
    "$ba$unknown-do-not-guess",
    "answerable-refresh",
    "answerable-access",
  ])
    expect(recorded).not.toContain(secret);
  const { adapter } = await createAuth(connection.db, testEnvironment())
    .$context;
  await adapter.update({
    model: "account",
    where: [{ field: "id", value: fixture.ids[0]! }],
    update: { accessToken: "new-encrypted-access" },
  });
  const renewed = await connection.db
    .select()
    .from(accounts)
    .orderBy(accounts.id);
  await cutover.run(connection.db);
  expect(
    await connection.db.select().from(accounts).orderBy(accounts.id),
  ).toEqual(renewed);
  expect(await cutover.receipts(connection.db)).toBe(1);
  expect(
    await connection.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "account.upstream_credentials.retired")),
  ).toEqual(events);
  await connection.db.delete(users).where(eq(users.id, fixture.userId));
  expect(
    (
      await connection.db
        .select()
        .from(auditEventSubjects)
        .where(eq(auditEventSubjects.entityId, fixture.userId))
    ).length,
  ).toBe(2);
});

async function worker() {
  const ready = Promise.withResolvers<number>();
  const committed = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  void committed.promise.catch(() => {});
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../__tests__/upstream-cutover-worker.ts", import.meta.url)
        .pathname,
    ],
    {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        const event = message as { stage: string; pid: number };
        if (event.stage === "ready") ready.resolve(event.pid);
        if (event.stage === "committed") committed.resolve();
      },
    },
  );
  children.push(child);
  child.stdin.write(
    JSON.stringify({
      environment: testEnvironment(),
      folder: cutover.folder,
      migrationsSchema: cutover.migrationsSchema,
    }),
  );
  child.stdin.end();
  void child.exited.then((code) => {
    ready.reject(new Error(`Cutover worker exited (${code})`));
    committed.reject(new Error(`Cutover worker exited (${code})`));
  });
  return { child, pid: await ready.promise, committed: committed.promise };
}

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Cutover process state was not observed");
}

for (const phase of ["before-commit", "after-commit"] as const)
  test(`cutover restart after SIGKILL ${phase} preserves one committed effect`, async () => {
    const fixture = await seed();
    const before = await connection.db
      .select()
      .from(accounts)
      .orderBy(accounts.id);
    const controller = createDatabase(testEnvironment());
    const held = await controller.pool.connect();
    const gate = 3_700_001;
    let first: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      if (phase === "before-commit") {
        await held.query("select pg_advisory_lock($1)", [gate]);
        await connection.db.execute(
          sql.raw(
            `create function cutover_pause_audit() returns trigger language plpgsql as $$ begin if new.action = 'account.upstream_credentials.retired' then perform pg_advisory_xact_lock(${gate}); end if; return new; end $$`,
          ),
        );
        await connection.db.execute(
          sql`create trigger cutover_pause_audit before insert on audit_events for each row execute function cutover_pause_audit()`,
        );
      }
      first = await worker();
      if (phase === "before-commit") {
        const controllerPid = (
          await held.query("select pg_backend_pid() as pid")
        ).rows[0].pid;
        await waitFor(
          async () =>
            (
              await held.query(
                "select $1::integer = any(pg_blocking_pids($2)) as blocked",
                [controllerPid, first!.pid],
              )
            ).rows[0].blocked === true,
        );
        expect(
          await connection.db.select().from(accounts).orderBy(accounts.id),
        ).toEqual(before);
        expect(await cutover.receipts(connection.db)).toBe(0);
      } else {
        await first.committed;
        expect(await cutover.receipts(connection.db)).toBe(1);
      }
      first.child.kill("SIGKILL");
      await first.child.exited;
      expect(first.child.signalCode).toBe("SIGKILL");
    } finally {
      if (first?.child.exitCode === null) first.child.kill("SIGKILL");
      if (first) await first.child.exited;
      await held.query("select pg_advisory_unlock_all()");
      if (first)
        await waitFor(
          async () =>
            (
              await held.query(
                "select 1 from pg_stat_activity where pid = $1",
                [first!.pid],
              )
            ).rows.length === 0,
        );
      held.release();
      await controller.close();
      if (phase === "before-commit") {
        await connection.db.execute(
          sql`drop trigger if exists cutover_pause_audit on audit_events`,
        );
        await connection.db.execute(
          sql`drop function if exists cutover_pause_audit()`,
        );
      }
    }
    const previousEvents = await connection.db
      .select()
      .from(auditEvents)
      .orderBy(auditEvents.id);
    if (phase === "before-commit") {
      expect(
        await connection.db.select().from(accounts).orderBy(accounts.id),
      ).toEqual(before);
      expect(previousEvents).toHaveLength(0);
      expect(await cutover.receipts(connection.db)).toBe(0);
    } else {
      const { adapter } = await createAuth(connection.db, testEnvironment())
        .$context;
      await adapter.update({
        model: "account",
        where: [{ field: "id", value: fixture.ids[0]! }],
        update: { accessToken: "post-cutover-access" },
      });
    }
    const retryBefore = await connection.db
      .select()
      .from(accounts)
      .orderBy(accounts.id);
    const restart = await worker();
    await restart.committed;
    restart.child.kill("SIGKILL");
    await restart.child.exited;
    expect(await cutover.receipts(connection.db)).toBe(1);
    const events = await connection.db
      .select()
      .from(auditEvents)
      .orderBy(auditEvents.id);
    expect(events).toHaveLength(3);
    if (phase === "after-commit") {
      expect(events).toEqual(previousEvents);
      expect(
        await connection.db.select().from(accounts).orderBy(accounts.id),
      ).toEqual(retryBefore);
    } else {
      expect(
        (await connection.db.select().from(accounts)).every(
          (row) =>
            row.accessToken === null &&
            row.refreshToken === null &&
            row.idToken === null,
        ),
      ).toBe(true);
    }
  });

test("audit failure rolls back retired values and the migration receipt before retry", async () => {
  await seed();
  const before = await connection.db
    .select()
    .from(accounts)
    .orderBy(accounts.id);
  await connection.db.execute(
    sql`alter table audit_events add constraint cutover_audit_fault check (action <> 'account.upstream_credentials.retired')`,
  );
  try {
    await expect(cutover.run(connection.db)).rejects.toThrow();
    expect(
      await connection.db.select().from(accounts).orderBy(accounts.id),
    ).toEqual(before);
    expect(await cutover.receipts(connection.db)).toBe(0);
    expect(await connection.db.select().from(auditEvents)).toHaveLength(0);
  } finally {
    await connection.db.execute(
      sql`alter table audit_events drop constraint cutover_audit_fault`,
    );
  }
  await cutover.run(connection.db);
  expect(await cutover.receipts(connection.db)).toBe(1);
  expect(await connection.db.select().from(auditEvents)).toHaveLength(3);
});

test("empty cutover records completion without touching later credentials", async () => {
  await cutover.run(connection.db);
  expect(await cutover.receipts(connection.db)).toBe(1);
  expect(await connection.db.select().from(auditEvents)).toHaveLength(0);
  const userId = createId();
  await connection.db
    .insert(users)
    .values({ id: userId, name: "Later", email: `${userId}@example.com` });
  const { adapter } = await createAuth(connection.db, testEnvironment())
    .$context;
  await adapter.create({
    model: "account",
    data: {
      userId,
      issuer: "https://later.example.com",
      providerId: "later",
      accountId: createId(),
      accessToken: "later-access",
    },
  });
  const before = await connection.db.select().from(accounts);
  expect(before[0]!.accessToken).toStartWith("$ba$1$");
  await cutover.run(connection.db);
  expect(await connection.db.select().from(accounts)).toEqual(before);
  expect(await connection.db.select().from(auditEvents)).toHaveLength(0);
});
