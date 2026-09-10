import { pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { vocabularyCheck } from "./columns.ts";

/** Permanent identifier reservations; no secrets or live-record foreign keys. */
export const securityIdentifiers = pgTable(
  "security_identifiers",
  {
    kind: text("kind").notNull(),
    identifier: text("identifier").notNull(),
    instanceId: uuid("instance_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.identifier] }),
    unique("security_identifiers_kind_instance_unique").on(
      table.kind,
      table.instanceId,
    ),
    vocabularyCheck("security_identifiers_kind_check", table.kind, [
      "client",
      "resource",
    ]),
  ],
);
