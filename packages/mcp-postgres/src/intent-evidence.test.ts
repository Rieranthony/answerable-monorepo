import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Intent } from "@answerable/mcp"
import { createEvidence } from "./evidence"
import { withEvidence } from "./intent-evidence"
import { createPostgresIntentStore } from "./intents"
import { migrate, migrations } from "./migrate"
import { database } from "./test/database"

const db = database.connect()
const evidence = createEvidence(db)
beforeAll(() => migrate(db, [migrations]))
afterAll(() => db.close())

function intent(organisation_id: string, overrides: Partial<Intent> = {}): Intent {
  const now = Date.now()
  return {
    intent_id: Bun.randomUUIDv7(), organisation_id, principal: { user_id: "user-1", membership_id: "membership-1", client_id: "claude-code" },
    capability_identity: "e2e/records.delete", capability_version: "2026-09-29", input: { id: "5b0e" }, targets: [],
    preview: { summary: "Delete record “Q3 plan”", changes: [{ path: "records[5b0e]", from: { title: "Q3 plan" }, to: null }], effects: [], warnings: [], quantities: [] },
    policy_class: "controlled", commit_token_hash: "a".repeat(64), status: "prepared",
    created_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(), ...overrides,
  }
}
const events = (organisation: string) => db`select kind, outcome, actor_id, client_id, capability_identity, capability_version, intent_id::text, receipt_id::text, data,
    payload_ref::text, payload_hash from evidence_events where organisation_id = ${organisation} order by seq`
const kinds = async (organisation: string) => (await events(organisation)).map((row: { kind: string }) => row.kind)
const setup = (now?: () => number) => withEvidence(createPostgresIntentStore(db, { now }), evidence)

test("an intent's preparation is evidence: its preview stored beside the chain by hash, and a human-class intent's approval request", async () => {
  const intents = setup()
  const organisation = crypto.randomUUID()
  const agent = intent(organisation)
  await intents.insert(agent)
  const [prepared] = await events(organisation)
  expect(prepared).toEqual({
    kind: "intent.prepared", outcome: "success", actor_id: "user-1", client_id: "claude-code", capability_identity: "e2e/records.delete",
    capability_version: "2026-09-29", intent_id: agent.intent_id, receipt_id: null, data: { policy_class: "controlled" },
    payload_ref: expect.any(String), payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
  expect<unknown>(await db`select body, hash from evidence_payloads where id = ${prepared.payload_ref}`).toEqual([{ body: agent.preview, hash: prepared.payload_hash }])
  await intents.insert(intent(organisation, { policy_class: "human", status: "awaiting_approval" }))
  expect(await kinds(organisation)).toEqual(["intent.prepared", "intent.prepared", "intent.approval_requested"])
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 3 })
})

test("a commit is evidence when it ends committed, with the receipt, or stale; claiming and failing are the call's own evidence", async () => {
  const intents = setup()
  const organisation = crypto.randomUUID()
  const [committed, stale, failed] = [intent(organisation), intent(organisation), intent(organisation)]
  for (const stored of [committed, stale, failed]) {
    await intents.insert(stored)
    await intents.transition(stored.intent_id, "prepared", "committing")
  }
  const receipt_id = Bun.randomUUIDv7()
  await intents.transition(committed.intent_id, "committing", "committed", {
    receipt_id, intent_id: committed.intent_id, status: "committed", results: {}, applied_changes: [], effects_performed: [],
    committed_at: new Date().toISOString(), committed_by: committed.principal, idempotent_replay: false,
  })
  await intents.transition(stale.intent_id, "committing", "stale")
  await intents.transition(failed.intent_id, "committing", "failed")
  const rows = (await events(organisation)).slice(3)
  expect(rows.map((row: { kind: string; intent_id: string; receipt_id: string | null }) => [row.kind, row.intent_id, row.receipt_id])).toEqual([
    ["intent.committed", committed.intent_id, receipt_id], ["receipt.issued", committed.intent_id, receipt_id], ["intent.stale", stale.intent_id, null],
  ])
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 6 })
})

test("an expiry is evidence once, whether a read or a claim finds it", async () => {
  let clock = Date.now()
  const intents = setup(() => clock)
  const organisation = crypto.randomUUID()
  const [read, claimed] = [intent(organisation), intent(organisation)]
  for (const stored of [read, claimed]) await intents.insert(stored)
  clock += 61_000
  expect((await intents.get(read.intent_id))!.status).toBe("expired")
  expect((await intents.get(read.intent_id))!.status).toBe("expired")
  expect(await intents.transition(claimed.intent_id, "prepared", "committing")).toBe(false)
  expect(await intents.now()).toBe(clock)
  const expired = (await events(organisation)).filter((row: { kind: string }) => row.kind === "intent.expired")
  expect(expired.map((row: { intent_id: string }) => row.intent_id)).toEqual([read.intent_id, claimed.intent_id])
})

test("each call reads the clock once: an intent whose expiry falls between two reads is expired by the next call, and recorded once", async () => {
  let clock = Date.now()
  let ticking = false
  // Once ticking, every read of the clock moves it on by 1 ms, so that a call reading it twice would see two times.
  const intents = setup(() => (ticking ? clock++ : clock))
  const organisation = crypto.randomUUID()
  const [read, claimed] = [intent(organisation), intent(organisation)]
  for (const stored of [read, claimed]) await intents.insert(stored)
  ticking = true
  clock = Date.parse(read.expires_at) - 1
  expect((await intents.get(read.intent_id))!.status).toBe("prepared")
  expect((await intents.get(read.intent_id))!.status).toBe("expired")
  expect((await intents.get(read.intent_id))!.status).toBe("expired")
  clock = Date.parse(claimed.expires_at) - 1
  expect(await intents.transition(claimed.intent_id, "prepared", "committing")).toBe(true)
  const expired = (await events(organisation)).filter((row: { kind: string }) => row.kind === "intent.expired")
  expect(expired.map((row: { intent_id: string }) => row.intent_id)).toEqual([read.intent_id])
})

test("a transition the store refuses writes no evidence", async () => {
  const intents = setup()
  const organisation = crypto.randomUUID()
  const stored = intent(organisation)
  await intents.insert(stored)
  expect(await intents.transition(stored.intent_id, "committing", "stale")).toBe(false)
  expect(await intents.transition(Bun.randomUUIDv7(), "committing", "committed")).toBe(false)
  expect(await kinds(organisation)).toEqual(["intent.prepared"])
})
