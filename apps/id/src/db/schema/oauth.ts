import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations, sessions, users } from "./auth.ts";
import {
  id,
  softDeletion,
  softDeletionChecks,
  timestampColumn,
  timestamps,
} from "./columns.ts";

// Tables in this file are owned by Better Auth's JWT plugin and by
// @better-auth/oauth-provider 1.7.2. Property names are the plugins' own field
// names; only the physical names follow Answerable's conventions.

/** Token-signing keys, published at the JWKS endpoint. The row id is the `kid`. */
export const jwks = pgTable("jwks", {
  id: id(),
  publicKey: text("public_key").notNull(),
  /** Encrypted by the plugin with the application secret; custody is a later milestone. */
  privateKey: text("private_key").notNull(),
  createdAt: timestampColumn("created_at").defaultNow().notNull(),
  expiresAt: timestampColumn("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

/** An OAuth client: an app users log into, or a tool that requests tokens. */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    ...softDeletion(),
    id: id(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    name: text("name"),
    uri: text("uri"),
    contacts: text("contacts").array(),
    redirectUris: text("redirect_uris").array().notNull(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    scopes: text("scopes").array(),
    /** Server-owned ceiling for client_credentials; null or empty denies machine tokens. */
    clientCredentialsScopes: text("client_credentials_scopes").array(),
    skipConsent: boolean("skip_consent"),
    disabled: boolean("disabled").default(false).notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    ...timestamps(),
    revision: integer("revision").default(1).notNull(),
    authorizationVersion: integer("authorization_version").default(1).notNull(),
  },
  (table) => [
    ...softDeletionChecks(
      "oauth_clients",
      table,
      sql`${table.disabled} and ${table.clientSecret} is null`,
    ),
    unique("oauth_clients_client_id_live_unique").on(
      table.clientId,
      table.live,
    ),
    foreignKey({
      name: "oauth_clients_organization_live_fk",
      columns: [table.organizationId, table.live],
      foreignColumns: [organizations.id, organizations.live],
    }),
    check("oauth_clients_revision_check", sql`${table.revision} > 0`),
    check(
      "oauth_clients_authorization_version_check",
      sql`${table.authorizationVersion} > 0`,
    ),
    index("oauth_clients_organization_id_idx").on(table.organizationId),
  ],
);

/** A protected resource (an MCP server) with its own token policy. */
export const oauthResources = pgTable(
  "oauth_resources",
  {
    ...softDeletion(),
    id: id(),
    classification: text("classification", {
      enum: ["platform_shared", "tenant_owned"],
    })
      .default("platform_shared")
      .notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    /** The RFC 8707 resource indicator and the `aud` claim value. */
    identifier: text("identifier").notNull().unique(),
    name: text("name").notNull(),
    accessTokenTtl: integer("access_token_ttl"),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    allowedScopes: text("allowed_scopes").array(),
    disabled: boolean("disabled").default(false).notNull(),
    revision: integer("revision").default(1).notNull(),
    ...timestamps(),
  },
  (table) => [
    ...softDeletionChecks("oauth_resources", table, sql`${table.disabled}`),
    unique("oauth_resources_id_live_unique").on(table.id, table.live),
    unique("oauth_resources_identifier_live_unique").on(
      table.identifier,
      table.live,
    ),
    foreignKey({
      name: "oauth_resources_organization_live_fk",
      columns: [table.organizationId, table.live],
      foreignColumns: [organizations.id, organizations.live],
    }),
    check(
      "oauth_resources_ownership_check",
      sql`(${table.classification} = 'platform_shared' and ${table.organizationId} is null) or (${table.classification} = 'tenant_owned' and ${table.organizationId} is not null)`,
    ),
    index("oauth_resources_organization_id_idx").on(table.organizationId),
    check("oauth_resources_revision_check", sql`${table.revision} > 0`),
  ],
);

/** Server-owned link: which clients may request tokens for which resources. */
export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    ...softDeletion(),
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    /** Holds the resource identifier, not its row id; the property keeps the plugin's naming. */
    resourceId: text("resource").notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
  },
  (table) => [
    ...softDeletionChecks("oauth_client_resources", table),
    foreignKey({
      name: "oauth_client_resources_client_live_fk",
      columns: [table.clientId, table.live],
      foreignColumns: [oauthClients.clientId, oauthClients.live],
    }).onDelete("cascade"),
    foreignKey({
      name: "oauth_client_resources_resource_live_fk",
      columns: [table.resourceId, table.live],
      foreignColumns: [oauthResources.identifier, oauthResources.live],
    }),
    // Named explicitly: the generated name would exceed 63 characters and
    // PostgreSQL would silently truncate it.
    foreignKey({
      name: "oauth_client_resources_resource_fk",
      columns: [table.resourceId],
      foreignColumns: [oauthResources.identifier],
    }).onDelete("restrict"),
    uniqueIndex("oauth_client_resources_client_id_resource_unique")
      .on(table.clientId, table.resourceId)
      .where(sql`${table.deletedAt} is null`),
    index("oauth_client_resources_resource_idx").on(table.resourceId),
  ],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: id(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    // The plugin sets an expiry on every token row; a token without one
    // cannot exist.
    expiresAt: timestampColumn("expires_at").notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    revoked: timestampColumn("revoked_at"),
    rotatedAt: timestampColumn("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestampColumn("rotation_replay_expires_at"),
    authTime: timestampColumn("auth_time"),
    confirmation: jsonb("confirmation"),
  },
  (table) => [
    index("oauth_refresh_tokens_expires_at_idx").on(table.expiresAt),
    index("oauth_refresh_tokens_client_id_idx").on(table.clientId),
    index("oauth_refresh_tokens_session_id_idx").on(table.sessionId),
    index("oauth_refresh_tokens_user_id_idx").on(table.userId),
    index("oauth_refresh_tokens_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: id(),
    /** Set for opaque tokens only; JWT access tokens are verified by signature. */
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: uuid("refresh_id").references(() => oauthRefreshTokens.id, {
      onDelete: "cascade",
    }),
    scopes: text("scopes").array().notNull(),
    // The plugin sets an expiry on every token row; a token without one
    // cannot exist.
    expiresAt: timestampColumn("expires_at").notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    revoked: timestampColumn("revoked_at"),
    confirmation: jsonb("confirmation"),
  },
  (table) => [
    index("oauth_access_tokens_expires_at_idx").on(table.expiresAt),
    index("oauth_access_tokens_client_id_idx").on(table.clientId),
    index("oauth_access_tokens_session_id_idx").on(table.sessionId),
    index("oauth_access_tokens_user_id_idx").on(table.userId),
    index("oauth_access_tokens_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
    index("oauth_access_tokens_refresh_id_idx").on(table.refreshId),
  ],
);

export const oauthConsents = pgTable(
  "oauth_consents",
  {
    ...softDeletion(),
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    ...timestamps(),
  },
  (table) => [
    ...softDeletionChecks("oauth_consents", table),
    foreignKey({
      name: "oauth_consents_client_live_fk",
      columns: [table.clientId, table.live],
      foreignColumns: [oauthClients.clientId, oauthClients.live],
    }).onDelete("cascade"),
    foreignKey({
      name: "oauth_consents_user_live_fk",
      columns: [table.userId, table.live],
      foreignColumns: [users.id, users.live],
    }).onDelete("cascade"),
    index("oauth_consents_client_id_idx").on(table.clientId),
    index("oauth_consents_user_id_idx").on(table.userId),
  ],
);

/**
 * Single-use `private_key_jwt` assertion ids. The plugin computes the row id
 * as a digest of the assertion's `jti`, so a replay collides on the primary
 * key; this is the second id column that is not a UUID.
 */
export const oauthClientAssertions = pgTable(
  "oauth_client_assertions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestampColumn("expires_at").notNull(),
  },
  (table) => [
    index("oauth_client_assertions_expires_at_idx").on(table.expiresAt),
  ],
);
