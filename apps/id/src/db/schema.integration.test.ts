import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  createClient,
  linkClientResource,
} from "../__tests__/client-queries.ts";
import { createResource } from "../__tests__/resource-queries.ts";
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
  entitlements,
  groupMembers,
  groups,
  jwks,
  members,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthResources,
  organizationDomains,
  organizations,
  ssoProviders,
  users,
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

// ID registers clients and resources itself; the plugin's own registration
// routes are not served.
async function registerTutor() {
  const clientId = "omnichat-test-cell";
  const resource = "https://mcp.example.com";
  await createClient(connection.db, {
    clientId,
    name: "OmniChat test cell",
    redirectUris: ["https://chat.example.com/callback"],
    tokenEndpointAuthMethod: "private_key_jwt",
    grantTypes: ["authorization_code", "refresh_token"],
  });
  await createResource(connection.db, {
    identifier: resource,
    name: "Tutor MCP",
    accessTokenTtl: 300,
    allowedScopes: ["tutor:read"],
  });
  await linkClientResource(connection.db, clientId, resource);
  return { clientId, resource };
}

describe("integration: PostgreSQL schema", () => {
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

    const organization = await context.adapter.create<
      { name: string; slug: string },
      { id: string; status: string }
    >({ model: "organization", data: { name: "Contoso", slug: "contoso" } });

    expect(isUuidV7(organization.id)).toBe(true);
    expect(organization.status).toBe("active");
    // Memberships come from Answerable ID alone: the organisation plugin's
    // member writes need the role column it declares, which ID does not keep.
    await expect(
      auth.api.addMember({
        body: {
          userId: user.id,
          organizationId: organization.id,
          role: "member",
        },
      }),
    ).rejects.toThrow('The field "role" does not exist');

    const membership = await insertMember(organization.id, user.id);
    const validUntil = new Date(Date.now() + 86_400_000);
    await context.adapter.update({
      model: "member",
      where: [{ field: "id", value: membership.id }],
      update: { validUntil },
    });
    const [updatedMembership] = await connection.db
      .select()
      .from(members)
      .where(eq(members.id, membership.id));
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
    const { clientId, resource } = await registerTutor();
    // The plugin's own registration would write client columns ID does not store.
    await expect(
      (await auth.$context).adapter.create({
        model: "oauthClient",
        data: { clientId: "plugin-registered", redirectUris: [] },
      }),
    ).rejects.toThrow('The field "dpopBoundAccessTokens" does not exist');

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

    expect(
      await connection.db
        .select({
          clientId: oauthClients.clientId,
          organizationId: oauthClients.organizationId,
        })
        .from(oauthClients)
        .where(eq(oauthClients.organizationId, organization.id)),
    ).toEqual([{ clientId, organizationId: organization.id }]);

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
    const organization = await insertOrganization("contoso");
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
    expect(
      await connection.db
        .select({
          id: ssoProviders.id,
          organizationId: ssoProviders.organizationId,
        })
        .from(ssoProviders)
        .where(eq(ssoProviders.organizationId, first.id)),
    ).toEqual([{ id: firstProvider.id, organizationId: first.id }]);
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
    });
    expect(isUuidV7(sales.id)).toBe(true);
    await createGroup(connection.db, {
      organizationId: second.id,
      slug: "sales",
      name: "Sales",
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

  test("live foreign keys keep live rows under live parents and deletion is terminal", async () => {
    const organization = await insertOrganization();
    const group = { id: createId(), organizationId: organization.id };
    const insertGroup = (values: Partial<typeof groups.$inferInsert> = {}) =>
      connection.db
        .insert(groups)
        .values({ ...group, slug: "team", name: "Team", ...values })
        .execute();
    const deleted = { status: "disabled" as const, deletedAt: new Date() };
    const deleteOrganization = () =>
      connection.db
        .update(organizations)
        .set({ ...deleted, disabledAt: new Date() })
        .where(eq(organizations.id, organization.id))
        .execute();
    const refusal = (code: string, constraint: string) => ({
      cause: { code, constraint },
    });
    await insertGroup();
    await expect(deleteOrganization()).rejects.toMatchObject(
      refusal("23503", "groups_organization_live_fk"),
    );
    // Children first; writers set deleted_at and the trigger clears live.
    await connection.db.update(groups).set(deleted);
    await deleteOrganization();
    expect(
      await connection.db
        .select({ live: organizations.live })
        .from(organizations)
        .union(connection.db.select({ live: groups.live }).from(groups)),
    ).toEqual([{ live: null }]);
    await expect(
      insertGroup({ id: createId(), slug: "late" }),
    ).rejects.toMatchObject(refusal("23503", "groups_organization_live_fk"));
    await insertGroup({ id: createId(), slug: "tombstone", ...deleted });
    await expect(
      connection.db.update(groups).set({ deletedAt: null }).execute(),
    ).rejects.toMatchObject(refusal("23514", "product_deletion_terminal"));
    // The CHECK holds live to deleted_at even where the trigger does not run.
    await expect(
      connection.db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.update(groups).set({ live: true });
      }),
    ).rejects.toMatchObject(refusal("23514", "groups_live_check"));
  });

  test("deleted rows hold no authority or credentials", async () => {
    const user = await insertUser();
    const organization = await insertOrganization();
    const deletedAt = new Date();
    for (const [write, constraint] of [
      [
        () =>
          connection.db
            .update(users)
            .set({ deletedAt })
            .where(eq(users.id, user.id)),
        "users_deleted_check",
      ],
      [
        () =>
          connection.db.insert(members).values({
            id: createId(),
            organizationId: organization.id,
            userId: user.id,
            deletedAt,
          }),
        "members_deleted_check",
      ],
      [
        () =>
          connection.db.insert(accounts).values({
            id: createId(),
            issuer: "https://issuer.example",
            accountId: "subject",
            providerId: "tenant",
            userId: user.id,
            refreshToken: "retained",
            deletedAt,
          }),
        "accounts_deleted_check",
      ],
      [
        () =>
          connection.db.insert(oauthClients).values({
            id: createId(),
            clientId: "deleted",
            redirectUris: [],
            disabled: true,
            clientSecret: "digest",
            deletedAt,
          }),
        "oauth_clients_deleted_check",
      ],
      [
        () =>
          connection.db.insert(oauthResources).values({
            id: createId(),
            identifier: "https://deleted.example",
            name: "Deleted",
            deletedAt,
          }),
        "oauth_resources_deleted_check",
      ],
    ] as const)
      await expect(Promise.resolve(write())).rejects.toMatchObject({
        cause: { code: "23514", constraint },
      });
  });

  test("orders effective windows", async () => {
    const { resource } = await registerTutor();
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
    const { clientId, resource } = await registerTutor();
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
});
