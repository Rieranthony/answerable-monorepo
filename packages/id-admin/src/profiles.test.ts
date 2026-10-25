import { expect, spyOn, test } from "bun:test"
import { ToolError } from "@answerable/mcp"
import { testPrincipal } from "@answerable/mcp/testing"
import { createIdAdmin, createIdProfiles } from "./index"
import { createFakeId } from "./testing"

// A fake ID holding Acme and Ada, a member of it; a clock the test moves; and the profile reads ID received.
function setup(options: { ttlMs?: number; staleMs?: number } = {}) {
  const id = createFakeId()
  let clock = Date.parse("2026-10-25T12:00:00.000Z")
  const profiles = createIdProfiles(createIdAdmin(id.config), { ...options, now: () => clock })
  const acme = id.organisation(Bun.randomUUIDv7(), { name: "Acme", slug: "acme" })
  const ada = id.member(acme.id, { name: "Ada Lovelace", email: "ada@acme.example" })
  const principal = testPrincipal({ organizationId: acme.id, membershipId: ada.id, userId: String(ada.userId) })
  const reads = () => id.requests.filter(request => request.startsWith("GET /api/admin/v1/organizations/"))
  return { id, profiles, acme, ada, principal, reads, advance: (ms: number) => { clock += ms }, at: (ms: number) => new Date(clock + ms).toISOString() }
}

test("reads the member and the organisation once, in parallel, then answers from the cache for 60 seconds", async () => {
  const { profiles, acme, ada, principal, reads, advance } = setup()
  const profile = { person: { name: "Ada Lovelace", email: "ada@acme.example", groups: [] }, organisation: { name: "Acme", slug: "acme" } }
  expect(await Promise.all([profiles(principal), profiles(principal)])).toEqual([profile, profile])
  expect(reads().toSorted()).toEqual([`GET /api/admin/v1/organizations/${acme.id}`, `GET /api/admin/v1/organizations/${acme.id}/members/${ada.id}`])
  advance(59_999)
  expect(await profiles(principal)).toEqual(profile)
  expect(reads()).toHaveLength(2)
  advance(1)
  await profiles(principal)
  expect(reads()).toHaveLength(4)
})

test("groups are the member's groups in force now, mapped to id, slug and name", async () => {
  const { id, profiles, acme, ada, principal, at } = setup()
  const engineers = id.group(acme.id, { slug: "engineers", name: "Engineers" })
  const alumni = id.group(acme.id, { slug: "alumni", name: "Alumni" })
  const interns = id.group(acme.id, { slug: "interns", name: "Interns" })
  const leads = id.group(acme.id, { slug: "leads", name: "Leads" })
  id.join(engineers.id, ada.id, { validFrom: at(-60_000), validUntil: at(60_000) })
  id.join(alumni.id, ada.id, { validUntil: at(-1) })
  id.join(interns.id, ada.id, { validFrom: at(1) })
  id.join(leads.id, ada.id)
  expect((await profiles(principal)).person.groups.toSorted((a, b) => a.slug.localeCompare(b.slug))).toEqual([
    { id: engineers.id, slug: "engineers", name: "Engineers" }, { id: leads.id, slug: "leads", name: "Leads" },
  ])
})

test("a member who is not in force is refused with PERMISSION_DENIED", async () => {
  const { id, profiles, acme, ada } = setup()
  const revoked = id.member(acme.id, { effective: false, membershipStatus: "revoked" })
  const refusal = profiles(testPrincipal({ organizationId: acme.id, membershipId: revoked.id }))
  await expect(refusal).rejects.toBeInstanceOf(ToolError)
  await expect(refusal).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: "Your membership of this organisation is not in force; ask an administrator of the organisation" })
  expect(ada.effective).toBe(true)
})

test("a member or an organisation ID no longer knows is refused with PERMISSION_DENIED, even with an old value in the cache", async () => {
  const { profiles, acme, ada, principal, advance } = setup()
  const gone = profiles(testPrincipal({ organizationId: acme.id, membershipId: Bun.randomUUIDv7() }))
  await expect(gone).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: "Answerable ID has no such member of this organisation any more; ask an administrator of the organisation" })
  const elsewhere = profiles(testPrincipal({ organizationId: Bun.randomUUIDv7(), membershipId: Bun.randomUUIDv7() }))
  await expect(elsewhere).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
  await profiles(principal)
  Object.assign(ada, { id: Bun.randomUUIDv7() }) // ID no longer knows Ada's membership: its read answers 404
  advance(60_000)
  await expect(profiles(principal)).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
})

test("invalidate makes the next call read again: an organisation, its members, or a user in every organisation", async () => {
  const { id, profiles, acme, ada, principal, reads } = setup()
  const other = id.organisation(Bun.randomUUIDv7(), { name: "Other", slug: "other" })
  const elsewhere = id.member(other.id, { userId: ada.userId })
  const there = testPrincipal({ organizationId: other.id, membershipId: elsewhere.id, userId: String(ada.userId) })
  await Promise.all([profiles(principal), profiles(there)])
  expect(reads()).toHaveLength(4)
  profiles.invalidate([acme.id])
  id.organisation(acme.id, { name: "Acme Ltd" })
  expect((await profiles(principal)).organisation.name).toBe("Acme Ltd")
  await profiles(there)
  expect(reads()).toHaveLength(6)
  profiles.invalidate([], [String(ada.userId)])
  await Promise.all([profiles(principal), profiles(there)])
  // A user's event drops their membership in every organisation, not the organisations.
  expect(reads().slice(6).toSorted()).toEqual([`GET /api/admin/v1/organizations/${acme.id}/members/${ada.id}`, `GET /api/admin/v1/organizations/${other.id}/members/${elsewhere.id}`])
  profiles.invalidate([crypto.randomUUID()], [crypto.randomUUID()])
  await profiles(principal)
  expect(reads()).toHaveLength(8)
})

test("when ID fails after a value expired, the value is served for an hour more, then the call rejects", async () => {
  const { id, profiles, principal, advance } = setup()
  await profiles(principal)
  id.outage(true)
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    advance(60_000 + 3_600_000 - 1)
    expect((await profiles(principal)).person.name).toBe("Ada Lovelace")
    expect(log.mock.calls[0]![0]).toBe("[id-admin] reading who is calling failed; serving what ID said before")
    advance(1)
    await expect(profiles(principal)).rejects.toThrow("with 503")
  } finally { log.mockRestore() }
  id.outage(false)
  expect((await profiles(principal)).person.name).toBe("Ada Lovelace")
})

test("with no value read before, a failing ID rejects the call, and a value past its stale window is never served", async () => {
  const { id, profiles, principal, advance } = setup({ ttlMs: 1_000, staleMs: 1_000 })
  id.outage(true)
  await expect(profiles(principal)).rejects.toMatchObject({ status: 503 })
  id.outage(false)
  await profiles(principal)
  advance(2_000)
  const other = testPrincipal({ organizationId: principal.organizationId, membershipId: id.member(principal.organizationId).id })
  await profiles(other)
  id.outage(true)
  await expect(profiles(principal)).rejects.toThrow("with 503")
})
