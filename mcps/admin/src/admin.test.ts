import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { SQL } from "bun"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { errorOf, type TestMcp } from "@answerable/mcp/testing"
import { createEvidence } from "@answerable/mcp-postgres"
import { createAdminMcp } from "./admin"
import { createAdmin, resource, seed, type FakeId } from "./test/admin"
import { testDatabase, testDatabaseUrl } from "./test/database"

const db = testDatabase()
afterAll(() => db.close())
const admins: Awaited<ReturnType<typeof createAdmin>>[] = []
afterEach(async () => {
  setSystemTime()
  await Promise.all(admins.splice(0).map(admin => admin.mcp.close()))
})
async function admin(options?: Parameters<typeof createAdmin>[1]) {
  const created = await createAdmin(db, options)
  admins.push(created)
  return created
}

const names = async (client: Awaited<ReturnType<TestMcp["connect"]>>) => (await client.listTools()).tools.map(tool => tool.name)
const reads = ["organisations_list", "organisations_get", "members_list", "members_get", "groups_list", "access_list", "audit_list", "sso_test", "staff_list"]
const commits = ["admin_commit", "admin_commit_confirmed"]
// What each role lists, in the provider's order: the ordinary writes for admin, and the critical ones too for owner.
const adminTools = ["admin_whoami", ...reads, "organisations_create", "organisations_update", "domains_add", "sso_set", "groups_create", "groups_addmember", "groups_dropmember", "access_grant", "access_revoke", "access_enable", "toolbox_enable", ...commits]
const ownerTools = [
  "admin_whoami", ...reads, "organisations_create", "organisations_update", "domains_add", "sso_set", "organisations_disable", "organisations_enable",
  "groups_create", "groups_addmember", "groups_dropmember", "access_grant", "access_revoke", "access_enable", "toolbox_enable", "staff_grant", "staff_revoke", ...commits,
]
type Event = Record<"kind" | "outcome" | "actor_id" | "client_id" | "capability_identity" | "capability_version", string> &
  Record<"reason" | "error_code" | "upstream" | "execution_id" | "request_id", string | null> & { data: Record<string, unknown> }
const events = (platform: string): Promise<Event[]> => db`
  select kind, outcome, actor_id, client_id, capability_identity, capability_version, reason, error_code, data, execution_id::text, request_id, upstream
  from evidence_events where organisation_id = ${platform} order by seq`
const accessReads = (id: { received: { request: string }[] }) => id.received.filter(({ request }) => request.endsWith("/access")).length

test("a token of another organisation lists no tools, and admin_whoami is the unknown-tool error, recorded as denied: not_platform", async () => {
  const { id, mcp, platform } = await admin()
  const outsider = crypto.randomUUID()
  const client = await mcp.connect({ organizationId: outsider })
  expect(await names(client)).toEqual([])
  await expect(client.callTool({ name: "admin_whoami", arguments: {} })).rejects.toThrow("Tool admin_whoami not found")
  expect(await events(platform)).toEqual([{
    kind: "capability.denied", outcome: "denied", actor_id: expect.any(String), client_id: "test-client", capability_identity: "admin/admin.whoami",
    capability_version: "2026-10-01", reason: "not_platform", error_code: null, data: { organisation_id: outsider }, execution_id: null, request_id: null, upstream: null,
  }])
  expect(id.received).toEqual([])
})

test("a platform member without a role lists admin_whoami only, which says role null and how to get one", async () => {
  const { staff, platform } = await admin()
  const person = staff(["admin"])
  const client = await person.connect()
  expect(await names(client)).toEqual(["admin_whoami"])
  expect((await client.callTool({ name: "admin_whoami", arguments: {} })).structuredContent).toEqual({
    userId: person.member.userId, membershipId: person.member.id, organizationId: platform, clientId: "test-client",
    role: null, nextStep: "Ask an owner to add you to a group that holds answerable-team, answerable-admin or answerable-owner on the admin MCP's resource; your next call then has the role.",
    tools: ["admin_whoami"],
  })
  await expect(client.callTool({ name: "organisations_list", arguments: {} })).rejects.toThrow("Tool organisations_list not found")
  expect((await events(platform)).map(({ kind, reason, capability_identity, data }) => [kind, reason, capability_identity, data])).toEqual([
    ["capability.completed", null, "admin/admin.whoami", {}],
    ["capability.denied", "role_below_minimum", "admin/organisations.list", { held: null, needed: "team" }],
  ])
})

test("answerable-team through a group entitlement on the admin MCP's resource lists whoami and every read", async () => {
  const { staff } = await admin()
  const client = await staff(["admin", "answerable-team"]).connect()
  expect(await names(client)).toEqual(["admin_whoami", ...reads])
  expect((await client.callTool({ name: "admin_whoami", arguments: {} })).structuredContent).toMatchObject({ role: "team", nextStep: null, tools: ["admin_whoami", ...reads] })
})

test("the highest role held counts; a role on another resource, through one client only, or an unknown string confers nothing", async () => {
  const { staff, id, platform } = await admin()
  const person = staff(["admin", "answerable-team", "answerable-owner"])
  const client = await person.connect()
  expect((await client.callTool({ name: "admin_whoami", arguments: {} })).structuredContent).toMatchObject({ role: "owner" })
  for (const targets of [
    [{ kind: "resource" as const, id: "https://toolbox.test/mcp", scopes: ["answerable-owner"] }],
    [{ kind: "client_resource" as const, id: "test-client", resource, scopes: ["answerable-owner"] }],
    [{ kind: "resource" as const, id: resource, scopes: ["admin", "answerable-root", "Answerable-Owner", "answerable-owner "] }],
  ]) {
    id.grant(platform, person.member.id, targets)
    expect(await names(client)).toEqual(["admin_whoami"])
  }
})

test("a role change in ID shows on the next request with the same token, and each request reads the role once however many tools it decides", async () => {
  const { staff, id } = await admin()
  const person = staff(["admin"])
  const client = await person.connect()
  expect(await names(client)).toEqual(["admin_whoami"])
  expect(accessReads(id)).toBe(1)
  person.holds(["admin", "answerable-team"])
  expect(await names(client)).toEqual(["admin_whoami", ...reads])
  expect(accessReads(id)).toBe(2)
  await client.callTool({ name: "organisations_list", arguments: {} })
  expect(accessReads(id)).toBe(3)
  person.holds(["admin"])
  expect(await names(client)).toEqual(["admin_whoami"])
  expect(accessReads(id)).toBe(4)
})

test("a member ID no longer knows has no role", async () => {
  const { mcp, platform } = await admin()
  const client = await mcp.connect({ organizationId: platform })
  expect(await names(client)).toEqual(["admin_whoami"])
})

test("a token without the admin scope gets no tools, recorded as denied: missing_scope", async () => {
  const { staff, mcp, platform } = await admin()
  const person = staff(["admin", "answerable-owner"])
  const client = await mcp.connect({ organizationId: platform, membershipId: person.member.id, userId: String(person.member.userId), scopes: ["offline_access"] })
  expect(await names(client)).toEqual([])
  await expect(client.callTool({ name: "admin_whoami", arguments: {} })).rejects.toThrow("Tool admin_whoami not found")
  expect((await events(platform)).map(({ reason, data }) => [reason, data])).toEqual([["missing_scope", { missing: ["admin"] }]])
})

test("when ID cannot say what a member may use, a list fails and a call answers UPSTREAM_UNAVAILABLE; nothing is served from memory", async () => {
  const { staff, id } = await admin()
  const client = await staff(["admin", "answerable-owner"]).connect()
  expect(await names(client)).toEqual(ownerTools)
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const fail of [() => id.outage(true), () => { id.outage(false); id.unreachable(true) }]) {
      fail()
      await expect(client.listTools()).rejects.toThrow()
      expect(errorOf(await client.callTool({ name: "admin_whoami", arguments: {} }))).toMatchObject({
        code: "UPSTREAM_UNAVAILABLE", message: "Answerable ID did not answer with your role; try again shortly", retry: { policy: "after_delay" },
      })
    }
    expect(log).toHaveBeenCalledWith("[admin] reading the role failed", expect.anything())
  } finally { log.mockRestore() }
})

test("every call leaves one evidence row on the platform organisation's chain, and every ID call it makes carries its execution id as x-request-id", async () => {
  const { staff, id, platform } = await admin()
  const person = staff(["admin", "answerable-team"])
  const organisation = id.organisation(crypto.randomUUID())
  id.domain(organisation.id, "newco.example")
  const client = await person.connect()
  await client.callTool({ name: "organisations_get", arguments: { organizationId: organisation.id } })
  const missing = errorOf(await client.callTool({ name: "organisations_get", arguments: { organizationId: crypto.randomUUID() } }))
  const rows = await events(platform)
  expect(rows).toEqual([
    {
      kind: "capability.completed", outcome: "success", actor_id: person.member.userId, client_id: "test-client", capability_identity: "admin/organisations.get",
      capability_version: "2026-10-01", reason: null, error_code: null, data: {}, execution_id: expect.any(String), request_id: expect.any(String), upstream: "id",
    },
    expect.objectContaining({ kind: "capability.completed", outcome: "failure", error_code: "NOT_FOUND", execution_id: missing.request_id }),
  ])
  const executed = id.received.filter(({ request }) => request.includes(`/organizations/${organisation.id}`))
  expect(executed.map(({ request }) => request)).toEqual([
    `GET /api/admin/v1/organizations/${organisation.id}`,
    `GET /api/admin/v1/organizations/${organisation.id}/domains?limit=200`,
    `GET /api/admin/v1/organizations/${organisation.id}/sso-provider`,
  ])
  expect(new Set(executed.map(({ requestId }) => requestId))).toEqual(new Set([rows[0].execution_id]))
  expect(await createEvidence(db).verify(platform)).toEqual({ ok: true, length: 2 })
})

test("health answers ok only while the database answers", async () => {
  const own = new SQL({ url: testDatabaseUrl, max: 1 })
  const id = createFakeId({ clientId: "admin-mcp" })
  const server = createAdminMcp({ auth: { issuer: "https://id.test", resource }, db: own, id: createIdAdmin(id.config), platform: id.organizationId })
  const health = async () => {
    const response = await server.fetch(new Request("https://mcp.test/health"))
    return [response.status, await response.json()]
  }
  expect(await health()).toEqual([200, { status: "ok" }])
  await own.close()
  expect(await health()).toEqual([503, { status: "unavailable" }])
})

type Client = Awaited<ReturnType<TestMcp["connect"]>>
type Prepared = { intent_id: string; commit_token: string; commit_tool: string; targets: { resource_id: string; version: { value: string } }[]; preview: { summary: string } }
const call = async (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
const prepared = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = await call(client, name, args)
  if (answer.isError) throw new Error(JSON.stringify(errorOf(answer)))
  return answer.structuredContent as Prepared
}
const confirm = (client: Client, intent: Prepared, summary = intent.preview.summary) =>
  call(client, "admin_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: summary })
const planKey = async (intent: Prepared) => (await db`select plan->>'key' as key from intents where intent_id = ${intent.intent_id}`)[0].key as string
const writesTo = (id: FakeId, request: string) => id.received.filter(item => item.request === request)

test("a team member sees no write and no commit tool; an admin the ordinary writes; an owner every write; an admin calling an owner tool gets the unknown-tool error and a capability.denied row", async () => {
  const { staff, platform } = await admin()
  expect(await names(await staff(["admin", "answerable-team"]).connect())).toEqual(["admin_whoami", ...reads])
  const operator = await staff(["admin", "answerable-admin"]).connect()
  expect(await names(operator)).toEqual(adminTools)
  expect((await call(operator, "admin_whoami", {})).structuredContent).toMatchObject({ role: "admin", tools: adminTools })
  expect(await names(await staff(["admin", "answerable-owner"]).connect())).toEqual(ownerTools)
  await expect(call(operator, "organisations_disable", { organizationId: crypto.randomUUID() })).rejects.toThrow("Tool organisations_disable not found")
  expect((await events(platform)).filter(row => row.kind === "capability.denied").map(({ capability_identity, reason, data }) => [capability_identity, reason, data])).toEqual([
    ["admin/organisations.disable", "role_below_minimum", { held: "admin", needed: "owner" }],
  ])
})

test("a controlled intent commits only through admin_commit_confirmed with its summary word for word, once, with the plan's key, the commit's execution id and the bound ETag, and the receipt names ID's operation", async () => {
  const { staff, id, platform, answers } = await admin()
  const newco = id.organisation(Bun.randomUUIDv7(), { name: "Newco", slug: "newco" })
  const client = await staff(["admin", "answerable-admin"]).connect()
  const intent = await prepared(client, "organisations_update", { organizationId: newco.id, name: "Newco Ltd" })
  expect(intent).toMatchObject({ commit_tool: "admin_commit_confirmed", targets: [{ resource_id: newco.id, version: { value: `"${newco.id}:1"` } }] })
  const refused = errorOf(await call(client, "admin_commit", { intent_id: intent.intent_id, commit_token: intent.commit_token }))
  expect(refused).toMatchObject({ code: "APPROVAL_REQUIRED", details: { approval: { class: "controlled", commit_tool: "admin_commit_confirmed" } } })
  expect(errorOf(await confirm(client, intent, "Update organisation Newco"))).toMatchObject({ code: "APPROVAL_REQUIRED", message: expect.stringContaining("preview_summary differs") })
  const receipt = (await confirm(client, intent)).structuredContent as { results: { operationId: string }; idempotent_replay: boolean }
  const [patch] = writesTo(id, `PATCH /api/admin/v1/organizations/${newco.id}`)
  const committing = (await events(platform)).findLast(row => row.capability_identity === "admin/commit_confirmed")!
  expect(patch).toEqual({
    request: `PATCH /api/admin/v1/organizations/${newco.id}`, requestId: committing.execution_id, idempotencyKey: await planKey(intent), ifMatch: `"${newco.id}:1"`, ifNoneMatch: null,
  })
  expect(receipt).toMatchObject({ results: { organizationId: newco.id, operationId: answers.find(answer => answer.request === `PATCH /api/admin/v1/organizations/${newco.id}`)!.operationId }, idempotent_replay: false })
  const again = (await confirm(client, intent)).structuredContent
  expect(again).toEqual({ ...receipt, idempotent_replay: true })
  expect(writesTo(id, `PATCH /api/admin/v1/organizations/${newco.id}`)).toHaveLength(1)
  expect((await events(platform)).map(({ kind, outcome, error_code, capability_identity }) => [kind, outcome, error_code, capability_identity])).toEqual([
    ["intent.prepared", "success", null, "admin/organisations.update"],
    ["capability.completed", "success", null, "admin/organisations.update"],
    ["capability.completed", "failure", "APPROVAL_REQUIRED", "admin/commit"],
    ["capability.completed", "failure", "APPROVAL_REQUIRED", "admin/commit_confirmed"],
    ["intent.committed", "success", null, "admin/organisations.update"],
    ["receipt.issued", "success", null, "admin/organisations.update"],
    ["capability.completed", "success", null, "admin/commit_confirmed"],
    ["capability.completed", "success", null, "admin/commit_confirmed"],
  ])
  expect(await createEvidence(db).verify(platform)).toEqual({ ok: true, length: 8 })
})

test("a target moved between prepare and commit answers INTENT_STALE with both ETags, writes nothing and records intent.stale", async () => {
  const { staff, id, platform } = await admin()
  const newco = id.organisation(Bun.randomUUIDv7(), { name: "Newco", slug: "newco" })
  const client = await staff(["admin", "answerable-admin"]).connect()
  const intent = await prepared(client, "organisations_update", { organizationId: newco.id, name: "Newco Ltd" })
  id.revise(newco.id)
  expect(errorOf(await confirm(client, intent))).toMatchObject({
    code: "INTENT_STALE", retry: { policy: "after_reprepare" }, details: { targets: [{ resource_id: newco.id, expected: `"${newco.id}:1"`, current: `"${newco.id}:2"` }] },
  })
  expect(writesTo(id, `PATCH /api/admin/v1/organizations/${newco.id}`)).toEqual([])
  expect((await events(platform)).map(row => row.kind)).toContain("intent.stale")
})

test("the plan's key survives a write whose answer is lost, which ID replays once without a second organisation, and a commit resent after a 401", async () => {
  const { staff, id, lose, answers } = await admin()
  const client = await staff(["admin", "answerable-admin"]).connect()
  const creates = () => writesTo(id, "POST /api/admin/v1/organizations")
  const answered = () => answers.filter(answer => answer.request === "POST /api/admin/v1/organizations")
  const lost = await prepared(client, "organisations_create", { slug: "lost", name: "Lost" })
  lose()
  const receipt = (await confirm(client, lost)).structuredContent as { results: { organizationId: string; operationId: string } }
  expect(creates().map(item => item.idempotencyKey)).toEqual([await planKey(lost), await planKey(lost)])
  const [first, replay] = answered()
  expect([first!.replayed, replay!.replayed, replay!.operationId]).toEqual([false, true, first!.operationId])
  expect(receipt.results).toMatchObject({ operationId: first!.operationId })
  const made = (await call(client, "organisations_list", { q: "lost" })).structuredContent as { items: { id: string; slug: string }[] }
  expect(made.items.map(item => [item.id, item.slug])).toEqual([[receipt.results.organizationId, "lost"]])
  // Every token ID issued so far is revoked: the write is refused once, then sent again with a new token and the same key.
  const renewed = await prepared(client, "organisations_create", { slug: "renewed", name: "Renewed" })
  id.revoke()
  await confirm(client, renewed)
  expect(creates().slice(2).map(item => item.idempotencyKey)).toEqual([await planKey(renewed), await planKey(renewed)])
  expect(answered().slice(2).map(answer => answer.status)).toEqual([401, 201])
})

test("demoting the person between prepare and commit refuses the commit: an admin no longer covers an owner's intent, and a team member has no commit tool", async () => {
  const { staff, id } = await admin()
  const newco = id.organisation(Bun.randomUUIDv7(), { name: "Newco", slug: "newco" })
  const owner = staff(["admin", "answerable-owner"])
  const client = await owner.connect()
  const intent = await prepared(client, "organisations_disable", { organizationId: newco.id })
  owner.holds(["admin", "answerable-admin"])
  expect(errorOf(await confirm(client, intent))).toMatchObject({ code: "PERMISSION_DENIED", message: "Your access no longer covers admin/organisations.disable" })
  owner.holds(["admin", "answerable-team"])
  await expect(confirm(client, intent)).rejects.toThrow("Tool admin_commit_confirmed not found")
  owner.holds(["admin", "answerable-owner"])
  expect((await confirm(client, intent)).structuredContent).toMatchObject({ results: { organizationId: newco.id, status: "disabled" } })
})

test("a critical operation needs a directory sign-in within the window: older or none answers ADMIN_REAUTHENTICATION_REQUIRED with the remedy, recorded as a denial; an intent prepared in time cannot commit once it is past", async () => {
  const { staff, id, platform } = await admin({ freshSeconds: 60 })
  const newco = id.organisation(Bun.randomUUIDv7(), { name: "Newco", slug: "newco" })
  const owner = staff(["admin", "answerable-owner"])
  const client = await owner.connect()
  const now = Math.floor(Date.now() / 1000)
  owner.signedInAt(now - 120)
  const stale = errorOf(await call(client, "organisations_disable", { organizationId: newco.id }))
  expect(stale).toEqual({
    code: "ADMIN_REAUTHENTICATION_REQUIRED", retry: { policy: "after_state_change" }, request_id: expect.any(String),
    details: { upstream_auth_time: now - 120, max_age_seconds: 60 },
    message: `This operation needs a sign-in at your company's directory within the last minute; yours is from ${new Date((now - 120) * 1000).toISOString()}. In the browser you use for Answerable ID, open https://id.test/security and choose Verify sign-in; then, in your host, clear this server's authentication and authenticate again (Claude Code: /mcp, choose this server, Clear authentication, then Authenticate). Refreshing the token does not help: it keeps the sign-in time of the authorisation it belongs to.`,
  })
  owner.signedInAt(null)
  expect(errorOf(await call(client, "staff_grant", { memberId: owner.member.id, role: "team" }))).toMatchObject({
    code: "ADMIN_REAUTHENTICATION_REQUIRED", message: expect.stringContaining("your token carries no sign-in time"), details: { upstream_auth_time: null, max_age_seconds: 60 },
  })
  expect((await events(platform)).filter(row => row.kind === "capability.denied").map(({ capability_identity, reason, outcome, data }) => [capability_identity, reason, outcome, data])).toEqual([
    ["admin/organisations.disable", "stale_authentication", "denied", { upstream_auth_time: now - 120, max_age_seconds: 60 }],
    ["admin/staff.grant", "stale_authentication", "denied", { upstream_auth_time: null, max_age_seconds: 60 }],
  ])
  owner.signedInAt(now)
  const intent = await prepared(client, "organisations_disable", { organizationId: newco.id })
  setSystemTime(Date.now() + 61_000)
  expect(errorOf(await confirm(client, intent))).toMatchObject({ code: "ADMIN_REAUTHENTICATION_REQUIRED" })
  expect(writesTo(id, `POST /api/admin/v1/organizations/${newco.id}/disable`)).toEqual([])
})

test("every write to the platform organisation is an owner's critical operation, whatever the tool's own minimum", async () => {
  const { staff, id, platform } = await admin({ freshSeconds: 60 })
  const world = seed(id)
  const recruit = world.staffer("recruit@answerable.test")
  const args = { organizationId: platform, groupId: world.roles.owner.group.id, memberId: recruit.id }
  const operator = await staff(["admin", "answerable-admin"]).connect()
  expect(errorOf(await call(operator, "groups_addmember", args))).toMatchObject({
    code: "PERMISSION_DENIED", message: "Changing the platform organisation is an owner's critical operation: it decides who is staff and how staff sign in",
  })
  const owner = staff(["admin", "answerable-owner"])
  const client = await owner.connect()
  expect((await prepared(client, "groups_addmember", args)).preview.summary).toBe("Add recruit@answerable.test to group “Founders” in organisation “Answerable” (answerable)")
  owner.signedInAt(Math.floor(Date.now() / 1000) - 120)
  expect(errorOf(await call(client, "sso_set", { organizationId: platform, issuer: "https://accounts.google.com", domain: "answerable.test" })).code).toBe("ADMIN_REAUTHENTICATION_REQUIRED")
  expect(id.received.filter(({ request }) => !request.startsWith("GET"))).toEqual([])
})

test("an owner taking their own last owner role is warned twice, and the evidence of a Toolbox call names the Toolbox", async () => {
  const { id, platform, connectAs } = await admin()
  const world = seed(id)
  const owner = world.staffer("only@answerable.test", ["owner"])
  const client = await connectAs(owner)
  const intent = await prepared(client, "staff_revoke", { memberId: owner.id, role: "owner" }) as Prepared & { preview: { warnings: string[] } }
  expect(intent.preview.warnings.slice(0, 2)).toEqual([
    "No other owner remains: only Answerable ID's admin API, with root or a platform administrator's token, can make an owner again.",
    "You are removing your own role: your next request has only the role that remains.",
  ])
  await prepared(client, "toolbox_enable", { organizationId: world.newco.id, hostClientIds: ["claude-code-toolbox"], providers: ["e2e"] })
  expect((await events(platform)).filter(row => row.kind === "capability.completed").map(({ capability_identity, upstream }) => [capability_identity, upstream])).toEqual([
    ["admin/staff.revoke", "id"], ["admin/toolbox.enable", "toolbox"],
  ])
})
