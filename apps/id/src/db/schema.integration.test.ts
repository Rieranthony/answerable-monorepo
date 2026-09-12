import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { createClient } from "../__tests__/client-queries.ts";
import {
  createOrganizationDomain,
  organizationAcceptsDomain,
} from "../__tests__/domain-queries.ts";
import { createEntitlement } from "../__tests__/entitlement-queries.ts";
import { addGroupMember, createGroup } from "../__tests__/group-queries.ts";
import { createSsoProvider } from "../__tests__/sso-queries.ts";
import { isUuidV7, testEnvironment } from "../__tests__/support.ts";
import { retireUserEmail } from "../__tests__/user-queries.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createId } from "../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import {
  accounts,
  auditEvents,
  entitlements,
  grantContexts,
  groupMembers,
  groups,
  invitations,
  jwks,
  members,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  organizationCapabilities,
  organizationDomains,
  organizations,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "./schema/index.ts";

const environment = testEnvironment();
let connection: DatabaseConnection;

beforeAll(() => {
  connection = createDatabase(environment);
});

beforeEach(async () => {
  await connection.db.execute(sql`
    truncate table
      audit_events,
      entitlements,
      group_members,
      groups,
      organization_domains,
      sso_providers,
      oauth_client_assertions,
      oauth_access_tokens,
      oauth_refresh_tokens,
      oauth_consents,
      oauth_client_resources,
      oauth_resources,
      oauth_clients,
      jwks,
      invitations,
      members,
      sessions,
      accounts,
      verifications,
      organizations,
      users
    cascade
  `);
});

afterAll(async () => {
  await connection.close();
});

async function insertUser(email = "person@example.com") {
  const [user] = await connection.db
    .insert(users)
    .values({ id: createId(), name: "Test Person", email, status: "active" })
    .returning();
  return user!;
}

async function insertOrganization(slug = "example") {
  const [organization] = await connection.db
    .insert(organizations)
    .values({ id: createId(), name: "Example", slug })
    .returning();
  return organization!;
}

async function insertMember(organizationId: string, userId: string) {
  const [member] = await connection.db
    .insert(members)
    .values({ id: createId(), organizationId, userId })
    .returning();
  return member!;
}

async function registerTutor(auth: ReturnType<typeof createAuth>) {
  // The plugin's admin endpoints require a Better Auth session and privilege
  // hooks, which arrive with the admin API milestone. Its adapter paths
  // exercise the same tables, field mapping, and id generation.
  const { adapter } = await auth.$context;
  const clientId = "omnichat-test-cell";
  const resource = "https://mcp.example.com";
  await adapter.create({
    model: "oauthClient",
    data: {
      clientId,
      name: "OmniChat test cell",
      redirectUris: ["https://chat.example.com/callback"],
      tokenEndpointAuthMethod: "private_key_jwt",
      grantTypes: ["authorization_code", "refresh_token"],
    },
  });
  await adapter.create({
    model: "oauthResource",
    data: { identifier: resource, name: "Tutor MCP", accessTokenTtl: 300 },
  });
  await adapter.create({
    model: "oauthClientResource",
    data: { clientId, resourceId: resource },
  });
  return { clientId, resource };
}

const allTables = [
  users,
  organizations,
  sessions,
  accounts,
  verifications,
  members,
  invitations,
  jwks,
  oauthClients,
  oauthResources,
  oauthClientResources,
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthConsents,
  oauthClientAssertions,
  organizationCapabilities,
  organizationDomains,
  groups,
  groupMembers,
  grantContexts,
  entitlements,
  ssoProviders,
  auditEvents,
];

describe("integration: PostgreSQL schema", () => {
  test("resolves every table configuration and foreign key reference", () => {
    for (const table of allTables) {
      // Resolving every lazy reference proves each foreign key points at a
      // real schema column, not merely that PostgreSQL accepted the push.
      for (const foreignKey of getTableConfig(table).foreignKeys) {
        const reference = foreignKey.reference();
        expect(reference.columns).not.toBeEmpty();
        expect(reference.foreignColumns).toHaveLength(reference.columns.length);
      }
    }
  });

  test("Better Auth creates core records with UUIDv7 and the inert default", async () => {
    const auth = createAuth(connection.db, environment);
    const context = await auth.$context;
    const adapter = context.internalAdapter;
    const user = await adapter.createUser(
      { name: "Better Auth User", email: "better-auth@example.com" },
      { method: "admin" },
    );
    const session = await adapter.createSession(user.id);

    expect(isUuidV7(user.id)).toBe(true);
    expect(isUuidV7(session.id)).toBe(true);
    expect(user.status).toBe("inert");
    expect((await adapter.findUserById(user.id))?.email).toBe(user.email);
    expect((await adapter.findSession(session.token))?.user.id).toBe(user.id);

    const organization = await auth.api.createOrganization({
      body: { name: "Contoso", slug: "contoso", userId: user.id },
    });

    expect(isUuidV7(organization!.id)).toBe(true);
    expect(organization!.status).toBe("active");

    const [membership] = await connection.db
      .select()
      .from(members)
      .where(eq(members.organizationId, organization!.id));
    expect(isUuidV7(membership!.id)).toBe(true);
    expect(membership!.validFrom).toBeNull();
    expect(membership!.validUntil).toBeNull();

    const validUntil = new Date(Date.now() + 86_400_000);
    await context.adapter.update({
      model: "member",
      where: [{ field: "id", value: membership!.id }],
      update: { validUntil },
    });
    const [updatedMembership] = await connection.db
      .select()
      .from(members)
      .where(eq(members.id, membership!.id));
    expect(updatedMembership!.validUntil).toEqual(validUntil);

    const openApi = await auth.api.generateOpenAPISchema();
    expect(Object.keys(openApi.paths)).toContain("/organization/create");
    expect(Object.keys(openApi.paths)).toContain("/oauth2/token");
  });

  test("joins accounts onto users through the Drizzle relations", async () => {
    const adapter = (await createAuth(connection.db, environment).$context)
      .internalAdapter;
    const user = await adapter.createUser(
      { name: "Linked User", email: "linked@example.com" },
      { method: "admin" },
    );
    await adapter.createAccount({
      userId: user.id,
      issuer: "https://login.microsoftonline.com/tenant/v2.0",
      accountId: "object-id",
      providerId: "microsoft",
    });

    const found = await adapter.findUserByEmail("linked@example.com", {
      includeAccounts: true,
    });

    expect(found?.user.id).toBe(user.id);
    expect(found?.accounts.map((account) => account.accountId)).toEqual([
      "object-id",
    ]);
  });

  test("accepts the verification ids Better Auth computes itself", async () => {
    const adapter = (await createAuth(connection.db, environment).$context)
      .internalAdapter;
    const reservation = {
      identifier: "revoke-unproven-account-access:example",
      value: "example",
      expiresAt: new Date(Date.now() + 5_000),
    };

    expect(await adapter.reserveVerificationValue(reservation)).toBe(true);
    expect(await adapter.reserveVerificationValue(reservation)).toBe(false);
  });

  test("stores OAuth clients, resources, links, and signing keys with UUIDv7", async () => {
    const auth = createAuth(connection.db, environment);
    const { clientId, resource } = await registerTutor(auth);

    const [client] = await connection.db.select().from(oauthClients);
    const [tutor] = await connection.db.select().from(oauthResources);
    const [link] = await connection.db.select().from(oauthClientResources);
    expect(isUuidV7(client!.id)).toBe(true);
    expect(client!.clientId).toBe(clientId);
    expect(client!.redirectUris).toEqual(["https://chat.example.com/callback"]);
    expect(client!.disabled).toBe(false);
    expect(isUuidV7(tutor!.id)).toBe(true);
    expect(tutor!.identifier).toBe(resource);
    expect(tutor!.accessTokenTtl).toBe(300);
    expect(isUuidV7(link!.id)).toBe(true);
    expect(link!).toMatchObject({ clientId, resourceId: resource });

    const published = await auth.api.getJwks();
    const [key] = await connection.db.select().from(jwks);
    expect(isUuidV7(key!.id)).toBe(true);
    expect(published.keys[0]?.kid).toBe(key!.id);

    await connection.db
      .delete(oauthClients)
      .where(eq(oauthClients.clientId, clientId));
    expect(
      await connection.db.select().from(oauthClientResources),
    ).toHaveLength(0);
  });

  test("keeps a machine client inside its owning organization", async () => {
    const organization = await insertOrganization();
    const { clientId } = await createClient(connection.db, {
      clientId: "owned-machine",
      redirectUris: [],
      organizationId: organization.id,
    });

    const owningOrganization =
      await connection.db.query.organizations.findFirst({
        where: eq(organizations.id, organization.id),
        with: { oauthClients: true },
      });
    const ownedClient = await connection.db.query.oauthClients.findFirst({
      where: eq(oauthClients.clientId, clientId),
      with: { organization: true },
    });
    expect(
      owningOrganization?.oauthClients.map((client) => client.clientId),
    ).toEqual([clientId]);
    expect(ownedClient?.organization?.id).toBe(organization.id);

    await expect(
      connection.db
        .delete(organizations)
        .where(eq(organizations.id, organization.id))
        .execute(),
    ).rejects.toThrow();
  });

  test("accepts the client assertion ids Better Auth computes itself", async () => {
    const { adapter } = await createAuth(connection.db, environment).$context;
    const assertion = {
      id: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ab",
      expiresAt: new Date(Date.now() + 300_000),
    };

    await adapter.create({
      model: "oauthClientAssertion",
      data: assertion,
      forceAllowId: true,
    });
    await expect(
      adapter.create({
        model: "oauthClientAssertion",
        data: assertion,
        forceAllowId: true,
      }),
    ).rejects.toThrow();
    expect(
      await connection.db.select().from(oauthClientAssertions),
    ).toHaveLength(1);
  });

  test("advances updated_at on Better Auth and Drizzle updates", async () => {
    const auth = createAuth(connection.db, environment);
    const context = await auth.$context;
    const owner = await context.internalAdapter.createUser(
      { name: "Owner", email: "owner@example.com" },
      { method: "admin" },
    );
    const organization = (await auth.api.createOrganization({
      body: { name: "Contoso", slug: "contoso", userId: owner.id },
    }))!;
    const domain = await createOrganizationDomain(connection.db, {
      organizationId: organization.id,
      domain: "contoso.com",
    });
    const past = new Date("2020-01-01T00:00:00Z");
    await connection.db
      .update(organizations)
      .set({ updatedAt: past })
      .where(eq(organizations.id, organization.id));
    await connection.db
      .update(organizationDomains)
      .set({ updatedAt: past })
      .where(eq(organizationDomains.id, domain.id));

    await context.adapter.update({
      model: "organization",
      where: [{ field: "id", value: organization.id }],
      update: { name: "Contoso Ltd" },
    });
    await connection.db
      .update(organizationDomains)
      .set({ status: "disabled" })
      .where(eq(organizationDomains.id, domain.id));

    const [updatedOrganization] = await connection.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    const [updatedDomain] = await connection.db
      .select()
      .from(organizationDomains)
      .where(eq(organizationDomains.id, domain.id));
    expect(updatedOrganization!.name).toBe("Contoso Ltd");
    expect(updatedOrganization!.updatedAt.getTime()).toBeGreaterThan(
      past.getTime(),
    );
    expect(updatedDomain!.status).toBe("disabled");
    expect(updatedDomain!.updatedAt.getTime()).toBeGreaterThan(past.getTime());
  });

  test("the real Better Auth health route is mounted at /auth", async () => {
    const auth = createAuth(connection.db, environment);
    const app = createApp({ auth, db: connection.db, environment });
    const response = await app.request("/auth/ok");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("reuses the single bounded pool for readiness checks", async () => {
    const auth = createAuth(connection.db, environment);
    const app = createApp({ auth, db: connection.db, environment });

    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    expect(connection.pool.options.max).toBe(1);
    expect(connection.pool.totalCount).toBeLessThanOrEqual(1);
  });

  test("enforces user identity and lifecycle invariants", async () => {
    await insertUser();

    await expect(insertUser()).rejects.toThrow();
    await expect(insertUser("MixedCase@example.com")).rejects.toThrow();
    await expect(
      connection.db
        .insert(users)
        .values({
          id: createId(),
          name: "Invalid",
          email: "invalid@example.com",
          status: "disabled",
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(users)
        .values({
          id: createId(),
          name: "Invalid",
          email: "invalid-status@example.com",
          status: "unknown" as "active",
        })
        .execute(),
    ).rejects.toThrow();
  });

  test("ties the email tombstone to retirement", async () => {
    await expect(
      connection.db
        .insert(users)
        .values({
          id: createId(),
          name: "Invalid",
          email: "active-retired@example.com",
          status: "active",
          retiredEmail: "former@example.com",
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(users)
        .values({
          id: createId(),
          name: "Invalid",
          email: "disabled-normal@example.com",
          status: "disabled",
          disabledAt: new Date(),
          retiredEmail: "former@example.com",
        })
        .execute(),
    ).rejects.toThrow();

    const tombstonedWithoutRetirement = createId();
    await expect(
      connection.db
        .insert(users)
        .values({
          id: tombstonedWithoutRetirement,
          name: "Invalid",
          email: `${tombstonedWithoutRetirement}@retired.invalid`,
          status: "disabled",
          disabledAt: new Date(),
        })
        .execute(),
    ).rejects.toThrow();

    const user = await insertUser("retire-check@example.com");
    await connection.db
      .update(users)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(users.id, user.id));
    await retireUserEmail(connection.db, user.id);
    await expect(
      connection.db
        .update(users)
        .set({ status: "active", disabledAt: null })
        .where(eq(users.id, user.id))
        .execute(),
    ).rejects.toThrow();
  });

  test("keys external accounts by issuer and account id", async () => {
    const user = await insertUser();
    const first = {
      id: createId(),
      issuer: "https://issuer-one.example.com",
      accountId: "upstream-subject",
      providerId: "oidc",
      userId: user.id,
    };

    await connection.db.insert(accounts).values(first);
    await connection.db.insert(accounts).values({
      ...first,
      id: createId(),
      issuer: "https://issuer-two.example.com",
    });
    await expect(
      connection.db
        .insert(accounts)
        .values({ ...first, id: createId() })
        .execute(),
    ).rejects.toThrow();
  });

  test("keys accounts by directory user id per issuer", async () => {
    const user = await insertUser();
    const account = {
      issuer: "https://issuer.example.com",
      accountId: "subject-one",
      providerId: "example",
      userId: user.id,
      directoryUserId: "directory-user",
    };

    await connection.db.insert(accounts).values({ id: createId(), ...account });
    await expect(
      connection.db
        .insert(accounts)
        .values({
          id: createId(),
          ...account,
          accountId: "subject-two",
        })
        .execute(),
    ).rejects.toThrow();
    await connection.db.insert(accounts).values([
      {
        id: createId(),
        ...account,
        issuer: "https://other-issuer.example.com",
        accountId: "subject-three",
      },
      {
        id: createId(),
        ...account,
        accountId: "subject-four",
        directoryUserId: null,
      },
      {
        id: createId(),
        ...account,
        accountId: "subject-five",
        directoryUserId: null,
      },
    ]);
  });

  test("binds one SSO provider per organization", async () => {
    const first = await insertOrganization("first");
    const second = await insertOrganization("second");
    const firstProvider = await createSsoProvider(connection.db, {
      organizationId: first.id,
      providerId: first.slug,
      issuer: "https://issuer.example.com",
      domain: "example.com",
      oidc: { clientId: "client" },
    });

    expect(isUuidV7(firstProvider.id)).toBe(true);
    expect(JSON.parse(firstProvider.oidcConfig!)).toEqual({
      issuer: "https://issuer.example.com",
      clientId: "client",
      discoveryEndpoint:
        "https://issuer.example.com/.well-known/openid-configuration",
      tokenEndpointAuthentication: "client_secret_post",
      pkce: true,
      overrideUserInfo: false,
    });
    const providerGraph = await connection.db.query.ssoProviders.findFirst({
      where: eq(ssoProviders.id, firstProvider.id),
      with: { organization: true, user: true },
    });
    const organizationGraph = await connection.db.query.organizations.findFirst(
      {
        where: eq(organizations.id, first.id),
        with: { ssoProvider: true },
      },
    );
    expect(providerGraph?.organization.id).toBe(first.id);
    expect(providerGraph?.user).toBeNull();
    expect(organizationGraph?.ssoProvider?.id).toBe(firstProvider.id);
    await expect(
      createSsoProvider(connection.db, {
        organizationId: first.id,
        providerId: "first-two",
        issuer: "https://issuer-two.example.com",
        domain: "example.com",
        oidc: { clientId: "client-two" },
      }),
    ).rejects.toThrow();
    await expect(
      createSsoProvider(connection.db, {
        organizationId: second.id,
        providerId: first.slug,
        issuer: "https://issuer-three.example.com",
        domain: "second.example.com",
        oidc: { clientId: "client-three" },
      }),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(ssoProviders)
        .values({
          id: createId(),
          organizationId: second.id,
          providerId: "second",
          issuer: "https://issuer.example.com",
          domain: "Bad Domain",
        })
        .execute(),
    ).rejects.toThrow();
  });

  test("enforces organization slug, uniqueness, and lifecycle invariants", async () => {
    const organization = await insertOrganization();
    const user = await insertUser();
    await insertMember(organization.id, user.id);

    await expect(insertOrganization()).rejects.toThrow();
    await expect(insertMember(organization.id, user.id)).rejects.toThrow();
    for (const slug of [
      "Contoso",
      "contoso corp",
      "-contoso",
      "contoso--ltd",
    ]) {
      await expect(insertOrganization(slug)).rejects.toThrow();
    }
    await expect(
      connection.db
        .insert(organizations)
        .values({
          id: createId(),
          name: "Disabled without timestamp",
          slug: "invalid-disabled",
          status: "disabled",
        })
        .execute(),
    ).rejects.toThrow();
  });

  test("constrains invitation status to Better Auth's vocabulary", async () => {
    const organization = await insertOrganization();
    const inviter = await insertUser();
    const invitation = {
      organizationId: organization.id,
      email: "invitee@example.com",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: inviter.id,
    };

    await connection.db
      .insert(invitations)
      .values({ id: createId(), ...invitation });
    await expect(
      connection.db
        .insert(invitations)
        .values({
          id: createId(),
          ...invitation,
          status: "expired" as "pending",
        })
        .execute(),
    ).rejects.toThrow();
  });

  test("routes a domain to exactly one active organization", async () => {
    const first = await insertOrganization("first");
    const second = await insertOrganization("second");

    const domain = await createOrganizationDomain(connection.db, {
      organizationId: first.id,
      domain: " Example.COM ",
    });
    expect(domain.domain).toBe("example.com");
    expect(isUuidV7(domain.id)).toBe(true);
    expect(
      await organizationAcceptsDomain(connection.db, first.id, " EXAMPLE.com "),
    ).toBe(true);
    expect(
      await organizationAcceptsDomain(connection.db, first.id, "other.example"),
    ).toBe(false);

    await expect(
      createOrganizationDomain(connection.db, {
        organizationId: second.id,
        domain: "example.com",
      }),
    ).rejects.toThrow();
    await expect(
      createOrganizationDomain(connection.db, {
        organizationId: first.id,
        domain: "example.com",
      }),
    ).rejects.toThrow();
    for (const invalid of [
      "not normalized.example",
      "localhost",
      "under_score.example",
      "-dash.example",
    ]) {
      await expect(
        connection.db
          .insert(organizationDomains)
          .values({ id: createId(), organizationId: first.id, domain: invalid })
          .execute(),
      ).rejects.toThrow();
    }
    await expect(
      connection.db
        .insert(organizationDomains)
        .values({
          id: createId(),
          organizationId: first.id,
          domain: "invalid-status.example",
          status: "unknown" as "active",
        })
        .execute(),
    ).rejects.toThrow();

    // Moving a domain: disable the old row, then add the new one.
    await connection.db
      .update(organizationDomains)
      .set({ status: "disabled" })
      .where(eq(organizationDomains.id, domain.id));
    await createOrganizationDomain(connection.db, {
      organizationId: second.id,
      domain: "example.com",
    });
    expect(
      await organizationAcceptsDomain(connection.db, second.id, "example.com"),
    ).toBe(true);

    await connection.db
      .update(organizations)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(organizations.id, second.id));
    expect(
      await organizationAcceptsDomain(connection.db, second.id, "example.com"),
    ).toBe(false);
  });

  test("keeps groups inside their organization", async () => {
    const first = await insertOrganization("first");
    const second = await insertOrganization("second");
    const user = await insertUser();
    const firstMember = await insertMember(first.id, user.id);
    const secondMember = await insertMember(second.id, user.id);

    const sales = await createGroup(connection.db, {
      organizationId: first.id,
      slug: "sales",
      name: "Sales",
      externalId: "entra-group-1",
    });
    expect(isUuidV7(sales.id)).toBe(true);
    await createGroup(connection.db, {
      organizationId: second.id,
      slug: "sales",
      name: "Sales",
      externalId: "entra-group-1",
    });
    await expect(
      createGroup(connection.db, {
        organizationId: first.id,
        slug: "sales",
        name: "Duplicate slug",
      }),
    ).rejects.toThrow();
    await expect(
      createGroup(connection.db, {
        organizationId: first.id,
        slug: "mirror",
        name: "Duplicate external id",
        externalId: "entra-group-1",
      }),
    ).rejects.toThrow();
    await expect(
      createGroup(connection.db, {
        organizationId: first.id,
        slug: "Sales Team",
        name: "Bad slug",
      }),
    ).rejects.toThrow();

    const membership = await addGroupMember(connection.db, {
      organizationId: first.id,
      groupId: sales.id,
      memberId: firstMember.id,
    });
    expect(membership.groupId).toBe(sales.id);
    await expect(
      addGroupMember(connection.db, {
        organizationId: first.id,
        groupId: sales.id,
        memberId: firstMember.id,
      }),
    ).rejects.toThrow();
    // A member of another organization cannot be placed in this group.
    await expect(
      addGroupMember(connection.db, {
        organizationId: second.id,
        groupId: sales.id,
        memberId: secondMember.id,
      }),
    ).rejects.toThrow();

    await connection.db.delete(members).where(eq(members.id, firstMember.id));
    expect(await connection.db.select().from(groupMembers)).toHaveLength(0);
  });

  test("orders effective windows", async () => {
    const auth = createAuth(connection.db, environment);
    const { resource } = await registerTutor(auth);
    const organization = await insertOrganization();
    const user = await insertUser();
    const member = await insertMember(organization.id, user.id);
    const reversedMemberUser = await insertUser("reversed-member@example.com");
    const group = await createGroup(connection.db, {
      organizationId: organization.id,
      slug: "windowed",
      name: "Windowed",
    });
    const earlier = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-02T00:00:00Z");

    await expect(
      connection.db
        .insert(members)
        .values({
          id: createId(),
          organizationId: organization.id,
          userId: reversedMemberUser.id,
          validFrom: later,
          validUntil: earlier,
        })
        .execute(),
    ).rejects.toThrow();
    const equalMemberUser = await insertUser("equal-member@example.com");
    await expect(
      connection.db
        .insert(members)
        .values({
          id: createId(),
          organizationId: organization.id,
          userId: equalMemberUser.id,
          validFrom: earlier,
          validUntil: earlier,
        })
        .execute(),
    ).rejects.toThrow();
    const boundedMemberUser = await insertUser("bounded-member@example.com");
    await connection.db.insert(members).values({
      id: createId(),
      organizationId: organization.id,
      userId: boundedMemberUser.id,
      validFrom: earlier,
    });

    const groupMembership = {
      id: createId(),
      organizationId: organization.id,
      groupId: group.id,
      memberId: member.id,
    };
    await expect(
      connection.db
        .insert(groupMembers)
        .values({ ...groupMembership, validFrom: later, validUntil: earlier })
        .execute(),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(groupMembers)
        .values({ ...groupMembership, validFrom: earlier, validUntil: earlier })
        .execute(),
    ).rejects.toThrow();
    await connection.db
      .insert(groupMembers)
      .values({ ...groupMembership, validUntil: later });

    const entitlement = {
      id: createId(),
      organizationId: organization.id,
      resource,
      scopes: ["tutor:read"],
    };
    await expect(
      connection.db
        .insert(entitlements)
        .values({ ...entitlement, validFrom: later, validUntil: earlier })
        .execute(),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(entitlements)
        .values({ ...entitlement, validFrom: earlier, validUntil: earlier })
        .execute(),
    ).rejects.toThrow();
    await connection.db
      .insert(entitlements)
      .values({ ...entitlement, validUntil: later });
  });

  test("enforces entitlement principals, targets, uniqueness, and organization binding", async () => {
    const auth = createAuth(connection.db, environment);
    const { clientId, resource } = await registerTutor(auth);
    const first = await insertOrganization("first");
    const second = await insertOrganization("second");
    const user = await insertUser();
    const member = await insertMember(first.id, user.id);
    const group = await createGroup(connection.db, {
      organizationId: first.id,
      slug: "sales",
      name: "Sales",
    });
    const foreignGroup = await createGroup(connection.db, {
      organizationId: second.id,
      slug: "sales",
      name: "Sales",
    });
    const forResource = {
      organizationId: first.id,
      resource,
      scopes: ["tutor:read"],
    };

    // The three principal shapes coexist and are each unique.
    const organizationWide = await createEntitlement(
      connection.db,
      forResource,
    );
    expect(isUuidV7(organizationWide.id)).toBe(true);
    await createEntitlement(connection.db, {
      ...forResource,
      groupId: group.id,
    });
    await createEntitlement(connection.db, {
      ...forResource,
      memberId: member.id,
    });
    await createEntitlement(connection.db, {
      organizationId: first.id,
      clientId,
      scopes: ["openid", "profile", "email"],
    });
    await expect(
      createEntitlement(connection.db, forResource),
    ).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, { ...forResource, groupId: group.id }),
    ).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, { ...forResource, memberId: member.id }),
    ).rejects.toThrow();

    // At most one principal narrowing; a client, resource or exact pair target.
    await expect(
      createEntitlement(connection.db, {
        ...forResource,
        memberId: member.id,
        groupId: group.id,
      }),
    ).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, {
        organizationId: first.id,
        scopes: ["tutor:read"],
      }),
    ).rejects.toThrow();
    expect(
      await createEntitlement(connection.db, {
        ...forResource,
        clientId,
        memberId: undefined,
      }),
    ).toMatchObject({ clientId, resource });

    // Targets must exist; principals must belong to the organization.
    await expect(
      createEntitlement(connection.db, {
        organizationId: first.id,
        clientId: "unregistered",
        scopes: ["openid"],
      }),
    ).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, {
        organizationId: second.id,
        memberId: member.id,
        resource,
        scopes: ["tutor:read"],
      }),
    ).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, {
        organizationId: first.id,
        groupId: foreignGroup.id,
        resource,
        scopes: ["tutor:read"],
      }),
    ).rejects.toThrow();

    await expect(
      createEntitlement(connection.db, { ...forResource, scopes: [] }),
    ).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, {
        ...forResource,
        scopes: ["tutor:read", ""],
      }),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(entitlements)
        .values({
          id: createId(),
          ...forResource,
          status: "unknown" as "active",
        })
        .execute(),
    ).rejects.toThrow();

    // A referenced client or resource cannot be deleted; disable it instead.
    await expect(
      connection.db
        .delete(oauthResources)
        .where(eq(oauthResources.identifier, resource))
        .execute(),
    ).rejects.toThrow();
    await expect(
      connection.db
        .delete(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .execute(),
    ).rejects.toThrow();

    // Removing the group or the member removes only their grants.
    await connection.db.delete(groups).where(eq(groups.id, group.id));
    await connection.db.delete(members).where(eq(members.id, member.id));
    expect(await connection.db.select().from(entitlements)).toHaveLength(3);
  });

  test("cascades organization data while keeping clients and resources", async () => {
    const auth = createAuth(connection.db, environment);
    const { clientId, resource } = await registerTutor(auth);
    const organization = await insertOrganization();
    const user = await insertUser();
    const member = await insertMember(organization.id, user.id);
    const group = await createGroup(connection.db, {
      organizationId: organization.id,
      slug: "everyone",
      name: "Everyone",
    });
    await addGroupMember(connection.db, {
      organizationId: organization.id,
      groupId: group.id,
      memberId: member.id,
    });
    await createOrganizationDomain(connection.db, {
      organizationId: organization.id,
      domain: "example.com",
    });
    await createEntitlement(connection.db, {
      organizationId: organization.id,
      groupId: group.id,
      resource,
      scopes: ["tutor:read"],
    });
    await createEntitlement(connection.db, {
      organizationId: organization.id,
      memberId: member.id,
      clientId,
      scopes: ["openid"],
    });

    const graph = await connection.db.query.organizations.findFirst({
      where: eq(organizations.id, organization.id),
      with: {
        domains: true,
        groups: { with: { groupMembers: true, entitlements: true } },
        members: { with: { groupMembers: true, entitlements: true } },
        entitlements: { with: { oauthClient: true, oauthResource: true } },
      },
    });
    expect(graph?.domains).toHaveLength(1);
    expect(graph?.groups[0]?.groupMembers).toHaveLength(1);
    expect(graph?.groups[0]?.entitlements).toHaveLength(1);
    expect(graph?.members[0]?.groupMembers).toHaveLength(1);
    expect(graph?.members[0]?.entitlements).toHaveLength(1);
    expect(
      graph?.entitlements.map(
        (entitlement) =>
          entitlement.oauthClient?.clientId ??
          entitlement.oauthResource?.identifier,
      ),
    ).toEqual(expect.arrayContaining([clientId, resource]));

    await connection.db
      .delete(organizations)
      .where(eq(organizations.id, organization.id));

    expect(await connection.db.select().from(members)).toHaveLength(0);
    expect(await connection.db.select().from(groups)).toHaveLength(0);
    expect(await connection.db.select().from(groupMembers)).toHaveLength(0);
    expect(await connection.db.select().from(organizationDomains)).toHaveLength(
      0,
    );
    expect(await connection.db.select().from(entitlements)).toHaveLength(0);
    expect(await connection.db.select().from(oauthClients)).toHaveLength(1);
    expect(await connection.db.select().from(oauthResources)).toHaveLength(1);
  });
});
