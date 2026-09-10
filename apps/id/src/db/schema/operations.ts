import {
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestampColumn, vocabularyCheck } from "./columns.ts";

/** Permanent command reservations contain references, never response secrets. */
export const adminOperations = pgTable(
  "admin_operations",
  {
    id: id(),
    actorInstance: text("actor_instance").notNull(),
    authorityScope: text("authority_scope").notNull(),
    name: text("name").notNull(),
    keyDigest: text("key_digest").notNull(),
    fingerprint: text("fingerprint").notNull(),
    outcome: text("outcome", { enum: ["applied", "noop"] }).notNull(),
    statusCode: integer("status_code").notNull(),
    resultReference: jsonb("result_reference")
      .$type<{ type: string; id: string }>()
      .notNull(),
    replayExpiresAt: timestampColumn("replay_expires_at"),
    committedAt: timestampColumn("committed_at").defaultNow().notNull(),
  },
  (table) => [
    unique("admin_operations_key_unique").on(
      table.actorInstance,
      table.authorityScope,
      table.name,
      table.keyDigest,
    ),
    vocabularyCheck("admin_operations_outcome_check", table.outcome, [
      "applied",
      "noop",
    ]),
  ],
);

/** Payloads may be purged without releasing their permanent command reservation. */
export const adminOperationResults = pgTable("admin_operation_results", {
  operationId: uuid("operation_id")
    .primaryKey()
    .references(() => adminOperations.id, { onDelete: "restrict" }),
  ciphertext: text("ciphertext").notNull(),
});
