import { sql } from "drizzle-orm"
import { bigint, check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"

/** What an evidence event records; `evidence_events.kind` accepts no other. A new kind is a change here, not a new layout. */
export const evidenceKinds = [
  "capability.completed", "capability.denied", "intent.prepared", "intent.approval_requested", "intent.committed", "intent.stale", "intent.expired", "receipt.issued",
] as const
/** How an evidence event ended. */
export const evidenceOutcomes = ["success", "failure", "denied"] as const
/** Who may commit an intent. */
export const policyClasses = ["agent", "controlled", "human"] as const
/** The statuses an intent moves through. */
export const intentStatuses = ["prepared", "awaiting_approval", "committing", "committed", "failed", "expired", "stale"] as const

const literals = (values: readonly string[]) => sql.raw(values.map(value => `'${value}'`).join(", "))
const timestamptz = () => timestamp({ withTimezone: true, mode: "date" })

// The three tables every server with a database has. The columns are named as the SDK's types name their fields, and every constraint as Postgres
// named it when this package's SQL files created these tables before drizzle, so that a database those files built is a fresh drizzle one and its
// adoption (migrate.ts) is bookkeeping, not DDL.

/** Erasable bodies, such as previews, stored beside the chain, which holds each one only by its hash. A trigger allows no change but an erasure. */
export const evidencePayloads = pgTable("evidence_payloads", {
  id: uuid().primaryKey(),
  organisation_id: uuid().notNull(),
  body: jsonb().$type<Record<string, unknown>>(),
  hash: text().notNull(),
  created_at: timestamptz().notNull().defaultNow(),
  erased_at: timestamptz(),
}, table => [
  check("evidence_payloads_check", sql`(${table.body} is null) = (${table.erased_at} is not null)`),
])

/**
 * A server's evidence: an append-only chain of events per organisation. The trigger in `sql/evidence-chain.sql` assigns `seq`, `prev_hash` and
 * `row_hash` on insert, and another refuses every update, delete and truncation. `data` holds bounded facts: an object of at most 4 KiB.
 */
export const evidenceEvents = pgTable("evidence_events", {
  id: uuid().primaryKey(),
  organisation_id: uuid().notNull(),
  seq: bigint({ mode: "number" }).notNull(),
  occurred_at: timestamptz().notNull().defaultNow(),
  kind: text({ enum: evidenceKinds }).notNull(),
  actor_type: text().notNull(),
  actor_id: text().notNull(),
  client_id: text(),
  capability_identity: text(),
  capability_version: text(),
  execution_id: uuid(),
  intent_id: uuid(),
  receipt_id: uuid(),
  upstream: text(),
  outcome: text({ enum: evidenceOutcomes }).notNull(),
  reason: text(),
  error_code: text(),
  request_id: text(),
  trace_id: text(),
  span_id: text(),
  data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  payload_ref: uuid(),
  payload_hash: text(),
  prev_hash: text().notNull(),
  row_hash: text().notNull(),
  schema_version: integer().notNull().default(1),
}, table => [
  foreignKey({ name: "evidence_events_payload_ref_fkey", columns: [table.payload_ref], foreignColumns: [evidencePayloads.id] }),
  unique("evidence_events_organisation_id_seq_key").on(table.organisation_id, table.seq),
  check("evidence_events_kind_check", sql`${table.kind} in (${literals(evidenceKinds)})`),
  check("evidence_events_outcome_check", sql`${table.outcome} in (${literals(evidenceOutcomes)})`),
  check("evidence_events_data_check", sql`jsonb_typeof(${table.data}) = 'object' and octet_length(${table.data}::text) <= 4096`),
])

/**
 * Prepared mutations: one row per intent, moved from status to status by compare-and-set, the commit token kept only as its SHA-256. The store
 * deletes an intent once it can no longer be committed, and a committed one a day after its commit.
 */
export const intents = pgTable("intents", {
  intent_id: uuid().primaryKey(),
  organisation_id: uuid().notNull(),
  user_id: text().notNull(),
  membership_id: text().notNull(),
  client_id: text().notNull(),
  capability_identity: text().notNull(),
  capability_version: text().notNull(),
  input: jsonb().notNull(),
  targets: jsonb().notNull(),
  preview: jsonb().notNull(),
  plan: jsonb(),
  policy_class: text({ enum: policyClasses }).notNull(),
  commit_token_hash: text().notNull(),
  status: text({ enum: intentStatuses }).notNull(),
  created_at: timestamptz().notNull(),
  expires_at: timestamptz().notNull(),
  receipt: jsonb(),
}, table => [
  check("intents_policy_class_check", sql`${table.policy_class} in (${literals(policyClasses)})`),
  check("intents_commit_token_hash_check", sql`${table.commit_token_hash} ~ '^[0-9a-f]{64}$'`),
  check("intents_status_check", sql`${table.status} in (${literals(intentStatuses)})`),
  check("intents_check", sql`${table.expires_at} > ${table.created_at}`),
  check("intents_check1", sql`(${table.status} = 'committed') = (${table.receipt} is not null)`),
])
