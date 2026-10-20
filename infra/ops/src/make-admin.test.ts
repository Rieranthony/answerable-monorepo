import { expect, test } from "bun:test"
import { makeAdmin } from "./make-admin"
import { fakeIdAdmin } from "./testing"

const MEMBER = "0190a000-0000-7000-8000-0000000000b1"

/** ID after register: the owner group exists, and the staff member has signed in once. */
function setup(options: Parameters<typeof fakeIdAdmin>[0] = {}, { signedIn = true, owners = true } = {}) {
  const id = fakeIdAdmin(options)
  if (owners) id.state.groups.set("answerable-owner", "0190a000-0000-7000-8000-0000000000a2")
  if (signedIn) id.state.members.set(MEMBER, "You@answerable.org")
  const lines: string[] = []
  const run = (email = "you@answerable.org") => makeAdmin({ id: "https://id.example", rootSecret: id.rootSecret, email, platformSlug: "answerable", fetch: id.fetch, log: line => lines.push(line) })
  return { id, lines, run, printed: () => lines.join("\n") }
}

test("puts the member in answerable-owner, then platform-admins, with keys of its own, and confirms root is locked", async () => {
  const { id, run, printed } = setup()
  expect(await run()).toEqual({ platform: id.platform, member: MEMBER })
  const puts = id.state.calls.filter(call => call.method === "PUT")
  expect(puts.map(call => call.path.split("/")[4])).toEqual(["0190a000-0000-7000-8000-0000000000a2", "0190a000-0000-7000-8000-0000000000a1"])
  expect(new Set(puts.map(call => call.key)).size).toBe(2)
  expect(id.state.memberships).toEqual(new Set([`0190a000-0000-7000-8000-0000000000a2 ${MEMBER}`, `0190a000-0000-7000-8000-0000000000a1 ${MEMBER}`]))
  expect(printed()).toContain(`you@answerable.org (member ${MEMBER}): added to answerable-owner, the admin MCP's owner role`)
  expect(printed()).toContain(`you@answerable.org (member ${MEMBER}): added to platform-admins, every platform scope`)
  expect(printed()).toContain("Root is locked now: ID refuses the root secret (403 root_locked)")
  expect(printed()).not.toContain(id.rootSecret)
})

test("a membership that exists is left as it is", async () => {
  const already = setup()
  already.id.state.memberships.add(`0190a000-0000-7000-8000-0000000000a2 ${MEMBER}`)
  await already.run()
  expect(already.printed()).toContain("already in answerable-owner")
  // Break glass keeps root open, so the same command can run again: both memberships are there.
  const again = setup({ breakGlass: true })
  await again.run().catch(() => {})
  again.lines.length = 0
  await again.run().catch(() => {})
  expect(again.printed()).toContain("already in answerable-owner")
  expect(again.printed()).toContain("already in platform-admins")
})

test("break glass after the last administrator left: a new run puts them back, since its keys are new and ID replays nothing", async () => {
  const { id, run, lines, printed } = setup({ breakGlass: true })
  await expect(run()).rejects.toThrow("is ROOT_ADMIN_BREAK_GLASS true")
  const first = id.state.calls.filter(call => call.method === "PUT").map(call => call.key)
  // The last administrator leaves both groups; ID keeps the first run's receipts.
  id.state.memberships.clear()
  lines.length = 0
  await expect(run()).rejects.toThrow("is ROOT_ADMIN_BREAK_GLASS true")
  const second = id.state.calls.filter(call => call.method === "PUT").map(call => call.key).slice(2)
  expect(second.filter(key => first.includes(key))).toEqual([])
  expect(printed()).toContain("added to answerable-owner")
  expect(printed()).toContain("added to platform-admins")
  expect(id.state.memberships).toEqual(new Set([`0190a000-0000-7000-8000-0000000000a2 ${MEMBER}`, `0190a000-0000-7000-8000-0000000000a1 ${MEMBER}`]))
})

test("fails, saying what to do, when the member has not signed in, a group is missing, root still works, or root is locked already", async () => {
  await expect(setup({}, { signedIn: false }).run()).rejects.toThrow("No member of the platform organisation has the email you@answerable.org: sign in once at https://id.example/login, then run make-admin again")
  await expect(setup({}, { owners: false }).run()).rejects.toThrow("no answerable-owner group: run register first")
  const noAdmins = setup()
  noAdmins.id.state.groups.delete("platform-admins")
  await expect(noAdmins.run()).rejects.toThrow("no platform-admins group: ID seeds it at its first start")
  const open = setup({ breakGlass: true })
  await expect(open.run()).rejects.toThrow("you@answerable.org is in platform-admins, but ID still accepts the root secret: is ROOT_ADMIN_BREAK_GLASS true")
  await expect(setup({ rootLocked: true }).run()).rejects.toThrow("ID refuses the root secret already (root_locked): a person is a platform administrator, so the first run is over")
})

test("any other answer is an error naming the call", async () => {
  const listing = setup()
  listing.id.state.failures.set(`GET /organizations/${listing.id.platform}/members`, 500)
  await expect(listing.run()).rejects.toThrow(`GET /organizations/${listing.id.platform}/members?email=you%40answerable.org answered 500 server_error`)
  const joining = setup()
  joining.id.state.failures.set(`PUT /organizations/${joining.id.platform}/groups/0190a000-0000-7000-8000-0000000000a2/members/${MEMBER}`, 500)
  await expect(joining.run()).rejects.toThrow("answered 500 server_error")
  const organisations = setup()
  organisations.id.state.failures.set("GET /organizations", 502)
  await expect(organisations.run()).rejects.toThrow("GET /organizations answered 502")
})

test("the check that root is locked: any other answer, or no answer, is an error", async () => {
  /** ID's fake, whose second GET /organizations, the check, answers `check` instead. */
  function checking(check: () => Promise<Response>) {
    const { id, ...rest } = setup()
    let lists = 0
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname.endsWith("/v1/organizations") && ++lists === 2 ? check() : id.fetch(input, init)) as typeof globalThis.fetch
    return () => makeAdmin({ id: "https://id.example", rootSecret: id.rootSecret, email: "you@answerable.org", platformSlug: "answerable", fetch, log: line => rest.lines.push(line) })
  }
  await expect(checking(async () => Response.json({ code: "server_error" }, { status: 502 }))()).rejects.toThrow("GET /organizations answered 502 server_error")
  await expect(checking(async () => { throw new TypeError("connection refused") })()).rejects.toThrow("connection refused")
})
