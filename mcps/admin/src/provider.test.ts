import { afterEach, expect, spyOn, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { assertProviderConformance, createTestMcp, errorOf, type TestMcp } from "@answerable/mcp/testing"
import { createAdminProvider } from "./provider"
import { createRoles } from "./roles"
import { createIdFake, createFakeToolbox, entraIssuer, resource, toolboxResource } from "./test/admin"
import { createToolboxAdmin } from "./toolbox"

const toolbox = "https://toolbox.test/mcp"

// ID holding one client organisation, Newco, with a domain, a Microsoft SSO provider, a member in a group and an entitlement; and platform staff.
function fixture(config: { clientSecret?: string } = {}) {
  const id = createIdFake()
  const platform = id.organizationId
  const admin = createIdAdmin({ ...id.config, ...config })
  const { provider } = createAdminProvider({
    id: admin, authority: createRoles({ id: admin, platform, resource }), platform, resource, issuer: "https://id.test", freshSeconds: 1800,
    toolbox: createToolboxAdmin({ id: admin, resource: toolboxResource, fetch: createFakeToolbox(id).fetch }),
  })
  const newco = id.organisation(crypto.randomUUID(), { name: "Newco", slug: "newco", metadata: "{\"plan\":\"pilot\"}" })
  const domain = id.domain(newco.id, "newco.example")
  id.ssoProvider(newco.id, { issuer: entraIssuer, domain: "newco.example" })
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

// Every mutation's example makes what it acts on, so that each check prepares on a state of its own; moveTarget changes a target as another writer would.
const world = fixture()
const { id: ids, newco, engineers, platform } = world
ids.resource(toolbox, ["e2e", "toolbox"])
ids.client("claude-code-toolbox")
const team = ids.group(platform, { slug: "support", name: "Support" })
const teamRole = ids.entitlement(platform, { groupId: team.id, resource, scopes: ["answerable-team"] })
const unique = () => crypto.randomUUID().slice(0, 8)
const organisation = (fields: Record<string, unknown> = {}) => ids.organisation(Bun.randomUUIDv7(), { name: "Spare", slug: `spare-${unique()}`, ...fields }).id
const person = () => ids.member(newco.id, { email: `${unique()}@newco.example` }).id
function staffer(joined: boolean) {
  const member = ids.member(platform, { email: `${unique()}@answerable.test` })
  if (joined) ids.join(team.id, member.id)
  ids.grant(platform, member.id, joined ? [{ kind: "resource", id: resource, scopes: ["answerable-team"], via: [{ entitlementId: teamRole.id, principal: "group", groupId: team.id }] }] : [])
  return member.id
}
assertProviderConformance(world.provider, {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: {
    "admin.whoami": {},
    "organisations.list": { q: "newco" },
    "organisations.get": { organizationId: newco.id },
    "members.list": { organizationId: newco.id },
    "members.get": { organizationId: newco.id, memberId: world.ada.id },
    "groups.list": { organizationId: newco.id },
    "access.list": { organizationId: newco.id },
    "audit.list": { organizationId: newco.id },
    "sso.test": { organizationId: newco.id },
    "staff.list": {},
    "organisations.create": () => ({ slug: `created-${unique()}`, name: "Created" }),
    "organisations.update": () => ({ organizationId: organisation(), name: "Renamed" }),
    "organisations.disable": () => ({ organizationId: organisation() }),
    "organisations.enable": () => ({ organizationId: organisation({ status: "disabled" }) }),
    "domains.add": () => ({ organizationId: newco.id, domain: `${unique()}.newco.example` }),
    "sso.set": () => ({ organizationId: organisation(), issuer: entraIssuer, domain: "spare.example" }),
    "groups.create": () => ({ organizationId: newco.id, slug: `group-${unique()}`, name: "Group" }),
    "groups.addmember": () => ({ organizationId: newco.id, groupId: engineers.id, memberId: person() }),
    "groups.dropmember": () => {
      const memberId = person()
      ids.join(engineers.id, memberId)
      return { organizationId: newco.id, groupId: engineers.id, memberId }
    },
    "access.grant": () => ({ organizationId: newco.id, principal: { kind: "member", id: person() }, resource: toolbox, scopes: ["e2e"] }),
    "access.revoke": () => ({ organizationId: newco.id, entitlementId: ids.entitlement(newco.id, { memberId: person(), resource: toolbox, scopes: ["e2e"] }).id }),
    "access.enable": () => ({ organizationId: newco.id, entitlementId: ids.entitlement(newco.id, { memberId: person(), resource: toolbox, scopes: ["e2e"], status: "disabled" }).id }),
    "toolbox.enable": () => ({ organizationId: organisation(), hostClientIds: ["claude-code-toolbox"], providers: ["e2e"] }),
    "staff.grant": () => ({ memberId: staffer(false), role: "team" }),
    "staff.revoke": () => ({ memberId: staffer(true), role: "team" }),
  },
  moveTarget: target => ids.revise(target.resource_id),
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

test("each read sends its filters to ID as the query string and answers ID's rows in its own shape; what ID does not hold is NOT_FOUND, saying where to look", async () => {
  const { id, provider, platform, newco, domain, ada, engineers, via, everyone, grouped, created } = fixture()
  const grace = id.member(newco.id, { email: "grace@newco.example", name: "Grace Hopper", effective: false, status: "disabled" })
  const direct = id.entitlement(newco.id, { memberId: ada.id, resource: toolbox, scopes: ["e2e/records.list"], status: "disabled" })
  // A staff role is held through a group called support: the entitlement on the admin MCP's resource confers it, never the group's slug, and a grant through one client confers nothing.
  const support = id.group(platform, { slug: "support" })
  const staffer = (name: string, scopes: string[]) => {
    const member = id.member(platform, { email: `${name}@answerable.test`, name })
    id.grant(platform, member.id, [
      { kind: "resource", id: resource, scopes, via: [{ entitlementId: crypto.randomUUID(), principal: "group", groupId: support.id }] },
      { kind: "client_resource", id: "claude-code-admin", resource, scopes: ["answerable-owner"] },
    ])
    return member
  }
  const [owner, helper, newcomer] = [staffer("owner", ["admin", "answerable-owner", "answerable-team"]), staffer("helper", ["admin", "answerable-team"]), staffer("newcomer", ["admin"])]
  const call = await connect(provider)
  const at = (path: string) => `GET /api/admin/v1${path}`
  const person = (member: typeof ada) => ({ id: member.id, userId: member.userId, email: member.email, name: member.name, status: member.status, membershipStatus: "active", effective: member.effective })
  const entitlement = ({ id, memberId, groupId, clientId, resource, scopes, status, validFrom, validUntil }: typeof everyone) => ({ id, memberId, groupId, clientId, resource, scopes, status, validFrom, validUntil })
  const event = ({ id, occurredAt, action, outcome, actorType, actorId, organizationId, targetType, targetId, reason, requestId, operationId }: typeof created) =>
    ({ id, occurredAt, action, outcome, actorType, actorId, organizationId, targetType, targetId, reason, requestId, operationId })
  const staff = (member: typeof owner, role: string | null) => ({ memberId: member.id, userId: member.userId, email: member.email, name: member.name, role })
  const page = (items: unknown[]) => ({ items, next_cursor: null, has_more: false })
  const unknown = crypto.randomUUID()
  const bare = id.organisation(crypto.randomUUID()).id
  const audit = { organizationId: newco.id, action: "organization.created", actorId: "admin-mcp", operationId: String(created.operationId), outcome: "success", targetType: "organization", targetId: newco.id, from: "2026-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z" }
  // Each read: its arguments, what it asks ID, and what it answers.
  const reads: [string, Record<string, unknown>, string[], unknown][] = [
    ["organisations_list", { q: "NEWCO", status: "active" }, [at("/organizations?q=NEWCO&status=active&limit=20")], page([{ id: newco.id, slug: "newco", name: "Newco", status: "active", createdAt: newco.createdAt }])],
    ["organisations_get", { organizationId: newco.id }, [at(`/organizations/${newco.id}`), at(`/organizations/${newco.id}/domains?limit=200`), at(`/organizations/${newco.id}/sso-provider`)], {
      id: newco.id, slug: "newco", name: "Newco", status: "active", logo: null, metadata: "{\"plan\":\"pilot\"}", disabledAt: null, createdAt: newco.createdAt, updatedAt: newco.updatedAt,
      domains: [{ id: domain.id, domain: "newco.example", status: "active" }], sso: { issuer: entraIssuer, domain: "newco.example", oidc: { credentials: "platform", hasClientSecret: false } },
    }],
    ["organisations_get", { organizationId: bare }, [at(`/organizations/${bare}`), at(`/organizations/${bare}/domains?limit=200`), at(`/organizations/${bare}/sso-provider`)], expect.objectContaining({ domains: [], sso: null })],
    ["members_list", { organizationId: newco.id, q: "hopper", effective: false, limit: 5 }, [at(`/organizations/${newco.id}/members?q=hopper&effective=false&limit=5`)], page([person(grace)])],
    ["members_list", { organizationId: newco.id, email: "ada@newco.example" }, [at(`/organizations/${newco.id}/members?email=ada%40newco.example&limit=20`)], page([person(ada)])],
    ["members_get", { organizationId: newco.id, memberId: ada.id }, [at(`/organizations/${newco.id}/members/${ada.id}`), at(`/organizations/${newco.id}/members/${ada.id}/access`)], {
      ...person(ada), validFrom: null, validUntil: null, createdAt: ada.createdAt,
      groups: [{ groupId: engineers.id, slug: "engineers", name: "Engineers", validFrom: null, validUntil: null }],
      access: [{ kind: "client_resource", id: "claude-code-toolbox", resource: toolbox, scopes: ["e2e", "toolbox"], via: [via] }],
    }],
    ["groups_list", { organizationId: newco.id, q: "engin", status: "active" }, [at(`/organizations/${newco.id}/groups?q=engin&status=active&limit=20`)],
      page([{ id: engineers.id, slug: "engineers", name: "Engineers", status: "active", externalId: null }])],
    ["access_list", { organizationId: newco.id }, [at(`/organizations/${newco.id}/entitlements?limit=20`)], page([entitlement(direct), entitlement(grouped), entitlement(everyone)])],
    ["access_list", { organizationId: newco.id, groupId: engineers.id, resource: toolbox }, [at(`/organizations/${newco.id}/entitlements?resource=${encodeURIComponent(toolbox)}&groupId=${engineers.id}&limit=20`)], page([entitlement(grouped)])],
    ["audit_list", audit, [at(`/audit-events?${new URLSearchParams({ ...audit, limit: "20" })}`)], page([event(created)])],
    ["audit_list", {}, [at("/audit-events?limit=20")], page([event(created)])],
    ["sso_test", { organizationId: newco.id }, [at(`/organizations/${newco.id}/sso-provider/test`)], expect.objectContaining({ issuer: entraIssuer, kind: "entra", problems: [] })],
    ["staff_list", {}, [at(`/organizations/${platform}/access?resource=${encodeURIComponent(resource)}&limit=20`)], page([staff(newcomer, null), staff(helper, "team"), staff(owner, "owner")])],
  ]
  for (const [name, args, asked, answer] of reads) {
    const before = id.requests.length
    expect(await content(call(name, args)), name).toEqual(answer)
    expect(id.requests.slice(before).filter(request => request.startsWith("GET ")).toSorted(), name).toEqual(asked.toSorted())
  }
  const missingOrganisation = `Answerable ID has no organisation ${unknown}; organisations_list lists them`
  for (const [name, args, message] of [
    ["organisations_get", { organizationId: unknown }, missingOrganisation],
    ["members_list", { organizationId: unknown }, missingOrganisation],
    ["members_get", { organizationId: newco.id, memberId: unknown }, `Answerable ID has no member ${unknown} in organisation ${newco.id}; members_list lists them`],
    ["sso_test", { organizationId: bare }, `Organisation ${bare} has no SSO provider in Answerable ID, or does not exist; organisations_get shows its SSO provider`],
  ] as const) expect(errorOf(await call(name, args)), name).toMatchObject({ code: "NOT_FOUND", message, retry: { policy: "never" } })
  expect(errorOf(await call("organisations_list", { limit: 101 }))).toMatchObject({ code: "INVALID_INPUT" })
})

test("a list pages with ID's cursor, and a read that needs every row reads every page", async () => {
  const { id, provider, newco } = fixture()
  for (const slug of ["pager-a", "pager-b", "pager-c"]) id.organisation(Bun.randomUUIDv7(), { slug, name: slug })
  for (let index = 0; index < 250; index++) id.domain(newco.id, `d${index}.newco.example`)
  const call = await connect(provider)
  const first = await content(call("organisations_list", { q: "pager", limit: 2 })) as { items: { slug: string }[]; next_cursor: string; has_more: boolean }
  expect([first.items.map(item => item.slug), first.has_more]).toEqual([["pager-c", "pager-b"], true])
  const second = await content(call("organisations_list", { q: "pager", limit: 2, cursor: first.next_cursor })) as typeof first
  expect<unknown>([second.items.map(item => item.slug), second.next_cursor, second.has_more]).toEqual([["pager-a"], null, false])
  expect(id.requests.at(-1)).toBe(`GET /api/admin/v1/organizations?q=pager&limit=2&cursor=${first.next_cursor}`)
  expect(((await content(call("organisations_get", { organizationId: newco.id }))) as { domains: unknown[] }).domains).toHaveLength(251)
  expect(id.requests.filter(request => request.includes(`/organizations/${newco.id}/domains`))).toEqual([
    `GET /api/admin/v1/organizations/${newco.id}/domains?limit=200`, expect.stringMatching(new RegExp(`/organizations/${newco.id}/domains\\?limit=200&cursor=[0-9a-f-]{36}$`)),
  ])
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
