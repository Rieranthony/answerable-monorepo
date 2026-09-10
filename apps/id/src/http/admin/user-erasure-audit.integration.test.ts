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
  users,
  members,
  groups,
  groupMembers,
  entitlements,
  accounts,
  sessions,
  invitations,
  ssoProviders,
  oauthClients,
  oauthClientResources,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsents,
  grantContexts,
  auditEvents,
  auditEventSubjects,
  adminOperations,
  securityIdentifiers,
  organizationCapabilities,
} from "../../db/schema/index.ts";
import { recordAuditEvent } from "../../db/queries/audit.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_user_audit_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = {
    ...fixture.environment,
    databaseUrl: url.toString(),
    databasePoolMax: 4,
  };
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

async function seed() {
  const person = fixture.principals.tenantReader;
  const other = fixture.principals.outsider;
  const [secondMember] = await fixture.db
    .insert(members)
    .values({
      id: createId(),
      userId: person.userId,
      organizationId: other.organizationId,
    })
    .returning();
  for (const member of [
    person,
    {
      ...person,
      memberId: secondMember!.id,
      organizationId: other.organizationId,
    },
  ]) {
    const [group] = await fixture.db
      .insert(groups)
      .values({
        id: createId(),
        organizationId: member.organizationId,
        slug: "user-erasure",
        name: "Keep group",
      })
      .returning();
    await fixture.db.insert(groupMembers).values({
      id: createId(),
      organizationId: member.organizationId,
      memberId: member.memberId,
      groupId: group!.id,
      validUntil: new Date("2000-01-01"),
    });
    await fixture.db.insert(entitlements).values({
      id: createId(),
      organizationId: member.organizationId,
      memberId: member.memberId,
      clientId: "answerable-bootstrap",
      resource: fixture.platform.adminResource,
      scopes: ["org:read"],
      status: "disabled",
    });
  }
  const owned = { id: createId(), clientId: createId() };
  await fixture.db.insert(oauthClients).values({
    ...owned,
    userId: person.userId,
    redirectUris: [],
    scopes: ["read"],
    clientSecret: "private-client-secret",
  });
  await fixture.db.insert(oauthClientResources).values({
    id: createId(),
    clientId: owned.clientId,
    resourceId: fixture.platform.adminResource,
  });
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, person.userId));
  const [otherSession] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, other.userId));
  const expiresAt = new Date("2100-01-01");
  const refreshId = createId();
  await fixture.db.insert(oauthRefreshTokens).values({
    id: refreshId,
    token: "private-refresh-token",
    clientId: owned.clientId,
    userId: other.userId,
    sessionId: otherSession!.id,
    scopes: ["read"],
    expiresAt,
    rotationReplayResponse: "private-replay-body",
  });
  await fixture.db.insert(oauthAccessTokens).values({
    id: createId(),
    token: "private-access-token",
    clientId: owned.clientId,
    userId: other.userId,
    refreshId,
    sessionId: otherSession!.id,
    scopes: ["read"],
    expiresAt,
  });
  await fixture.db.insert(oauthConsents).values({
    id: createId(),
    clientId: owned.clientId,
    userId: other.userId,
    scopes: ["read"],
  });
  await fixture.db.insert(grantContexts).values({
    id: createId(),
    organizationId: other.organizationId,
    memberId: other.memberId,
    userId: other.userId,
    clientInstanceId: owned.id,
    authenticationSessionId: otherSession!.id,
    authTime: sql`(select created_at from sessions where id = ${otherSession!.id}::uuid)`,
    requestedScopes: ["read"],
    expiresAt,
  });
  // These survive user erasure but lose the deleted session reference via SET NULL.
  await fixture.db.insert(oauthAccessTokens).values({
    id: createId(),
    clientId: fixture.platform.client.clientId,
    userId: other.userId,
    sessionId: session!.id,
    scopes: [],
    expiresAt,
  });
  await fixture.db.insert(oauthRefreshTokens).values({
    id: createId(),
    token: createId(),
    clientId: fixture.platform.client.clientId,
    userId: other.userId,
    sessionId: session!.id,
    scopes: [],
    expiresAt,
  });
  await fixture.db.insert(invitations).values({
    id: createId(),
    organizationId: other.organizationId,
    inviterId: person.userId,
    email: "private-invite@example.com",
    expiresAt,
  });
  await fixture.db
    .update(ssoProviders)
    .set({ userId: person.userId })
    .where(eq(ssoProviders.organizationId, other.organizationId));
  return { person, other, owned };
}
async function state() {
  return {
    users: await fixture.db.select().from(users).orderBy(users.id),
    members: await fixture.db.select().from(members).orderBy(members.id),
    groups: await fixture.db.select().from(groups).orderBy(groups.id),
    assignments: await fixture.db
      .select()
      .from(groupMembers)
      .orderBy(groupMembers.id),
    entitlements: await fixture.db
      .select()
      .from(entitlements)
      .orderBy(entitlements.id),
    accounts: await fixture.db.select().from(accounts).orderBy(accounts.id),
    sessions: await fixture.db.select().from(sessions).orderBy(sessions.id),
    invitations: await fixture.db
      .select()
      .from(invitations)
      .orderBy(invitations.id),
    providers: await fixture.db
      .select()
      .from(ssoProviders)
      .orderBy(ssoProviders.id),
    clients: await fixture.db
      .select()
      .from(oauthClients)
      .orderBy(oauthClients.id),
    links: await fixture.db
      .select()
      .from(oauthClientResources)
      .orderBy(oauthClientResources.id),
    access: await fixture.db
      .select()
      .from(oauthAccessTokens)
      .orderBy(oauthAccessTokens.id),
    refresh: await fixture.db
      .select()
      .from(oauthRefreshTokens)
      .orderBy(oauthRefreshTokens.id),
    consents: await fixture.db
      .select()
      .from(oauthConsents)
      .orderBy(oauthConsents.id),
    grants: await fixture.db
      .select()
      .from(grantContexts)
      .orderBy(grantContexts.id),
    operations: await fixture.db
      .select()
      .from(adminOperations)
      .orderBy(adminOperations.id),
  };
}
function erase(id: string, key: string) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return app.request(`/api/admin/v1/users/${id}?confirm=${id}`, {
    method: "DELETE",
    headers,
  });
}
test("global user erasure records actual cross-tenant and owned-client effects without credentials", async () => {
  const { person, other, owned } = await seed();
  const before = await state();
  const key = createId();
  const response = await erase(person.userId, key);
  expect(response.status).toBe(204);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  expect(event!.schemaVersion).toBe(3);
  const after = await state();
  const effects = event!.data!.effects as Record<string, Array<{ id: string }>>;
  for (const [effect, table] of Object.entries({
    softDeletedMembers: "members",
    softDeletedAssignments: "assignments",
    softDeletedEntitlements: "entitlements",
    softDeletedAccounts: "accounts",
    deletedSessions: "sessions",
    softDeletedInvitations: "invitations",
    softDeletedClients: "clients",
    softDeletedClientResources: "links",
    deletedAccessTokens: "access",
    deletedRefreshTokens: "refresh",
    softDeletedConsents: "consents",
  }) as Array<[string, keyof Awaited<ReturnType<typeof state>>]>) {
    expect(effects[effect]!.map((row) => row.id).sort()).toEqual(
      before[table]
        .filter((row) =>
          effect.startsWith("softDeleted")
            ? after[table].some(
                (retained) =>
                  retained.id === row.id &&
                  "deletedAt" in retained &&
                  retained.deletedAt !== null,
              )
            : !after[table].some((remaining) => remaining.id === row.id),
        )
        .map((row) => row.id)
        .sort(),
    );
  }
  expect(effects.softDeletedMembers).toHaveLength(2);
  for (const member of before.members.filter(
    (row) => row.userId === person.userId,
  )) {
    expect(effects.softDeletedMembers).toContainEqual(
      expect.objectContaining({
        id: member.id,
        organizationId: member.organizationId,
        userId: person.userId,
        revision: member.revision + 1,
        status: "revoked",
        deletedAt: expect.any(String),
      }),
    );
    expect(effects.softDeletedEntitlements).toContainEqual(
      expect.objectContaining({
        organizationId: member.organizationId,
        memberId: member.id,
        status: "disabled",
        scopes: ["org:read"],
      }),
    );
  }
  for (const name of [
    "deletedAccessTokens",
    "deletedRefreshTokens",
    "softDeletedConsents",
    "clearedAccessTokenSessions",
    "clearedRefreshTokenSessions",
  ])
    expect(effects[name]).toContainEqual(
      expect.objectContaining({ userId: other.userId }),
    );

  expect(after.groups).toEqual(before.groups);
  expect(after.providers).toEqual(
    before.providers.map((row) =>
      row.userId === person.userId
        ? { ...row, userId: null, revision: row.revision + 1 }
        : row,
    ),
  );
  for (const name of [
    "accounts",
    "sessions",
    "clients",
    "links",
    "consents",
    "invitations",
    "assignments",
    "entitlements",
  ] as const) {
    const unchanged = after[name].filter(
      (row) => !("deletedAt" in row) || row.deletedAt === null,
    );
    const remainingIds = new Set(unchanged.map((row) => row.id));
    expect(unchanged).toEqual(
      before[name].filter((row) => remainingIds.has(row.id)),
    );
    if (name !== "sessions")
      expect(after[name]).toHaveLength(before[name].length);
  }

  expect(after.users.filter((row) => row.id !== person.userId)).toEqual(
    before.users.filter((row) => row.id !== person.userId),
  );
  expect(after.users.find((row) => row.id === person.userId)).toMatchObject({
    name: before.users.find((row) => row.id === person.userId)!.name,
    status: "disabled",
    deletedAt: expect.any(Date),
  });
  expect(after.members).toHaveLength(before.members.length);
  expect(after.members.filter((row) => row.userId !== person.userId)).toEqual(
    before.members.filter((row) => row.userId !== person.userId),
  );
  expect(
    after.members
      .filter((row) => row.userId === person.userId)
      .every((row) => row.deletedAt !== null && row.status === "revoked"),
  ).toBe(true);
  expect(
    effects.clearedAccessTokenSessions!.map((row) => row.id).sort(),
  ).toEqual(
    after.access
      .filter((row) => row.sessionId === null)
      .map((row) => row.id)
      .sort(),
  );
  expect(
    effects.clearedRefreshTokenSessions!.map((row) => row.id).sort(),
  ).toEqual(
    after.refresh
      .filter((row) => row.sessionId === null)
      .map((row) => row.id)
      .sort(),
  );
  for (const [name, table] of [
    ["clearedAccessTokenSessions", "access"],
    ["clearedRefreshTokenSessions", "refresh"],
  ] as const) {
    for (const effect of effects[name]!) {
      expect(effect).toMatchObject({
        beforeSessionId: before[table].find((row) => row.id === effect.id)!
          .sessionId,
        afterSessionId: null,
      });
    }
  }
  expect(effects.detachedSsoProviders).toEqual(
    before.providers
      .filter((row) => row.userId === person.userId)
      .map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        before: { userId: person.userId, revision: row.revision },
        after: { userId: null, revision: row.revision + 1 },
      })),
  );
  for (const secret of [
    "private-client-secret",
    "private-refresh-token",
    "private-access-token",
    "private-replay-body",
    "private-invite@example.com",
    "oidcConfig",
    "accountId",
    "directoryUserId",
    "password",
  ])
    expect(JSON.stringify(event!.data)).not.toContain(secret);
  const replay = await erase(person.userId, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await state()).toEqual(after);
  const history = await app.request(
    `/api/admin/v1/users/${other.userId}/audit-events?action=user.erased`,
    { headers: fixture.headers("root") },
  );
  expect(history.status).toBe(200);
  expect(
    (await history.json()).items.map((row: { id: string }) => row.id),
  ).toEqual([event!.id]);
  expect(
    await fixture.db
      .select()
      .from(securityIdentifiers)
      .where(eq(securityIdentifiers.instanceId, owned.id)),
  ).toHaveLength(1);

  // Isolate each real producer array: another effect must not mask a missing subject contract.
  for (const name of [
    "deletedAccessTokens",
    "deletedRefreshTokens",
    "softDeletedConsents",
    "clearedAccessTokenSessions",
    "clearedRefreshTokenSessions",
  ]) {
    const isolated = await recordAuditEvent(runtime.db, {
      actorType: "system",
      actorId: "contract-test",
      organizationId: null,
      targetType: "user",
      targetId: person.userId,
      action: "user.erased",
      schemaVersion: 3,
      outcome: "success",
      data: {
        deletionMode: "soft",
        before: { id: person.userId },
        after: event!.data!.after,
        effects: { [name]: effects[name] },
      },
    });
    const subjects = await fixture.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, isolated.id));
    expect(
      subjects
        .filter((row) => row.relationship === "affected")
        .map((row) => row.entityId),
    ).toEqual([other.userId]);
  }
});
test("global user erasure rolls back all effects and its receipt when subject capture fails", async () => {
  const { person } = await seed();
  const before = await state();
  const key = createId();
  await fixture.db.execute(
    sql`alter table audit_event_subjects add constraint user_erasure_fault check (relationship <> 'affected') not valid`,
  );
  try {
    expect((await erase(person.userId, key)).status).toBe(400);
  } finally {
    await fixture.db.execute(
      sql`alter table audit_event_subjects drop constraint user_erasure_fault`,
    );
  }
  expect(await state()).toEqual(before);
  expect((await erase(person.userId, key)).status).toBe(204);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "user.erased"));
  expect(event!.schemaVersion).toBe(3);
  expect(
    (await erase(person.userId, key)).headers.get("Idempotency-Replayed"),
  ).toBe("true");
});

for (const reference of ["entitlement", "capability"] as const) {
  test(`global user erasure preserves external ${reference} restrictions and rolls back earlier effects`, async () => {
    const { person, other, owned } = await seed();
    if (reference === "entitlement")
      await fixture.db.insert(entitlements).values({
        id: createId(),
        organizationId: other.organizationId,
        memberId: other.memberId,
        clientId: owned.clientId,
        scopes: ["read"],
      });
    else
      await fixture.db.insert(organizationCapabilities).values({
        id: createId(),
        organizationId: other.organizationId,
        clientId: owned.clientId,
        grantKind: "authorization_code",
        scopes: ["read"],
      });
    const before = await state();
    const key = createId();
    const refused = await erase(person.userId, key);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "reference_violation" });
    expect(await state()).toEqual(before);
    if (reference === "entitlement")
      await fixture.db
        .delete(entitlements)
        .where(eq(entitlements.clientId, owned.clientId));
    else
      await fixture.db
        .delete(organizationCapabilities)
        .where(eq(organizationCapabilities.clientId, owned.clientId));
    expect((await erase(person.userId, key)).status).toBe(204);
    expect(
      (await erase(person.userId, key)).headers.get("Idempotency-Replayed"),
    ).toBe("true");
  });
}

for (const order of ["user-first", "client-first"] as const) {
  test(`global user erasure orders owned-client effects with client erasure: ${order}`, async () => {
    const { person, owned } = await seed();
    const action = order === "user-first" ? "user.erased" : "client.erased";
    const gateKey = Math.floor(Math.random() * 1_000_000_000);
    await fixture.db.execute(
      sql.raw(
        `create function pause_user_erasure() returns trigger language plpgsql as $$ begin if NEW.action = '${action}' then perform pg_advisory_xact_lock(${gateKey}); end if; return NEW; end $$`,
      ),
    );
    await fixture.db.execute(
      sql`create trigger pause_user_erasure before insert on audit_events for each row execute function pause_user_erasure()`,
    );
    let entered!: () => void, release!: () => void;
    let blockerPid = 0;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = fixture.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${gateKey})`);
      blockerPid = Number(
        (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      entered();
      await resume;
    });
    const userKey = createId(),
      clientKey = createId();
    const eraseClient = () => {
      const headers = fixture.headers("root");
      headers.set("Idempotency-Key", clientKey);
      return app.request(
        `/api/admin/v1/clients/${owned.clientId}?confirm=${owned.clientId}`,
        { method: "DELETE", headers },
      );
    };
    async function waitingOn(pid: number) {
      const deadline = Date.now() + 1500;
      while (true) {
        const waiting = await runtime.db.execute(
          sql`select pid from pg_stat_activity where usename = ${role} and ${pid} = any(pg_blocking_pids(pid))`,
        );
        if (waiting.rows.length) return Number(waiting.rows[0]!.pid);
        if (Date.now() > deadline)
          throw new Error("Expected erasure lock was not observed");
        await Bun.sleep(10);
      }
    }
    let first: ReturnType<typeof app.request> | undefined,
      second: ReturnType<typeof app.request> | undefined;
    await held;
    try {
      first =
        order === "user-first" ? erase(person.userId, userKey) : eraseClient();
      const firstPid = await waitingOn(blockerPid);
      second =
        order === "user-first" ? eraseClient() : erase(person.userId, userKey);
      await waitingOn(firstPid);
    } finally {
      release();
      await blocker;
      await Promise.allSettled([first, second]);
      await fixture.db.execute(
        sql`drop trigger pause_user_erasure on audit_events`,
      );
      await fixture.db.execute(sql`drop function pause_user_erasure()`);
    }
    expect((await first!).status).toBe(204);
    expect((await second!).status).toBe(order === "user-first" ? 404 : 204);
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "user.erased"));
    const effects = event!.data!.effects as {
      softDeletedClients: Array<{ id: string }>;
      deletedAccessTokens: Array<{ clientId: string }>;
    };
    expect(effects.softDeletedClients.some((row) => row.id === owned.id)).toBe(
      order === "user-first",
    );
    expect(
      effects.deletedAccessTokens.some(
        (row) => row.clientId === owned.clientId,
      ),
    ).toBe(order === "user-first");
    expect(
      (await erase(person.userId, userKey)).headers.get("Idempotency-Replayed"),
    ).toBe("true");
  });
}

test("global erasure subject capture rejects unrelated versions, outcomes and malformed effect contracts", async () => {
  const person = fixture.principals.tenantReader,
    other = fixture.principals.outsider;
  const effect = { id: createId(), userId: other.userId };
  const base = {
    actorType: "system" as const,
    actorId: "contract-test",
    targetType: "user",
    targetId: person.userId,
    organizationId: null,
    action: "user.erased",
    outcome: "success" as const,
    schemaVersion: 2 as const,
  };
  const data = {
    before: { id: person.userId },
    effects: { deletedAccessTokens: [effect] },
  };
  for (const input of [
    { ...base, schemaVersion: 1 as const, data },
    { ...base, outcome: "failure" as const, data },
    { ...base, organizationId: person.organizationId, data },
    { ...base, action: "user.disabled", data },
    { ...base, data: { ...data, before: { id: other.userId } } },
    { ...base, data: { ...data, effects: { deletedAccessTokens: effect } } },
    {
      ...base,
      data: {
        ...data,
        effects: {
          deletedAccessTokens: [
            { ...effect, id: "" },
            { id: effect.id, userId: null },
          ],
        },
      },
    },
  ]) {
    const event = await recordAuditEvent(runtime.db, input);
    const subjects = await fixture.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, event.id));
    expect(subjects.filter((row) => row.relationship === "affected")).toEqual(
      [],
    );
  }
});
