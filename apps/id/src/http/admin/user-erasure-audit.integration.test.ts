import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  insertGrantContext,
  insertOriginSession,
} from "../../__tests__/grants.ts";
import { recordAuditEvent } from "../../db/queries/audit.ts";
import {
  accounts,
  adminOperations,
  auditEvents,
  auditEventUsers,
  entitlements,
  grantContexts,
  groupMembers,
  groups,
  members,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  sessions,
  ssoProviders,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 4 },
    { restrictedRole: true },
  );
});
afterEach(async () => {
  await fixture?.close();
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
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, person.userId));
  const expiresAt = new Date("2100-01-01");
  const clientId = fixture.platform.client.clientId;
  const refreshId = createId();
  await fixture.db.insert(oauthRefreshTokens).values({
    id: refreshId,
    token: "private-refresh-token",
    clientId,
    userId: person.userId,
    sessionId: session!.id,
    scopes: ["read"],
    expiresAt,
    rotationReplayResponse: "private-replay-body",
  });
  await fixture.db.insert(oauthAccessTokens).values({
    id: createId(),
    token: "private-access-token",
    clientId,
    userId: person.userId,
    refreshId,
    sessionId: session!.id,
    scopes: ["read"],
    expiresAt,
  });
  await fixture.db.insert(oauthConsents).values({
    id: createId(),
    clientId,
    userId: person.userId,
    scopes: ["read"],
  });
  const [client] = await fixture.db
    .insert(oauthClients)
    .values({
      id: createId(),
      clientId: createId(),
      redirectUris: [],
      scopes: ["read"],
    })
    .returning();
  for (const membership of [
    { ...person, sessionId: session!.id },
    {
      ...person,
      memberId: secondMember!.id,
      organizationId: other.organizationId,
      sessionId: (
        await insertOriginSession(fixture.db, {
          userId: person.userId,
          organizationId: other.organizationId,
        })
      ).id,
    },
  ])
    await insertGrantContext(fixture.db, {
      id: createId(),
      organizationId: membership.organizationId,
      memberId: membership.memberId,
      userId: person.userId,
      clientInstanceId: client!.id,
      authenticationSessionId: membership.sessionId,
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
  return { person, other };
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
    providers: await fixture.db
      .select()
      .from(ssoProviders)
      .orderBy(ssoProviders.id),
    clients: await fixture.db
      .select()
      .from(oauthClients)
      .orderBy(oauthClients.id),
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
  return fixture.app.request(`/api/admin/v1/users/${id}?confirm=${id}`, {
    method: "DELETE",
    headers,
  });
}
test("global user erasure records actual cross-tenant effects without credentials", async () => {
  const { person, other } = await seed();
  const before = await state();
  const key = createId();
  const response = await erase(person.userId, key);
  expect(response.status).toBe(204);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  const after = await state();
  const effects = event!.data!.effects as Record<string, Array<{ id: string }>>;
  for (const [effect, table] of Object.entries({
    softDeletedMembers: "members",
    softDeletedAssignments: "assignments",
    softDeletedEntitlements: "entitlements",
    softDeletedAccounts: "accounts",
    deletedSessions: "sessions",
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
  ])
    expect(effects[name]).toContainEqual(
      expect.objectContaining({ userId: person.userId }),
    );
  for (const name of [
    "clearedAccessTokenSessions",
    "clearedRefreshTokenSessions",
  ])
    expect(effects[name]).toContainEqual(
      expect.objectContaining({ userId: other.userId }),
    );
  expect(
    (event!.data!.revokedGrantContexts as { id: string }[])
      .map((row) => row.id)
      .sort(),
  ).toEqual(
    before.grants
      .filter((row) => row.userId === person.userId)
      .map((row) => row.id)
      .sort(),
  );

  expect(after.groups).toEqual(before.groups);
  expect(after.providers).toEqual(before.providers);
  expect(after.clients).toEqual(before.clients);
  for (const name of [
    "accounts",
    "sessions",
    "consents",
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
  for (const secret of [
    "private-client-secret",
    "private-refresh-token",
    "private-access-token",
    "private-replay-body",
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
  const history = await fixture.app.request(
    `/api/admin/v1/users/${other.userId}/audit-events?action=user.erased`,
    { headers: fixture.headers("root") },
  );
  expect(history.status).toBe(200);
  expect(
    (await history.json()).items.map((row: { id: string }) => row.id),
  ).toEqual([event!.id]);

  // Isolate each manifest naming another user: one must not mask a missing extraction.
  for (const name of [
    "clearedAccessTokenSessions",
    "clearedRefreshTokenSessions",
  ]) {
    const isolated = await recordAuditEvent(fixture.appDb, {
      actorType: "system",
      actorId: "contract-test",
      organizationId: null,
      targetType: "user",
      targetId: person.userId,
      action: "user.erased",
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
      .from(auditEventUsers)
      .where(eq(auditEventUsers.eventId, isolated.id));
    expect(subjects.map((row) => row.userId).sort()).toEqual(
      [person.userId, other.userId].sort(),
    );
  }
});
