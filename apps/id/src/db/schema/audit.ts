import { auditPolicies } from "./tenant-policies.ts";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { id, timestampColumn, vocabularyCheck } from "./columns.ts";
import { adminOperations } from "./operations.ts";
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
    organizationId: uuid("organization_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    outcome: text("outcome", { enum: auditOutcomes }).notNull(),
    reason: text("reason"),
    requestId: text("request_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    operationId: uuid("operation_id").references(() => adminOperations.id, {
      onDelete: "restrict",
    }),
    schemaVersion: integer("schema_version").notNull().default(1),
  },
  (table) => [
    ...auditPolicies(table.organizationId),
    index("audit_events_organization_id_id_idx").on(
      table.organizationId,
      table.id,
    ),
    index("audit_events_operation_id_idx").on(table.operationId),
    index("audit_events_action_occurred_at_idx").on(
      table.action,
      table.occurredAt,
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
).enableRLS();
/** Subject references outlive operational identities; provenance marks legacy derivation. */
export const auditEventSubjects = pgTable(
  "audit_event_subjects",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => auditEvents.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    relationship: text("relationship").notNull(),
    organizationId: uuid("organization_id"),
    provenance: text("provenance").notNull().default("recorded"),
  },
  (table) => [
    ...auditPolicies(table.organizationId),
    primaryKey({
      name: "audit_event_subjects_pkey",
      columns: [
        table.eventId,
        table.entityType,
        table.entityId,
        table.relationship,
      ],
    }),
    index("audit_event_subjects_entity_idx").on(
      table.entityType,
      table.entityId,
      table.eventId,
    ),
    index("audit_event_subjects_tenant_entity_idx").on(
      table.organizationId,
      table.entityType,
      table.entityId,
      table.eventId,
    ),
    vocabularyCheck("audit_event_subjects_provenance_check", table.provenance, [
      "recorded",
      "legacy_derived",
    ]),
  ],
).enableRLS();
