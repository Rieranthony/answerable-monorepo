import { expect, test } from "bun:test"
import { createMemoryIntentStore, type Intent, type Receipt } from "./index"

const principal = { user_id: crypto.randomUUID(), membership_id: crypto.randomUUID(), client_id: "test" }
function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    intent_id: Bun.randomUUIDv7(), organisation_id: crypto.randomUUID(), principal,
    capability_identity: "test/records.delete", capability_version: "2026-09-29", input: { id: "r1" },
    targets: [{ resource_type: "record", resource_id: "r1", label: "First", version: { kind: "serial", value: "1" } }],
    preview: { summary: "Delete record “First”", changes: [{ path: "records[r1]", from: { title: "First" }, to: null }], effects: [], warnings: [], quantities: [] },
    plan: { id: "r1" }, policy_class: "controlled", approval: { required: false, status: "not_required" },
    commit_token_hash: "0".repeat(64), status: "prepared",
    created_at: new Date(0).toISOString(), expires_at: new Date(1000).toISOString(),
    ...overrides,
  }
}
const receipt = (intent_id: string): Receipt => ({
  receipt_id: Bun.randomUUIDv7(), intent_id, status: "committed", results: { deleted: true },
  applied_changes: [], effects_performed: [], committed_at: new Date(500).toISOString(),
  committed_by: principal, idempotent_replay: false,
})

test("insert and get keep a JSON copy, and the store's clock defaults to Date.now", async () => {
  const store = createMemoryIntentStore()
  const before = Date.now()
  expect(store.now()).toBeGreaterThanOrEqual(before)
  const stored = intent({ expires_at: new Date(Date.now() + 60_000).toISOString(), plan: { id: "r1", at: new Date(0) } })
  await store.insert(stored)
  stored.status = "committed"
  const read = (await store.get(stored.intent_id))!
  expect(read).toEqual({ ...stored, status: "prepared", plan: { id: "r1", at: "1970-01-01T00:00:00.000Z" } })
  read.status = "failed"
  expect((await store.get(stored.intent_id))!.status).toBe("prepared")
  expect(await store.get(Bun.randomUUIDv7())).toBeUndefined()
})

test("the store decides expiry: a prepared or awaiting intent past expires_at is returned and kept as expired", async () => {
  let clock = 999
  const store = createMemoryIntentStore({ now: () => clock })
  expect(store.now()).toBe(999)
  const prepared = intent()
  const awaiting = intent({ status: "awaiting_approval", approval: { required: true, status: "pending" }, policy_class: "human" })
  const committed = intent({ status: "committed" })
  for (const item of [prepared, awaiting, committed]) await store.insert(item)
  expect((await store.get(prepared.intent_id))!.status).toBe("prepared")
  clock = 1000
  expect((await store.get(prepared.intent_id))!.status).toBe("expired")
  expect(await store.transition(awaiting.intent_id, "awaiting_approval", "committing")).toBe(false)
  expect((await store.get(awaiting.intent_id))!.status).toBe("expired")
  expect((await store.get(committed.intent_id))!.status).toBe("committed")
  clock = 0
  expect((await store.get(prepared.intent_id))!.status).toBe("expired")
})

test("transition moves only from the expected status, and the receipt is stored once", async () => {
  const store = createMemoryIntentStore({ now: () => 0 })
  const stored = intent()
  await store.insert(stored)
  expect(await store.transition(stored.intent_id, "committing", "committed")).toBe(false)
  expect(await store.transition(Bun.randomUUIDv7(), "prepared", "committing")).toBe(false)
  expect(await store.transition(stored.intent_id, "prepared", "committing")).toBe(true)
  expect(await store.transition(stored.intent_id, "prepared", "committing")).toBe(false)
  const first = receipt(stored.intent_id)
  expect(await store.transition(stored.intent_id, "committing", "committed", first)).toBe(true)
  expect(await store.transition(stored.intent_id, "committing", "committed", receipt(stored.intent_id))).toBe(false)
  expect(await store.get(stored.intent_id)).toEqual({ ...stored, status: "committed", receipt: first })
})

test("an insert sweeps the store at most once a minute: expired, failed and stale intents leave it, and a committed one a day after its commit", async () => {
  let clock = 0
  const store = createMemoryIntentStore({ now: () => clock })
  const day = 86_400_000
  const open = intent({ expires_at: new Date(2 * day).toISOString() })
  const lapsed = intent()
  const waiting = intent({ status: "awaiting_approval", approval: { required: true, status: "pending" }, policy_class: "human" })
  const settled = (["expired", "failed", "stale"] as const).map(status => intent({ status }))
  const running = intent({ status: "committing" })
  const committed = intent({ status: "committed" })
  committed.receipt = receipt(committed.intent_id)
  for (const item of [open, lapsed, waiting, ...settled, running, committed]) await store.insert(item)
  const present = async () => (await Promise.all([open, lapsed, waiting, ...settled, running, committed].map(item => store.get(item.intent_id)))).map(item => item?.status ?? null)
  clock = 59_999
  await store.insert(intent({ expires_at: new Date(2 * day).toISOString() }))
  expect(await present()).toEqual(["prepared", "expired", "expired", "expired", "failed", "stale", "committing", "committed"])
  clock = 60_000
  await store.insert(intent({ expires_at: new Date(2 * day).toISOString() }))
  expect(await present()).toEqual(["prepared", null, null, null, null, null, "committing", "committed"])
  clock = 500 + day
  await store.insert(intent({ expires_at: new Date(2 * day).toISOString() }))
  expect(await present()).toEqual(["prepared", null, null, null, null, null, "committing", null])
})
