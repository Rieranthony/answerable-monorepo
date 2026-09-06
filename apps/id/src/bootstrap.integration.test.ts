import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { testEnvironment } from "./__tests__/support.ts";
import { assertDisposableTestDatabase } from "./__tests__/test-database.ts";
import {
  addStaff,
  bootstrap,
  PlatformNotBootstrappedError,
  platformAdminsGroupSlug,
  platformScopes,
  StaffUserNotFoundError,
  type BootstrapOptions,
} from "./bootstrap.ts";
import { createDatabase } from "./db/client.ts";
import {
  auditEvents,
  entitlements,
  groupMembers,
  groups,
  members,
  oauthClientResources,
  oauthClients,
  oauthResources,
  organizationDomains,
  organizations,
  ssoProviders,
  users,
} from "./db/schema/index.ts";
import { adminScopes } from "./http/admin/scopes.ts";
import { createId } from "./lib/id.ts";
import { hashClientSecret } from "./services/client-secrets.ts";

const connection = createDatabase(testEnvironment());
const db = connection.db;
const options: BootstrapOptions = {
  platformOrganizationSlug: "answerable",
  platformOrganizationName: "Answerable",
  platformDomain: "Answerable.ORG",
  sso: {
    issuer: "https://issuer.example.com",
    clientId: "sso-client",
    clientSecret: "sso-secret",
  },
  adminResourceIdentifier: "https://id.answerable.org/api/admin",
  bootstrapClientId: "answerable-bootstrap",
};
const staff = {
  platformOrganizationSlug: options.platformOrganizationSlug,
  email: " Person@Answerable.ORG ",
};

beforeEach(async () => {
  assertDisposableTestDatabase("truncate bootstrap fixtures");
  await db.execute(
    sql`truncate table organizations, users, oauth_resources, oauth_clients, audit_events cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

async function rows() {
  return {
    organization: await db.select().from(organizations),
    domain: await db.select().from(organizationDomains),
    ssoProvider: await db.select().from(ssoProviders),
    resource: await db.select().from(oauthResources),
    group: await db.select().from(groups),
    entitlement: await db.select().from(entitlements),
    client: await db.select().from(oauthClients),
    links: await db.select().from(oauthClientResources),
  };
}

const auditChanges = (created: boolean, updated = false) =>
  Object.fromEntries(
    [
      "organization",
      "domain",
      "ssoProvider",
      "resource",
      "group",
      "entitlement",
      "client",
    ].map((key) => [key, { created, updated }]),
  );

test("creates the complete platform, repeats without changes and repairs drift", async () => {
  const first = await bootstrap(db, options);
  for (const row of Object.values(first)) expect(row.created).toBe(true);
  const seeded = await rows();
  for (const table of Object.values(seeded)) expect(table).toHaveLength(1);
  expect(seeded.organization[0]).toMatchObject({
    id: first.organization.id,
    slug: "answerable",
    name: "Answerable",
    status: "active",
  });
  expect(seeded.domain[0]).toMatchObject({
    id: first.domain.id,
    organizationId: first.organization.id,
    domain: "answerable.org",
    status: "active",
  });
  expect(seeded.ssoProvider[0]).toMatchObject({
    id: first.ssoProvider.id,
    organizationId: first.organization.id,
    providerId: "answerable",
    issuer: options.sso.issuer,
    domain: "answerable.org",
  });
  expect(JSON.parse(seeded.ssoProvider[0]!.oidcConfig!)).toEqual({
    issuer: options.sso.issuer,
    clientId: "sso-client",
    clientSecret: "sso-secret",
    tokenEndpointAuthentication: "client_secret_post",
    pkce: true,
    discoveryEndpoint: `${options.sso.issuer}/.well-known/openid-configuration`,
    overrideUserInfo: false,
  });
  expect(seeded.resource[0]).toMatchObject({
    id: first.resource.id,
    identifier: options.adminResourceIdentifier,
    name: "Answerable ID admin API",
    accessTokenTtl: 600,
    allowedScopes: [...adminScopes],
    disabled: false,
  });
  expect(seeded.group[0]).toMatchObject({
    id: first.group.id,
    organizationId: first.organization.id,
    slug: platformAdminsGroupSlug,
    name: "Platform admins",
    status: "active",
  });
  expect(seeded.entitlement[0]).toMatchObject({
    id: first.entitlement.id,
    organizationId: first.organization.id,
    groupId: first.group.id,
    memberId: null,
    clientId: null,
    resource: options.adminResourceIdentifier,
    scopes: platformScopes,
  });
  expect(first.client.clientSecret).toBeString();
  expect(seeded.client[0]).toMatchObject({
    clientId: options.bootstrapClientId,
    clientSecret: hashClientSecret(first.client.clientSecret!),
    name: "Answerable bootstrap",
    redirectUris: [],
    grantTypes: ["client_credentials"],
    responseTypes: [],
    tokenEndpointAuthMethod: "client_secret_basic",
    scopes: [],
    clientCredentialsScopes: platformScopes,
    organizationId: first.organization.id,
    disabled: false,
  });
  expect(seeded.links[0]).toMatchObject({
    clientId: options.bootstrapClientId,
    resourceId: options.adminResourceIdentifier,
  });
  let audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "bootstrap.applied",
    actorType: "system",
    actorId: "bootstrap",
    organizationId: first.organization.id,
    targetType: "organization",
    targetId: first.organization.id,
    outcome: "success",
    data: auditChanges(true),
  });
  expect(JSON.stringify(audit)).not.toContain(first.client.clientSecret!);
  expect(JSON.stringify(audit)).not.toContain(options.sso.clientSecret);

  const second = await bootstrap(db, options);
  for (const row of Object.values(second)) {
    expect(row.created).toBe(false);
    if ("updated" in row) expect(row.updated).toBe(false);
  }
  expect(second.client.clientSecret).toBeNull();
  expect(await rows()).toEqual(seeded);
  audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(2);
  expect(audit[1]!.data).toEqual(auditChanges(false));

  await db
    .update(oauthResources)
    .set({ accessTokenTtl: 42, name: "Drift", allowedScopes: [] })
    .where(eq(oauthResources.id, first.resource.id));
  await db
    .update(entitlements)
    .set({ scopes: ["platform:read"] })
    .where(eq(entitlements.id, first.entitlement.id));
  const third = await bootstrap(db, {
    ...options,
    platformOrganizationName: "Answerable platform",
    sso: {
      ...options.sso,
      issuer: "https://new.example.com",
      discoveryEndpoint: "https://new.example.com/discovery",
    },
  });
  for (const row of [
    third.organization,
    third.ssoProvider,
    third.resource,
    third.entitlement,
  ])
    expect(row.updated).toBe(true);
  for (const row of Object.values(third)) expect(row.created).toBe(false);
  expect(third.client.clientSecret).toBeNull();
  const repaired = await rows();
  expect(repaired.organization[0]!.name).toBe("Answerable platform");
  expect(repaired.ssoProvider[0]!.issuer).toBe("https://new.example.com");
  expect(JSON.parse(repaired.ssoProvider[0]!.oidcConfig!)).toMatchObject({
    issuer: "https://new.example.com",
    discoveryEndpoint: "https://new.example.com/discovery",
  });
  expect(repaired.resource[0]).toMatchObject({
    accessTokenTtl: 600,
    name: "Answerable ID admin API",
    allowedScopes: [...adminScopes],
  });
  expect(repaired.entitlement[0]!.scopes).toEqual(platformScopes);
  expect(repaired.client).toEqual(seeded.client);
  audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit).toHaveLength(3);
  expect(audit[2]!.data).toEqual({
    ...auditChanges(false),
    organization: { created: false, updated: true },
    ssoProvider: { created: false, updated: true },
    resource: { created: false, updated: true },
    entitlement: { created: false, updated: true },
  });
});

test("repairs client ownership, scope ceiling and missing resource links without rotating the secret", async () => {
  const seeded = await bootstrap(db, options);
  await db
    .update(oauthClients)
    .set({ organizationId: null, clientCredentialsScopes: null });
  await db.delete(oauthClientResources);
  const result = await bootstrap(db, options);
  expect(result.client).toEqual({
    clientId: options.bootstrapClientId,
    created: false,
    clientSecret: null,
  });
  const [client] = await db.select().from(oauthClients);
  expect(client).toMatchObject({
    organizationId: seeded.organization.id,
    clientCredentialsScopes: platformScopes,
    clientSecret: hashClientSecret(seeded.client.clientSecret!),
  });
  expect(await db.select().from(oauthClientResources)).toHaveLength(1);
  const audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audit[1]!.data).toEqual({
    ...auditChanges(false),
    client: { created: false, updated: true },
  });
  await db.delete(oauthClientResources);
  await bootstrap(db, options);
  expect(await db.select().from(oauthClientResources)).toHaveLength(1);
});

test("rolls back the entire seed when a domain CHECK fails", async () => {
  await expect(
    bootstrap(db, { ...options, platformDomain: "invalid domain" }),
  ).rejects.toThrow();
  for (const table of Object.values(await rows()))
    expect(table).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

test("also rolls back earlier rows when a late client insert fails", async () => {
  await expect(
    bootstrap(db, { ...options, bootstrapClientId: null as unknown as string }),
  ).rejects.toThrow();
  for (const table of Object.values(await rows()))
    expect(table).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

test("staff requires the platform organisation and its admin group", async () => {
  await expect(addStaff(db, staff)).rejects.toBeInstanceOf(
    PlatformNotBootstrappedError,
  );
  await db
    .insert(organizations)
    .values({ id: createId(), slug: "answerable", name: "Answerable" });
  await expect(addStaff(db, staff)).rejects.toBeInstanceOf(
    PlatformNotBootstrappedError,
  );
});

test("unknown, inert and disabled staff cannot be added", async () => {
  await bootstrap(db, options);
  await expect(addStaff(db, staff)).rejects.toBeInstanceOf(
    StaffUserNotFoundError,
  );
  await expect(addStaff(db, staff)).rejects.toThrow("person@answerable.org");
  await db.insert(users).values({
    id: createId(),
    name: "Person",
    email: "person@answerable.org",
    status: "inert",
  });
  await expect(addStaff(db, staff)).rejects.toBeInstanceOf(
    StaffUserNotFoundError,
  );
  await db.update(users).set({ status: "disabled", disabledAt: new Date() });
  await expect(addStaff(db, staff)).rejects.toBeInstanceOf(
    StaffUserNotFoundError,
  );
  expect(await db.select().from(members)).toHaveLength(0);
  expect(await db.select().from(groupMembers)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(1);
});

test("adds active staff once and audits every application", async () => {
  const platform = await bootstrap(db, options);
  const userId = createId();
  await db.insert(users).values({
    id: userId,
    email: "person@answerable.org",
    name: "Person",
    status: "active",
  });
  const first = await addStaff(db, staff);
  expect(first).toMatchObject({
    userId,
    member: { created: true },
    groupMember: { created: true },
  });
  expect(await db.select().from(members)).toMatchObject([
    {
      id: first.memberId,
      organizationId: platform.organization.id,
      userId,
      role: "member",
    },
  ]);
  expect(await db.select().from(groupMembers)).toMatchObject([
    {
      organizationId: platform.organization.id,
      groupId: platform.group.id,
      memberId: first.memberId,
    },
  ]);
  const second = await addStaff(db, staff);
  expect(second).toEqual({
    userId,
    memberId: first.memberId,
    member: { created: false },
    groupMember: { created: false },
  });
  expect(await db.select().from(members)).toHaveLength(1);
  expect(await db.select().from(groupMembers)).toHaveLength(1);
  const audit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "staff.added"))
    .orderBy(auditEvents.id);
  expect(audit).toHaveLength(2);
  expect(audit[0]).toMatchObject({
    actorType: "system",
    actorId: "bootstrap",
    organizationId: platform.organization.id,
    targetType: "user",
    targetId: userId,
    outcome: "success",
    data: { email: "person@answerable.org", member: true, groupMember: true },
  });
  expect(audit[1]!.data).toEqual({
    email: "person@answerable.org",
    member: false,
    groupMember: false,
  });
  await db.delete(groupMembers);
  expect(await addStaff(db, staff)).toMatchObject({
    member: { created: false },
    groupMember: { created: true },
  });
});
