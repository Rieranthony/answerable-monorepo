import type { SQL } from "bun"

/** What an evidence event records. */
type EvidenceKind =
  | "capability.completed" | "capability.denied" | "intent.prepared" | "intent.approval_requested" | "intent.committed" | "intent.stale"
  | "intent.expired" | "receipt.issued"

/** One event, as the caller gives it; the chain adds `id`, `seq`, `occurred_at` and the hashes. Never inputs, results or secrets. */
export type EvidenceEvent = {
  organisation_id: string
  kind: EvidenceKind
  actor_type: "user"
  actor_id: string
  outcome: "success" | "failure" | "denied"
  client_id?: string
  capability_identity?: string
  capability_version?: string
  execution_id?: string
  intent_id?: string
  receipt_id?: string
  upstream?: string
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
// The chained fields, in the order of the byte layout in migrations/0001_evidence.sql.
const chained = [
  "schema_version", "organisation_id", "seq", "id", "occurred_at", "kind", "actor_type", "actor_id", "client_id", "capability_identity", "capability_version",
  "execution_id", "intent_id", "receipt_id", "upstream", "outcome", "reason", "error_code", "request_id", "trace_id", "span_id", "data", "payload_ref",
  "payload_hash",
] as const
// Each event with its payload's row, when it has one: whether the row exists, its stored hash, and its body as Postgres prints it, null once erased.
type Row = Record<(typeof chained)[number] | "prev_hash" | "row_hash" | "stored_hash" | "body", string | null> & { stored: boolean }
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const field = (value: string | null) => value === null ? "~" : `${Buffer.byteLength(value)}:${value}`
const rowHash = (row: Row) => sha256(row.prev_hash + chained.map(name => field(row[name])).join(""))
// A referenced payload must still exist, and an unerased body must hash to what its row and the chain hold.
const payloadHolds = (row: Row) => row.payload_ref === null || (row.stored && (row.body === null || (sha256(row.body) === row.stored_hash && row.stored_hash === row.payload_hash)))

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
    /**
     * Walk an organisation's chain in `seq` order, recomputing every hash, and each unerased payload's hash from its body. `length` counts the
     * events checked; `broken_at` is the first that fails.
     */
    async verify(organisationId: string): Promise<{ ok: true; length: number } | { ok: false; length: number; broken_at: number }> {
      let previous = genesis
      let length = 0
      for (;;) {
        const rows: (Row & { seq: string })[] = await db`
          select event.prev_hash, event.row_hash, event.schema_version::text as schema_version, event.organisation_id::text as organisation_id,
            event.seq::text as seq, event.id::text as id, to_char(event.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
            event.kind, event.actor_type, event.actor_id, event.client_id, event.capability_identity, event.capability_version,
            event.execution_id::text as execution_id, event.intent_id::text as intent_id, event.receipt_id::text as receipt_id, event.upstream, event.outcome,
            event.reason, event.error_code, event.request_id, event.trace_id, event.span_id, event.data::text as data, event.payload_ref::text as payload_ref,
            event.payload_hash, payload.id is not null as stored, payload.hash as stored_hash, payload.body::text as body
          from evidence_events as event left join evidence_payloads as payload on payload.id = event.payload_ref
          where event.organisation_id = ${organisationId} and event.seq > ${length} order by event.seq limit ${batch}`
        for (const row of rows) {
          length++
          if (Number(row.seq) !== length || row.prev_hash !== previous || row.row_hash !== rowHash(row) || !payloadHolds(row)) return { ok: false, length, broken_at: Number(row.seq) }
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
