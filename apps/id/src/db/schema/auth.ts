import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  disabledCheck,
  id,
  slugCheck,
  timestampColumn,
  timestamps,
  vocabularyCheck,
} from "./columns.ts";
import {
  invitationStatuses,
  lifecycleStatuses,
  userStatuses,
} from "./vocabulary.ts";

// Tables in this file are owned by Better Auth 1.7.2 (core and the
// organization plugin). Columns beyond its field set are Answerable's
// additional fields, declared again in `src/auth.ts`.

export const users = pgTable(
  "users",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    status: text("status", { enum: userStatuses }).default("inert").notNull(),
    disabledAt: timestampColumn("disabled_at"),
    ...timestamps(),
  },
  (table) => [
    vocabularyCheck("users_status_check", table.status, userStatuses),
    check(
      "users_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email}))`,
    ),
    disabledCheck("users_disabled_check", table.status, table.disabledAt),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    metadata: text("metadata"),
    status: text("status", { enum: lifecycleStatuses })
      .default("active")
      .notNull(),
    disabledAt: timestampColumn("disabled_at"),
    ...timestamps(),
  },
  (table) => [
    slugCheck("organizations_slug_normalized_check", table.slug),
    vocabularyCheck(
      "organizations_status_check",
      table.status,
      lifecycleStatuses,
    ),
    disabledCheck(
      "organizations_disabled_check",
      table.status,
      table.disabledAt,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    expiresAt: timestampColumn("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ...timestamps(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Organization plugin state for Better Auth's own routes. Never an
    // authorization input: the token's organization comes from membership.
    activeOrganizationId: uuid("active_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_active_organization_id_idx").on(
      table.activeOrganizationId,
    ),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestampColumn("access_token_expires_at"),
    refreshTokenExpiresAt: timestampColumn("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    ...timestamps(),
  },
  (table) => [
    unique("accounts_issuer_account_id_unique").on(
      table.issuer,
      table.accountId,
    ),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    // Better Auth computes some verification ids itself (a SHA-256 digest for
    // reservation locks), so this is the one id column that is not a UUID.
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    ...timestamps(),
  },
  (table) => [
    index("verifications_identifier_idx").on(table.identifier),
    index("verifications_expires_at_idx").on(table.expiresAt),
  ],
);

export const members = pgTable(
  "members",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Better Auth role state; may hold a comma-separated list. Confers no
    // authority in Answerable ID, where entitlements decide access.
    role: text("role").default("member").notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("members_organization_id_user_id_unique").on(
      table.organizationId,
      table.userId,
    ),
    // Lets entitlements reference (organization_id, member_id) together, so a
    // member-specific grant cannot point at another organization's member.
    unique("members_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("members_user_id_idx").on(table.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status", { enum: invitationStatuses })
      .default("pending")
      .notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitations_organization_id_idx").on(table.organizationId),
    index("invitations_inviter_id_idx").on(table.inviterId),
    index("invitations_email_idx").on(table.email),
    vocabularyCheck(
      "invitations_status_check",
      table.status,
      invitationStatuses,
    ),
  ],
);
