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

import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { isUuidV7, testEnvironment } from "../__tests__/support.ts";
import { createId } from "../lib/id.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { createEntitlement } from "./queries/entitlements.ts";
import { addGroupMember, createGroup } from "./queries/groups.ts";
import {
  createOrganizationDomain,
  findOrganizationByDomain,
} from "./queries/organization-domains.ts";
import {
  accounts,
  entitlements,
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
  organizationDomains,
  organizations,
  sessions,
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
      entitlements,
      group_members,
      groups,
      organization_domains,
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

function groupByTable<T extends { table: string }>(
  rows: T[],
  render: (row: T) => string,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const row of rows) (grouped[row.table] ??= []).push(render(row));
  return grouped;
}

function byTableThenName<T extends { table: string; name: string }>(
  a: T,
  b: T,
): number {
  if (a.table !== b.table) return a.table < b.table ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
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
  organizationDomains,
  groups,
  groupMembers,
  entitlements,
];

describe("integration: PostgreSQL schema", () => {
  test("freezes the approved column contract", async () => {
    const result = await connection.db.execute<{
      table: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(sql`
      select table_name as "table", column_name, data_type, udt_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `);

    const columns = groupByTable(result.rows, (row) => {
      const type =
        row.data_type === "ARRAY"
          ? `${row.udt_name.slice(1)}[]`
          : row.data_type === "timestamp with time zone"
            ? "timestamptz"
            : row.data_type;
      return [
        row.column_name,
        type,
        row.is_nullable === "YES" ? "null" : null,
        row.column_default ? `default ${row.column_default}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    });

    const created = "created_at timestamptz default now()";
    const updated = "updated_at timestamptz default now()";
    const active = "status text default 'active'::text";
    expect(columns).toEqual({
      users: [
        "id uuid",
        "name text",
        "email text",
        "email_verified boolean default false",
        "image text null",
        "status text default 'inert'::text",
        "disabled_at timestamptz null",
        created,
        updated,
      ],
      organizations: [
        "id uuid",
        "name text",
        "slug text",
        "logo text null",
        "metadata text null",
        active,
        "disabled_at timestamptz null",
        created,
        updated,
      ],
      sessions: [
        "id uuid",
        "expires_at timestamptz",
        "token text",
        created,
        updated,
        "ip_address text null",
        "user_agent text null",
        "user_id uuid",
        "active_organization_id uuid null",
      ],
      accounts: [
        "id uuid",
        "issuer text",
        "account_id text",
        "provider_id text",
        "user_id uuid",
        "access_token text null",
        "refresh_token text null",
        "id_token text null",
        "access_token_expires_at timestamptz null",
        "refresh_token_expires_at timestamptz null",
        "scope text null",
        "password text null",
        created,
        updated,
      ],
      verifications: [
        "id text",
        "identifier text",
        "value text",
        "expires_at timestamptz",
        created,
        updated,
      ],
      members: [
        "id uuid",
        "organization_id uuid",
        "user_id uuid",
        "role text default 'member'::text",
        created,
      ],
      invitations: [
        "id uuid",
        "organization_id uuid",
        "email text",
        "role text null",
        "status text default 'pending'::text",
        "expires_at timestamptz",
        created,
        "inviter_id uuid",
      ],
      jwks: [
        "id uuid",
        "public_key text",
        "private_key text",
        created,
        "expires_at timestamptz null",
        "alg text null",
        "crv text null",
      ],
      oauth_clients: [
        "id uuid",
        "client_id text",
        "client_secret text null",
        "client_discovery_id text null",
        "reference_id text null",
        "name text null",
        "uri text null",
        "icon text null",
        "contacts text[] null",
        "tos text null",
        "policy text null",
        "software_id text null",
        "software_version text null",
        "software_statement text null",
        "redirect_uris text[]",
        "post_logout_redirect_uris text[] null",
        "backchannel_logout_uri text null",
        "backchannel_logout_session_required boolean null",
        "token_endpoint_auth_method text null",
        "application_type text null",
        "jwks text null",
        "jwks_uri text null",
        "grant_types text[] null",
        "response_types text[] null",
        "require_pkce boolean null",
        "dpop_bound_access_tokens boolean default false",
        "subject_type text null",
        "scopes text[] null",
        "client_credentials_scopes text[] null",
        "skip_consent boolean null",
        "enable_end_session boolean null",
        "disabled boolean default false",
        "user_id uuid null",
        "metadata jsonb null",
        created,
        updated,
      ],
      oauth_resources: [
        "id uuid",
        "identifier text",
        "name text",
        "access_token_ttl integer null",
        "refresh_token_ttl integer null",
        "signing_algorithm text null",
        "signing_key_id text null",
        "allowed_scopes text[] null",
        "custom_claims jsonb null",
        "dpop_bound_access_tokens_required boolean default false",
        "disabled boolean default false",
        "policy_version integer default 1",
        "metadata jsonb null",
        created,
        updated,
      ],
      oauth_client_resources: [
        "id uuid",
        "client_id text",
        "resource_id text",
        "metadata jsonb null",
        created,
      ],
      oauth_refresh_tokens: [
        "id uuid",
        "token text",
        "client_id text",
        "session_id uuid null",
        "user_id uuid",
        "reference_id text null",
        "authorization_code_id text null",
        "resources text[] null",
        "requested_user_info_claims text[] null",
        "scopes text[]",
        "expires_at timestamptz",
        created,
        "revoked timestamptz null",
        "rotated_at timestamptz null",
        "rotation_replay_response text null",
        "rotation_replay_expires_at timestamptz null",
        "auth_time timestamptz null",
        "confirmation jsonb null",
      ],
      oauth_access_tokens: [
        "id uuid",
        "token text null",
        "client_id text",
        "session_id uuid null",
        "user_id uuid null",
        "reference_id text null",
        "authorization_code_id text null",
        "resources text[] null",
        "requested_user_info_claims text[] null",
        "refresh_id uuid null",
        "scopes text[]",
        "expires_at timestamptz",
        created,
        "revoked timestamptz null",
        "confirmation jsonb null",
      ],
      oauth_consents: [
        "id uuid",
        "client_id text",
        "user_id uuid null",
        "reference_id text null",
        "resources text[] null",
        "requested_user_info_claims text[] null",
        "scopes text[]",
        created,
        updated,
      ],
      oauth_client_assertions: ["id text", "expires_at timestamptz"],
      organization_domains: [
        "id uuid",
        "organization_id uuid",
        "domain text",
        active,
        created,
        updated,
      ],
      groups: [
        "id uuid",
        "organization_id uuid",
        "slug text",
        "name text",
        "external_id text null",
        active,
        created,
        updated,
      ],
      group_members: [
        "organization_id uuid",
        "group_id uuid",
        "member_id uuid",
        created,
      ],
      entitlements: [
        "id uuid",
        "organization_id uuid",
        "member_id uuid null",
        "group_id uuid null",
        "client_id text null",
        "resource text null",
        "scopes text[]",
        active,
        created,
        updated,
      ],
    });
  });

  test("freezes the approved constraint and index contract", async () => {
    const constraints = await connection.db.execute<{
      table: string;
      name: string;
      definition: string;
    }>(sql`
      select conrelid::regclass::text as "table", conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where connamespace = 'public'::regnamespace
    `);
    const indexes = await connection.db.execute<{
      table: string;
      name: string;
      definition: string;
    }>(sql`
      select i.tablename as "table", i.indexname as name, i.indexdef as definition
      from pg_indexes i
      where i.schemaname = 'public'
        and not exists (
          select 1 from pg_constraint c
          where c.conname = i.indexname and c.connamespace = 'public'::regnamespace
        )
    `);

    const lifecycle =
      "CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))";
    const cascadeOrganization =
      "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE";
    const cascadeUser =
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE";
    const cascadeClient =
      "FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE";
    const nullSession =
      "FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL";
    expect(
      groupByTable(
        [...constraints.rows].sort(byTableThenName),
        (row) => `${row.name} ${row.definition}`,
      ),
    ).toEqual({
      users: [
        "users_disabled_check CHECK (((status = 'disabled'::text) = (disabled_at IS NOT NULL)))",
        "users_email_normalized_check CHECK ((email = lower(btrim(email))))",
        "users_email_unique UNIQUE (email)",
        "users_pkey PRIMARY KEY (id)",
        "users_status_check CHECK ((status = ANY (ARRAY['inert'::text, 'active'::text, 'disabled'::text])))",
      ],
      organizations: [
        "organizations_disabled_check CHECK (((status = 'disabled'::text) = (disabled_at IS NOT NULL)))",
        "organizations_pkey PRIMARY KEY (id)",
        "organizations_slug_normalized_check CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))",
        "organizations_slug_unique UNIQUE (slug)",
        `organizations_status_check ${lifecycle}`,
      ],
      sessions: [
        "sessions_active_organization_id_organizations_id_fk FOREIGN KEY (active_organization_id) REFERENCES organizations(id) ON DELETE SET NULL",
        "sessions_pkey PRIMARY KEY (id)",
        "sessions_token_unique UNIQUE (token)",
        `sessions_user_id_users_id_fk ${cascadeUser}`,
      ],
      accounts: [
        "accounts_issuer_account_id_unique UNIQUE (issuer, account_id)",
        "accounts_pkey PRIMARY KEY (id)",
        `accounts_user_id_users_id_fk ${cascadeUser}`,
      ],
      verifications: ["verifications_pkey PRIMARY KEY (id)"],
      members: [
        "members_organization_id_id_unique UNIQUE (organization_id, id)",
        `members_organization_id_organizations_id_fk ${cascadeOrganization}`,
        "members_organization_id_user_id_unique UNIQUE (organization_id, user_id)",
        "members_pkey PRIMARY KEY (id)",
        `members_user_id_users_id_fk ${cascadeUser}`,
      ],
      invitations: [
        "invitations_inviter_id_users_id_fk FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE",
        `invitations_organization_id_organizations_id_fk ${cascadeOrganization}`,
        "invitations_pkey PRIMARY KEY (id)",
        "invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'canceled'::text])))",
      ],
      jwks: ["jwks_pkey PRIMARY KEY (id)"],
      oauth_clients: [
        "oauth_clients_client_id_unique UNIQUE (client_id)",
        "oauth_clients_pkey PRIMARY KEY (id)",
        `oauth_clients_user_id_users_id_fk ${cascadeUser}`,
      ],
      oauth_resources: [
        "oauth_resources_identifier_unique UNIQUE (identifier)",
        "oauth_resources_pkey PRIMARY KEY (id)",
      ],
      oauth_client_resources: [
        `oauth_client_resources_client_id_oauth_clients_client_id_fk ${cascadeClient}`,
        "oauth_client_resources_client_id_resource_id_unique UNIQUE (client_id, resource_id)",
        "oauth_client_resources_pkey PRIMARY KEY (id)",
        "oauth_client_resources_resource_id_fk FOREIGN KEY (resource_id) REFERENCES oauth_resources(identifier) ON DELETE CASCADE",
      ],
      oauth_refresh_tokens: [
        `oauth_refresh_tokens_client_id_oauth_clients_client_id_fk ${cascadeClient}`,
        "oauth_refresh_tokens_pkey PRIMARY KEY (id)",
        `oauth_refresh_tokens_session_id_sessions_id_fk ${nullSession}`,
        "oauth_refresh_tokens_token_unique UNIQUE (token)",
        `oauth_refresh_tokens_user_id_users_id_fk ${cascadeUser}`,
      ],
      oauth_access_tokens: [
        `oauth_access_tokens_client_id_oauth_clients_client_id_fk ${cascadeClient}`,
        "oauth_access_tokens_pkey PRIMARY KEY (id)",
        "oauth_access_tokens_refresh_id_oauth_refresh_tokens_id_fk FOREIGN KEY (refresh_id) REFERENCES oauth_refresh_tokens(id) ON DELETE CASCADE",
        `oauth_access_tokens_session_id_sessions_id_fk ${nullSession}`,
        "oauth_access_tokens_token_unique UNIQUE (token)",
        `oauth_access_tokens_user_id_users_id_fk ${cascadeUser}`,
      ],
      oauth_consents: [
        `oauth_consents_client_id_oauth_clients_client_id_fk ${cascadeClient}`,
        "oauth_consents_pkey PRIMARY KEY (id)",
        `oauth_consents_user_id_users_id_fk ${cascadeUser}`,
      ],
      oauth_client_assertions: ["oauth_client_assertions_pkey PRIMARY KEY (id)"],
      organization_domains: [
        "organization_domains_domain_normalized_check CHECK ((domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'::text))",
        "organization_domains_organization_id_domain_unique UNIQUE (organization_id, domain)",
        `organization_domains_organization_id_organizations_id_fk ${cascadeOrganization}`,
        "organization_domains_pkey PRIMARY KEY (id)",
        `organization_domains_status_check ${lifecycle}`,
      ],
      groups: [
        "groups_organization_id_id_unique UNIQUE (organization_id, id)",
        `groups_organization_id_organizations_id_fk ${cascadeOrganization}`,
        "groups_organization_id_slug_unique UNIQUE (organization_id, slug)",
        "groups_pkey PRIMARY KEY (id)",
        "groups_slug_normalized_check CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))",
        `groups_status_check ${lifecycle}`,
      ],
      group_members: [
        "group_members_organization_id_group_id_fk FOREIGN KEY (organization_id, group_id) REFERENCES groups(organization_id, id) ON DELETE CASCADE",
        "group_members_organization_id_member_id_fk FOREIGN KEY (organization_id, member_id) REFERENCES members(organization_id, id) ON DELETE CASCADE",
        "group_members_pkey PRIMARY KEY (group_id, member_id)",
      ],
      entitlements: [
        "entitlements_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE RESTRICT",
        "entitlements_organization_id_group_id_fk FOREIGN KEY (organization_id, group_id) REFERENCES groups(organization_id, id) ON DELETE CASCADE",
        "entitlements_organization_id_member_id_fk FOREIGN KEY (organization_id, member_id) REFERENCES members(organization_id, id) ON DELETE CASCADE",
        `entitlements_organization_id_organizations_id_fk ${cascadeOrganization}`,
        "entitlements_pkey PRIMARY KEY (id)",
        "entitlements_principal_check CHECK ((num_nonnulls(member_id, group_id) <= 1))",
        "entitlements_principal_target_unique UNIQUE NULLS NOT DISTINCT (organization_id, member_id, group_id, client_id, resource)",
        "entitlements_resource_oauth_resources_identifier_fk FOREIGN KEY (resource) REFERENCES oauth_resources(identifier) ON DELETE RESTRICT",
        "entitlements_scopes_check CHECK (((cardinality(scopes) > 0) AND (array_position(scopes, ''::text) IS NULL)))",
        `entitlements_status_check ${lifecycle}`,
        "entitlements_target_check CHECK ((num_nonnulls(client_id, resource) = 1))",
      ],
    });

    expect(
      groupByTable([...indexes.rows].sort(byTableThenName), (row) => {
        const unique = row.definition.startsWith("CREATE UNIQUE")
          ? " unique"
          : "";
        const columns = row.definition.slice(
          row.definition.indexOf("USING btree ") + "USING btree ".length,
        );
        return `${row.name}${unique} ${columns}`;
      }),
    ).toEqual({
      sessions: [
        "sessions_active_organization_id_idx (active_organization_id)",
        "sessions_expires_at_idx (expires_at)",
        "sessions_user_id_idx (user_id)",
      ],
      accounts: ["accounts_user_id_idx (user_id)"],
      verifications: [
        "verifications_expires_at_idx (expires_at)",
        "verifications_identifier_idx (identifier)",
      ],
      members: ["members_user_id_idx (user_id)"],
      invitations: [
        "invitations_email_idx (email)",
        "invitations_inviter_id_idx (inviter_id)",
        "invitations_organization_id_idx (organization_id)",
      ],
      oauth_clients: ["oauth_clients_user_id_idx (user_id)"],
      oauth_client_resources: [
        "oauth_client_resources_resource_id_idx (resource_id)",
      ],
      oauth_refresh_tokens: [
        "oauth_refresh_tokens_authorization_code_id_idx (authorization_code_id)",
        "oauth_refresh_tokens_client_id_idx (client_id)",
        "oauth_refresh_tokens_session_id_idx (session_id)",
        "oauth_refresh_tokens_user_id_idx (user_id)",
      ],
      oauth_access_tokens: [
        "oauth_access_tokens_authorization_code_id_idx (authorization_code_id)",
        "oauth_access_tokens_client_id_idx (client_id)",
        "oauth_access_tokens_refresh_id_idx (refresh_id)",
        "oauth_access_tokens_session_id_idx (session_id)",
        "oauth_access_tokens_user_id_idx (user_id)",
      ],
      oauth_consents: [
        "oauth_consents_client_id_idx (client_id)",
        "oauth_consents_user_id_idx (user_id)",
      ],
      oauth_client_assertions: [
        "oauth_client_assertions_expires_at_idx (expires_at)",
      ],
      organization_domains: [
        "organization_domains_active_domain_idx unique (domain) WHERE (status = 'active'::text)",
      ],
      groups: [
        "groups_organization_id_external_id_idx unique (organization_id, external_id) WHERE (external_id IS NOT NULL)",
      ],
      group_members: ["group_members_member_id_idx (member_id)"],
      entitlements: [
        "entitlements_client_id_idx (client_id)",
        "entitlements_resource_idx (resource)",
      ],
    });
  });

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
    const adapter = (await auth.$context).internalAdapter;
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
    expect(await connection.db.select().from(oauthClientResources)).toHaveLength(0);
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
    expect(await connection.db.select().from(oauthClientAssertions)).toHaveLength(1);
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

  test("enforces organization slug, uniqueness, and lifecycle invariants", async () => {
    const organization = await insertOrganization();
    const user = await insertUser();
    await insertMember(organization.id, user.id);

    await expect(insertOrganization()).rejects.toThrow();
    await expect(insertMember(organization.id, user.id)).rejects.toThrow();
    for (const slug of ["Contoso", "contoso corp", "-contoso", "contoso--ltd"]) {
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
        .values({ id: createId(), ...invitation, status: "expired" as "pending" })
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
      await findOrganizationByDomain(connection.db, " EXAMPLE.com "),
    ).toEqual({ id: first.id, slug: "first" });
    expect(await findOrganizationByDomain(connection.db, "other.example")).toBeNull();

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
    for (const invalid of ["not normalized.example", "localhost", "under_score.example", "-dash.example"]) {
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
    expect(await findOrganizationByDomain(connection.db, "example.com")).toEqual({
      id: second.id,
      slug: "second",
    });

    await connection.db
      .update(organizations)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(organizations.id, second.id));
    expect(await findOrganizationByDomain(connection.db, "example.com")).toBeNull();
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
    const organizationWide = await createEntitlement(connection.db, forResource);
    expect(isUuidV7(organizationWide.id)).toBe(true);
    await createEntitlement(connection.db, { ...forResource, groupId: group.id });
    await createEntitlement(connection.db, { ...forResource, memberId: member.id });
    await createEntitlement(connection.db, {
      organizationId: first.id,
      clientId,
      scopes: ["openid", "profile", "email"],
    });
    await expect(createEntitlement(connection.db, forResource)).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, { ...forResource, groupId: group.id }),
    ).rejects.toThrow();
    await expect(
      createEntitlement(connection.db, { ...forResource, memberId: member.id }),
    ).rejects.toThrow();

    // Exactly one principal narrowing and exactly one target.
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
    await expect(
      createEntitlement(connection.db, {
        ...forResource,
        clientId,
        memberId: undefined,
      }),
    ).rejects.toThrow();

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
        .values({ id: createId(), ...forResource, status: "unknown" as "active" })
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
    expect(await connection.db.select().from(entitlements)).toHaveLength(2);
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
    expect(await connection.db.select().from(organizationDomains)).toHaveLength(0);
    expect(await connection.db.select().from(entitlements)).toHaveLength(0);
    expect(await connection.db.select().from(oauthClients)).toHaveLength(1);
    expect(await connection.db.select().from(oauthResources)).toHaveLength(1);
  });
});
