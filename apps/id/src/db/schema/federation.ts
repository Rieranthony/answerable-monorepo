import { sql } from "drizzle-orm";
import { check, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./auth.ts";
import { id, timestampColumn } from "./columns.ts";

// Persisted configuration owned by @better-auth/sso. The organization and
// normalized domain constraints are Answerable's tenant-boundary additions.
export const ssoProviders = pgTable(
  "sso_providers",
  {
    id: id(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidc_config"),
    samlConfig: text("saml_config"),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("sso_providers_organization_id_unique").on(table.organizationId),
    check(
      "sso_providers_domain_normalized_check",
      sql`${table.domain} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`,
    ),
  ],
);
