import { expect, spyOn, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import type { GrantsReader } from "./grants"
import { startGrantsPoller } from "./poller"

function setup(intervalMs = 60_000) {
  const id = createFakeId()
  const invalidated: string[][] = []
  const grants: GrantsReader = { read: async () => [], invalidate: organisations => { invalidated.push([...organisations].sort()) } }
  return { id, invalidated, start: () => startGrantsPoller({ id: createIdAdmin(id.config), grants, intervalMs }) }
}

test("the first poll only records the newest event; later polls invalidate the organisations whose grants may have changed", async () => {
  const { id, invalidated, start } = setup()
  const [alpha, beta, gamma] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort()
  id.event("entitlement.created", gamma)
  const poller = start()
  // The poll started with the poller, then this one: neither sees an event newer than the first.
  await poller.poll()
  expect(invalidated).toEqual([[], []])
  for (const [action, organisation] of [
    ["entitlement.updated", alpha], ["group_member.added", beta], ["group.disabled", alpha], ["member.removed", alpha], ["organization.disabled", beta],
    ["client.created", gamma], ["session.revoked", gamma], ["entitlement.removed", null],
  ] as const) id.event(action, organisation)
  await poller.poll()
  expect(invalidated.at(-1)).toEqual([alpha, beta])
  await poller.poll()
  expect(invalidated.at(-1)).toEqual([])
  poller.stop()
})

test("a poll pages back through more than 200 events until it meets the last one seen", async () => {
  const { id, invalidated, start } = setup()
  const poller = start()
  await poller.poll()
  const organisations = Array.from({ length: 250 }, () => crypto.randomUUID())
  for (const organisation of organisations) id.event("entitlement.created", organisation)
  await poller.poll()
  expect(invalidated.at(-1)).toEqual(organisations.toSorted())
  expect(id.requests.filter(request => request.includes("/audit-events")).at(-1)).toMatch(/^GET \/api\/admin\/v1\/audit-events\?limit=200&cursor=[0-9a-f-]{36}$/)
  poller.stop()
})

test("an ID failure is logged and the next poll catches up", async () => {
  const { id, invalidated, start } = setup()
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const poller = start()
    await poller.poll()
    const organisation = crypto.randomUUID()
    id.event("entitlement.created", organisation)
    id.outage(true)
    await poller.poll()
    expect(log.mock.calls[0]![0]).toBe("[toolbox] reading ID's audit log failed")
    id.outage(false)
    await poller.poll()
    expect(invalidated.at(-1)).toEqual([organisation])
    poller.stop()
  } finally { log.mockRestore() }
})

test("it polls every intervalMs, one poll at a time, until stopped", async () => {
  const { id, start } = setup(20)
  id.slow(30)
  const poller = start()
  await Bun.sleep(150)
  poller.stop()
  const polls = id.requests.filter(request => request.includes("/audit-events")).length
  expect(polls).toBeGreaterThanOrEqual(2)
  expect(polls).toBeLessThanOrEqual(6)
  await Bun.sleep(100)
  expect(id.requests.filter(request => request.includes("/audit-events")).length).toBeLessThanOrEqual(polls + 1)
})
