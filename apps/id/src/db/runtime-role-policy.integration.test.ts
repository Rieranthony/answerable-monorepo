import { withDatabaseScope } from "./isolation.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createAuth } from "../auth.ts";
import { type DatabaseConnection } from "./client.ts";
import { auditEvents } from "./schema/index.ts";
import { assertRuntimeRole } from "./runtime-role.ts";
import {
  closeRuntimeRole,
  openRuntimeRole,
} from "../__tests__/runtime-role.ts";

let owner: DatabaseConnection;
let runtime: DatabaseConnection;
const roleName = `id_test_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
const environment = testEnvironment();
beforeAll(async () => {
  ({ owner, runtime } = await openRuntimeRole(environment, roleName));
});
afterAll(() => closeRuntimeRole({ owner, runtime }, roleName));
test("restricted runtime evaluates exact user pairs through scoped policy reads", async () => {
  const { createSsoProvider } = await import("../__tests__/sso-queries.ts");
  const { setDatabaseScope, withDatabaseScope } =
    await import("./isolation.ts");
  const { userResourcePolicy } =
    await import("../auth/user-resource-policy.ts");
  const {
    accounts,
    users,
    members,
    sessions,
    organizations,
    oauthClients,
    oauthResources,
    oauthClientResources,
    grantContexts,
    organizationCapabilities,
    entitlements,
  } = await import("./schema/index.ts");
  const userId = crypto.randomUUID(),
    organizationId = crypto.randomUUID(),
    memberId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    clientInstanceId = crypto.randomUUID(),
    resourceInstanceId = crypto.randomUUID(),
    pairId = crypto.randomUUID();
  const clientId = `policy-${clientInstanceId}`,
    resource = `https://${resourceInstanceId}.example`,
    authTime = new Date();
  await owner.db
    .insert(organizations)
    .values({ id: organizationId, slug: organizationId, name: "Policy" });
  await owner.db.insert(users).values({
    id: userId,
    name: "Policy",
    email: `${userId}@example.com`,
    status: "active",
  });
  await owner.db
    .insert(members)
    .values({ id: memberId, organizationId, userId });
  // Stored policy fixture; native acceptance is covered by the admission suite.
  const provider = await createSsoProvider(owner.db, {
    organizationId,
    providerId: organizationId,
    issuer: "https://policy.example.com",
    domain: "example.com",
    oidc: { clientId: "policy", clientSecret: "secret" },
  });
  const accountId = crypto.randomUUID();
  await owner.db.insert(accounts).values({
    id: accountId,
    userId,
    issuer: provider.issuer,
    providerId: provider.providerId,
    accountId: userId,
  });
  await owner.db.insert(sessions).values({
    id: sessionId,
    userId,
    token: crypto.randomUUID(),
    createdAt: authTime,
    authenticationOrganizationId: organizationId,
    authenticationProviderId: provider.id,
    authenticationProviderRevision: provider.revision,
    authenticationAccountId: accountId,
    expiresAt: new Date(Date.now() + 60000),
  });
  await owner.db.insert(oauthClients).values({
    id: clientInstanceId,
    clientId,
    redirectUris: [],
    grantTypes: ["authorization_code", "refresh_token"],
    scopes: ["openid", "read"],
  });
  await owner.db.insert(oauthResources).values({
    id: resourceInstanceId,
    identifier: resource,
    name: "Policy",
    allowedScopes: ["read"],
  });
  await owner.db
    .insert(oauthClientResources)
    .values({ id: crypto.randomUUID(), clientId, resourceId: resource });
  const { createResourceGrant } =
    await import("../auth/create-resource-grant.ts");
  const { id: grantId } = await createResourceGrant(
    runtime.db,
    {
      memberId,
      userId,
      sessionId,
      clientId,
      resource,
      scopes: ["openid", "read"],
    },
    60,
  );

  await owner.db
    .delete(oauthClientResources)
    .where(eq(oauthClientResources.clientId, clientId));
  await expect(
    createResourceGrant(
      runtime.db,
      {
        memberId,
        userId,
        sessionId,
        clientId,
        resource,
        scopes: ["openid", "read"],
      },
      60,
    ),
  ).rejects.toMatchObject({ body: { error: "access_denied" } });
  expect(
    await owner.db
      .select({ id: grantContexts.id })
      .from(grantContexts)
      .where(eq(grantContexts.userId, userId)),
  ).toEqual([{ id: grantId }]);
  await owner.db
    .insert(oauthClientResources)
    .values({ id: crypto.randomUUID(), clientId, resourceId: resource });

  await owner.db.insert(organizationCapabilities).values([
    {
      id: crypto.randomUUID(),
      organizationId,
      clientId,
      resource: null,
      grantKind: "authorization_code",
      scopes: ["openid"],
    },
    {
      id: crypto.randomUUID(),
      organizationId,
      clientId,
      resource,
      grantKind: "authorization_code",
      scopes: ["read"],
    },
  ]);
  await owner.db.insert(entitlements).values([
    {
      id: crypto.randomUUID(),
      organizationId,
      clientId,
      resource: null,
      scopes: ["openid"],
    },
    { id: pairId, organizationId, clientId, resource, scopes: ["read"] },
  ]);
  const input = {
    id: grantId,
    clientId,
    resource,
    grantType: "authorization_code" as const,
    requestedScopes: ["openid", "read"],
  };
  const { lockResourceGrantPolicy } =
    await import("../auth/lock-resource-grant-policy.ts");
  const { authTransaction } = await import("../auth/database-adapter.ts");
  const adapter = (await createAuth(runtime.db, environment).$context).adapter;
  const decision = await adapter.transaction(async (bound) => {
    await setDatabaseScope(authTransaction(bound), {
      kind: "grant-client",
      clientId,
    });
    await lockResourceGrantPolicy(bound, input);
    return userResourcePolicy(authTransaction(bound), input);
  });
  expect(decision).toMatchObject({
    allowed: true,
    scopes: ["read"],
    reason: "approved",
    grantType: "authorization_code",
    subjectType: "user",
    organization: { id: organizationId, authorizationVersion: 1 },
    subject: { userId, memberId },
    client: { id: clientInstanceId, clientId },
    resource: { id: resourceInstanceId, identifier: resource },
    requestedScopes: ["openid", "read"],
  });
  const { memberAccess, targetAccess } = await import("./queries/access.ts");
  const { inTenantRead } = await import("../__tests__/tenant-command.ts");
  const otherId = crypto.randomUUID(),
    otherMemberId = crypto.randomUUID();
  await owner.db
    .insert(organizations)
    .values({ id: otherId, slug: otherId, name: "Other policy" });
  await owner.db
    .insert(members)
    .values({ id: otherMemberId, organizationId: otherId, userId });
  await owner.db.insert(entitlements).values({
    id: crypto.randomUUID(),
    organizationId: otherId,
    clientId,
    resource,
    scopes: ["read"],
  });
  async function checkExplanation(allowed: boolean) {
    const view = await inTenantRead(
      runtime.db,
      organizationId,
      "memberAccess",
      (context) => memberAccess(context, memberId),
    );
    expect(
      view.targets.find((target) => target.kind === "client_resource")
        ?.permission,
    ).toMatchObject({ allowed });
    expect(
      view.targets.find((target) => target.kind === "client")!.permission,
    ).toMatchObject({ allowed });
    const loginPage = await inTenantRead(
      runtime.db,
      organizationId,
      "directory",
      (context) => targetAccess(context, { clientId }, { limit: 10 }),
    );
    expect(loginPage.items[0]!.permission).toMatchObject({ allowed });
    const page = await inTenantRead(
      runtime.db,
      organizationId,
      "directory",
      (context) => targetAccess(context, { clientId, resource }, { limit: 10 }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.permission).toMatchObject({ allowed });
    if (!allowed)
      expect(page.items[0]!.permission).toEqual({
        allowed: false,
        reason: "context",
      });
    const foreign = await inTenantRead(
      runtime.db,
      otherId,
      "memberAccess",
      (context) => memberAccess(context, otherMemberId),
    );
    expect(foreign.targets[0]?.permission).toEqual({
      allowed: false,
      reason: allowed ? "login" : "context",
    });
  }
  await checkExplanation(true);

  await owner.db
    .update(oauthClients)
    .set({ grantTypes: ["refresh_token"] })
    .where(eq(oauthClients.id, clientInstanceId));
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId },
      (tx) => userResourcePolicy(tx, input),
    ),
  ).toMatchObject({
    allowed: false,
    reason: "context",
    scopes: [],
    grantType: "authorization_code",
    organization: { id: organizationId },
    subject: { userId, memberId },
    client: { id: clientInstanceId, clientId },
    resource: { id: resourceInstanceId, identifier: resource },
  });
  await checkExplanation(false);
  await owner.db
    .update(oauthClients)
    .set({ grantTypes: ["authorization_code", "refresh_token"] })
    .where(eq(oauthClients.id, clientInstanceId));
  await owner.db
    .update(oauthClients)
    .set({ scopes: null })
    .where(eq(oauthClients.id, clientInstanceId));
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId },
      (tx) => userResourcePolicy(tx, input),
    ),
  ).toMatchObject({
    allowed: false,
    reason: "login",
  });
  await owner.db
    .update(oauthClients)
    .set({ scopes: ["openid", "read"] })
    .where(eq(oauthClients.id, clientInstanceId));
  await owner.db.delete(entitlements).where(eq(entitlements.id, pairId));
  expect(
    await withDatabaseScope(
      runtime.db,
      { kind: "grant-client", clientId },
      (tx) => userResourcePolicy(tx, input),
    ),
  ).toMatchObject({
    allowed: false,
    reason: "scope",
  });
  await assertRuntimeRole(runtime.db);
});

test("administrative RLS isolates rows while retaining routing and append-only broker access", async () => {
  const { createId } = await import("../lib/id.ts");
  const {
    members,
    invitations,
    organizationDomains,
    ssoProviders,
    organizations,
    users,
    auditEventSubjects,
  } = await import("./schema/index.ts");
  const { recordAuditEvent } = await import("./queries/audit.ts");
  const userId = createId();
  await owner.db.insert(users).values({
    id: userId,
    name: "RLS subject",
    email: `${userId}@example.com`,
    status: "active",
  });
  const tenants = [createId(), createId()];
  for (const organizationId of tenants) {
    await owner.db.insert(organizations).values({
      id: organizationId,
      slug: `rls-${organizationId}`,
      name: "RLS tenant",
    });
    await owner.db
      .insert(members)
      .values({ id: createId(), organizationId, userId });
    await owner.db.insert(invitations).values({
      id: createId(),
      organizationId,
      email: "invite@example.com",
      inviterId: userId,
      expiresAt: new Date(Date.now() + 60000),
    });
    await owner.db.insert(organizationDomains).values({
      id: createId(),
      organizationId,
      domain: `${organizationId}.example.com`,
    });
    await owner.db.insert(ssoProviders).values({
      id: createId(),
      organizationId,
      providerId: organizationId,
      issuer: "https://issuer.example.com",
      domain: `${organizationId}.example.com`,
    });
    await recordAuditEvent(runtime.db, {
      organizationId,
      actorType: "system",
      actorId: "rls-proof",
      action: "rls.proof",
      targetType: "user",
      targetId: userId,
      outcome: "success",
    });
  }
  for (const organizationId of tenants) {
    await withDatabaseScope(
      runtime.db,
      { kind: "tenant", access: "read", organizationId },
      async (tx) => {
        // Deliberately omit application tenant predicates.
        for (const table of [
          members,
          invitations,
          auditEvents,
          auditEventSubjects,
        ]) {
          const rows = await tx
            .select({ organizationId: table.organizationId })
            .from(table);
          expect(rows.length).toBeGreaterThan(0);
          expect(
            rows.every((row) => row.organizationId === organizationId),
          ).toBe(true);
        }
        // Routing is intentionally public to all database scopes.
        for (const table of [organizationDomains, ssoProviders]) {
          const rows = await tx
            .select({ organizationId: table.organizationId })
            .from(table);
          expect(rows.map((row) => row.organizationId)).toEqual(
            expect.arrayContaining(tenants),
          );
        }
      },
    );
  }
  const foreign = tenants[1]!;
  const inserts = [
    (tx: import("./client.ts").Executor) =>
      tx
        .insert(members)
        .values({ id: createId(), organizationId: foreign, userId }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(invitations).values({
        id: createId(),
        organizationId: foreign,
        email: "foreign@example.com",
        inviterId: userId,
        expiresAt: new Date(Date.now() + 60000),
      }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(organizationDomains).values({
        id: createId(),
        organizationId: foreign,
        domain: `${createId()}.example.com`,
      }),
    (tx: import("./client.ts").Executor) =>
      tx.insert(ssoProviders).values({
        id: createId(),
        organizationId: foreign,
        providerId: createId(),
        issuer: "https://issuer.example.com",
        domain: "foreign.example.com",
      }),
  ];
  for (const insert of inserts)
    await expect(
      withDatabaseScope(
        runtime.db,
        { kind: "tenant", access: "write", organizationId: tenants[0]! },
        async (tx) => {
          await insert(tx);
        },
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  expect(await runtime.db.select().from(members)).toEqual([]);
  expect(await runtime.db.select().from(invitations)).toEqual([]);
  expect(await runtime.db.select().from(auditEvents)).toEqual([]);
  expect(await runtime.db.select().from(auditEventSubjects)).toEqual([]);
  for (const table of [organizationDomains, ssoProviders])
    expect(
      (
        await runtime.db
          .select({ organizationId: table.organizationId })
          .from(table)
      ).map((row) => row.organizationId),
    ).toEqual(expect.arrayContaining(tenants));
  const event = await withDatabaseScope(
    runtime.db,
    { kind: "tenant", access: "write", organizationId: tenants[0]! },
    (tx) =>
      recordAuditEvent(tx, {
        organizationId: foreign,
        actorType: "system",
        actorId: "rls-proof",
        action: "rls.append",
        targetType: "user",
        targetId: userId,
        outcome: "success",
      }),
  );
  expect(
    await owner.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, event.id)),
  ).toEqual([event]);
  await expect(
    Promise.resolve(
      runtime.db.insert(auditEventSubjects).values({
        eventId: event.id,
        entityType: "user",
        entityId: userId,
        relationship: "forged",
        organizationId: foreign,
      }),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  for (const table of [
    "members",
    "invitations",
    "organization_domains",
    "sso_providers",
    "audit_events",
    "audit_event_subjects",
  ]) {
    await owner.db.execute(
      sql`alter table ${sql.identifier(table)} disable row level security`,
    );
    try {
      await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
        "Unsafe database runtime role",
      );
    } finally {
      await owner.db.execute(
        sql`alter table ${sql.identifier(table)} enable row level security`,
      );
    }
  }
  await assertRuntimeRole(runtime.db);
});

test("policy-user access tables require an effective membership", async () => {
  const { createId } = await import("../lib/id.ts");
  const { organizations, users, members, groups } =
    await import("./schema/index.ts");
  const organizationId = createId(),
    userId = createId(),
    memberId = createId();
  await owner.db.insert(organizations).values({
    id: organizationId,
    slug: `effective-${organizationId}`,
    name: "Effective membership",
  });
  await owner.db.insert(users).values({
    id: userId,
    name: "Member",
    email: `${userId}@example.com`,
    status: "active",
  });
  await owner.db
    .insert(members)
    .values({ id: memberId, organizationId, userId });
  await owner.db.insert(groups).values({
    id: createId(),
    organizationId,
    slug: "effective",
    name: "Effective",
  });
  const rows = () =>
    withDatabaseScope(runtime.db, { kind: "policy-user", userId }, (tx) =>
      tx.select().from(groups),
    );
  expect(await rows()).toHaveLength(1);
  for (const patch of [
    { validFrom: new Date(Date.now() + 60000), validUntil: null },
    { validFrom: null, validUntil: new Date(Date.now() - 60000) },
    { validUntil: null, status: "revoked" as const, revokedAt: new Date() },
    { deletedAt: new Date() },
  ]) {
    await owner.db.update(members).set(patch).where(eq(members.id, memberId));
    expect(await rows()).toEqual([]);
  }
});
