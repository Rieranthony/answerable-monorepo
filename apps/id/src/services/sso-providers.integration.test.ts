import type { PlatformApplicationIds } from "../auth/platform-applications.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { inTenantRead } from "../__tests__/tenant-command.ts";
import {
  type Database,
  createDatabase,
  type DatabaseConnection,
} from "../db/client.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  insertGrantContext,
  insertOriginSession,
} from "../__tests__/grants.ts";
import { testEnvironment } from "../__tests__/support.ts";
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
  ssoProviders,
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
const input = {
  issuer: "https://login.example.com",
  domain: "acme.example.com",
  oidc: { clientId: "client", clientSecret: "private-secret" },
};
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
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: "Shared user",
    status: "active",
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
    const session = await insertOriginSession(db, {
      userId,
      organizationId: tenant.id,
    });
    contexts.push(
      await insertGrantContext(db, {
        id: createId(),
        organizationId: tenant.id,
        memberId,
        userId,
        clientInstanceId: client!.id,
        authenticationSessionId: session.id,
        requestedScopes: ["openid"],
        expiresAt: new Date(Date.now() + 60000),
      }),
    );
  }
  // Without a provider, the organisation's grant outlives the one that authenticated it.
  if (!withProvider)
    await db
      .update(ssoProviders)
      .set({ deletedAt: new Date() })
      .where(eq(ssoProviders.organizationId, org.id));
  return { db, org, other, userId, contexts };
}
const changedInput = {
  ...input,
  oidc: { ...input.oidc, clientSecret: "replacement-secret" },
};
for (const mode of ["create", "update", "delete"] as const) {
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
