import { foreignKey, pgTable, text, uuid } from "drizzle-orm/pg-core";
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
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => oauthResources.id, { onDelete: "restrict" }),
    groupId: uuid("group_id").notNull(),
  },
  (table) => [
    vocabularyCheck("system_bindings_name_check", table.name, ["platform"]),
    foreignKey({
      columns: [table.organizationId, table.groupId],
      foreignColumns: [groups.organizationId, groups.id],
    }).onDelete("restrict"),
  ],
);
