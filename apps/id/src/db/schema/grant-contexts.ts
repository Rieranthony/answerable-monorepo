import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  pgPolicy,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { members, organizations, users } from "./auth.ts";
import { oauthClients, oauthResources } from "./oauth.ts";
import { id, timestampColumn } from "./columns.ts";

/** One immutable authority context per user authorisation, shared by its rotations. */
export const grantContexts = pgTable(
  "grant_contexts",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clientInstanceId: uuid("client_instance_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "restrict" }),
    resourceInstanceId: uuid("resource_instance_id").references(
      () => oauthResources.id,
      { onDelete: "restrict" },
    ),
    authorizationCodeId: text("authorization_code_id").unique(),
    // Immutable authentication evidence, copied from the session's origin and
    // retained after the browser session ends; named as on `sessions`.
    authenticationSessionId: uuid("authentication_session_id").notNull(),
    authTime: timestampColumn("auth_time").notNull(),
    authenticationAccountId: uuid("authentication_account_id").notNull(),
    authenticationProviderId: uuid("authentication_provider_id").notNull(),
    authenticationProviderRevision: integer(
      "authentication_provider_revision",
    ).notNull(),
    upstreamAuthTime: timestampColumn("upstream_auth_time"),
    requestedScopes: text("requested_scopes").array().notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    revokedAt: timestampColumn("revoked_at"),
  },
  (table) => {
    const mode = sql`current_setting('answerable.scope', true)`;
    const tenant = sql`${table.organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid`;
    const subject = sql`${table.userId} = nullif(current_setting('answerable.subject', true), '')::uuid`;
    const admission = sql`(${mode} = 'grant-admission' and ${subject} and ${table.authenticationSessionId} = nullif(current_setting('answerable.session', true), '')::uuid)`;
    const client = sql`(${mode} = 'grant-client' and ${table.clientInstanceId} in (select id from oauth_clients where client_id = current_setting('answerable.client', true)))`;
    const write = sql`(${mode} in ('platform-write', 'platform-users') or (${mode} = 'tenant-write' and ${tenant}) or ${client})`;
    return [
      pgPolicy("grant_read", {
        for: "select",
        using: sql`${write} or ${mode} = 'platform-read' or (${mode} = 'tenant-read' and ${tenant}) or (${mode} = 'policy-user' and ${subject}) or ${admission}`,
      }),
      pgPolicy("grant_insert", {
        for: "insert",
        withCheck: sql`${mode} = 'platform-write' or ${admission}`,
      }),
      pgPolicy("grant_update", {
        for: "update",
        using: write,
        withCheck: write,
      }),
      index("grant_contexts_organization_id_idx").on(table.organizationId),
      index("grant_contexts_member_id_idx").on(table.memberId),
      index("grant_contexts_user_id_idx").on(table.userId),
      index("grant_contexts_client_instance_id_idx").on(table.clientInstanceId),
      index("grant_contexts_resource_instance_id_idx").on(
        table.resourceInstanceId,
      ),
      check(
        "grant_contexts_authentication_provider_revision_check",
        sql`${table.authenticationProviderRevision} > 0`,
      ),
      check(
        "grant_contexts_code_check",
        sql`${table.authorizationCodeId} is null or length(${table.authorizationCodeId}) > 0`,
      ),
      check(
        "grant_contexts_expiry_check",
        sql`${table.expiresAt} > ${table.createdAt}`,
      ),
      check(
        "grant_contexts_scopes_check",
        sql`cardinality(${table.requestedScopes}) > 0 and array_position(${table.requestedScopes}, '') is null and array_position(${table.requestedScopes}, null) is null`,
      ),
    ];
  },
).enableRLS();
