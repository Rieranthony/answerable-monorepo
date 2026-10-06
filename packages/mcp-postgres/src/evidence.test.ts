import { afterAll, beforeAll, expect, test } from "bun:test"
import { createEvidence, type EvidenceEvent } from "./evidence"
import { migrate, migrations } from "./migrate"
import { database } from "./test/database"

const db = database.connect()
const evidence = createEvidence(db)
beforeAll(() => migrate(db, [migrations]))
afterAll(() => db.close())

const event = (organisation_id: string, overrides: Partial<EvidenceEvent> = {}): EvidenceEvent => ({
  organisation_id, kind: "capability.completed", actor_type: "user", actor_id: crypto.randomUUID(), outcome: "success", ...overrides,
})
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
// A Bun.sql query runs when awaited, which expect(...).rejects does not do.
const run = async (query: PromiseLike<unknown>) => { await query }

test("each organisation's events form a chain: seq from 1, each prev_hash the row_hash before it", async () => {
  const [alpha, beta] = [crypto.randomUUID(), crypto.randomUUID()]
  for (const organisation of [alpha, beta, alpha, alpha]) await evidence.record(event(organisation))
  const rows = await db`select seq::int, prev_hash, row_hash from evidence_events where organisation_id = ${alpha} order by seq`
  expect(rows.map((row: { seq: number }) => row.seq)).toEqual([1, 2, 3])
  expect(rows[0].prev_hash).toBe("0".repeat(64))
  expect(rows[1].prev_hash).toBe(rows[0].row_hash)
  expect(rows[2].prev_hash).toBe(rows[1].row_hash)
  expect(await evidence.verify(alpha)).toEqual({ ok: true, length: 3 })
  expect(await evidence.verify(beta)).toEqual({ ok: true, length: 1 })
  expect(await evidence.verify(crypto.randomUUID())).toEqual({ ok: true, length: 0 })
})

test("row_hash is SHA-256 over prev_hash and each field as its byte length, a colon and its text, or ~ for null", async () => {
  const organisation = crypto.randomUUID()
  const fields = {
    actor_id: "user-1", client_id: "claude-code", capability_identity: "e2e/records.delete", capability_version: "2026-09-29",
    execution_id: "0199a0d2-6f00-7000-8000-000000000001", intent_id: "0199a0d2-6f00-7000-8000-000000000002", receipt_id: "0199a0d2-6f00-7000-8000-000000000003",
    upstream: "id", outcome: "failure", reason: "café ☕", error_code: "UPSTREAM_REJECTED", request_id: "7", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7", data: { result_bytes: 42 },
  } as const
  const { id, payload_ref } = await evidence.record(event(organisation, { ...fields, kind: "intent.committed", payload: { summary: "Delete" } }))
  const [row] = await db`select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at, payload_hash, row_hash from evidence_events where id = ${id}`
  const field = (value: string | null) => value === null ? "~" : `${Buffer.byteLength(value)}:${value}`
  const text = "0".repeat(64) + [
    "1", organisation, "1", id, row.occurred_at, "intent.committed", "user", "user-1", "claude-code", "e2e/records.delete", "2026-09-29",
    fields.execution_id, fields.intent_id, fields.receipt_id, "id", "failure", "café ☕", "UPSTREAM_REJECTED", "7", fields.trace_id, fields.span_id,
    '{"result_bytes": 42}', payload_ref, row.payload_hash,
  ].map(field).join("")
  expect(text).toContain("9:café ☕")
  expect(row.payload_hash).toBe(sha256('{"summary": "Delete"}'))
  expect(row.row_hash).toBe(sha256(text))
  // Every column but the two hashes is chained.
  const columns = await db`select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'evidence_events' order by column_name`
  expect(columns.map((row: { column_name: string }) => row.column_name)).toEqual([
    "actor_id", "actor_type", "capability_identity", "capability_version", "client_id", "data", "error_code", "execution_id", "id", "intent_id", "kind",
    "occurred_at", "organisation_id", "outcome", "payload_hash", "payload_ref", "prev_hash", "reason", "receipt_id", "request_id", "row_hash",
    "schema_version", "seq", "span_id", "trace_id", "upstream",
  ])
})

test("concurrent events of one organisation still form one gapless chain", async () => {
  const organisation = crypto.randomUUID()
  await Promise.all(Array.from({ length: 20 }, () => evidence.record(event(organisation))))
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 20 })
})

test("verify reads a chain longer than one batch", async () => {
  const organisation = crypto.randomUUID()
  await db`insert into evidence_events (id, organisation_id, kind, actor_type, actor_id, outcome)
    select gen_random_uuid(), ${organisation}, 'capability.completed', 'user', 'bulk', 'success' from generate_series(1, 1001)`
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 1001 })
})

test("the trigger refuses updates, deletes and truncation", async () => {
  const organisation = crypto.randomUUID()
  await evidence.record(event(organisation))
  await expect(run(db`update evidence_events set outcome = 'failure' where organisation_id = ${organisation}`)).rejects.toThrow("evidence_events is append-only: UPDATE is refused")
  await expect(run(db`delete from evidence_events where organisation_id = ${organisation}`)).rejects.toThrow("evidence_events is append-only: DELETE is refused")
  await expect(run(db`truncate evidence_events`)).rejects.toThrow("evidence_events is append-only: TRUNCATE is refused")
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 1 })
})

test("verify names the first event whose fields, order or link no longer match", async () => {
  const organisation = crypto.randomUUID()
  for (let index = 0; index < 4; index++) await evidence.record(event(organisation))
  const tamper = await db.reserve()
  try {
    // A superuser can switch triggers off: what verify is for.
    await tamper`set session_replication_role = replica`
    await tamper`update evidence_events set outcome = 'failure' where organisation_id = ${organisation} and seq = 3`
    expect(await evidence.verify(organisation)).toEqual({ ok: false, length: 3, broken_at: 3 })
    await tamper`delete from evidence_events where organisation_id = ${organisation} and seq = 3`
    expect(await evidence.verify(organisation)).toEqual({ ok: false, length: 3, broken_at: 4 })
    await tamper`update evidence_events set prev_hash = ${"f".repeat(64)} where organisation_id = ${organisation} and seq = 2`
    expect(await evidence.verify(organisation)).toEqual({ ok: false, length: 2, broken_at: 2 })
  } finally {
    await tamper`set session_replication_role = origin`
    tamper.release()
  }
})

test("a row rewritten with its row_hash recomputed still breaks the chain at the next row", async () => {
  const organisation = crypto.randomUUID()
  for (let index = 0; index < 3; index++) await evidence.record(event(organisation))
  const tamper = await db.reserve()
  try {
    await tamper`set session_replication_role = replica`
    await tamper`update evidence_events set outcome = 'failure' where organisation_id = ${organisation} and seq = 2`
    // The trigger's own formula, so that the rewritten row verifies by itself.
    await tamper`update evidence_events set row_hash = encode(sha256(convert_to(prev_hash
      || evidence_field(schema_version::text) || evidence_field(organisation_id::text) || evidence_field(seq::text) || evidence_field(id::text)
      || evidence_field(to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || evidence_field(kind) || evidence_field(actor_type)
      || evidence_field(actor_id) || evidence_field(client_id) || evidence_field(capability_identity) || evidence_field(capability_version)
      || evidence_field(execution_id::text) || evidence_field(intent_id::text) || evidence_field(receipt_id::text) || evidence_field(upstream)
      || evidence_field(outcome) || evidence_field(reason) || evidence_field(error_code) || evidence_field(request_id) || evidence_field(trace_id)
      || evidence_field(span_id) || evidence_field(data::text) || evidence_field(payload_ref::text) || evidence_field(payload_hash), 'UTF8')), 'hex')
      where organisation_id = ${organisation} and seq = 2`
    expect(await evidence.verify(organisation)).toEqual({ ok: false, length: 3, broken_at: 3 })
  } finally {
    await tamper`set session_replication_role = origin`
    tamper.release()
  }
})

test("a payload is stored beside the chain by hash; erasing it keeps the chain valid", async () => {
  const organisation = crypto.randomUUID()
  const preview = { summary: "Delete record “Quarterly plan”", changes: [{ path: "records[1]", from: { title: "Quarterly plan" }, to: null }] }
  const { id, payload_ref } = await evidence.record(event(organisation, { kind: "intent.prepared", payload: preview }))
  const [stored] = await db`select body, hash, erased_at from evidence_payloads where id = ${payload_ref}`
  expect(stored).toEqual({ body: preview, hash: expect.stringMatching(/^[0-9a-f]{64}$/), erased_at: null })
  expect<unknown>(await db`select payload_hash from evidence_events where id = ${id}`).toEqual([{ payload_hash: stored.hash }])
  await evidence.record(event(organisation))
  await evidence.erase(payload_ref!)
  expect<unknown>(await db`select body, hash, erased_at is not null as erased from evidence_payloads where id = ${payload_ref}`).toEqual([{ body: null, hash: stored.hash, erased: true }])
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 2 })
})

test("a payload changes only by its erasure: other updates, deletes and truncation are refused", async () => {
  const organisation = crypto.randomUUID()
  const { payload_ref } = await evidence.record(event(organisation, { kind: "intent.prepared", payload: { summary: "Delete" } }))
  const refused = (tg_op: string) => `evidence_payloads only erases a body: ${tg_op} is refused`
  await expect(run(db`update evidence_payloads set body = '{"summary": "Keep"}' where id = ${payload_ref}`)).rejects.toThrow(refused("UPDATE"))
  await expect(run(db`update evidence_payloads set hash = ${"f".repeat(64)} where id = ${payload_ref}`)).rejects.toThrow(refused("UPDATE"))
  await expect(run(db`update evidence_payloads set body = null, erased_at = now(), hash = ${"f".repeat(64)} where id = ${payload_ref}`)).rejects.toThrow(refused("UPDATE"))
  await expect(run(db`delete from evidence_payloads where id = ${payload_ref}`)).rejects.toThrow(refused("DELETE"))
  await expect(run(db`truncate evidence_payloads cascade`)).rejects.toThrow(refused("TRUNCATE"))
  await evidence.erase(payload_ref!)
  await expect(run(db`update evidence_payloads set erased_at = now() where id = ${payload_ref}`)).rejects.toThrow(refused("UPDATE"))
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 1 })
})

test("verify names the first event whose payload's body no longer hashes to its hash, or whose payload is gone", async () => {
  const organisation = crypto.randomUUID()
  const refs: string[] = []
  for (let index = 0; index < 4; index++) refs.push((await evidence.record(event(organisation, { kind: "intent.prepared", payload: { summary: `Delete ${index}` } }))).payload_ref!)
  await evidence.erase(refs[1]!)
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 4 })
  const tamper = await db.reserve()
  try {
    await tamper`set session_replication_role = replica`
    // The body changed with its hash kept, the body and its hash changed together, and the payload deleted.
    await tamper`update evidence_payloads set body = '{"summary": "Keep 3"}' where id = ${refs[3]}`
    expect(await evidence.verify(organisation)).toEqual({ ok: false, length: 4, broken_at: 4 })
    await tamper`update evidence_payloads set body = '{"summary": "Keep 2"}', hash = encode(sha256(convert_to('{"summary": "Keep 2"}', 'UTF8')), 'hex') where id = ${refs[2]}`
    expect(await evidence.verify(organisation)).toEqual({ ok: false, length: 3, broken_at: 3 })
    await tamper`delete from evidence_payloads where id = ${refs[0]}`
    expect(await evidence.verify(organisation)).toEqual({ ok: false, length: 1, broken_at: 1 })
  } finally {
    await tamper`set session_replication_role = origin`
    tamper.release()
  }
})

test("the table refuses a kind nothing writes, and data that is not an object of at most 4 KiB", async () => {
  await expect(evidence.record(event(crypto.randomUUID(), { kind: "operation.started" as EvidenceEvent["kind"] }))).rejects.toThrow("evidence_events_kind_check")
  await expect(evidence.record(event(crypto.randomUUID(), { data: { note: "x".repeat(4100) } }))).rejects.toThrow("evidence_events_data_check")
})
