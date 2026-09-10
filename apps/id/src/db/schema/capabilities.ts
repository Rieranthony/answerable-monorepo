import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgPolicy,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./auth.ts";
import { oauthClients, oauthResources } from "./oauth.ts";
import {
  effectiveWindow,
  id,
  timestamps,
  vocabularyCheck,
  windowCheck,
} from "./columns.ts";
import { lifecycleStatuses } from "./vocabulary.ts";

export const capabilityGrantKinds = [
  "admin_session",
  "authorization_code",
  "refresh_token",
  "client_credentials",
] as const;

/** Platform-approved ceilings are separate from tenant assignments. */
export const organizationCapabilities = pgTable(
  "organization_capabilities",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: text("client_id").references(() => oauthClients.clientId, {
      onDelete: "restrict",
    }),
    resource: text("resource").references(() => oauthResources.identifier, {
      onDelete: "restrict",
    }),
    grantKind: text("grant_kind", { enum: capabilityGrantKinds }).notNull(),
    scopes: text("scopes").array().notNull(),
    status: text("status", { enum: lifecycleStatuses })
      .default("active")
      .notNull(),
    ...effectiveWindow(),
    ...timestamps(),
    revision: integer("revision").default(1).notNull(),
  },
  (table) => [
    unique("organization_capabilities_target_kind_unique")
      .on(table.organizationId, table.clientId, table.resource, table.grantKind)
      .nullsNotDistinct(),
    check(
      "organization_capabilities_revision_check",
      sql`${table.revision} > 0`,
    ),
    vocabularyCheck(
      "organization_capabilities_kind_check",
      table.grantKind,
      capabilityGrantKinds,
    ),
    vocabularyCheck(
      "organization_capabilities_status_check",
      table.status,
      lifecycleStatuses,
    ),
    check(
      "organization_capabilities_target_check",
      sql`
    (${table.grantKind} = 'admin_session' and ${table.clientId} is null and ${table.resource} is not null)
    or (${table.grantKind} = 'authorization_code' and ${table.clientId} is not null)
    or (${table.grantKind} in ('refresh_token', 'client_credentials') and ${table.clientId} is not null and ${table.resource} is not null)`,
    ),
    check(
      "organization_capabilities_scopes_check",
      sql`cardinality(${table.scopes}) > 0 and array_position(${table.scopes}, '') is null and array_position(${table.scopes}, null) is null`,
    ),
    windowCheck(
      "organization_capabilities_window_check",
      table.validFrom,
      table.validUntil,
    ),
    pgPolicy("capability_write", {
      for: "all",
      using: sql`current_setting('answerable.scope', true) = 'platform-write'`,
      withCheck: sql`current_setting('answerable.scope', true) = 'platform-write'`,
    }),
    pgPolicy("capability_read", {
      for: "select",
      using: sql`current_setting('answerable.scope', true) in ('platform-read', 'platform-write')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and ${table.organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or (current_setting('answerable.scope', true) = 'policy-user' and ${table.organizationId} in (select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid))
      or (current_setting('answerable.scope', true) = 'policy-root' and ${table.organizationId} in (select organization_id from system_bindings))`,
    }),
  ],
).enableRLS();
