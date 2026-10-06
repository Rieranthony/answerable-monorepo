import { afterEach, expect, spyOn, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { createMcpServer, createMemoryIntentStore, type ToolCall } from "@answerable/mcp"
import { createTestMcp, errorOf, type TestMcp } from "@answerable/mcp/testing"
import { createAdminProvider } from "./provider"
import { createRoles } from "./roles"
import { createFakeToolbox, createIdFake, entraIssuer, resource, seed, toolboxMcp, toolboxResource } from "./test/admin"
import { createToolboxAdmin } from "./toolbox"

type Intent = {
  intent_id: string; commit_token: string; commit_tool: string; policy_class: string
  targets: { resource_type: string; resource_id: string; label: string; version: { kind: string; value: string } }[]
  preview: { summary: string; changes: { path: string; from: unknown; to: unknown }[]; effects: string[]; warnings: string[]; quantities: unknown[] }
}
const google = "https://accounts.google.com"
const servers: TestMcp[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(mcp => mcp.close())) })

// The provider served alone on a fake ID seeded with Newco and the platform's role groups, and a fake Toolbox; the intents in memory, readable.
async function setup({ toolbox: withToolbox = true } = {}) {
  const id = createIdFake()
  const world = seed(id)
  const toolbox = createFakeToolbox(id)
  const admin = createIdAdmin(id.config)
  const intents = createMemoryIntentStore()
  const { provider } = createAdminProvider({
    id: admin, authority: createRoles({ id: admin, platform: world.platform, resource }), platform: world.platform, resource, issuer: "https://id.test", freshSeconds: 1800,
    toolbox: withToolbox ? createToolboxAdmin({ id: admin, resource: toolboxResource, fetch: toolbox.fetch }) : undefined,
  })
  const calls: ToolCall[] = []
  const mcp = await createTestMcp(auth => createMcpServer({ provider, auth, intents, wrapCall: (call, run) => (calls.push(call), run()) }))
  servers.push(mcp)
  const client = await mcp.connect()
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
  async function prepare(name: string, args: Record<string, unknown>) {
    const answer = await call(name, args)
    if (answer.isError) throw new Error(`${name}: ${JSON.stringify(errorOf(answer))}`)
    return answer.structuredContent as Intent
  }
  const refusal = async (name: string, args: Record<string, unknown>) => errorOf(await call(name, args))
  const commit = (intent: Intent) => call("admin_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary })
  async function committed(intent: Intent) {
    const answer = await commit(intent)
    if (answer.isError) throw new Error(`commit: ${JSON.stringify(errorOf(answer))}`)
    return answer.structuredContent as { results: Record<string, unknown>; applied_changes: unknown[]; effects_performed: string[]; idempotent_replay: boolean }
  }
  // The writes ID received, without the reads; the plan's key of an intent; the execution id of the last commit.
  const writes = () => id.received.filter(({ request }) => !request.startsWith("GET"))
  const key = async (intent: Intent) => ((await intents.get(intent.intent_id))!.plan as { key: string }).key
  const lastCommit = () => calls.findLast(item => item.tool.kind === "commit")!.executionId
  return { id, world, toolbox, prepare, refusal, commit, committed, writes, key, lastCommit }
}
const noPrecondition = (write: string) => `Answerable ID takes no precondition on ${write}: the admin MCP reads the target again just before it writes, but a change in between is not refused by ID.`
const etag = (row: Record<string, unknown> & { id: string }) => `"${row.id}:${row.revision}"`

test("organisations_create previews the organisation, changes nothing until committed, then sends one create with the plan's key and the call's execution id", async () => {
  const { id, prepare, refusal, committed, writes, key, lastCommit } = await setup()
  const intent = await prepare("organisations_create", { slug: "acme", name: "Acme" })
  expect(intent).toMatchObject({ policy_class: "controlled", commit_tool: "admin_commit_confirmed", targets: [] })
  expect(intent.preview).toEqual({
    summary: "Create organisation “Acme” with slug acme", changes: [{ path: "organizations[acme]", from: null, to: { slug: "acme", name: "Acme" } }],
    effects: ["publication"], warnings: [noPrecondition("creating an organisation")], quantities: [],
  })
  expect(writes()).toEqual([])
  const receipt = await committed(intent)
  const [create] = writes()
  expect(create).toEqual({ request: "POST /api/admin/v1/organizations", requestId: lastCommit(), idempotencyKey: await key(intent), ifMatch: null, ifNoneMatch: null })
  expect(receipt.results).toEqual({ organizationId: expect.any(String), slug: "acme", operationId: expect.any(String) })
  expect(receipt.effects_performed).toEqual(["publication"])
  expect(await refusal("organisations_create", { slug: "acme", name: "Acme again" })).toMatchObject({
    code: "PRECONDITION_FAILED", message: `The slug acme belongs to organisation “Acme” (acme), ${receipt.results.organizationId}; choose another`, retry: { policy: "after_state_change" },
    details: { preconditions: [{ slug: "acme", organizationId: receipt.results.organizationId }] },
  })
  expect((await refusal("organisations_create", { slug: "Not A Slug", name: "x" })).code).toBe("INVALID_INPUT")
  expect(id.received.find(({ request }) => request.startsWith("GET /api/admin/v1/organizations?"))!.request).toBe("GET /api/admin/v1/organizations?q=acme&limit=200")
})

test("organisations_update previews the new name, binds the organisation's ETag and sends it as If-Match; a moved organisation is stale", async () => {
  const { id, world: { newco }, prepare, refusal, commit, committed, writes } = await setup()
  const intent = await prepare("organisations_update", { organizationId: newco.id, name: "Newco Ltd" })
  expect(intent.targets).toEqual([{ resource_type: "organization", resource_id: newco.id, label: "“Newco” (newco)", version: { kind: "etag", value: etag(newco) } }])
  expect(intent.preview).toMatchObject({
    summary: "Rename organisation “Newco” (newco) to “Newco Ltd”", changes: [{ path: `organizations[${newco.id}].name`, from: "Newco", to: "Newco Ltd" }], effects: [], warnings: [],
  })
  expect((await committed(intent)).results).toEqual({ organizationId: newco.id, operationId: expect.any(String) })
  expect(writes()).toEqual([expect.objectContaining({ request: `PATCH /api/admin/v1/organizations/${newco.id}`, ifMatch: `"${newco.id}:1"` })])
  expect(id.organisation(newco.id)).toMatchObject({ name: "Newco Ltd", revision: 2 })
  const rename = await prepare("organisations_update", { organizationId: newco.id, name: "Newco Group" })
  expect(rename.preview.summary).toBe("Rename organisation “Newco Ltd” (newco) to “Newco Group”")
  id.revise(newco.id)
  expect(errorOf(await commit(rename))).toMatchObject({
    code: "INTENT_STALE", retry: { policy: "after_reprepare" }, details: { targets: [{ resource_id: newco.id, expected: `"${newco.id}:2"`, current: `"${newco.id}:3"` }] },
  })
  expect(writes()).toHaveLength(1)
  expect(await refusal("organisations_update", { organizationId: newco.id, name: "Newco Ltd" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Organisation “Newco Ltd” (newco) is already named “Newco Ltd”; nothing would change" })
  expect((await refusal("organisations_update", { organizationId: newco.id })).code).toBe("INVALID_INPUT")
  const unknown = crypto.randomUUID()
  expect(await refusal("organisations_update", { organizationId: unknown, name: "x" })).toMatchObject({ code: "NOT_FOUND", message: `Answerable ID has no organisation ${unknown}; organisations_list lists them` })
})

test("organisations_disable and organisations_enable preview the status and its consequences, refuse no change, and never disable the platform organisation", async () => {
  const { id, world: { newco, platform }, prepare, refusal, committed, writes } = await setup()
  const disable = await prepare("organisations_disable", { organizationId: newco.id })
  expect(disable.targets).toEqual([expect.objectContaining({ resource_id: newco.id, version: { kind: "etag", value: etag(newco) } })])
  expect(disable.preview).toEqual({
    summary: "Disable organisation “Newco” (newco)", changes: [{ path: `organizations[${newco.id}].status`, from: "active", to: "disabled" }], effects: ["cascade_delete"],
    warnings: [
      "Its people can no longer get tokens: Answerable ID revokes the organisation's grants at once, so a refresh fails. An access token already issued keeps working until it expires.",
      "organisations_enable restores the status, not the revoked grants: its people sign in again.", noPrecondition("disabling an organisation"),
    ], quantities: [],
  })
  expect((await committed(disable)).results).toEqual({ organizationId: newco.id, status: "disabled", operationId: expect.any(String) })
  expect(id.organisation(newco.id).status).toBe("disabled")
  expect(await refusal("organisations_disable", { organizationId: newco.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Organisation “Newco” (newco) is already disabled" })
  const enable = await prepare("organisations_enable", { organizationId: newco.id })
  expect(enable.preview).toMatchObject({
    summary: "Enable organisation “Newco” (newco)", changes: [{ from: "disabled", to: "active" }], effects: [],
    warnings: ["The grants revoked when it was disabled stay revoked: its people sign in again, and its machine clients get new tokens.", noPrecondition("enabling an organisation")],
  })
  await committed(enable)
  expect(writes().map(({ request }) => request)).toEqual([`POST /api/admin/v1/organizations/${newco.id}/disable`, `POST /api/admin/v1/organizations/${newco.id}/enable`])
  expect(await refusal("organisations_enable", { organizationId: newco.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: "Organisation “Newco” (newco) is already active" })
  expect(await refusal("organisations_disable", { organizationId: platform })).toMatchObject({
    code: "PRECONDITION_FAILED", message: "The platform organisation cannot be disabled through the admin MCP: every member of Answerable staff, you included, would lose access",
  })
})

test("domains_add previews the organisation's domains from and to, and refuses one already routed to it", async () => {
  const { world: { newco }, prepare, refusal, committed, writes } = await setup()
  const intent = await prepare("domains_add", { organizationId: newco.id, domain: " Mail.Newco.Example " })
  expect(intent.preview).toMatchObject({
    summary: "Route email domain mail.newco.example to organisation “Newco” (newco)",
    changes: [{ path: `organizations[${newco.id}].domains`, from: ["newco.example"], to: ["mail.newco.example", "newco.example"] }],
    warnings: ["If another organisation holds mail.newco.example, Answerable ID refuses the write with 409 conflict.", noPrecondition("adding a domain")],
  })
  expect((await committed(intent)).results).toEqual({ domainId: expect.any(String), domain: "mail.newco.example", operationId: expect.any(String) })
  expect(writes()).toEqual([expect.objectContaining({ request: `POST /api/admin/v1/organizations/${newco.id}/domains` })])
  expect(await refusal("domains_add", { organizationId: newco.id, domain: "newco.example" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "newco.example is already routed to organisation “Newco” (newco)" })
  expect((await refusal("domains_add", { organizationId: newco.id, domain: "not a domain" })).code).toBe("INVALID_INPUT")
})

test("sso_set sets a Microsoft or Google provider through Answerable's applications, with If-None-Match first and If-Match to replace, and refuses any other issuer naming the workaround", async () => {
  const { id, world: { newco }, prepare, refusal, committed, writes } = await setup()
  const first = await prepare("sso_set", { organizationId: newco.id, issuer: entraIssuer, domain: "newco.example" })
  expect(first.targets).toEqual([])
  expect(first.preview).toEqual({
    summary: `Set the SSO provider of organisation “Newco” (newco): ${entraIssuer} for newco.example, through Answerable's Microsoft application`,
    changes: [{ path: `organizations[${newco.id}].ssoProvider`, from: null, to: { issuer: entraIssuer, domain: "newco.example", credentials: "platform" } }],
    effects: ["permission_change"],
    warnings: ["When the provider changes, including when it is first set, Answerable ID revokes every grant of the organisation: its people sign in to each application again."],
    quantities: [],
  })
  const created = await committed(first)
  expect(writes()).toEqual([expect.objectContaining({ request: `PUT /api/admin/v1/organizations/${newco.id}/sso-provider`, ifNoneMatch: "*", ifMatch: null })])
  const replace = await prepare("sso_set", { organizationId: newco.id, issuer: google, domain: "newco.example" })
  expect(replace.targets).toEqual([{ resource_type: "sso_provider", resource_id: created.results.ssoProviderId as string, label: entraIssuer, version: { kind: "etag", value: `"${created.results.ssoProviderId}:1"` } }])
  expect(replace.preview).toMatchObject({
    summary: `Replace the SSO provider of organisation “Newco” (newco): ${entraIssuer} for newco.example → ${google} for newco.example, through Answerable's Google application`,
    changes: [{ from: { issuer: entraIssuer, domain: "newco.example", credentials: "platform" }, to: { issuer: google, domain: "newco.example", credentials: "platform" } }],
  })
  await committed(replace)
  expect(writes()[1]).toMatchObject({ ifMatch: `"${created.results.ssoProviderId}:1"`, ifNoneMatch: null })
  expect(id.received.at(-1)).toMatchObject({ request: `PUT /api/admin/v1/organizations/${newco.id}/sso-provider` })
  for (const issuer of ["https://idp.newco.example", "https://login.microsoftonline.com/common/v2.0", "http://127.0.0.1:47602"]) {
    expect(await refusal("sso_set", { organizationId: newco.id, issuer, domain: "newco.example" })).toEqual({
      code: "INVALID_INPUT", retry: { policy: "after_fix_input" }, request_id: expect.any(String),
      message: "sso_set sets only Answerable's own applications: a Microsoft Entra issuer https://login.microsoftonline.com/<tenant id>/v2.0 or https://accounts.google.com. A directory with its own credentials needs a client secret, which no tool takes: staff set it with Answerable ID's admin API, as https://www.answerable.org/docs/id/onboard#connect-the-directory shows.",
      details: { field_violations: [{ field: "issuer", message: expect.stringContaining("which no tool takes") }] },
    })
  }
})

test("groups_create previews the group and refuses a slug the organisation already has", async () => {
  const { world: { newco }, prepare, refusal, committed, writes } = await setup()
  const intent = await prepare("groups_create", { organizationId: newco.id, slug: "designers", name: "Designers" })
  expect(intent.preview).toMatchObject({
    summary: "Create group “Designers” (designers) in organisation “Newco” (newco)",
    changes: [{ path: `organizations[${newco.id}].groups[designers]`, from: null, to: { slug: "designers", name: "Designers" } }], warnings: [noPrecondition("creating a group")],
  })
  expect((await committed(intent)).results).toEqual({ groupId: expect.any(String), operationId: expect.any(String) })
  expect(writes()).toEqual([expect.objectContaining({ request: `POST /api/admin/v1/organizations/${newco.id}/groups` })])
  expect(await refusal("groups_create", { organizationId: newco.id, slug: "engineers", name: "More engineers" })).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("already has a group engineers, “Engineers”") })
})

test("groups_addmember adds with If-None-Match, changes an end with If-Match, and refuses a member already in, a revoked membership and a directory group", async () => {
  const { id, world: { newco, engineers, ada }, prepare, refusal, committed, writes } = await setup()
  const grace = id.member(newco.id, { email: "grace@newco.example" })
  const add = await prepare("groups_addmember", { organizationId: newco.id, groupId: engineers.id, memberId: grace.id, validUntil: "2026-12-31T00:00:00Z" })
  expect(add.targets).toEqual([])
  expect(add.preview).toEqual({
    summary: "Add grace@newco.example to group “Engineers” in organisation “Newco” (newco) until 2026-12-31T00:00:00Z",
    changes: [{ path: `groups[${engineers.id}].members[${grace.id}]`, from: null, to: { validFrom: null, validUntil: "2026-12-31T00:00:00Z" } }],
    effects: ["permission_change"], warnings: [], quantities: [],
  })
  expect((await committed(add)).results).toEqual({ groupId: engineers.id, memberId: grace.id, operationId: expect.any(String) })
  expect(writes()[0]).toMatchObject({ request: `PUT /api/admin/v1/organizations/${newco.id}/groups/${engineers.id}/members/${grace.id}`, ifNoneMatch: "*" })
  const extend = await prepare("groups_addmember", { organizationId: newco.id, groupId: engineers.id, memberId: grace.id, validUntil: "2027-06-30T00:00:00Z" })
  expect(extend.targets[0]).toMatchObject({ resource_type: "group_member", label: "grace@newco.example in “Engineers”" })
  expect(extend.preview.summary).toBe("Change when grace@newco.example's membership of group “Engineers” in organisation “Newco” (newco) ends: 2026-12-31T00:00:00Z → 2027-06-30T00:00:00Z")
  await committed(extend)
  expect(writes()[1]).toMatchObject({ ifMatch: extend.targets[0]!.version.value, ifNoneMatch: null })
  expect(await refusal("groups_addmember", { organizationId: newco.id, groupId: engineers.id, memberId: ada.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: "ada@newco.example is already in group “Engineers”" })
  expect(await refusal("groups_addmember", { organizationId: newco.id, groupId: engineers.id, memberId: grace.id, validUntil: "2027-06-30T00:00:00.000Z" })).toMatchObject({ code: "PRECONDITION_FAILED" })
  const gone = id.member(newco.id, { email: "gone@newco.example", membershipStatus: "revoked" })
  expect(await refusal("groups_addmember", { organizationId: newco.id, groupId: engineers.id, memberId: gone.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: "gone@newco.example's membership is revoked; Answerable ID gives it no access until it is reinstated" })
  expect(await refusal("groups_addmember", { organizationId: newco.id, groupId: crypto.randomUUID(), memberId: grace.id })).toMatchObject({ code: "NOT_FOUND" })
  expect(await refusal("groups_addmember", { organizationId: newco.id, groupId: engineers.id, memberId: crypto.randomUUID() })).toMatchObject({ code: "NOT_FOUND" })
})

test("groups_dropmember removes a member with the membership as its target, and refuses one who is not in the group", async () => {
  const { id, world: { newco, engineers, ada }, prepare, refusal, committed, writes } = await setup()
  const intent = await prepare("groups_dropmember", { organizationId: newco.id, groupId: engineers.id, memberId: ada.id })
  expect(intent.targets).toEqual([expect.objectContaining({ resource_type: "group_member", label: "ada@newco.example in “Engineers”" })])
  expect(intent.preview).toMatchObject({
    summary: "Remove ada@newco.example from group “Engineers” in organisation “Newco” (newco)",
    changes: [{ path: `groups[${engineers.id}].members[${ada.id}]`, from: { validFrom: null, validUntil: null }, to: null }], effects: ["permission_change"],
    warnings: [noPrecondition("removing a member from a group")],
  })
  expect((await committed(intent)).results).toEqual({ groupId: engineers.id, memberId: ada.id, operationId: expect.any(String) })
  expect(writes()).toEqual([expect.objectContaining({ request: `DELETE /api/admin/v1/organizations/${newco.id}/groups/${engineers.id}/members/${ada.id}` })])
  expect(id.joined(engineers.id, ada.id)).toBe(false)
  expect(await refusal("groups_dropmember", { organizationId: newco.id, groupId: engineers.id, memberId: ada.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: "ada@newco.example is not in group “Engineers”" })
})

test("access_grant names who receives what, binds the organisation and the resource, and refuses a scope the resource does not allow and a second entitlement for one principal and target", async () => {
  const { id, world: { newco, engineers, ada }, prepare, refusal, committed, writes } = await setup()
  const intent = await prepare("access_grant", { organizationId: newco.id, principal: { kind: "group", id: engineers.id }, resource: toolboxMcp, scopes: ["e2e/records", "e2e", "e2e"] })
  const resourceRow = id.resourceOf(toolboxMcp)
  expect(intent.targets).toEqual([
    expect.objectContaining({ resource_type: "organization", resource_id: newco.id }),
    { resource_type: "resource", resource_id: toolboxMcp, label: toolboxMcp, version: { kind: "etag", value: etag(resourceRow) } },
  ])
  expect(intent.preview).toEqual({
    summary: `Grant e2e e2e/records on ${toolboxMcp} to group “Engineers” in organisation “Newco” (newco)`,
    changes: [{ path: `organizations[${newco.id}].entitlements`, from: null, to: { memberId: null, groupId: engineers.id, clientId: null, resource: toolboxMcp, scopes: ["e2e", "e2e/records"] } }],
    effects: ["permission_change"], warnings: [noPrecondition("creating an entitlement")], quantities: [],
  })
  const receipt = await committed(intent)
  expect(receipt.results).toEqual({ entitlementId: expect.any(String), operationId: expect.any(String) })
  expect(id.entitlements(newco.id).at(-1)).toMatchObject({ id: receipt.results.entitlementId, groupId: engineers.id, memberId: null, clientId: null, resource: toolboxMcp, scopes: ["e2e", "e2e/records"] })
  expect(writes()).toEqual([expect.objectContaining({ request: `POST /api/admin/v1/organizations/${newco.id}/entitlements` })])
  expect(await refusal("access_grant", { organizationId: newco.id, principal: { kind: "group", id: engineers.id }, resource: toolboxMcp, scopes: ["e2e/records", "e2e"] })).toMatchObject({
    code: "PRECONDITION_FAILED", message: `group “Engineers” in organisation “Newco” (newco) already holds e2e e2e/records on ${toolboxMcp} through entitlement ${receipt.results.entitlementId}`,
  })
  expect(await refusal("access_grant", { organizationId: newco.id, principal: { kind: "group", id: engineers.id }, resource: toolboxMcp, scopes: ["toolbox"] })).toMatchObject({
    code: "PRECONDITION_FAILED",
    message: `group “Engineers” in organisation “Newco” (newco) has entitlement ${receipt.results.entitlementId} on ${toolboxMcp}, active, granting e2e e2e/records; Answerable ID keeps one entitlement per principal and target. Change its scopes with ID's updateEntitlement, as https://www.answerable.org/docs/id/admin-api/entitlements/updateEntitlement shows`,
    details: { preconditions: [{ entitlementId: receipt.results.entitlementId, status: "active", scopes: ["e2e", "e2e/records"] }] },
  })
  expect(await refusal("access_grant", { organizationId: newco.id, principal: { kind: "member", id: ada.id }, resource: toolboxMcp, scopes: ["e2e", "e2e/admin", "admin"] })).toMatchObject({
    code: "INVALID_INPUT", message: `${toolboxMcp} does not allow admin, e2e/admin; it allows e2e, e2e/records, toolbox`, details: { field_violations: [{ field: "scopes" }] },
  })
  const everyone = await prepare("access_grant", { organizationId: newco.id, principal: { kind: "organization" }, resource: toolboxMcp, clientId: "claude-code-toolbox", scopes: ["toolbox"] })
  expect(everyone.preview.summary).toBe(`Grant toolbox on ${toolboxMcp} through claude-code-toolbox to everyone in organisation “Newco” (newco)`)
  const one = await prepare("access_grant", { organizationId: newco.id, principal: { kind: "member", id: ada.id }, resource: toolboxMcp, scopes: ["e2e"] })
  expect(one.preview.summary).toBe(`Grant e2e on ${toolboxMcp} to ada@newco.example in organisation “Newco” (newco)`)
  await committed(one)
  expect(writes().at(-1)).toMatchObject({ request: `POST /api/admin/v1/organizations/${newco.id}/entitlements` })
  expect(id.entitlements(newco.id).at(-1)).toMatchObject({ memberId: ada.id, groupId: null })
  expect(await refusal("access_grant", { organizationId: newco.id, principal: { kind: "organization", id: ada.id }, resource: toolboxMcp, scopes: ["e2e"] })).toMatchObject({ code: "INVALID_INPUT", details: { field_violations: [{ field: "principal.id" }] } })
  expect(await refusal("access_grant", { organizationId: newco.id, principal: { kind: "member" }, resource: toolboxMcp, scopes: ["e2e"] })).toMatchObject({ code: "INVALID_INPUT", message: "Name the member's id in principal.id" })
  expect(await refusal("access_grant", { organizationId: newco.id, principal: { kind: "organization" }, resource: "https://unknown.test/mcp", scopes: ["e2e"] })).toMatchObject({ code: "NOT_FOUND", message: "Answerable ID has no resource https://unknown.test/mcp; register it first" })
  expect(await refusal("access_grant", { organizationId: newco.id, principal: { kind: "organization" }, resource: toolboxMcp, clientId: "unknown-client", scopes: ["e2e"] })).toMatchObject({ code: "NOT_FOUND", message: "Answerable ID has no client unknown-client" })
})

test("access_revoke disables an entitlement, reversibly, naming who loses what, and refuses one already disabled", async () => {
  const { id, world: { newco, engineers, ada }, prepare, refusal, committed, writes } = await setup()
  const grouped = id.entitlement(newco.id, { groupId: engineers.id, resource: toolboxMcp, scopes: ["e2e"] })
  const intent = await prepare("access_revoke", { organizationId: newco.id, entitlementId: grouped.id })
  expect(intent.targets).toEqual([{ resource_type: "entitlement", resource_id: grouped.id, label: `e2e on ${toolboxMcp}`, version: { kind: "etag", value: etag(grouped) } }])
  expect(intent.preview).toEqual({
    summary: `Revoke e2e on ${toolboxMcp} from group “Engineers” in organisation “Newco” (newco)`,
    changes: [{ path: `entitlements[${grouped.id}].status`, from: "active", to: "disabled" }], effects: ["permission_change"],
    warnings: [
      "A token already issued keeps its scopes until it expires; a server that reads access live, such as the Toolbox, drops it within its cache time.",
      noPrecondition("disabling an entitlement"),
    ],
    quantities: [],
  })
  expect((await committed(intent)).results).toEqual({ entitlementId: grouped.id, operationId: expect.any(String) })
  expect(writes()).toEqual([expect.objectContaining({ request: `POST /api/admin/v1/organizations/${newco.id}/entitlements/${grouped.id}/disable` })])
  expect(await refusal("access_revoke", { organizationId: newco.id, entitlementId: grouped.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: `Entitlement ${grouped.id} is already disabled` })
  const own = id.entitlement(newco.id, { memberId: ada.id, clientId: "claude-code-toolbox", scopes: ["openid"] })
  expect((await prepare("access_revoke", { organizationId: newco.id, entitlementId: own.id })).preview.summary).toBe("Revoke openid through claude-code-toolbox from ada@newco.example in organisation “Newco” (newco)")
  const everyone = id.entitlement(newco.id, { resource: toolboxMcp, scopes: ["toolbox"] })
  expect((await prepare("access_revoke", { organizationId: newco.id, entitlementId: everyone.id })).preview.summary).toBe(`Revoke toolbox on ${toolboxMcp} from everyone in organisation “Newco” (newco)`)
  const departed = id.entitlement(newco.id, { memberId: crypto.randomUUID(), resource: toolboxMcp, scopes: ["e2e"] })
  expect((await prepare("access_revoke", { organizationId: newco.id, entitlementId: departed.id })).preview.summary).toStartWith(`Revoke e2e on ${toolboxMcp} from member ${departed.memberId}`)
  expect(await refusal("access_revoke", { organizationId: newco.id, entitlementId: crypto.randomUUID() })).toMatchObject({ code: "NOT_FOUND" })
})

test("toolbox_enable reads the Toolbox's providers and catalogue, posts the enable operation with a token for the Toolbox's admin resource, and is safe to repeat", async () => {
  const { id, toolbox, world: { newco }, prepare, refusal, committed } = await setup()
  const intent = await prepare("toolbox_enable", { organizationId: newco.id, hostClientIds: ["claude-code-toolbox", "claude-code-toolbox"], providers: ["e2e"] })
  expect(intent.targets).toEqual([expect.objectContaining({ resource_type: "organization", resource_id: newco.id })])
  expect(intent.preview).toEqual({
    summary: "Enable the Toolbox for organisation “Newco” (newco): e2e, from claude-code-toolbox",
    changes: [{ path: `toolbox.catalogue[${newco.id}]`, from: [], to: ["e2e"] }], effects: ["permission_change", "external_call"],
    warnings: [
      "For each host client, the Toolbox makes in Answerable ID what is missing of: the client's link to the Toolbox, and the organisation's login and toolbox capabilities and entitlements for everyone in it. The receipt lists what it made and what it found.",
      "Not atomic: if the Toolbox fails part-way, what it made stays; preparing and committing the same request again finishes it, skipping what exists.",
    ],
    quantities: [],
  })
  expect(toolbox.received.filter(({ method }) => method === "POST")).toEqual([])
  expect((await committed(intent)).results).toEqual({ created: ["link claude-code-toolbox", "catalogue e2e"], existing: [] })
  expect(toolbox.received.at(-1)).toEqual({ method: "POST", path: `/organisations/${newco.id}/enable`, body: { hostClientIds: ["claude-code-toolbox"], providers: ["e2e"] } })
  expect(id.scopesAsked).toContain("toolbox:admin")
  const again = await prepare("toolbox_enable", { organizationId: newco.id, hostClientIds: ["claude-code-toolbox"], providers: ["docs", "e2e"] })
  expect(again.preview.changes).toEqual([{ path: `toolbox.catalogue[${newco.id}]`, from: ["e2e"], to: ["docs", "e2e"] }])
  expect((await committed(again)).results).toEqual({ created: ["catalogue docs"], existing: ["link claude-code-toolbox", "catalogue e2e"] })
  expect(await refusal("toolbox_enable", { organizationId: newco.id, hostClientIds: ["claude-code-toolbox"], providers: ["e2e", "payroll"] })).toMatchObject({
    code: "INVALID_INPUT", message: "The Toolbox has no provider payroll; it has docs, e2e", details: { field_violations: [{ field: "providers" }] },
  })
  expect(await refusal("toolbox_enable", { organizationId: newco.id, hostClientIds: ["nobody"], providers: ["e2e"] })).toMatchObject({
    code: "INVALID_INPUT", message: "Answerable ID has no client nobody; register it first", details: { field_violations: [{ field: "hostClientIds" }] },
  })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    toolbox.outage(true)
    expect(await refusal("toolbox_enable", { organizationId: newco.id, hostClientIds: ["claude-code-toolbox"], providers: ["e2e"] })).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE", message: "The Toolbox answered GET https://toolbox.test/admin/v1/providers with 500 internal_error: The Toolbox failed to answer; its log says why",
      details: { upstream: { status: 500, code: "internal_error" } },
    })
  } finally { log.mockRestore() }
})

test("toolbox_enable without the Toolbox's admin resource configured stays listed and answers PRECONDITION_FAILED saying what to set", async () => {
  const { world: { newco }, refusal } = await setup({ toolbox: false })
  expect(await refusal("toolbox_enable", { organizationId: newco.id, hostClientIds: ["claude-code-toolbox"], providers: ["e2e"] })).toMatchObject({
    code: "PRECONDITION_FAILED", retry: { policy: "after_state_change" },
    message: "The admin MCP does not know the Toolbox: set ADMIN_TOOLBOX_ADMIN_RESOURCE to the Toolbox's admin resource, such as http://localhost:47400/admin, and restart it",
    details: { preconditions: [{ variable: "ADMIN_TOOLBOX_ADMIN_RESOURCE" }] },
  })
})

test("staff_grant finds the role's group by its entitlement on the admin MCP's resource, never by slug, and adds the member with If-None-Match", async () => {
  const { id, world: { platform, roles, staffer }, prepare, refusal, committed, writes } = await setup()
  // A group named after the role confers nothing: only an entitlement does.
  id.group(platform, { slug: "answerable-owner", name: "answerable-owner" })
  const newcomer = staffer("newcomer@answerable.test")
  const intent = await prepare("staff_grant", { memberId: newcomer.id, role: "owner" })
  expect(intent.targets).toEqual([{ resource_type: "entitlement", resource_id: roles.owner.entitlement.id, label: "answerable-owner of group “Founders”", version: { kind: "etag", value: etag(roles.owner.entitlement) } }])
  expect(intent.preview).toEqual({
    summary: "Make newcomer@answerable.test owner of the admin MCP: add them to group “Founders” of the platform organisation",
    changes: [{ path: `staff[${newcomer.id}].role`, from: null, to: "owner" }, { path: `groups[${roles.owner.group.id}].members[${newcomer.id}]`, from: null, to: { validFrom: null, validUntil: null } }],
    effects: ["permission_change"], warnings: [], quantities: [],
  })
  expect((await committed(intent)).results).toEqual({ memberId: newcomer.id, groupId: roles.owner.group.id, role: "owner", operationId: expect.any(String) })
  expect(writes()).toEqual([expect.objectContaining({ request: `PUT /api/admin/v1/organizations/${platform}/groups/${roles.owner.group.id}/members/${newcomer.id}`, ifNoneMatch: "*" })])
  expect(id.joined(roles.owner.group.id, newcomer.id)).toBe(true)
  // A team member made admin: the role goes from team to admin.
  const helper = staffer("helper@answerable.test", ["team"])
  expect((await prepare("staff_grant", { memberId: helper.id, role: "admin" })).preview.changes[0]).toEqual({ path: `staff[${helper.id}].role`, from: "team", to: "admin" })
  expect(await refusal("staff_grant", { memberId: helper.id, role: "team" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "helper@answerable.test already holds team" })
  expect(await refusal("staff_grant", { memberId: crypto.randomUUID(), role: "team" })).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("The platform organisation has no member") })
  const former = id.member(platform, { email: "former@answerable.test", effective: false })
  expect(await refusal("staff_grant", { memberId: former.id, role: "team" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "former@answerable.test's membership of the platform organisation is not in force" })
  roles.team.entitlement.status = "disabled"
  expect(await refusal("staff_grant", { memberId: staffer("x@answerable.test").id, role: "team" })).toMatchObject({
    code: "PRECONDITION_FAILED",
    message: `No group of the platform organisation holds answerable-team on ${resource}. Create one: groups_create in the platform organisation (${platform}), then access_grant to that group on ${resource} with the scope answerable-team`,
  })
})

test("staff_grant prefers the group that confers the least beyond the role, and skips a disabled group", async () => {
  const { id, world: { platform, roles, staffer }, prepare } = await setup()
  const leaders = id.group(platform, { slug: "leaders", name: "Leaders" })
  id.entitlement(platform, { groupId: leaders.id, resource, scopes: ["answerable-admin", "answerable-owner"] })
  const retired = id.group(platform, { slug: "retired", name: "Retired", status: "disabled" })
  id.entitlement(platform, { groupId: retired.id, resource, scopes: ["answerable-admin"] })
  expect((await prepare("staff_grant", { memberId: staffer("a@answerable.test").id, role: "admin" })).preview.summary).toContain("group “Operations”")
  expect(roles.admin.group.name).toBe("Operations")
})

test("staff_revoke removes the member from every group that carries the role, each with its own step of the key, and says what role remains", async () => {
  const { id, world: { platform, roles, staffer }, prepare, refusal, committed, writes, key } = await setup()
  const second = id.group(platform, { slug: "board", name: "Board" })
  const board = id.entitlement(platform, { groupId: second.id, resource, scopes: ["answerable-owner"] })
  const owner = staffer("owner@answerable.test", ["owner", "team"])
  id.join(second.id, owner.id)
  id.grant(platform, owner.id, [{
    kind: "resource", id: resource, scopes: ["answerable-owner", "answerable-team"],
    via: [
      { entitlementId: roles.owner.entitlement.id, principal: "group", groupId: roles.owner.group.id },
      { entitlementId: board.id, principal: "group", groupId: second.id },
      { entitlementId: roles.team.entitlement.id, principal: "group", groupId: roles.team.group.id },
    ],
  }])
  const intent = await prepare("staff_revoke", { memberId: owner.id, role: "owner" })
  const leaving = [roles.owner.group, second].sort((a, b) => (a.id < b.id ? -1 : 1))
  expect(intent.targets.map(({ resource_type, label }) => [resource_type, label])).toEqual(leaving.map(group => ["group_member", `owner@answerable.test in “${group.name}”`]))
  expect(intent.preview).toMatchObject({
    summary: `Take owner away from owner@answerable.test: remove them from group ${leaving.map(group => `“${group.name}”`).join(", ")} of the platform organisation`,
    changes: [{ path: `staff[${owner.id}].role`, from: "owner", to: "team" }, ...leaving.map(group => ({ path: `groups[${group.id}].members[${owner.id}]`, to: null }))],
    effects: ["permission_change"],
    warnings: [
      "No other owner remains: only Answerable ID's admin API, with root or a platform administrator's token, can make an owner again.",
      noPrecondition("removing a member from a group"),
      "Not atomic: the member leaves each group in turn; if one removal fails, the ones before it stay done.",
    ],
  })
  const receipt = await committed(intent)
  expect(receipt.results).toEqual({ memberId: owner.id, groupIds: leaving.map(group => group.id), operationIds: [expect.any(String), expect.any(String)] })
  const planKey = await key(intent)
  expect(writes().map(({ request, idempotencyKey }) => [request, idempotencyKey])).toEqual(leaving.map((group, step) => [
    `DELETE /api/admin/v1/organizations/${platform}/groups/${group.id}/members/${owner.id}`, `${planKey}.${step + 1}`,
  ]))
  expect(await refusal("staff_revoke", { memberId: staffer("plain@answerable.test").id, role: "team" })).toMatchObject({ code: "PRECONDITION_FAILED", message: "plain@answerable.test does not hold team" })
})

test("staff_revoke refuses a role held only through an entitlement that is not a group's, and warns when the role survives the removal", async () => {
  const { id, world: { platform, roles, staffer }, prepare, refusal } = await setup()
  const everyone = id.entitlement(platform, { resource, scopes: ["answerable-team"] })
  const reader = staffer("reader@answerable.test")
  id.grant(platform, reader.id, [{ kind: "resource", id: resource, scopes: ["answerable-team"], via: [{ entitlementId: everyone.id, principal: "organization", groupId: null }] }])
  expect(await refusal("staff_revoke", { memberId: reader.id, role: "team" })).toMatchObject({
    code: "PRECONDITION_FAILED", message: `reader@answerable.test holds team through an organisation-wide entitlement ${everyone.id}, not a group; revoke that with access_revoke`,
  })
  const own = id.entitlement(platform, { memberId: reader.id, resource, scopes: ["answerable-team"] })
  id.grant(platform, reader.id, [{ kind: "resource", id: resource, scopes: ["answerable-team"], via: [{ entitlementId: own.id, principal: "member", groupId: null }] }])
  expect((await refusal("staff_revoke", { memberId: reader.id, role: "team" })).message).toContain("through their own entitlement")
  const both = staffer("both@answerable.test", ["team"])
  id.grant(platform, both.id, [{
    kind: "resource", id: resource, scopes: ["answerable-team"],
    via: [{ entitlementId: roles.team.entitlement.id, principal: "group", groupId: roles.team.group.id }, { entitlementId: everyone.id, principal: "organization", groupId: null }],
  }])
  const intent = await prepare("staff_revoke", { memberId: both.id, role: "team" })
  expect(intent.preview.changes[0]).toEqual({ path: `staff[${both.id}].role`, from: "team", to: "team" })
  expect(intent.preview.warnings[0]).toBe("both@answerable.test still holds team through an entitlement that is not a group's; access_revoke removes it.")
  // Another owner remains, so taking owner from one of two raises no last-owner warning.
  const first = staffer("first@answerable.test", ["owner"])
  staffer("other@answerable.test", ["owner"])
  expect((await prepare("staff_revoke", { memberId: first.id, role: "owner" })).preview.warnings).toEqual([noPrecondition("removing a member from a group")])
})

test("access_enable grants a disabled entitlement again, with its ETag as the target, and refuses one already active", async () => {
  const { id, world: { newco, engineers }, prepare, refusal, committed, writes } = await setup()
  const grouped = id.entitlement(newco.id, { groupId: engineers.id, resource: toolboxMcp, scopes: ["e2e"], status: "disabled" })
  const intent = await prepare("access_enable", { organizationId: newco.id, entitlementId: grouped.id })
  expect(intent.targets).toEqual([{ resource_type: "entitlement", resource_id: grouped.id, label: `e2e on ${toolboxMcp}`, version: { kind: "etag", value: etag(grouped) } }])
  expect(intent.preview).toEqual({
    summary: `Grant again e2e on ${toolboxMcp} to group “Engineers” in organisation “Newco” (newco)`,
    changes: [{ path: `entitlements[${grouped.id}].status`, from: "disabled", to: "active" }], effects: ["permission_change"],
    warnings: [noPrecondition("enabling an entitlement")], quantities: [],
  })
  expect(writes()).toEqual([])
  expect((await committed(intent)).results).toEqual({ entitlementId: grouped.id, operationId: expect.any(String) })
  expect(writes()).toEqual([expect.objectContaining({ request: `POST /api/admin/v1/organizations/${newco.id}/entitlements/${grouped.id}/enable` })])
  expect(id.entitlements(newco.id).find(row => row.id === grouped.id)).toMatchObject({ status: "active", revision: 2 })
  expect(await refusal("access_enable", { organizationId: newco.id, entitlementId: grouped.id })).toMatchObject({ code: "PRECONDITION_FAILED", message: `Entitlement ${grouped.id} is already active` })
  expect(await refusal("access_enable", { organizationId: newco.id, entitlementId: crypto.randomUUID() })).toMatchObject({ code: "NOT_FOUND" })
})

test("an entitlement revoked cannot be granted again, and the refusal names access_enable with its id, which a model can follow", async () => {
  const { world: { newco, ada }, prepare, refusal, committed } = await setup()
  const args = { organizationId: newco.id, principal: { kind: "member", id: ada.id }, resource: toolboxMcp, scopes: ["e2e"] }
  const { results: { entitlementId } } = await committed(await prepare("access_grant", args))
  await committed(await prepare("access_revoke", { organizationId: newco.id, entitlementId }))
  expect(await refusal("access_grant", args)).toMatchObject({
    code: "PRECONDITION_FAILED", details: { preconditions: [{ entitlementId, status: "disabled", scopes: ["e2e"] }] },
    message: `ada@newco.example in organisation “Newco” (newco) has entitlement ${entitlementId} on ${toolboxMcp}, disabled, granting e2e; Answerable ID keeps one entitlement per principal and target. Enable it with access_enable and entitlementId ${entitlementId}`,
  })
  expect((await refusal("access_grant", { ...args, scopes: ["e2e/records"] })).message).toBe(
    `ada@newco.example in organisation “Newco” (newco) has entitlement ${entitlementId} on ${toolboxMcp}, disabled, granting e2e; Answerable ID keeps one entitlement per principal and target. Enable it with access_enable and entitlementId ${entitlementId}, then change its scopes with ID's updateEntitlement, as https://www.answerable.org/docs/id/admin-api/entitlements/updateEntitlement shows`,
  )
  const enabled = await committed(await prepare("access_enable", { organizationId: newco.id, entitlementId }))
  expect(enabled.results).toEqual({ entitlementId, operationId: expect.any(String) })
  expect((await refusal("access_grant", args)).message).toBe(`ada@newco.example in organisation “Newco” (newco) already holds e2e on ${toolboxMcp} through entitlement ${entitlementId}`)
})
