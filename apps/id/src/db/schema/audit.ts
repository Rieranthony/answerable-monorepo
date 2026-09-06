import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { organizations } from "./auth.ts";
import { id, timestampColumn, vocabularyCheck } from "./columns.ts";
import { auditActorTypes, auditOutcomes } from "./vocabulary.ts";

/**
 * Append-only record of administrative changes and authentication outcomes.
 * target_id is text so an erased row's id survives. Rows are never updated
 * or deleted by application code.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    occurredAt: timestampColumn("occurred_at").defaultNow().notNull(),
    actorType: text("actor_type", { enum: auditActorTypes }).notNull(),
    actorId: text("actor_id").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    outcome: text("outcome", { enum: auditOutcomes }).notNull(),
    reason: text("reason"),
    requestId: text("request_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("audit_events_organization_id_id_idx").on(
      table.organizationId,
      table.id,
    ),
    index("audit_events_actor_id_idx").on(table.actorId),
    index("audit_events_target_type_target_id_idx").on(
      table.targetType,
      table.targetId,
    ),
    vocabularyCheck(
      "audit_events_actor_type_check",
      table.actorType,
      auditActorTypes,
    ),
    vocabularyCheck("audit_events_outcome_check", table.outcome, auditOutcomes),
  ],
);
