import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { errorOf, type TestMcp } from "@answerable/mcp/testing"
import { createAdmin, entraIssuer, seed, type FakeId } from "./test/admin"
import { serving } from "./test/database"

// The tools on how an organisation signs in by emailed link, against the fake ID and the admin MCP's roles: each is previewed saying what it will and will
// not reach, committed under the intent's key with the scope ID checks, and refused for the wrong role, an old sign-in and what ID would refuse.
const login = await serving()
afterAll(() => login.drop())
const admins: Awaited<ReturnType<typeof createAdmin>>[] = []
afterEach(async () => {
  setSystemTime()
  await Promise.all(admins.splice(0).map(admin => admin.mcp.close()))
})
async function admin(options?: Parameters<typeof createAdmin>[1]) {
  const created = await createAdmin(login.db, options)
  admins.push(created)
  return created
}

type Client = Awaited<ReturnType<TestMcp["connect"]>>
type Prepared = {
  intent_id: string; commit_token: string
  targets: { resource_type: string; resource_id: string; label: string; version: { kind: string; value: string } }[]
  preview: { summary: string; changes: { path: string; from: unknown; to: unknown }[]; effects: string[]; warnings: string[]; quantities: { name: string; value: number; unit: string }[] }
}
const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
const refusal = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = await call(client, name, args)
  if (!answer.isError) throw new Error(`${name} succeeded where a refusal was expected: ${JSON.stringify(answer.structuredContent)}`)
  return errorOf(answer)
}
const prepared = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = await call(client, name, args)
  if (answer.isError) throw new Error(`${name}: ${JSON.stringify(errorOf(answer))}`)
  return answer.structuredContent as Prepared
}
const confirm = (client: Client, intent: Prepared) => call(client, "admin_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary })
const committed = async (client: Client, intent: Prepared) => {
  const answer = await confirm(client, intent)
  if (answer.isError) throw new Error(`commit: ${JSON.stringify(errorOf(answer))}`)
  return answer.structuredContent as { results: Record<string, unknown>; applied_changes: unknown[]; effects_performed: string[] }
}
// The preview of an import is a POST that changes nothing.
const writes = (id: FakeId) => id.received.filter(({ request }) => !request.startsWith("GET") && !request.endsWith("/members/import/preview"))
const noPrecondition = (write: string) => `Answerable ID takes no precondition on ${write}: the admin MCP reads the target again just before it writes, but a change in between is not refused by ID.`

// An admin with a recent sign-in, on Newco, which holds a member and one domain.
async function asAdmin(role: "answerable-admin" | "answerable-owner" = "answerable-admin") {
  const created = await admin()
  const world = seed(created.id)
  const staffer = created.staff(["admin", role])
  return { ...created, world, client: await staffer.connect(), staffer }
}

test("magiclink_disable says what it ends, that directory sign-ins are not touched, and what outlives it; magiclink_enable turns it back on", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  const off = await prepared(client, "magiclink_disable", { organizationId: newco.id })
  expect(off).toMatchObject({ policy_class: "controlled", commit_tool: "admin_commit_confirmed" })
  expect(off.targets).toEqual([expect.objectContaining({ resource_type: "organization", resource_id: newco.id })])
  expect(off.preview).toEqual({
    summary: "Turn magic links off for organisation “Newco” (newco)",
    changes: [{ path: `organizations[${newco.id}].magicLink.enabled`, from: true, to: false }],
    effects: ["permission_change"],
    warnings: [
      "It has no directory, so nobody at this organisation can then sign in.",
      "Ends every magic-link session and grant at this organisation. It does not touch directory sign-ins, sessions or grants.",
      "A service token already issued lives to its expiry.",
      "magiclink_enable turns links back on and revives none of what this ended.",
      noPrecondition("turning magic links off"),
    ],
    quantities: [],
  })
  expect(writes(id)).toEqual([])
  const receipt = await committed(client, off)
  expect(receipt.results).toEqual({ organizationId: newco.id, enabled: false, operationId: expect.any(String) })
  expect(receipt.effects_performed).toEqual(["permission_change"])
  expect(writes(id)).toEqual([{ request: `POST /api/admin/v1/organizations/${newco.id}/magic-link/disable`, requestId: expect.any(String), idempotencyKey: off.intent_id, ifMatch: null, ifNoneMatch: null, caller: "admin-mcp" }])
  expect(id.scopesAsked.at(-1)).toBe("platform:read platform:write")
  expect(await refusal(client, "magiclink_disable", { organizationId: newco.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Magic links are already off for organisation “Newco” (newco)" })
  const on = await prepared(client, "magiclink_enable", { organizationId: newco.id })
  expect(on.preview).toEqual({
    summary: "Turn magic links on for organisation “Newco” (newco)",
    changes: [{ path: `organizations[${newco.id}].magicLink.enabled`, from: false, to: true }],
    effects: ["permission_change"],
    warnings: [
      "Who may ask for a link: its 1 effective member.",
      "Sessions and grants ended when links were turned off stay ended: their people sign in again.",
      noPrecondition("turning magic links on"),
    ],
    quantities: [],
  })
  expect((await committed(client, on)).results).toEqual({ organizationId: newco.id, enabled: true, operationId: expect.any(String) })
  expect(await refusal(client, "magiclink_enable", { organizationId: newco.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Magic links are already on for organisation “Newco” (newco)" })
})

test("magiclink_disable with a directory connected says nothing of a lockout: its people still sign in there", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  id.ssoProvider(newco.id, { issuer: entraIssuer, domain: "newco.example" })
  const off = await prepared(client, "magiclink_disable", { organizationId: newco.id })
  expect(off.preview.warnings).toEqual([
    "Ends every magic-link session and grant at this organisation. It does not touch directory sign-ins, sessions or grants.",
    "A service token already issued lives to its expiry.",
    "magiclink_enable turns links back on and revives none of what this ended.",
    noPrecondition("turning magic links off"),
  ])
})

test("magiclink_enable with a directory connected says what a link does not pass through; in domain mode it says who else may ask", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  id.organisation(newco.id, { magicLink: { enabled: false, admission: "domain" } })
  id.ssoProvider(newco.id, { issuer: entraIssuer, domain: "newco.example" })
  const on = await prepared(client, "magiclink_enable", { organizationId: newco.id })
  expect(on.preview.warnings).toEqual([
    "Who may ask for a link: its 1 effective member, and anyone at a proved domain, whom a first sign-in creates.",
    "A magic link does not pass through the directory's MFA or conditional access, and someone disabled there can still use a link while their mailbox works; remove the member in Answerable ID, with members_remove, to stop both.",
    "Sessions and grants ended when links were turned off stay ended: their people sign in again.",
    noPrecondition("turning magic links on"),
  ])
})

test("the platform organisation: an admin is refused every one of these, an owner with a recent sign-in cannot turn links on, and may look at the rest", async () => {
  const { id, platform, staff, world } = await asAdmin()
  const owner = staff(["admin", "answerable-owner"])
  const client = await owner.connect()
  id.domain(platform, "answerable.test")
  expect(await refusal(client, "magiclink_enable", { organizationId: platform })).toMatchObject({ code: "PRECONDITION_FAILED", message: "The platform organisation can never use magic links: staff sign in through its directory" })
  expect(await refusal(client, "magiclink_admission", { organizationId: platform, admission: "domain" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "The platform organisation can never use magic links: staff sign in through its directory" })
  expect(await refusal(client, "magiclink_disable", { organizationId: platform })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Magic links are already off for organisation “Answerable” (answerable)" })
  expect((await prepared(client, "domains_verify", { organizationId: platform, domain: "answerable.test" })).preview.summary).toBe("Check the DNS record that proves answerable.test for organisation “Answerable” (answerable)")
  expect(world.platform).toBe(platform)
  expect(writes(id)).toEqual([])
})

test("each needs a recent directory sign-in, at prepare and at commit, as ID's own route does of a person", async () => {
  const { id, world: { newco }, client, staffer } = await asAdmin("answerable-owner")
  id.domain(newco.id, "other.newco.example", { verifiedAt: new Date().toISOString() })
  const calls: [string, Record<string, unknown>][] = [
    ["magiclink_disable", { organizationId: newco.id }],
    ["magiclink_admission", { organizationId: newco.id, admission: "listed" }],
    ["members_import", { organizationId: newco.id, addresses: ["someone@newco.example"] }],
    ["domains_verify", { organizationId: newco.id, domain: "newco.example" }],
  ]
  id.organisation(newco.id, { magicLink: { enabled: true, admission: "domain" } })
  const fresh = await Promise.all(calls.map(([name, args]) => prepared(client, name, args)))
  staffer.signedInAt(Math.floor(Date.now() / 1000) - 2 * 3600)
  for (const [name, args] of calls) expect((await refusal(client, name, args)).code, name).toBe("ADMIN_REAUTHENTICATION_REQUIRED")
  for (const intent of fresh) expect(errorOf(await confirm(client, intent)).code).toBe("ADMIN_REAUTHENTICATION_REQUIRED")
  staffer.signedInAt(null)
  expect((await refusal(client, "magiclink_enable", { organizationId: newco.id })).code).toBe("ADMIN_REAUTHENTICATION_REQUIRED")
  expect(writes(id)).toEqual([])
})

test("magiclink_admission to domain is an owner's: an admin is refused and may still narrow it to listed", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  id.domainsOf(newco.id)[0]!.verifiedAt = new Date().toISOString()
  expect(await refusal(client, "magiclink_admission", { organizationId: newco.id, admission: "domain" })).toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringContaining("an owner's") })
  expect(writes(id)).toEqual([])
  id.organisation(newco.id, { magicLink: { enabled: true, admission: "domain" } })
  const narrow = await prepared(client, "magiclink_admission", { organizationId: newco.id, admission: "listed" })
  expect(narrow.preview).toEqual({
    summary: "Let only the effective members of organisation “Newco” (newco) ask for a magic link",
    changes: [{ path: `organizations[${newco.id}].magicLink.admission`, from: "domain", to: "listed" }],
    effects: ["permission_change"],
    warnings: ["People who are not yet members can no longer ask. Existing members stay members, and no session or grant ends.", noPrecondition("changing who may ask")],
    quantities: [],
  })
  expect((await committed(client, narrow)).results).toEqual({ organizationId: newco.id, admission: "listed", operationId: expect.any(String) })
  expect(writes(id)).toEqual([expect.objectContaining({ request: `PATCH /api/admin/v1/organizations/${newco.id}/magic-link`, idempotencyKey: narrow.intent_id })])
  expect(await refusal(client, "magiclink_admission", { organizationId: newco.id, admission: "listed" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Organisation “Newco” (newco) already admits listed; nothing would change" })
})

test("magiclink_admission to domain warns of organisation-wide entitlements and of aliases, and needs every active domain proved", async () => {
  const { id, world: { newco }, client } = await asAdmin("answerable-owner")
  expect(await refusal(client, "magiclink_admission", { organizationId: newco.id, admission: "domain" })).toMatchObject({
    code: "PRECONDITION_FAILED", message: "Every active domain must be proved first: newco.example. domains_verify checks each, once its DNS record is published",
    details: { preconditions: [{ organizationId: newco.id, unverified: ["newco.example"] }] },
  })
  id.domainsOf(newco.id)[0]!.verifiedAt = new Date().toISOString()
  id.domain(newco.id, "old.newco.example", { status: "disabled" })
  const quiet = await prepared(client, "magiclink_admission", { organizationId: newco.id, admission: "domain" })
  expect(quiet.preview).toEqual({
    summary: "Let anyone at a proved domain of organisation “Newco” (newco) ask for a magic link: newco.example",
    changes: [{ path: `organizations[${newco.id}].magicLink.admission`, from: "listed", to: "domain" }],
    effects: ["permission_change"],
    warnings: [
      "An alias of a removed person is a different address, which Answerable ID cannot recognise: it could sign in as someone new. Removing a member stops that one address.",
      "A shared mailbox or a distribution list at these domains becomes one person, whoever reads it.",
      "Mail can now reach addresses nobody holds: at most 100 an hour from one client and 500 a day for the organisation. Beyond them a new person gets no mail, so a firm-wide start uses members_import first, since listed people are not new addresses.",
      "A domain added later admits nobody new until it is proved. Nothing re-checks a proof on a schedule, so a lapsed domain someone re-registers stays proved until domains_verify runs again.",
      noPrecondition("changing who may ask"),
    ],
    quantities: [],
  })
  const person = id.member(newco.id, { email: "grace@newco.example" })
  id.entitlement(newco.id, { resource: "https://toolbox.test/mcp", scopes: ["e2e"] })
  id.entitlement(newco.id, { clientId: "claude-code-toolbox", scopes: ["openid"] })
  id.entitlement(newco.id, { resource: "https://other.test/mcp", scopes: ["other"], status: "disabled" })
  id.entitlement(newco.id, { memberId: person.id, resource: "https://named.test/mcp", scopes: ["named"] })
  const warned = await prepared(client, "magiclink_admission", { organizationId: newco.id, admission: "domain" })
  expect(warned.preview.warnings[0]).toBe("2 organisation-wide entitlements exist, so a new person would have access at once: claude-code-toolbox, https://toolbox.test/mcp.")
  expect((await committed(client, warned)).results).toEqual({ organizationId: newco.id, admission: "domain", operationId: expect.any(String) })
  const bare = id.organisation(Bun.randomUUIDv7(), { name: "Bare", slug: "bare" })
  expect(await refusal(client, "magiclink_admission", { organizationId: bare.id, admission: "domain" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Organisation “Bare” (bare) has no active domain: domains_add one, then domains_verify it" })
})

test("magiclink_admission to domain with links off says it has no effect until they are on; to listed, it does not", async () => {
  const { id, world: { newco }, client } = await asAdmin("answerable-owner")
  id.domainsOf(newco.id)[0]!.verifiedAt = new Date().toISOString()
  const line = "Magic links are off here, so this has no effect until magiclink_enable."
  expect((await prepared(client, "magiclink_admission", { organizationId: newco.id, admission: "domain" })).preview.warnings).not.toContain(line)
  id.organisation(newco.id, { magicLink: { enabled: false, admission: "listed" } })
  expect((await prepared(client, "magiclink_admission", { organizationId: newco.id, admission: "domain" })).preview.warnings[0]).toBe(line)
  id.organisation(newco.id, { magicLink: { enabled: false, admission: "domain" } })
  expect((await prepared(client, "magiclink_admission", { organizationId: newco.id, admission: "listed" })).preview.warnings).not.toContain(line)
})

test("what the admin MCP cannot know, ID refuses, and the tool says so: a public mail domain on the row", async () => {
  const { id, world: { newco }, client } = await asAdmin("answerable-owner")
  id.domainsOf(newco.id)[0]!.verifiedAt = new Date().toISOString()
  id.domain(newco.id, "gmail.com", { verifiedAt: new Date().toISOString() })
  const intent = await prepared(client, "magiclink_admission", { organizationId: newco.id, admission: "domain" })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await confirm(client, intent))).toMatchObject({ code: "UPSTREAM_REJECTED", details: { upstream: { status: 409, code: "domain_not_verified" } } })
  } finally { log.mockRestore() }
})

test("members_import previews the counts from ID's own answer, changing nothing, and commits one import under the intent's key with a platform:users token", async () => {
  const { id, world: { newco, ada }, client } = await asAdmin()
  const other = id.organisation(Bun.randomUUIDv7(), { name: "Other", slug: "other" })
  const alan = id.member(other.id, { email: "alan@newco.example", name: "Alan" })
  const addresses = ["new@newco.example", "NEW@newco.example", "alan@newco.example", String(ada.email), "someone@gmail.com", "someone@elsewhere.example", "nonsense"]
  const intent = await prepared(client, "members_import", { organizationId: newco.id, addresses })
  expect(intent.preview).toEqual({
    summary: "List 2 people in organisation “Newco” (newco): 1 new, 1 existing users added; 1 already members, 3 refused",
    changes: [{ path: `organizations[${newco.id}].magicLink.listed`, from: 1, to: 3 }],
    effects: ["permission_change"],
    warnings: [
      "Refused: someone@gmail.com (public_mail), someone@elsewhere.example (outside_domains), nonsense (invalid).",
      "Sends no mail. Each person's account is made at their first sign-in. A removed member and a disabled person stay as they are.",
      noPrecondition("importing members"),
    ],
    quantities: [
      { name: "created", value: 1, unit: "people" }, { name: "added", value: 1, unit: "people" },
      { name: "alreadyMember", value: 1, unit: "people" }, { name: "refused", value: 3, unit: "addresses" },
    ],
  })
  expect(writes(id)).toEqual([])
  expect(id.received.filter(({ request }) => request.endsWith("/members/import/preview"))).toHaveLength(1)
  expect(id.userOf(String(ada.userId))).toBeDefined()
  expect(id.scopesAsked).toContain("platform:read")
  const receipt = await committed(client, intent)
  expect(receipt.results).toEqual({
    organizationId: newco.id, operationId: expect.any(String),
    counts: { created: 1, added: 1, alreadyMember: 1, refused: 3 },
    refused: [{ address: "someone@gmail.com", reason: "public_mail" }, { address: "someone@elsewhere.example", reason: "outside_domains" }, { address: "nonsense", reason: "invalid" }],
  })
  expect(writes(id)).toEqual([
    { request: `POST /api/admin/v1/organizations/${newco.id}/members/import`, requestId: expect.any(String), idempotencyKey: intent.intent_id, ifMatch: null, ifNoneMatch: null, caller: "admin-mcp" },
  ])
  // The fake refuses a token without platform:users, so the write could only have been made with the machine client's users token.
  expect(id.scopesAsked).toContain("platform:read platform:users")
  expect((id.organisation(newco.id).magicLink as object)).toBeDefined()
  expect(alan.userId).toBeDefined()
})

test("members_import names what it cannot reach: links off, a directory connected, organisation-wide access, and more refusals than it spells out", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  id.organisation(newco.id, { magicLink: { enabled: false, admission: "listed" } })
  id.ssoProvider(newco.id, { issuer: entraIssuer, domain: "newco.example" })
  id.entitlement(newco.id, { resource: "https://toolbox.test/mcp", scopes: ["e2e"] })
  const refused = Array.from({ length: 25 }, (_, index) => `p${index}@elsewhere.example`)
  const intent = await prepared(client, "members_import", { organizationId: newco.id, addresses: ["one@newco.example", ...refused] })
  expect(intent.preview.summary).toBe("List 1 person in organisation “Newco” (newco): 1 new, 0 existing users added; 0 already members, 25 refused")
  expect(intent.preview.warnings).toEqual([
    expect.stringMatching(/^Refused: p0@elsewhere\.example \(outside_domains\), .*p19@elsewhere\.example \(outside_domains\), and 5 more\.$/),
    "Sends no mail. Each person's account is made at their first sign-in. A removed member and a disabled person stay as they are.",
    "1 organisation-wide entitlement exists, so each new member has access at once: https://toolbox.test/mcp.",
    "Magic links are off here, so nobody listed can sign in by link until magiclink_enable.",
    "A directory is connected: a listed person's first directory sign-in asks for a code from their mailbox, once, which connects it to the person listed here. That works whether links are on or off.",
    noPrecondition("importing members"),
  ])
  const receipt = await committed(client, intent)
  expect(receipt.results.refused).toHaveLength(20)
  expect(receipt.results.counts).toEqual({ created: 1, added: 0, alreadyMember: 0, refused: 25 })
})

test("members_import refuses what would change nothing, an unknown organisation and an empty or oversized list, and keeps removed and disabled people as they are", async () => {
  const { id, world: { newco, ada }, client } = await asAdmin()
  const removed = id.member(newco.id, { email: "gone@newco.example", membershipStatus: "revoked", effective: false })
  const disabled = id.member(newco.id, { email: "off@newco.example", status: "disabled" })
  id.user({ email: "foreign@newco.example", otherFirm: true })
  const nothing = await refusal(client, "members_import", { organizationId: newco.id, addresses: [String(ada.email), String(removed.email), "foreign@newco.example", "nonsense"] })
  expect(nothing).toMatchObject({
    code: "PRECONDITION_FAILED", message: "Importing these addresses would change nothing in organisation “Newco” (newco): 1 already members, 3 refused",
    details: { preconditions: [{ organizationId: newco.id, refused: [{ address: "gone@newco.example", reason: "removed" }, { address: "foreign@newco.example", reason: "other_firm" }, { address: "nonsense", reason: "invalid" }] }] },
  })
  const off = await prepared(client, "members_import", { organizationId: newco.id, addresses: ["off@newco.example", "fine@newco.example"] })
  expect(off.preview.warnings[0]).toBe("Refused: off@newco.example (disabled).")
  expect(disabled.status).toBe("disabled")
  const unknown = crypto.randomUUID()
  expect(await refusal(client, "members_import", { organizationId: unknown, addresses: ["a@b.example"] })).toMatchObject({ code: "NOT_FOUND" })
  expect((await refusal(client, "members_import", { organizationId: newco.id, addresses: [] })).code).toBe("INVALID_INPUT")
  expect((await refusal(client, "members_import", { organizationId: newco.id, addresses: Array.from({ length: 1001 }, (_, index) => `p${index}@newco.example`) })).code).toBe("INVALID_INPUT")
})

test("members_import at its limit: 1,000 addresses go through the intent store and the evidence on a real database, and the preview stays small", async () => {
  const { world: { newco }, client } = await asAdmin()
  const addresses = Array.from({ length: 1000 }, (_, index) => (index % 2 ? `person-${index}@newco.example` : `someone-with-a-long-address-${index}@elsewhere.example`))
  const intent = await prepared(client, "members_import", { organizationId: newco.id, addresses })
  expect(intent.preview.summary).toBe("List 500 people in organisation “Newco” (newco): 500 new, 0 existing users added; 0 already members, 500 refused")
  expect(JSON.stringify(intent).length).toBeLessThan(4_000)
  const receipt = await committed(client, intent)
  expect(receipt.results.counts).toEqual({ created: 500, added: 0, alreadyMember: 0, refused: 500 })
  expect(receipt.results.refused).toHaveLength(20)
  expect(JSON.stringify(receipt).length).toBeLessThan(4_000)
})

test("members_import whose answer was lost: the commit's retry replays ID's receipt, and says it has no counts", async () => {
  const { id, world: { newco }, staffer, lose } = await asAdmin()
  const client = await staffer.connect()
  const intent = await prepared(client, "members_import", { organizationId: newco.id, addresses: ["lost@newco.example"] })
  lose()
  const receipt = await committed(client, intent)
  expect(receipt.results).toEqual({ organizationId: newco.id, operationId: expect.any(String), counts: null, refused: [] })
  expect(writes(id)).toHaveLength(2)
})

test("domains_verify shows the record it looks for, commits one check with platform:write, and a record not found says what to publish", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  const [domain] = id.domainsOf(newco.id)
  const record = domain!.verificationRecord as { type: string; name: string; value: string }
  const intent = await prepared(client, "domains_verify", { organizationId: newco.id, domain: " NEWCO.example " })
  expect(intent.preview).toEqual({
    summary: "Check the DNS record that proves newco.example for organisation “Newco” (newco)",
    changes: [{ path: `organizations[${newco.id}].domains[${domain!.id}].verifiedAt`, from: null, to: "the time the record is seen, or null when it is not found" }],
    effects: ["permission_change"],
    warnings: [`Answerable ID looks for a TXT record at ${record.name} with the value ${record.value}. The commit fails when it is not there.`, noPrecondition("checking a domain")],
    quantities: [],
  })
  expect(writes(id)).toEqual([])
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await confirm(client, intent))).toMatchObject({
      code: "PRECONDITION_FAILED", retry: { policy: "after_state_change" },
      message: `Answerable ID did not find the TXT record at ${record.name} with the value ${record.value}. DNS can take time: publish it, then prepare this again`,
      details: { preconditions: [{ domain: "newco.example", expected: record }] },
    })
  } finally { log.mockRestore() }
  id.publish(domain!.id)
  const again = await prepared(client, "domains_verify", { organizationId: newco.id, domain: "newco.example" })
  const receipt = await committed(client, again)
  expect(receipt.results).toEqual({ domainId: domain!.id, domain: "newco.example", verifiedAt: expect.any(String), operationId: expect.any(String) })
  expect(writes(id).at(-1)).toMatchObject({ request: `POST /api/admin/v1/organizations/${newco.id}/domains/${domain!.id}/verify`, idempotencyKey: again.intent_id, caller: "admin-mcp" })
  expect(id.scopesAsked.at(-1)).toBe("platform:read platform:write")
})

test("domains_verify on a proved domain warns of what a failure does; when the record has gone, the proof goes with it, and the answer says so", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  const [domain] = id.domainsOf(newco.id)
  domain!.verifiedAt = new Date().toISOString()
  const intent = await prepared(client, "domains_verify", { organizationId: newco.id, domain: "newco.example" })
  expect(intent.preview.warnings[1]).toBe("newco.example is proved now: if the record is gone, this clears that, and it admits nobody new until it is proved again. Nobody's session ends.")
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await confirm(client, intent))).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining(", so newco.example is no longer proved. DNS can take time") })
  } finally { log.mockRestore() }
  expect(domain!.verifiedAt).toBeNull()
})

test("domains_verify whose answer was lost: the retry has no time to show, and says where to read it; another failure stays ID's", async () => {
  const { id, world: { newco }, staffer, lose } = await asAdmin()
  const client = await staffer.connect()
  const [domain] = id.domainsOf(newco.id)
  id.publish(domain!.id)
  const intent = await prepared(client, "domains_verify", { organizationId: newco.id, domain: "newco.example" })
  lose()
  expect((await committed(client, intent)).results).toEqual({ domainId: domain!.id, domain: "newco.example", verifiedAt: null, operationId: expect.any(String) })
  const next = await prepared(client, "domains_verify", { organizationId: newco.id, domain: "newco.example" })
  id.fail(`POST /organizations/${newco.id}/domains/${domain!.id}/verify`, 403, "insufficient_scope")
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(errorOf(await confirm(client, next))).toMatchObject({ code: "UPSTREAM_REJECTED", details: { upstream: { status: 403, code: "insufficient_scope" } } })
  } finally { log.mockRestore() }
})

test("domains_verify refuses a domain the organisation does not hold", async () => {
  const { world: { newco }, client } = await asAdmin()
  expect(await refusal(client, "domains_verify", { organizationId: newco.id, domain: "elsewhere.example" })).toMatchObject({
    code: "PRECONDITION_FAILED", message: "elsewhere.example is not routed to organisation “Newco” (newco); domains_add routes it",
  })
})

test("a person with the team role lists none of these, and an unknown organisation is NOT_FOUND on each", async () => {
  const { staff, world: { newco }, client } = await asAdmin()
  const reader = await staff(["admin", "answerable-team"]).connect()
  const listed = (await reader.listTools()).tools.map(tool => tool.name)
  for (const name of ["magiclink_enable", "magiclink_disable", "magiclink_admission", "members_import", "domains_verify"]) expect(listed).not.toContain(name)
  const unknown = crypto.randomUUID()
  for (const [name, args] of [
    ["magiclink_enable", {}], ["magiclink_disable", {}], ["magiclink_admission", { admission: "listed" }], ["members_import", { addresses: ["a@b.example"] }], ["domains_verify", { domain: "a.example" }],
  ] as const) expect((await refusal(client, name, { organizationId: unknown, ...args })).code, name).toBe("NOT_FOUND")
  expect(newco.id).toBeString()
})

test("organisations_get shows magic links and the directory side by side, each with its own state, and every domain's proof", async () => {
  const { id, world: { newco }, client } = await asAdmin()
  const [domain] = id.domainsOf(newco.id)
  const shown = async () => (await call(client, "organisations_get", { organizationId: newco.id })).structuredContent as Record<string, unknown>
  expect(await shown()).toMatchObject({
    magicLink: { enabled: true, admission: "listed", listed: 1 }, sso: null,
    domains: [{ id: domain!.id, domain: "newco.example", status: "active", verifiedAt: null, verificationRecord: domain!.verificationRecord }],
  })
  id.organisation(newco.id, { magicLink: { enabled: false, admission: "domain" } })
  id.ssoProvider(newco.id, { issuer: entraIssuer, domain: "newco.example" })
  expect(await shown()).toMatchObject({ magicLink: { enabled: false, admission: "domain", listed: 1 }, sso: { issuer: entraIssuer } })
})

test("descriptions no longer imply a directory is the only way in", async () => {
  const { client } = await asAdmin()
  const { tools } = await client.listTools()
  const description = (name: string) => tools.find(tool => tool.name === name)!.description!
  expect(description("organisations_create")).toContain("A directory is one way in, not the only one")
  expect(description("domains_add")).toContain("a magic link, its directory, or the choice of both")
  expect(description("sso_set")).toContain("magic links, their sessions and their grants stay as they are")
})
