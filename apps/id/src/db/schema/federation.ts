import { routingPolicies } from "./tenant-policies.ts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./auth.ts";
import { id, softDeletion, softDeletionChecks, timestamps } from "./columns.ts";

// Persisted configuration owned by @better-auth/sso. The organization and
// normalized domain constraints are Answerable's tenant-boundary additions.
export const ssoProviders = pgTable(
  "sso_providers",
  {
    ...softDeletion(),
    id: id(),
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
    uniqueIndex("sso_providers_organization_id_unique")
      .on(table.organizationId)
      .where(sql`${table.deletedAt} is null`),
    check(
      "sso_providers_domain_normalized_check",
      sql`${table.domain} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`,
    ),
  ],
).enableRLS();
