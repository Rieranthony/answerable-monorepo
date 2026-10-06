import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./auth.ts";
import { groups } from "./authorization.ts";
import { oauthResources } from "./oauth.ts";
import { vocabularyCheck } from "./columns.ts";

/** The platform's identities are persisted once, independent of names. */
export const systemBindings = pgTable(
  "system_bindings",
  {
    name: text("name").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    resourceInstanceId: uuid("resource_instance_id")
      .notNull()
      .references(() => oauthResources.id, { onDelete: "restrict" }),
    groupId: uuid("group_id").notNull(),
    /** Always true: the live foreign keys keep every bound object undeleted. */
    live: boolean("live").default(true).notNull(),
  },
  (table) => [
    vocabularyCheck("system_bindings_name_check", table.name, ["platform"]),
    check("system_bindings_live_check", sql`${table.live}`),
    foreignKey({
      name: "system_bindings_organization_group_fk",
      columns: [table.organizationId, table.groupId],
      foreignColumns: [groups.organizationId, groups.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "system_bindings_organization_live_fk",
      columns: [table.organizationId, table.live],
      foreignColumns: [organizations.id, organizations.live],
    }),
    foreignKey({
      name: "system_bindings_resource_instance_live_fk",
      columns: [table.resourceInstanceId, table.live],
      foreignColumns: [oauthResources.id, oauthResources.live],
    }),
    foreignKey({
      name: "system_bindings_group_live_fk",
      columns: [table.groupId, table.live],
      foreignColumns: [groups.id, groups.live],
    }),
  ],
);
