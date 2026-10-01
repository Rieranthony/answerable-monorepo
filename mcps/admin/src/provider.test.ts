import { afterEach, expect, spyOn, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { assertProviderConformance, createTestMcp, errorOf, type TestMcp } from "@answerable/mcp/testing"
import { createAdminProvider } from "./provider"
import { createRoles } from "./roles"
import { resource } from "./test/admin"

const toolbox = "https://toolbox.test/mcp"

// ID holding one client organisation, Newco, with a domain, a Microsoft SSO provider, a member in a group and an entitlement; and platform staff.
function fixture(config: { clientSecret?: string } = {}) {
  const id = createFakeId({ clientId: "admin-mcp" })
  const platform = id.organizationId
  const admin = createIdAdmin({ ...id.config, ...config })
  const { provider } = createAdminProvider({ id: admin, authority: createRoles({ id: admin, platform, resource }), platform, resource })
  const newco = id.organisation(crypto.randomUUID(), { name: "Newco", slug: "newco", metadata: "{\"plan\":\"pilot\"}" })
  const domain = id.domain(newco.id, "newco.example")
  id.ssoProvider(newco.id, { issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-00000000000a/v2.0", domain: "newco.example" })
  const ada = id.member(newco.id, { email: "ada@newco.example", name: "Ada Lovelace" })
  const engineers = id.group(newco.id, { slug: "engineers", name: "Engineers" })
  id.join(engineers.id, ada.id)
  const via = { entitlementId: crypto.randomUUID(), principal: "group" as const, groupId: engineers.id }
  id.grant(newco.id, ada.id, [{ kind: "client_resource", id: "claude-code-toolbox", resource: toolbox, scopes: ["e2e", "toolbox"], via: [via] }])
  const everyone = id.entitlement(newco.id, { clientId: "claude-code-toolbox", resource: toolbox, scopes: ["toolbox"] })
  const grouped = id.entitlement(newco.id, { groupId: engineers.id, resource: toolbox, scopes: ["e2e"] })
  const created = id.event("organization.created", newco.id, { targetType: "organization", targetId: newco.id, requestId: crypto.randomUUID(), operationId: crypto.randomUUID() })
  return { id, platform, provider, newco, domain, ada, engineers, via, everyone, grouped, created }
}

const world = fixture()
assertProviderConformance(world.provider, {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: {
    "admin.whoami": {},
    "organisations.list": { q: "newco" },
    "organisations.get": { organizationId: world.newco.id },
    "members.list": { organizationId: world.newco.id },
    "members.get": { organizationId: world.newco.id, memberId: world.ada.id },
    "groups.list": { organizationId: world.newco.id },
    "access.list": { organizationId: world.newco.id },
    "audit.list": { organizationId: world.newco.id },
    "sso.test": { organizationId: world.newco.id },
    "staff.list": {},
  },
})

const servers: TestMcp[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(mcp => mcp.close())) })
async function connect(provider: typeof world.provider) {
  const mcp = await createTestMcp(provider)
  servers.push(mcp)
  const client = await mcp.connect()
  return async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args })
}
const content = async (answer: Promise<{ structuredContent?: unknown }>) => (await answer).structuredContent

test("organisations_list filters by text and status and pages with ID's cursor", async () => {
  const { id, provider, newco } = fixture()
  const call = await connect(provider)
  expect(await content(call("organisations_list", { q: "NEWCO", status: "active" }))).toEqual({
    items: [{ id: newco.id, slug: "newco", name: "Newco", status: "active", createdAt: newco.createdAt }], next_cursor: null, has_more: false,
  })
  for (const slug of ["pager-a", "pager-b", "pager-c"]) id.organisation(Bun.randomUUIDv7(), { slug, name: slug })
  const first = await content(call("organisations_list", { q: "pager", limit: 2 })) as { items: { slug: string }[]; next_cursor: string; has_more: boolean }
  expect([first.items.map(item => item.slug), first.has_more]).toEqual([["pager-c", "pager-b"], true])
  const second = await content(call("organisations_list", { q: "pager", limit: 2, cursor: first.next_cursor })) as typeof first
  expect<unknown>([second.items.map(item => item.slug), second.next_cursor, second.has_more]).toEqual([["pager-a"], null, false])
  expect(id.requests.filter(request => request.includes("/organizations?"))).toEqual([
    "GET /api/admin/v1/organizations?q=NEWCO&status=active&limit=20",
    "GET /api/admin/v1/organizations?q=pager&limit=2",
    `GET /api/admin/v1/organizations?q=pager&limit=2&cursor=${first.next_cursor}`,
  ])
  expect(errorOf(await call("organisations_list", { limit: 101 }))).toMatchObject({ code: "INVALID_INPUT" })
})

test("organisations_get gives the organisation, its domains and its SSO provider summary, or sso null when it has none", async () => {
  const { id, provider, newco, domain } = fixture()
  const call = await connect(provider)
  expect(await content(call("organisations_get", { organizationId: newco.id }))).toEqual({
    id: newco.id, slug: "newco", name: "Newco", status: "active", logo: null, metadata: "{\"plan\":\"pilot\"}", disabledAt: null,
    createdAt: newco.createdAt, updatedAt: newco.updatedAt,
    domains: [{ id: domain.id, domain: "newco.example", status: "active" }],
    sso: { issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-00000000000a/v2.0", domain: "newco.example", oidc: { credentials: "platform", hasClientSecret: false } },
  })
  const bare = id.organisation(crypto.randomUUID(), { status: "disabled", disabledAt: "2026-10-01T09:00:00.000Z" })
  expect(await content(call("organisations_get", { organizationId: bare.id }))).toMatchObject({ status: "disabled", disabledAt: "2026-10-01T09:00:00.000Z", domains: [], sso: null })
  const unknown = crypto.randomUUID()
  expect(errorOf(await call("organisations_get", { organizationId: unknown }))).toMatchObject({
    code: "NOT_FOUND", message: `Answerable ID has no organisation ${unknown}; organisations_list lists them`, retry: { policy: "never" },
  })
})

test("organisations_get reads every page of domains", async () => {
  const { id, provider, newco } = fixture()
  for (let index = 0; index < 250; index++) id.domain(newco.id, `d${index}.newco.example`)
  const call = await connect(provider)
  expect(((await content(call("organisations_get", { organizationId: newco.id }))) as { domains: unknown[] }).domains).toHaveLength(251)
})

test("members_list filters by email, text and effectiveness; members_get gives the member, their groups and their access", async () => {
  const { id, provider, newco, ada, engineers, via } = fixture()
  const grace = id.member(newco.id, { email: "grace@newco.example", name: "Grace Hopper", effective: false, status: "disabled" })
  const call = await connect(provider)
  const row = (member: typeof ada) => ({ id: member.id, userId: member.userId, email: member.email, name: member.name, status: member.status, membershipStatus: "active", effective: member.effective })
  expect(await content(call("members_list", { organizationId: newco.id }))).toEqual({ items: [row(grace), row(ada)], next_cursor: null, has_more: false })
  expect(await content(call("members_list", { organizationId: newco.id, email: "ada@newco.example" }))).toMatchObject({ items: [row(ada)] })
  expect(await content(call("members_list", { organizationId: newco.id, q: "hopper" }))).toMatchObject({ items: [row(grace)] })
  expect(await content(call("members_list", { organizationId: newco.id, effective: false }))).toMatchObject({ items: [row(grace)] })
  expect(await content(call("members_get", { organizationId: newco.id, memberId: ada.id }))).toEqual({
    ...row(ada), validFrom: null, validUntil: null, createdAt: ada.createdAt,
    groups: [{ groupId: engineers.id, slug: "engineers", name: "Engineers", validFrom: null, validUntil: null }],
    access: [{ kind: "client_resource", id: "claude-code-toolbox", resource: toolbox, scopes: ["e2e", "toolbox"], via: [via] }],
  })
  const unknown = crypto.randomUUID()
  expect(errorOf(await call("members_get", { organizationId: newco.id, memberId: unknown }))).toMatchObject({
    code: "NOT_FOUND", message: `Answerable ID has no member ${unknown} in organisation ${newco.id}; members_list lists them`,
  })
  expect(errorOf(await call("members_list", { organizationId: unknown }))).toMatchObject({ code: "NOT_FOUND", message: `Answerable ID has no organisation ${unknown}; organisations_list lists them` })
})

test("groups_list and access_list list an organisation's groups and entitlements, with the principal each entitlement names", async () => {
  const { id, provider, newco, engineers, everyone, grouped, ada } = fixture()
  const direct = id.entitlement(newco.id, { memberId: ada.id, resource: toolbox, scopes: ["e2e/records.list"], status: "disabled", validUntil: "2026-12-31T00:00:00.000Z" })
  const call = await connect(provider)
  expect(await content(call("groups_list", { organizationId: newco.id, q: "engin", status: "active" }))).toEqual({
    items: [{ id: engineers.id, slug: "engineers", name: "Engineers", status: "active", externalId: null }], next_cursor: null, has_more: false,
  })
  const entitlement = ({ id, memberId, groupId, clientId, resource, scopes, status, validFrom, validUntil }: typeof everyone) => ({ id, memberId, groupId, clientId, resource, scopes, status, validFrom, validUntil })
  expect(await content(call("access_list", { organizationId: newco.id }))).toEqual({ items: [entitlement(direct), entitlement(grouped), entitlement(everyone)], next_cursor: null, has_more: false })
  expect(await content(call("access_list", { organizationId: newco.id, groupId: engineers.id, resource: toolbox }))).toMatchObject({ items: [{ id: grouped.id }] })
  expect(id.requests.at(-1)).toBe(`GET /api/admin/v1/organizations/${newco.id}/entitlements?resource=${encodeURIComponent(toolbox)}&groupId=${engineers.id}&limit=20`)
})

test("audit_list carries each event's request id and operation id, filters at ID, and reads every organisation without organizationId", async () => {
  const { id, provider, newco, created } = fixture()
  const other = id.event("organization.updated", crypto.randomUUID(), { actorType: "user", actorId: "someone" })
  const call = await connect(provider)
  const item = ({ id, occurredAt, action, outcome, actorType, actorId, organizationId, targetType, targetId, reason, requestId, operationId }: typeof created) =>
    ({ id, occurredAt, action, outcome, actorType, actorId, organizationId, targetType, targetId, reason, requestId, operationId })
  expect(await content(call("audit_list", { organizationId: newco.id }))).toEqual({ items: [item(created)], next_cursor: null, has_more: false })
  expect(await content(call("audit_list", {}))).toEqual({ items: [item(other), item(created)], next_cursor: null, has_more: false })
  const filters = { organizationId: newco.id, action: "organization.created", actorId: "admin-mcp", operationId: created.operationId, outcome: "success", targetType: "organization", targetId: newco.id, from: "2026-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z" }
  expect(await content(call("audit_list", filters))).toMatchObject({ items: [item(created)] })
  expect(id.requests.at(-1)).toBe(`GET /api/admin/v1/audit-events?organizationId=${newco.id}&action=organization.created&actorId=admin-mcp&operationId=${created.operationId}&outcome=success&targetType=organization&targetId=${newco.id}&from=2026-01-01T00%3A00%3A00Z&to=2099-01-01T00%3A00%3A00Z&limit=20`)
  expect(await content(call("audit_list", { action: "organization.erased" }))).toEqual({ items: [], next_cursor: null, has_more: false })
})

test("sso_test reports ID's connectivity test of the organisation's provider, and NOT_FOUND without one", async () => {
  const { id, provider, newco } = fixture()
  const call = await connect(provider)
  const issuer = "https://login.microsoftonline.com/00000000-0000-0000-0000-00000000000a/v2.0"
  expect(await content(call("sso_test", { organizationId: newco.id }))).toEqual({
    issuer, kind: "entra",
    discovery: {
      url: `${issuer}/.well-known/openid-configuration`, reachable: true, status: 200, issuerMatches: true,
      authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/keys`,
    },
    jwks: { reachable: true, keys: 1 }, elapsedMs: 12, problems: [],
  })
  const local = id.organisation(crypto.randomUUID())
  id.ssoProvider(local.id, { issuer: "http://127.0.0.1:47602", domain: "local.example", oidc: { credentials: "own", clientId: "local", hasClientSecret: true } })
  expect(await content(call("sso_test", { organizationId: local.id }))).toMatchObject({ kind: "oidc", discovery: { reachable: false, status: null }, problems: [{ code: "insecure_issuer", detail: "The issuer must use HTTPS" }] })
  const bare = id.organisation(crypto.randomUUID())
  expect(errorOf(await call("sso_test", { organizationId: bare.id }))).toMatchObject({
    code: "NOT_FOUND", message: `Organisation ${bare.id} has no SSO provider in Answerable ID, or does not exist; organisations_get shows its SSO provider`,
  })
})

test("staff_list gives every member of the platform organisation who can reach the admin MCP with their role, whatever their groups are called", async () => {
  const { id, provider, platform } = fixture()
  // The team role is held through a group called support: the entitlement on the admin MCP's resource confers it, not the group's slug.
  const support = id.group(platform, { slug: "support" })
  const staff = (name: string, scopes: string[]) => {
    const member = id.member(platform, { email: `${name}@answerable.test`, name })
    id.join(support.id, member.id)
    id.grant(platform, member.id, [
      { kind: "resource", id: resource, scopes, via: [{ entitlementId: crypto.randomUUID(), principal: "group", groupId: support.id }] },
      { kind: "client_resource", id: "claude-code-admin", resource, scopes: ["answerable-owner"] },
    ])
    return member
  }
  const owner = staff("owner", ["admin", "answerable-owner", "answerable-team"])
  const helper = staff("helper", ["admin", "answerable-team"])
  const newcomer = staff("newcomer", ["admin"])
  id.member(platform, { email: "elsewhere@answerable.test" })
  const call = await connect(provider)
  const row = (member: typeof owner, role: string | null) => ({ memberId: member.id, userId: member.userId, email: member.email, name: member.name, role })
  expect(await content(call("staff_list", {}))).toEqual({ items: [row(newcomer, null), row(helper, "team"), row(owner, "owner")], next_cursor: null, has_more: false })
  const first = await content(call("staff_list", { limit: 2 })) as { next_cursor: string }
  expect(await content(call("staff_list", { limit: 2, cursor: first.next_cursor }))).toEqual({ items: [row(owner, "owner")], next_cursor: null, has_more: false })
  expect(id.requests.at(-1)).toBe(`GET /api/admin/v1/organizations/${platform}/access?resource=${encodeURIComponent(resource)}&limit=2&cursor=${first.next_cursor}`)
})

test("ID failing answers UPSTREAM_UNAVAILABLE, and ID refusing the machine client UPSTREAM_REJECTED with ID's status, never an empty success", async () => {
  const { id, provider } = fixture()
  const call = await connect(provider)
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    id.outage(true)
    expect(errorOf(await call("organisations_list"))).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: "Answerable ID did not answer; try again shortly", retry: { policy: "after_delay" } })
    id.outage(false)
    id.unreachable(true)
    expect(errorOf(await call("staff_list"))).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" })
    const refused = await connect(fixture({ clientSecret: "wrong" }).provider)
    expect(errorOf(await refused("organisations_list"))).toMatchObject({
      code: "UPSTREAM_REJECTED", message: expect.stringContaining("Answerable ID refused the client credentials of admin-mcp (401)"), retry: { policy: "never" },
      details: { upstream: { status: 401, code: null } },
    })
    expect(log).toHaveBeenCalledWith("[admin] Answerable ID failed", expect.anything())
  } finally { log.mockRestore() }
})
