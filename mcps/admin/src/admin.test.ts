import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { SQL } from "bun"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { errorOf, type TestMcp } from "@answerable/mcp/testing"
import { createEvidence } from "@answerable/mcp-postgres"
import { createAdminMcp } from "./admin"
import { createAdmin, resource } from "./test/admin"
import { testDatabase, testDatabaseUrl } from "./test/database"

const db = testDatabase()
afterAll(() => db.close())
const admins: Awaited<ReturnType<typeof createAdmin>>[] = []
afterEach(async () => { await Promise.all(admins.splice(0).map(admin => admin.mcp.close())) })
async function admin() {
  const created = await createAdmin(db)
  admins.push(created)
  return created
}

const names = async (client: Awaited<ReturnType<TestMcp["connect"]>>) => (await client.listTools()).tools.map(tool => tool.name)
const reads = ["organisations_list", "organisations_get", "members_list", "members_get", "groups_list", "access_list", "audit_list", "sso_test", "staff_list"]
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
  expect(await names(client)).toEqual(["admin_whoami", ...reads])
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
