import { routingPolicies } from "./tenant-policies.ts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./auth.ts";
import {
  hostnameCheck,
  id,
  softDeletion,
  softDeletionChecks,
  timestamps,
  vocabularyCheck,
} from "./columns.ts";
import { magicLinkAdmissions, ssoProviderKinds } from "./vocabulary.ts";

// Persisted configuration owned by @better-auth/sso. The organization and
// normalized domain constraints are Answerable's tenant-boundary additions.
export const ssoProviders = pgTable(
  "sso_providers",
  {
    ...softDeletion(),
    id: id(),
    kind: text("kind", { enum: ssoProviderKinds }).default("oidc").notNull(),
    /** Only a magic-link row can be off: sessions and grants name this row and its
     * revision, so turning it off ends those at once and touches nothing else. */
    enabled: boolean("enabled").default(true).notNull(),
    /** Who may ask this row for a link. Changing it moves no revision (drizzle/0010): narrowing
     * it leaves members as members, so it ends no session and no grant. */
    admission: text("admission", { enum: magicLinkAdmissions })
      .default("listed")
      .notNull(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidc_config"),
    providerId: text("provider_id").notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    ...timestamps(),
    revision: integer("revision").default(1).notNull(),
  },
  (table) => [
    ...routingPolicies(table.organizationId, true),
    ...softDeletionChecks(
      "sso_providers",
      table,
      sql`${table.oidcConfig} is null`,
    ),
    foreignKey({
      name: "sso_providers_organization_live_fk",
      columns: [table.organizationId, table.live],
      foreignColumns: [organizations.id, organizations.live],
    }).onDelete("cascade"),
    check("sso_providers_revision_check", sql`${table.revision} > 0`),
    vocabularyCheck("sso_providers_kind_check", table.kind, ssoProviderKinds),
    // A live directory has its configuration; a magic-link row never has one.
    check(
      "sso_providers_kind_config_check",
      sql`(${table.kind} = 'oidc' and (${table.deletedAt} is not null or ${table.oidcConfig} is not null)) or (${table.kind} = 'magic_link' and ${table.oidcConfig} is null)`,
    ),
    check(
      "sso_providers_enabled_check",
      sql`${table.kind} = 'magic_link' or ${table.enabled}`,
    ),
    vocabularyCheck(
      "sso_providers_admission_check",
      table.admission,
      magicLinkAdmissions,
    ),
    check(
      "sso_providers_admission_kind_check",
      sql`${table.kind} = 'magic_link' or ${table.admission} = 'listed'`,
    ),
    uniqueIndex("sso_providers_organization_kind_unique")
      .on(table.organizationId, table.kind)
      .where(sql`${table.deletedAt} is null`),
    hostnameCheck("sso_providers_domain_normalized_check", table.domain),
  ],
).enableRLS();
