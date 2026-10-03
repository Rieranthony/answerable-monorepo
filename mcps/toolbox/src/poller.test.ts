import { expect, spyOn, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import type { GrantsReader } from "./grants"
import { organisationActions, startGrantsPoller, userActions } from "./poller"

function setup(intervalMs = 60_000) {
  const id = createFakeId()
  // What each poll invalidated: the organisations and the users, sorted.
  const invalidated: { organisations: string[]; users: string[] }[] = []
  const grants: GrantsReader = { read: async () => [], invalidate: (organisations, users = []) => { invalidated.push({ organisations: [...organisations].sort(), users: [...users].sort() }) } }
  return { id, invalidated, start: () => startGrantsPoller({ id: createIdAdmin(id.config), grants, intervalMs }) }
}

test("the first poll only records the newest event; later polls invalidate the organisations, and the users in every organisation, whose grants may have changed", async () => {
  const { id, invalidated, start } = setup()
  const [alpha, beta, gamma, delta] = Array.from({ length: 4 }, () => crypto.randomUUID()).sort()
  const [ada, grace, alan] = Array.from({ length: 3 }, () => crypto.randomUUID()).sort()
  const none = { organisations: [], users: [] }
  id.event("entitlement.created", gamma)
  const poller = start()
  // The poll started with the poller, then this one: neither sees an event newer than the first.
  await poller.poll()
  expect(invalidated).toEqual([none, none])
  for (const [action, organisation, targetId = null] of [
    ["entitlement.updated", alpha], ["group_member.added", beta], ["group.disabled", alpha], ["member.removed", alpha], ["organization.disabled", beta],
    ["capability.updated", delta], ["user.disabled", null, ada], ["user.erased", null, grace],
    ["client.created", gamma], ["session.revoked_all", null, alan], ["entitlement.removed", null],
  ] as const) id.event(action, organisation, { targetId })
  await poller.poll()
  expect(invalidated.at(-1)).toEqual({ organisations: [alpha, beta, delta], users: [ada, grace] })
  await poller.poll()
  expect(invalidated.at(-1)).toEqual(none)
  poller.stop()
})

test("a poll pages back through more than 200 events until it meets the last one seen", async () => {
  const { id, invalidated, start } = setup()
  const poller = start()
  await poller.poll()
  const organisations = Array.from({ length: 250 }, () => crypto.randomUUID())
  for (const organisation of organisations) id.event("entitlement.created", organisation)
  await poller.poll()
  expect(invalidated.at(-1)!.organisations).toEqual(organisations.toSorted())
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
    expect(invalidated.at(-1)!.organisations).toEqual([organisation])
    poller.stop()
  } finally { log.mockRestore() }
})

test("every action prefix the poller reads names audit actions Answerable ID emits, so that a family ID renames fails here", async () => {
  // ID's audit vocabulary as its source spells it: the "family.action" string literals of apps/id/src, its tests aside.
  const source = new URL("../../../apps/id/src/", import.meta.url).pathname
  const emitted = new Set<string>()
  for await (const file of new Bun.Glob("**/*.ts").scan(source)) {
    if (file.includes("test")) continue
    for (const [, literal] of (await Bun.file(`${source}${file}`).text()).matchAll(/"([a-z][a-z_]*\.[a-z][a-z_.]*)"/g)) emitted.add(literal!)
  }
  for (const prefix of [...organisationActions, ...userActions]) expect([...emitted].filter(action => action.startsWith(prefix)), prefix).not.toEqual([])
  expect([...emitted]).toEqual(expect.arrayContaining(["capability.updated", "entitlement.created", "group_member.added", "member.removed", "organization.disabled", "user.disabled", "user.erased"]))
})
