import type { SQL } from "bun"

/** What an evidence event records. */
export type EvidenceKind =
  | "capability.requested" | "capability.completed" | "capability.denied" | "intent.prepared" | "intent.approval_requested" | "intent.approved"
  | "intent.denied" | "intent.committed" | "intent.stale" | "intent.expired" | "receipt.issued" | "operation.started" | "operation.finished"
  | "run.started" | "run.finished" | "limit.refused"

/** One event, as the caller gives it; the chain adds `id`, `seq`, `occurred_at` and the hashes. Never inputs, results or secrets. */
export type EvidenceEvent = {
  organisation_id: string
  kind: EvidenceKind
  actor_type: "user"
  actor_id: string
  outcome: "success" | "failure" | "denied"
  on_behalf_of?: string
  client_id?: string
  capability_identity?: string
  capability_version?: string
  execution_id?: string
  intent_id?: string
  receipt_id?: string
  operation_id?: string
  upstream?: string
  target_type?: string
  target_id?: string
  reason?: string
  error_code?: string
  request_id?: string
  trace_id?: string
  span_id?: string
  /** Bounded facts about the event, at most 4 KiB of JSON. */
  data?: Record<string, unknown>
  /** An erasable body, such as a preview, stored beside the chain; the chain holds only its hash. */
  payload?: Record<string, unknown>
}

const genesis = "0".repeat(64)
const batch = 1000
// The chained fields, in the order of the byte layout in migrations/0002_evidence.sql.
const chained = [
  "schema_version", "organisation_id", "seq", "id", "occurred_at", "kind", "actor_type", "actor_id", "on_behalf_of", "client_id", "capability_identity",
  "capability_version", "execution_id", "intent_id", "receipt_id", "operation_id", "upstream", "target_type", "target_id", "outcome", "reason", "error_code",
  "request_id", "trace_id", "span_id", "data", "payload_ref", "payload_hash",
] as const
type Row = Record<(typeof chained)[number] | "prev_hash" | "row_hash", string | null>
const field = (value: string | null) => value === null ? "~" : `${Buffer.byteLength(value)}:${value}`
const rowHash = (row: Row) => new Bun.CryptoHasher("sha256").update(row.prev_hash + chained.map(name => field(row[name])).join("")).digest("hex")

/** An MCP server's evidence: `record` appends to an organisation's chain, `verify` recomputes it, `erase` removes a payload's body. */
export function createEvidence(db: SQL) {
  return {
    /** Append an event to its organisation's chain; the database assigns its `seq` and hashes. */
    async record({ payload, data = {}, ...fields }: EvidenceEvent): Promise<{ id: string; seq: number; payload_ref: string | null }> {
      return db.begin(async tx => {
        const row: Record<string, unknown> = { id: Bun.randomUUIDv7(), ...fields, data }
        if (payload) {
          const [stored] = await tx`insert into evidence_payloads (id, organisation_id, body, hash)
            select ${Bun.randomUUIDv7()}, ${fields.organisation_id}, body, encode(sha256(convert_to(body::text, 'UTF8')), 'hex') from (select ${payload}::jsonb as body) as payload
            returning id, hash`
          Object.assign(row, { payload_ref: stored.id, payload_hash: stored.hash })
        }
        const [event] = await tx`insert into evidence_events ${tx(row)} returning id, seq::int as seq, payload_ref`
        return event
      })
    },
    /** Walk an organisation's chain in `seq` order, recomputing every hash. `length` counts the events checked; `broken_at` is the first that fails. */
    async verify(organisationId: string): Promise<{ ok: true; length: number } | { ok: false; length: number; broken_at: number }> {
      let previous = genesis
      let length = 0
      for (;;) {
        const rows: (Row & { seq: string })[] = await db`
          select prev_hash, row_hash, schema_version::text as schema_version, organisation_id::text as organisation_id, seq::text as seq, id::text as id,
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at, kind, actor_type, actor_id, on_behalf_of, client_id,
            capability_identity, capability_version, execution_id::text as execution_id, intent_id::text as intent_id, receipt_id::text as receipt_id,
            operation_id::text as operation_id, upstream, target_type, target_id, outcome, reason, error_code, request_id, trace_id, span_id,
            data::text as data, payload_ref::text as payload_ref, payload_hash
          from evidence_events where organisation_id = ${organisationId} and evidence_events.seq > ${length} order by evidence_events.seq limit ${batch}`
        for (const row of rows) {
          length++
          if (Number(row.seq) !== length || row.prev_hash !== previous || row.row_hash !== rowHash(row)) return { ok: false, length, broken_at: Number(row.seq) }
          previous = row.row_hash!
        }
        if (rows.length < batch) return { ok: true, length }
      }
    },
    /** Remove a payload's body for good; its hash stays, so the chain still verifies. */
    async erase(payloadId: string) {
      await db`update evidence_payloads set body = null, erased_at = now() where id = ${payloadId} and erased_at is null`
    },
  }
}
