import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Intent, Receipt } from "@answerable/mcp"
import { createEvidence } from "./evidence"
import { createPostgresIntentStore } from "./intents"
import { migrate, migrations } from "./migrate"
import { database } from "./test/database"

const db = database.connect()
const evidence = createEvidence(db)
beforeAll(() => migrate(db, [migrations]))
afterAll(() => db.close())
const openStore = (now?: () => number) => createPostgresIntentStore(db, evidence, { now })

const minute = 60_000
function intent(overrides: Partial<Intent> = {}, now = Date.now()): Intent {
  return {
    intent_id: Bun.randomUUIDv7(), organisation_id: crypto.randomUUID(),
    principal: { user_id: crypto.randomUUID(), membership_id: crypto.randomUUID(), client_id: "claude-code" },
    capability_identity: "e2e/records.delete", capability_version: "2026-09-29",
    input: { id: "5b0e", nested: { tags: ["a", "é"], count: 2, flag: false, none: null } },
    targets: [{ resource_type: "record", resource_id: "5b0e", label: "Q3 plan", version: { kind: "serial", value: "1" } }],
    preview: { summary: "Delete record “Q3 plan”", changes: [{ path: "records[5b0e]", from: { title: "Q3 plan" }, to: null }], effects: ["cascade_delete"], warnings: ["Links break"], quantities: [{ name: "records", value: 1, unit: "record" }] },
    plan: { id: "5b0e" }, policy_class: "controlled",
    commit_token_hash: "a".repeat(64), status: "prepared", created_at: new Date(now).toISOString(), expires_at: new Date(now + 30 * minute).toISOString(),
    ...overrides,
  }
}
const receipt = (stored: Intent): Receipt => ({
  receipt_id: Bun.randomUUIDv7(), intent_id: stored.intent_id, status: "committed", results: { deleted: true, id: "5b0e" },
  applied_changes: stored.preview.changes, effects_performed: ["cascade_delete"], committed_at: new Date().toISOString(),
  committed_by: stored.principal, idempotent_replay: false,
})

test("an intent comes back as it went in, every JSON field included; plan and receipt only when present; an unknown id is undefined", async () => {
  const store = openStore()
  for (const plan of [{ id: "5b0e", steps: [1, "two", { three: true }] }, null, 7, "text", [1, 2], undefined]) {
    const stored = intent({ plan })
    if (plan === undefined) delete stored.plan
    await store.insert(stored)
    expect(await store.get(stored.intent_id)).toEqual(stored)
    expect(Object.hasOwn((await store.get(stored.intent_id))!, "plan")).toBe(plan !== undefined)
  }
  const human = intent({ policy_class: "human", status: "awaiting_approval" })
  await store.insert(human)
  expect(await store.get(human.intent_id)).toEqual(human)
  expect(await store.get(Bun.randomUUIDv7())).toBeUndefined()
})

test("transition moves an intent only from the status it names, and stores the receipt with committed", async () => {
  const store = openStore()
  const stored = intent()
  await store.insert(stored)
  expect(await store.transition(stored.intent_id, "prepared", "committing")).toBe(true)
  expect(await store.transition(stored.intent_id, "prepared", "committing")).toBe(false)
  const issued = receipt(stored)
  expect(await store.transition(stored.intent_id, "committing", "committed", issued)).toBe(true)
  expect(await store.get(stored.intent_id)).toEqual({ ...stored, status: "committed", receipt: issued })
  expect(await store.transition(Bun.randomUUIDv7(), "prepared", "committing")).toBe(false)
})

test("of two concurrent transitions from one status, exactly one wins", async () => {
  const store = openStore()
  const stored = intent()
  await store.insert(stored)
  const results = await Promise.all([store.transition(stored.intent_id, "prepared", "committing"), store.transition(stored.intent_id, "prepared", "committing")])
  expect(results.toSorted()).toEqual([false, true])
  expect((await store.get(stored.intent_id))!.status).toBe("committing")
})

test("with an injected clock, get and transition mark a prepared or waiting intent expired once expires_at has passed", async () => {
  let clock = Date.parse("2026-09-29T12:00:00.000Z")
  const store = openStore(() => clock)
  expect(store.now()).toBe(clock)
  const [read, claimed, waiting, running] = [intent({}, clock), intent({}, clock), intent({ status: "awaiting_approval" }, clock), intent({}, clock)]
  for (const stored of [read, claimed, waiting, running]) await store.insert(stored)
  await store.transition(running.intent_id, "prepared", "committing")
  clock += 30 * minute - 1
  expect((await store.get(read.intent_id))!.status).toBe("prepared")
  clock += 1
  expect((await store.get(read.intent_id))!.status).toBe("expired")
  expect(await store.transition(claimed.intent_id, "prepared", "committing")).toBe(false)
  expect((await store.get(claimed.intent_id))!.status).toBe("expired")
  expect(await store.get(waiting.intent_id)).toEqual({ ...waiting, status: "expired" })
  expect((await store.get(running.intent_id))!.status).toBe("committing")
})

test("without an injected clock, expiry follows the database's clock", async () => {
  const store = openStore()
  expect(Math.abs(store.now() - Date.now())).toBeLessThan(1000)
  const [{ now }] = await db`select now()`
  const past = intent({ expires_at: new Date(now.getTime() - 1).toISOString() }, now.getTime() - minute)
  const future = intent({ expires_at: new Date(now.getTime() + minute).toISOString() })
  for (const stored of [past, future]) await store.insert(stored)
  expect((await store.get(past.intent_id))!.status).toBe("expired")
  expect((await store.get(future.intent_id))!.status).toBe("prepared")
})

test("the table refuses an intent that expires before it was created, and a commit token hash that is not lower-case SHA-256 hex", async () => {
  const store = openStore()
  const at = Date.now()
  await expect(store.insert(intent({ expires_at: new Date(at).toISOString() }, at))).rejects.toThrow('violates check constraint "intents_check"')
  for (const commit_token_hash of ["A".repeat(64), "a".repeat(63), `act_${"a".repeat(60)}`]) {
    await expect(store.insert(intent({ commit_token_hash }))).rejects.toThrow('violates check constraint "intents_commit_token_hash_check"')
  }
})

test("an insert sweeps the table at most once a minute: what can no longer be committed leaves it, and a committed intent a day after its commit", async () => {
  const start = Date.now()
  let clock = start
  const store = openStore(() => clock)
  const day = 86_400_000
  const later = (ms: number) => new Date(start + ms).toISOString()
  const open = intent({ expires_at: later(2 * day) }, start)
  const lapsed = intent({ expires_at: later(1000) }, start)
  const waiting = intent({ status: "awaiting_approval", policy_class: "human", expires_at: later(1000) }, start)
  const settled = (["expired", "failed", "stale"] as const).map(status => intent({ status }, start))
  const running = intent({ status: "committing" }, start)
  const committed = intent({ status: "committed" }, start)
  committed.receipt = { ...receipt(committed), committed_at: later(500) }
  const mine = [open, lapsed, waiting, ...settled, running, committed]
  for (const item of mine) await store.insert(item)
  // As stored, without expiring anything.
  const present = async () => Promise.all(mine.map(async item => (await db`select status from intents where intent_id = ${item.intent_id}`)[0]?.status ?? null))
  clock = start + 59_999
  await store.insert(intent({ expires_at: later(2 * day) }, start))
  expect(await present()).toEqual(["prepared", "prepared", "awaiting_approval", "expired", "failed", "stale", "committing", "committed"])
  clock = start + 60_000
  await store.insert(intent({ expires_at: later(2 * day) }, start))
  expect(await present()).toEqual(["prepared", null, null, null, null, null, "committing", "committed"])
  clock = start + 500 + day
  await store.insert(intent({ expires_at: later(2 * day) }, start))
  expect(await present()).toEqual(["prepared", null, null, null, null, null, "committing", null])
})

// Evidence: every step of an intent, in the organisation's chain.
const events = (organisation: string) => db`select kind, outcome, actor_id, client_id, capability_identity, capability_version, intent_id::text, receipt_id::text, data,
    payload_ref::text, payload_hash from evidence_events where organisation_id = ${organisation} order by seq`
const kinds = async (organisation: string) => (await events(organisation)).map((row: { kind: string }) => row.kind)
const expiries = async (organisation: string) => (await events(organisation)).filter((row: { kind: string }) => row.kind === "intent.expired").map((row: { intent_id: string }) => row.intent_id)

test("an intent's preparation is evidence: its preview stored beside the chain by hash, and a human-class intent's approval request", async () => {
  const store = openStore()
  const organisation = crypto.randomUUID()
  const agent = intent({ organisation_id: organisation })
  await store.insert(agent)
  const [prepared] = await events(organisation)
  expect(prepared).toEqual({
    kind: "intent.prepared", outcome: "success", actor_id: agent.principal.user_id, client_id: "claude-code", capability_identity: "e2e/records.delete",
    capability_version: "2026-09-29", intent_id: agent.intent_id, receipt_id: null, data: { policy_class: "controlled" },
    payload_ref: expect.any(String), payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
  expect<unknown>(await db`select body, hash from evidence_payloads where id = ${prepared.payload_ref}`).toEqual([{ body: agent.preview, hash: prepared.payload_hash }])
  await store.insert(intent({ organisation_id: organisation, policy_class: "human", status: "awaiting_approval" }))
  expect(await kinds(organisation)).toEqual(["intent.prepared", "intent.prepared", "intent.approval_requested"])
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 3 })
})

test("a commit is evidence when it ends committed, with the receipt, or stale; claiming and failing are the call's own evidence", async () => {
  const store = openStore()
  const organisation = crypto.randomUUID()
  const [committed, stale, failed] = [intent({ organisation_id: organisation }), intent({ organisation_id: organisation }), intent({ organisation_id: organisation })]
  for (const stored of [committed, stale, failed]) {
    await store.insert(stored)
    await store.transition(stored.intent_id, "prepared", "committing")
  }
  const issued = receipt(committed)
  await store.transition(committed.intent_id, "committing", "committed", issued)
  await store.transition(stale.intent_id, "committing", "stale")
  await store.transition(failed.intent_id, "committing", "failed")
  const rows = (await events(organisation)).slice(3)
  expect(rows.map((row: { kind: string; intent_id: string; receipt_id: string | null }) => [row.kind, row.intent_id, row.receipt_id])).toEqual([
    ["intent.committed", committed.intent_id, issued.receipt_id], ["receipt.issued", committed.intent_id, issued.receipt_id], ["intent.stale", stale.intent_id, null],
  ])
  expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 6 })
})

test("an expiry is evidence once, whether a read or a claim finds it", async () => {
  let clock = Date.now()
  const store = openStore(() => clock)
  const organisation = crypto.randomUUID()
  const [read, claimed] = [intent({ organisation_id: organisation }, clock), intent({ organisation_id: organisation }, clock)]
  for (const stored of [read, claimed]) await store.insert(stored)
  clock += 30 * minute
  expect((await store.get(read.intent_id))!.status).toBe("expired")
  expect((await store.get(read.intent_id))!.status).toBe("expired")
  expect(await store.transition(claimed.intent_id, "prepared", "committing")).toBe(false)
  expect(await expiries(organisation)).toEqual([read.intent_id, claimed.intent_id])
})

test("each call reads the clock once: an intent whose expiry falls between two reads is expired by the next call, and recorded once", async () => {
  let clock = Date.now()
  let ticking = false
  // Once ticking, every read of the clock moves it on by 1 ms, so that a call reading it twice would see two times.
  const store = openStore(() => (ticking ? clock++ : clock))
  const organisation = crypto.randomUUID()
  const [read, claimed] = [intent({ organisation_id: organisation }, clock), intent({ organisation_id: organisation }, clock)]
  for (const stored of [read, claimed]) await store.insert(stored)
  ticking = true
  clock = Date.parse(read.expires_at) - 1
  expect((await store.get(read.intent_id))!.status).toBe("prepared")
  expect((await store.get(read.intent_id))!.status).toBe("expired")
  expect((await store.get(read.intent_id))!.status).toBe("expired")
  clock = Date.parse(claimed.expires_at) - 1
  expect(await store.transition(claimed.intent_id, "prepared", "committing")).toBe(true)
  expect(await expiries(organisation)).toEqual([read.intent_id])
})

test("a transition the store refuses writes no evidence", async () => {
  const store = openStore()
  const organisation = crypto.randomUUID()
  const stored = intent({ organisation_id: organisation })
  await store.insert(stored)
  expect(await store.transition(stored.intent_id, "committing", "stale")).toBe(false)
  expect(await store.transition(Bun.randomUUIDv7(), "committing", "committed")).toBe(false)
  expect(await kinds(organisation)).toEqual(["intent.prepared"])
})
