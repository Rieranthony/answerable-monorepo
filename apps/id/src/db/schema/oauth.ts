import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations, sessions, users } from "./auth.ts";
import { id, timestampColumn, timestamps } from "./columns.ts";

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
    id: id(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    referenceId: text("reference_id"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens")
      .default(false)
      .notNull(),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    /** Server-owned ceiling for client_credentials; null or empty denies machine tokens. */
    clientCredentialsScopes: text("client_credentials_scopes").array(),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    disabled: boolean("disabled").default(false).notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "restrict" },
    ),
    metadata: jsonb("metadata"),
    ...timestamps(),
  },
  (table) => [
    index("oauth_clients_user_id_idx").on(table.userId),
    index("oauth_clients_organization_id_idx").on(table.organizationId),
  ],
);

/** A protected resource (an MCP server) with its own token policy. */
export const oauthResources = pgTable("oauth_resources", {
  id: id(),
  /** The RFC 8707 resource indicator and the `aud` claim value. */
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required")
    .default(false)
    .notNull(),
  disabled: boolean("disabled").default(false).notNull(),
  policyVersion: integer("policy_version").default(1).notNull(),
  metadata: jsonb("metadata"),
  ...timestamps(),
});

/** Server-owned link: which clients may request tokens for which resources. */
export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    /** Holds the resource identifier, not its row id; the plugin's naming. */
    resourceId: text("resource_id").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Named explicitly: the generated name would exceed 63 characters and
    // PostgreSQL would silently truncate it.
    foreignKey({
      name: "oauth_client_resources_resource_id_fk",
      columns: [table.resourceId],
      foreignColumns: [oauthResources.identifier],
    }).onDelete("cascade"),
    unique("oauth_client_resources_client_id_resource_id_unique").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauth_client_resources_resource_id_idx").on(table.resourceId),
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
    revoked: timestampColumn("revoked"),
    rotatedAt: timestampColumn("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestampColumn("rotation_replay_expires_at"),
    authTime: timestampColumn("auth_time"),
    confirmation: jsonb("confirmation"),
  },
  (table) => [
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
    revoked: timestampColumn("revoked"),
    confirmation: jsonb("confirmation"),
  },
  (table) => [
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
