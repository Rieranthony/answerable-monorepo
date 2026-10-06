import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Intent, Receipt } from "@answerable/mcp"
import { createPostgresIntentStore } from "./intents"
import { migrate, migrations } from "./migrate"
import { database } from "./test/database"

const db = database.connect()
beforeAll(() => migrate(db, [migrations]))
afterAll(() => db.close())

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
  const store = createPostgresIntentStore(db)
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
  const store = createPostgresIntentStore(db)
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
  const store = createPostgresIntentStore(db)
  const stored = intent()
  await store.insert(stored)
  const results = await Promise.all([store.transition(stored.intent_id, "prepared", "committing"), store.transition(stored.intent_id, "prepared", "committing")])
  expect(results.toSorted()).toEqual([false, true])
  expect((await store.get(stored.intent_id))!.status).toBe("committing")
})

test("with an injected clock, get and transition mark an intent expired once expires_at has passed; expire returns the intent it expired", async () => {
  let clock = Date.parse("2026-09-29T12:00:00.000Z")
  const store = createPostgresIntentStore(db, { now: () => clock })
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
  expect(await store.expire(waiting.intent_id)).toEqual({ ...waiting, status: "expired" })
  expect(await store.expire(waiting.intent_id)).toBeUndefined()
  expect((await store.get(running.intent_id))!.status).toBe("committing")
})

test("without an injected clock, expiry follows the database's clock", async () => {
  const store = createPostgresIntentStore(db)
  expect(Math.abs(store.now() - Date.now())).toBeLessThan(1000)
  const [{ now }] = await db`select now()`
  const past = intent({ expires_at: new Date(now.getTime() - 1).toISOString() }, now.getTime() - minute)
  const future = intent({ expires_at: new Date(now.getTime() + minute).toISOString() })
  for (const stored of [past, future]) await store.insert(stored)
  expect((await store.get(past.intent_id))!.status).toBe("expired")
  expect((await store.get(future.intent_id))!.status).toBe("prepared")
})

test("read and move skip expiry: they show and move an intent past expires_at as it is stored", async () => {
  let clock = Date.now()
  const store = createPostgresIntentStore(db, { now: () => clock })
  const stored = intent({}, clock)
  await store.insert(stored)
  clock += 30 * minute
  expect((await store.read(stored.intent_id))!.status).toBe("prepared")
  expect(await store.move(stored.intent_id, "prepared", "committing")).toEqual({ ...stored, status: "committing" })
  expect(await store.move(stored.intent_id, "prepared", "committing")).toBeUndefined()
  expect(await store.read(Bun.randomUUIDv7())).toBeUndefined()
})

test("the table refuses an intent that expires before it was created, and a commit token hash that is not lower-case SHA-256 hex", async () => {
  const store = createPostgresIntentStore(db)
  const at = Date.now()
  await expect(store.insert(intent({ expires_at: new Date(at).toISOString() }, at))).rejects.toThrow('violates check constraint "intents_check"')
  for (const commit_token_hash of ["A".repeat(64), "a".repeat(63), `act_${"a".repeat(60)}`]) {
    await expect(store.insert(intent({ commit_token_hash }))).rejects.toThrow('violates check constraint "intents_commit_token_hash_check"')
  }
})

test("an insert sweeps the table at most once a minute: what can no longer be committed leaves it, and a committed intent a day after its commit", async () => {
  const start = Date.now()
  let clock = start
  const store = createPostgresIntentStore(db, { now: () => clock })
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
  const present = async () => (await Promise.all(mine.map(item => store.read(item.intent_id)))).map(item => item?.status ?? null)
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
