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
  const { id } = await evidence.record(event(organisation, {
    actor_id: "user-1", client_id: "claude-code", capability_identity: "e2e/records.list", capability_version: "2026-09-29",
    execution_id: "0199a0d2-6f00-7000-8000-000000000001", request_id: "7", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7",
    reason: "café ☕", data: { result_bytes: 42 },
  }))
  const [row] = await db`select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at, row_hash from evidence_events where id = ${id}`
  const field = (value: string | null) => value === null ? "~" : `${Buffer.byteLength(value)}:${value}`
  const text = "0".repeat(64) + [
    "1", organisation, "1", id, row.occurred_at, "capability.completed", "user", "user-1", null, "claude-code", "e2e/records.list", "2026-09-29",
    "0199a0d2-6f00-7000-8000-000000000001", null, null, null, null, null, null, "success", "café ☕", null, "7",
    "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", '{"result_bytes": 42}', null, null,
  ].map(field).join("")
  expect(text).toContain("9:café ☕")
  expect(row.row_hash).toBe(sha256(text))
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
      || evidence_field(actor_id) || evidence_field(on_behalf_of) || evidence_field(client_id) || evidence_field(capability_identity)
      || evidence_field(capability_version) || evidence_field(execution_id::text) || evidence_field(intent_id::text) || evidence_field(receipt_id::text)
      || evidence_field(operation_id::text) || evidence_field(upstream) || evidence_field(target_type) || evidence_field(target_id) || evidence_field(outcome)
      || evidence_field(reason) || evidence_field(error_code) || evidence_field(request_id) || evidence_field(trace_id) || evidence_field(span_id)
      || evidence_field(data::text) || evidence_field(payload_ref::text) || evidence_field(payload_hash), 'UTF8')), 'hex')
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

test("data is an object of at most 4 KiB", async () => {
  await expect(evidence.record(event(crypto.randomUUID(), { data: { note: "x".repeat(4100) } }))).rejects.toThrow()
})
