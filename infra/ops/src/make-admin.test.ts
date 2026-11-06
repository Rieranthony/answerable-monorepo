import { expect, test } from "bun:test"
import { makeAdmin } from "./make-admin"
import { fakeId } from "./testing"

/** ID after register: the owner group exists, and the staff member has signed in once; ID seeded platform-admins at its first start. */
function setup(options: Parameters<typeof fakeId>[0] = {}, { signedIn = true, owners = true, admins = true } = {}) {
  const id = fakeId(options)
  const groups = {
    owner: owners ? id.group(id.platform, { slug: "answerable-owner" }).id : undefined,
    admins: admins ? id.group(id.platform, { slug: "platform-admins" }).id : undefined,
  }
  const member = signedIn ? id.member(id.platform, { email: "you@answerable.org" }).id : undefined
  const lines: string[] = []
  const run = (...emails: string[]) => makeAdmin({ id: "https://id.example", rootSecret: id.rootSecret, emails: emails.length > 0 ? emails : ["you@answerable.org"], fetch: id.fetch, log: line => lines.push(line) })
  return { id, groups, member: member!, lines, run, printed: () => lines.join("\n") }
}

test("puts the member in answerable-owner, then platform-admins, with keys of its own, and confirms root is locked", async () => {
  const { id, groups, member, run, printed } = setup()
  expect(await run()).toEqual({ platform: id.platform, members: [member] })
  const puts = id.calls().filter(call => call.method === "PUT")
  expect(puts.map(call => call.path.split("/")[4])).toEqual([groups.owner!, groups.admins!])
  expect(new Set(puts.map(call => call.key)).size).toBe(2)
  expect([id.joined(groups.owner!, member), id.joined(groups.admins!, member)]).toEqual([true, true])
  expect(printed()).toContain(`you@answerable.org (member ${member}): added to answerable-owner, the admin MCP's owner role`)
  expect(printed()).toContain(`you@answerable.org (member ${member}): added to platform-admins, every platform scope`)
  expect(printed()).toContain("Root is locked now: ID refuses the root secret (403 root_locked)")
  expect(printed()).not.toContain(id.rootSecret)
})

test("several members: each an owner, the first alone in platform-admins, since the root secret locks with its first member", async () => {
  const { id, groups, member, run, printed } = setup()
  const others = ["stephen@answerable.org", "keir@answerable.org"].map(email => id.member(id.platform, { email }).id)
  // Any case, any order of the others, and a name given twice: the first named is the platform administrator.
  expect(await run("You@Answerable.org", "stephen@answerable.org", "keir@answerable.org", "you@answerable.org")).toEqual({ platform: id.platform, members: [member, ...others] })
  for (const each of [member, ...others]) expect(id.joined(groups.owner!, each)).toBe(true)
  expect([member, ...others].map(each => id.joined(groups.admins!, each))).toEqual([true, false, false])
  const puts = id.calls().filter(call => call.method === "PUT")
  expect(puts.map(call => call.path.split("/")[4])).toEqual([groups.owner!, groups.owner!, groups.owner!, groups.admins!])
  expect(new Set(puts.map(call => call.key)).size).toBe(4)
  expect(printed()).toContain("stephen@answerable.org, keir@answerable.org: owners, not in platform-admins")
  expect(printed()).toContain("Root is locked now")
})

test("several members, one of whom has not signed in: nothing is written, and the missing are named", async () => {
  const { id, run } = setup()
  id.member(id.platform, { email: "stephen@answerable.org" })
  await expect(run("you@answerable.org", "stephen@answerable.org", "keir@answerable.org", "ada@answerable.org")).rejects.toThrow(
    "No member of the platform organisation has the email keir@answerable.org or ada@answerable.org: sign in once at https://id.example/login, then run make-admin again",
  )
  expect(id.calls().filter(call => call.method === "PUT")).toEqual([])
  expect(id.rootLocked()).toBe(false)
})

test("a membership that exists is left as it is", async () => {
  const already = setup()
  already.id.join(already.groups.owner!, already.member)
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
  const { id, groups, member, run, lines, printed } = setup({ breakGlass: true })
  await expect(run()).rejects.toThrow("is ROOT_ADMIN_BREAK_GLASS true")
  const first = id.calls().filter(call => call.method === "PUT").map(call => call.key)
  // The last administrator leaves both groups; ID keeps the first run's receipts.
  for (const group of [groups.owner, groups.admins]) {
    await id.fetch(`https://id.example/api/admin/v1/organizations/${id.platform}/groups/${group}/members/${member}`, { method: "DELETE", headers: { Authorization: `Bearer ${id.rootSecret}`, "Idempotency-Key": crypto.randomUUID() } })
  }
  expect(id.joined(groups.admins!, member)).toBe(false)
  lines.length = 0
  await expect(run()).rejects.toThrow("is ROOT_ADMIN_BREAK_GLASS true")
  const second = id.calls().filter(call => call.method === "PUT").map(call => call.key).slice(2)
  expect(second.filter(key => first.includes(key))).toEqual([])
  expect(printed()).toContain("added to answerable-owner")
  expect(printed()).toContain("added to platform-admins")
  expect([id.joined(groups.owner!, member), id.joined(groups.admins!, member)]).toEqual([true, true])
})

test("fails, saying what to do, when the member has not signed in, a group is missing, root still works, or root is locked already", async () => {
  await expect(setup({}, { signedIn: false }).run()).rejects.toThrow("No member of the platform organisation has the email you@answerable.org: sign in once at https://id.example/login, then run make-admin again")
  await expect(setup({}, { owners: false }).run()).rejects.toThrow("no answerable-owner group: run register first")
  await expect(setup({}, { admins: false }).run()).rejects.toThrow("no platform-admins group: ID seeds it at its first start")
  const open = setup({ breakGlass: true })
  await expect(open.run()).rejects.toThrow("you@answerable.org is in platform-admins, but ID still accepts the root secret: is ROOT_ADMIN_BREAK_GLASS true")
  const locked = setup()
  locked.id.lockRoot(true)
  await expect(locked.run()).rejects.toThrow("ID refuses the root secret already (root_locked): a person is a platform administrator, so the first run is over")
})

test("any other answer is an error naming the call", async () => {
  const listing = setup()
  listing.id.fail(`GET /organizations/${listing.id.platform}/members`, 500)
  await expect(listing.run()).rejects.toThrow(`GET /organizations/${listing.id.platform}/members?email=you%40answerable.org answered 500 internal_error`)
  const joining = setup()
  joining.id.fail(`PUT /organizations/${joining.id.platform}/groups/${joining.groups.owner}/members/${joining.member}`, 500)
  await expect(joining.run()).rejects.toThrow("answered 500 internal_error")
  const organisations = setup()
  organisations.id.fail("GET /organizations", 502, "bad_gateway")
  await expect(organisations.run()).rejects.toThrow("GET /organizations answered 502")
})

test("the check that root is locked: any other answer, or no answer, is an error", async () => {
  /** ID's fake, whose second GET /organizations, the check, answers `check` instead. */
  function checking(check: () => Promise<Response>) {
    const { id, ...rest } = setup()
    let lists = 0
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname.endsWith("/v1/organizations") && ++lists === 2 ? check() : id.fetch(input, init)) as typeof globalThis.fetch
    return () => makeAdmin({ id: "https://id.example", rootSecret: id.rootSecret, emails: ["you@answerable.org"], fetch, log: line => rest.lines.push(line) })
  }
  await expect(checking(async () => Response.json({ code: "server_error" }, { status: 502 }))()).rejects.toThrow("GET /organizations answered 502 server_error")
  await expect(checking(async () => { throw new TypeError("connection refused") })()).rejects.toThrow("connection refused")
})
