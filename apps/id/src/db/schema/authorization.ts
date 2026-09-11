import { tenantPolicies } from "./tenant-policies.ts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { members, organizations } from "./auth.ts";
import {
  effectiveWindow,
  id,
  slugCheck,
  timestampColumn,
  timestamps,
  vocabularyCheck,
  windowCheck,
} from "./columns.ts";
import { oauthClients, oauthResources } from "./oauth.ts";
import { lifecycleStatuses } from "./vocabulary.ts";

// Tables in this file are owned by Answerable: tenant routing, groups, and
// the authorization policy that runs at every token grant.

export const organizationDomains = pgTable(
  "organization_domains",
  {
    deletedAt: timestampColumn("deleted_at"),
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status", { enum: lifecycleStatuses })
      .default("active")
      .notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("organization_domains_organization_id_domain_unique")
      .on(table.organizationId, table.domain)
      .where(sql`${table.deletedAt} is null`),
    // A domain routes to at most one organization. Moving it means disabling
    // the old row first, so ambiguity cannot exist in the data.
    uniqueIndex("organization_domains_active_domain_idx")
      .on(table.domain)
      .where(sql`${table.status} = 'active' and ${table.deletedAt} is null`),
    vocabularyCheck(
      "organization_domains_status_check",
      table.status,
      lifecycleStatuses,
    ),
    // Lowercase ASCII host name with at least two labels (IDNs as punycode).
    check(
      "organization_domains_domain_normalized_check",
      sql`${table.domain} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`,
    ),
  ],
);

/**
 * A set of members within one organization. Enterprise customers assign
 * access by group; a group either mirrors an upstream directory group
 * (`external_id` set, membership synced from the directory) or is managed in
 * Answerable ID.
 */
export const groups = pgTable(
  "groups",
  {
    deletedAt: timestampColumn("deleted_at"),
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The upstream directory's group id (an Entra object id, a Google group id). */
    externalId: text("external_id"),
    status: text("status", { enum: lifecycleStatuses })
      .default("active")
      .notNull(),
    ...timestamps(),
    revision: integer("revision").default(1).notNull(),
  },
  (table) => [
    ...tenantPolicies(table.organizationId),
    check("groups_revision_check", sql`${table.revision} > 0`),
    unique("groups_organization_id_slug_unique").on(
      table.organizationId,
      table.slug,
    ),
    // Lets group membership and entitlements reference
    // (organization_id, group_id) together.
    unique("groups_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("groups_organization_id_external_id_idx")
      .on(table.organizationId, table.externalId)
      .where(sql`${table.externalId} is not null`),
    slugCheck("groups_slug_normalized_check", table.slug),
    vocabularyCheck("groups_status_check", table.status, lifecycleStatuses),
  ],
).enableRLS();

/**
 * Membership of a group. Both composite foreign keys carry the organization,
 * so a group can only ever contain members of its own organization.
 */
export const groupMembers = pgTable(
  "group_members",
  {
    deletedAt: timestampColumn("deleted_at"),
    organizationId: uuid("organization_id").notNull(),
    groupId: uuid("group_id").notNull(),
    memberId: uuid("member_id").notNull(),
    ...effectiveWindow(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    id: uuid("id").notNull(),
    revision: integer("revision").default(1).notNull(),
  },
  (table) => [
    ...tenantPolicies(table.organizationId),
    uniqueIndex("group_members_live_assignment_unique")
      .on(table.groupId, table.memberId)
      .where(sql`${table.deletedAt} is null`),
    check("group_members_revision_check", sql`${table.revision} > 0`),
    primaryKey({
      name: "group_members_pkey",
      columns: [table.id],
    }),
    foreignKey({
      name: "group_members_organization_id_group_id_fk",
      columns: [table.organizationId, table.groupId],
      foreignColumns: [groups.organizationId, groups.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "group_members_organization_id_member_id_fk",
      columns: [table.organizationId, table.memberId],
      foreignColumns: [members.organizationId, members.id],
    }).onDelete("cascade"),
    index("group_members_member_id_idx").on(table.memberId),
    windowCheck(
      "group_members_window_check",
      table.validFrom,
      table.validUntil,
    ),
  ],
).enableRLS();

/**
 * Who may obtain tokens for what, and with which scopes.
 *
 * Principal: the whole organization (member_id and group_id null), one
 * group, or one member. Target: a client, a resource, or an exact client/resource
 * pair. Resource-only assignments cannot grant OAuth service access.
 * Grants are additive within the same exact target: a person is
 * entitled when any active row matches them for the target.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    deletedAt: timestampColumn("deleted_at"),
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id"),
    groupId: uuid("group_id"),
    clientId: text("client_id").references(() => oauthClients.clientId, {
      onDelete: "restrict",
    }),
    resource: text("resource").references(() => oauthResources.identifier, {
      onDelete: "restrict",
    }),
    scopes: text("scopes").array().notNull(),
    status: text("status", { enum: lifecycleStatuses })
      .default("active")
      .notNull(),
    ...effectiveWindow(),
    ...timestamps(),
    revision: integer("revision").default(1).notNull(),
  },
  (table) => [
    ...tenantPolicies(table.organizationId),
    check("entitlements_revision_check", sql`${table.revision} > 0`),
    foreignKey({
      name: "entitlements_organization_id_member_id_fk",
      columns: [table.organizationId, table.memberId],
      foreignColumns: [members.organizationId, members.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "entitlements_organization_id_group_id_fk",
      columns: [table.organizationId, table.groupId],
      foreignColumns: [groups.organizationId, groups.id],
    }).onDelete("cascade"),
    // NULLS NOT DISTINCT makes every principal and target shape unique with
    // one constraint. Named short because the generated form exceeds 63 chars.
    // The SQL migration adds NULLS NOT DISTINCT; Drizzle cannot express it on partial indexes.
    uniqueIndex("entitlements_principal_target_unique")
      .on(
        table.organizationId,
        table.memberId,
        table.groupId,
        table.clientId,
        table.resource,
      )
      .where(sql`${table.deletedAt} is null`),
    index("entitlements_client_id_idx").on(table.clientId),
    index("entitlements_resource_idx").on(table.resource),
    check(
      "entitlements_principal_check",
      sql`num_nonnulls(${table.memberId}, ${table.groupId}) <= 1`,
    ),
    check(
      "entitlements_target_check",
      sql`num_nonnulls(${table.clientId}, ${table.resource}) >= 1`,
    ),
    vocabularyCheck(
      "entitlements_status_check",
      table.status,
      lifecycleStatuses,
    ),
    windowCheck("entitlements_window_check", table.validFrom, table.validUntil),
    check(
      "entitlements_scopes_check",
      sql`cardinality(${table.scopes}) > 0 and array_position(${table.scopes}, '') is null`,
    ),
  ],
).enableRLS();
