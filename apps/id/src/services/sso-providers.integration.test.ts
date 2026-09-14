import type { PlatformApplicationIds } from "../auth/platform-applications.ts";
import { listUserAuditEvents } from "./audit.ts";
import {
  inPlatformWrite,
  inPlatformRead,
} from "../__tests__/platform-context.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import type { Database } from "../db/client.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createId } from "../lib/id.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
import {
  auditEvents,
  grantContexts,
  members,
  oauthClients,
  sessions,
  users,
} from "../db/schema/index.ts";
import type { Actor } from "./actor.ts";
const actor: Actor = {
  actorType: "system",
  actorId: "root",
  requestId: "service-test",
  ip: "192.0.2.1",
  userAgent: "test",
};
const invalidActor = { ...actor, requestId: "\0" };
import * as implementation from "./sso-providers.ts";
const service = {
  ...implementation,

  putSsoProvider: (
    db: Database,
    actor: Actor,
    org: string,
    input: implementation.SsoProviderInput,
    expected?: { id: string; revision: number } | null,
  ) =>
    inPlatformWrite(
      db,
      (context) => implementation.putSsoProvider(context, org, input, expected),
      actor,
    ),
  deleteSsoProvider: (db: Database, actor: Actor, org: string) =>
    inPlatformWrite(
      db,
      (context) => implementation.deleteSsoProvider(context, org),
      actor,
    ),
  getSsoProvider: (db: Database, org: string) =>
    inTenantRead(db, org, "directory", implementation.getSsoProvider),
};
import { findSsoProviderByOrganization } from "../__tests__/sso-queries.ts";
import { ssoProviders } from "../db/schema/index.ts";
import { eq } from "drizzle-orm";
const input = {
  issuer: "https://login.example.com",
  domain: "acme.example.com",
  oidc: { clientId: "client", clientSecret: "private-secret" },
};
test("provider upsert keeps omitted secrets, replaces supplied secrets, redacts reads and audits each write", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const created = await service.putSsoProvider(db, actor, org.id, input);
  expect(created.created).toBe(true);
  expect(created.provider).toMatchObject({
    providerId: org.slug,
    organizationId: org.id,
    oidc: { hasClientSecret: true },
  });
  expect(await service.getSsoProvider(db, org.id)).toEqual(created.provider);
  const updated = await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "changed" },
  });
  expect(updated.created).toBe(false);
  expect(updated.provider.oidc).toMatchObject({
    clientId: "changed",
    hasClientSecret: true,
  });
  expect(
    JSON.parse((await findSsoProviderByOrganization(db, org.id))!.oidcConfig!)
      .clientSecret,
  ).toBe("private-secret");
  await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "changed", clientSecret: "replacement-secret" },
  });
  expect(
    JSON.parse((await findSsoProviderByOrganization(db, org.id))!.oidcConfig!)
      .clientSecret,
  ).toBe("replacement-secret");
  await service.deleteSsoProvider(db, actor, org.id);
  await expect(service.getSsoProvider(db, org.id)).rejects.toMatchObject({
    status: 404,
    code: "not_found",
  });
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(4);
  expect(events.map((event) => event.action)).toEqual([
    "sso_provider.created",
    "sso_provider.updated",
    "sso_provider.updated",
    "sso_provider.deleted",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      organizationId: org.id,
      targetType: "sso_provider",
      targetId: created.provider.id,
      outcome: "success",
      data: {},
    });
  for (const value of [created.provider, updated.provider, events]) {
    expect(JSON.stringify(value)).not.toContain('"clientSecret"');
    expect(JSON.stringify(value)).not.toContain("private-secret");
    expect(JSON.stringify(value)).not.toContain("replacement-secret");
  }
});
test("missing provider and organisation paths produce 404 without audit", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  for (const id of [org.id, createId()]) {
    await expect(service.getSsoProvider(db, id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(
      service.deleteSsoProvider(db, actor, id),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  }
  await expect(
    service.putSsoProvider(db, actor, createId(), input),
  ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
test("secretless and null configurations can be updated, and all audit failures roll back", async () => {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  await expect(
    service.putSsoProvider(db, invalidActor, org.id, input),
  ).rejects.toThrow();
  expect(await findSsoProviderByOrganization(db, org.id)).toBeNull();
  const created = await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "public" },
  });
  expect(created.provider.oidc.hasClientSecret).toBe(false);
  await expect(
    service.putSsoProvider(db, invalidActor, org.id, input),
  ).rejects.toThrow();
  expect(await service.getSsoProvider(db, org.id)).toEqual(created.provider);
  await expect(
    service.deleteSsoProvider(db, invalidActor, org.id),
  ).rejects.toThrow();
  expect(await service.getSsoProvider(db, org.id)).toEqual(created.provider);
  await db
    .update(ssoProviders)
    .set({ oidcConfig: null })
    .where(eq(ssoProviders.id, created.provider.id));
  const updated = await service.putSsoProvider(db, actor, org.id, {
    ...input,
    oidc: { clientId: "public" },
  });
  expect(updated.provider.oidc.hasClientSecret).toBe(false);
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});

async function grantFixture(
  withProvider = true,
  providerInput: implementation.SsoProviderInput = input,
  ids: PlatformApplicationIds = {},
) {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  if (withProvider)
    await inPlatformWrite(
      db,
      (context) =>
        implementation.putSsoProvider(
          context,
          org.id,
          providerInput,
          undefined,
          ids,
        ),
      actor,
    );
  const userId = createId();
  const sessionId = createId();
  const authTime = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: "Shared user",
    status: "active",
  });
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token: createId(),
    createdAt: authTime,
    expiresAt: new Date(Date.now() + 60000),
  });
  const [client] = await db
    .insert(oauthClients)
    .values({
      id: createId(),
      clientId: createId(),
      redirectUris: [],
      scopes: ["openid"],
    })
    .returning();
  const contexts = [];
  for (const tenant of [org, other]) {
    const memberId = createId();
    await db
      .insert(members)
      .values({ id: memberId, userId, organizationId: tenant.id });
    const [grant] = await db
      .insert(grantContexts)
      .values({
        id: createId(),
        organizationId: tenant.id,
        memberId,
        userId,
        clientInstanceId: client!.id,
        authenticationSessionId: sessionId,
        authTime,
        requestedScopes: ["openid"],
        expiresAt: new Date(Date.now() + 60000),
      })
      .returning();
    contexts.push(grant!);
  }
  return { db, org, other, userId, sessionId, contexts };
}
const changedInput = {
  ...input,
  oidc: { ...input.oidc, clientSecret: "replacement-secret" },
};
for (const mode of ["create", "update", "delete"] as const) {
  test(`SSO ${mode} revokes only its tenant grants with exact audit effects and preserves browser access`, async () => {
    const { db, org, contexts, sessionId, userId } = await grantFixture(
      mode !== "create",
    );
    if (mode === "delete") await service.deleteSsoProvider(db, actor, org.id);
    else await service.putSsoProvider(db, actor, org.id, changedInput);
    const after = await db
      .select()
      .from(grantContexts)
      .orderBy(grantContexts.id);
    for (const grant of after)
      expect(grant.revokedAt !== null).toBe(grant.organizationId === org.id);
    const [event] = await db
      .select()
      .from(auditEvents)
      .orderBy(sql`${auditEvents.id} desc`)
      .limit(1);
    expect(event!.data!.effects).toEqual({
      revokedGrantContexts: [{ id: contexts[0]!.id, userId }],
    });
    expect(event!.organizationId).toBe(org.id);
    expect(JSON.stringify(event)).not.toContain(contexts[1]!.id);
    expect(
      await db.select().from(sessions).where(eq(sessions.id, sessionId)),
    ).toHaveLength(1);
    const history = await inPlatformRead(db, (context) =>
      listUserAuditEvents(
        context,
        userId,
        { action: event!.action },
        { limit: 100 },
      ),
    );
    expect(history.items.map((row) => row.id)).toContain(event!.id);
    // Restoring configuration or recreating a provider never restores old grants.
    await service.putSsoProvider(db, actor, org.id, input);
    expect(
      await db.select().from(grantContexts).orderBy(grantContexts.id),
    ).toEqual(after);
    const [restored] = await db
      .select()
      .from(auditEvents)
      .orderBy(sql`${auditEvents.id} desc`)
      .limit(1);
    expect(restored!.data!.effects).toEqual({ revokedGrantContexts: [] });
    await db.delete(users).where(eq(users.id, userId));
    const erasedHistory = await inPlatformRead(db, (context) =>
      listUserAuditEvents(
        context,
        userId,
        { action: event!.action },
        { limit: 100 },
      ),
    );
    expect(erasedHistory.items.map((row) => row.id)).toContain(event!.id);
  });
  test(`SSO ${mode} audit failure rolls back configuration and grant revocation`, async () => {
    const { db, org } = await grantFixture(mode !== "create");
    const beforeProvider = await findSsoProviderByOrganization(db, org.id);
    const beforeGrants = await db
      .select()
      .from(grantContexts)
      .orderBy(grantContexts.id);
    const beforeEvents = await db
      .select()
      .from(auditEvents)
      .orderBy(auditEvents.id);
    await expect(
      mode === "delete"
        ? service.deleteSsoProvider(db, invalidActor, org.id)
        : service.putSsoProvider(db, invalidActor, org.id, changedInput),
    ).rejects.toThrow();
    expect(await findSsoProviderByOrganization(db, org.id)).toEqual(
      beforeProvider,
    );
    expect(
      await db.select().from(grantContexts).orderBy(grantContexts.id),
    ).toEqual(beforeGrants);
    expect(await db.select().from(auditEvents).orderBy(auditEvents.id)).toEqual(
      beforeEvents,
    );
  });
}
test("unchanged SSO configuration preserves active grants and records empty effects", async () => {
  const { db, org } = await grantFixture();
  const before = await db
    .select()
    .from(grantContexts)
    .orderBy(grantContexts.id);
  expect(await service.putSsoProvider(db, actor, org.id, input)).toMatchObject({
    changed: false,
  });
  expect(
    await db.select().from(grantContexts).orderBy(grantContexts.id),
  ).toEqual(before);
  const [event] = await db
    .select()
    .from(auditEvents)
    .orderBy(sql`${auditEvents.id} desc`)
    .limit(1);
  expect(event!.data!.effects).toEqual({ revokedGrantContexts: [] });
});

const applicationIds = {
  google: { clientId: "platform-google" },
  microsoft: { clientId: "platform-microsoft" },
};
const platformIssuers = {
  google: "https://accounts.google.com",
  microsoft:
    "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
};
for (const application of ["google", "microsoft"] as const) {
  test(`${application} platform creation and deletion audit expose only application ids`, async () => {
    const db = connection.db;
    const org = await createOrganization(db, {
      slug: application,
      name: application,
    });
    const created = await inPlatformWrite(
      db,
      (context) =>
        implementation.putSsoProvider(
          context,
          org.id,
          {
            ...input,
            issuer: platformIssuers[application],
            oidc: { credentials: "platform" },
          },
          undefined,
          applicationIds,
        ),
      actor,
    );
    expect(created).toMatchObject({
      created: true,
      changed: true,
      provider: {
        oidc: {
          credentials: "platform",
          clientId: applicationIds[application].clientId,
          hasClientSecret: true,
        },
      },
    });
    expect(
      await inTenantRead(db, org.id, "directory", (context) =>
        implementation.getSsoProvider(context, applicationIds),
      ),
    ).toEqual(created.provider);
    await inPlatformWrite(
      db,
      (context) =>
        implementation.deleteSsoProvider(context, org.id, applicationIds),
      actor,
    );
    const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toMatchObject({
      before: null,
      after: { oidc: JSON.parse(JSON.stringify(created.provider.oidc)) },
      credentialsChanged: true,
    });
    expect(events[1]!.data).toMatchObject({
      before: { oidc: JSON.parse(JSON.stringify(created.provider.oidc)) },
      deletionMode: "soft",
    });
    expect(JSON.stringify(events)).not.toContain('"clientSecret"');
  });
}
test("unsupported or missing platform applications reject before configuration and audit writes", async () => {
  const db = connection.db;
  const org = await createOrganization(db, {
    slug: "missing-app",
    name: "Missing",
  });
  for (const [issuer, status, code] of [
    [input.issuer, 400, "platform_credentials_unsupported"],
    [platformIssuers.google, 409, "platform_application_missing"],
    [platformIssuers.microsoft, 409, "platform_application_missing"],
  ] as const) {
    await expect(
      inPlatformWrite(
        db,
        (context) =>
          implementation.putSsoProvider(context, org.id, {
            ...input,
            issuer,
            oidc: { credentials: "platform" },
          }),
        actor,
      ),
    ).rejects.toMatchObject({ status, code });
  }
  expect(await findSsoProviderByOrganization(db, org.id)).toBeNull();
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
for (const transition of [
  "own-platform",
  "platform-own-secret",
  "platform-own-no-secret",
  "platform-platform",
] as const) {
  test(`${transition} preserves credential boundaries and revokes grants only on change`, async () => {
    const own: implementation.SsoProviderInput = {
      ...input,
      issuer: platformIssuers.google,
    };
    const platform = { ...own, oidc: { credentials: "platform" as const } };
    const beforeInput = transition === "own-platform" ? own : platform;
    const afterInput: implementation.SsoProviderInput = transition.startsWith(
      "platform-own",
    )
      ? {
          ...own,
          oidc: {
            clientId: "own-again",
            ...(transition === "platform-own-secret"
              ? { clientSecret: "replacement-private" }
              : {}),
          },
        }
      : platform;
    const { db, org, contexts, userId } = await grantFixture(
      true,
      beforeInput,
      applicationIds,
    );
    const before = await findSsoProviderByOrganization(db, org.id);
    const changed = transition !== "platform-platform";
    const result = await inPlatformWrite(
      db,
      (context) =>
        implementation.putSsoProvider(
          context,
          org.id,
          afterInput,
          undefined,
          applicationIds,
        ),
      actor,
    );
    expect(result.changed).toBe(changed);
    const after = await findSsoProviderByOrganization(db, org.id);
    if (!changed) expect(after).toEqual(before);
    const stored = JSON.parse(after!.oidcConfig!);
    expect(
      stored.clientSecret ===
        (transition === "platform-own-secret"
          ? "replacement-private"
          : undefined),
    ).toBe(true);
    if (afterInput.oidc.credentials === "platform") {
      expect(stored).not.toHaveProperty("clientId");
      expect(stored).not.toHaveProperty("tokenEndpointAuthentication");
    }
    const grants = await db
      .select()
      .from(grantContexts)
      .orderBy(grantContexts.id);
    for (const grant of grants)
      expect(grant.revokedAt !== null).toBe(
        changed && grant.organizationId === org.id,
      );
    const [event] = await db
      .select()
      .from(auditEvents)
      .orderBy(sql`${auditEvents.id} desc`)
      .limit(1);
    expect(event!.data).toMatchObject({
      before: { oidc: { credentials: beforeInput.oidc.credentials ?? "own" } },
      after: { oidc: JSON.parse(JSON.stringify(result.provider.oidc)) },
      credentialsChanged: changed,
      effects: {
        revokedGrantContexts: changed ? [{ id: contexts[0]!.id, userId }] : [],
      },
    });
    const serialized = JSON.stringify([result.provider, event]);
    expect(serialized).not.toContain('"clientSecret"');
    expect(serialized.includes("private-secret")).toBe(false);
    expect(serialized.includes("replacement-private")).toBe(false);
  });
}
