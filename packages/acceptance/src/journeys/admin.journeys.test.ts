// Real Answerable ID, a real browser and the official MCP OAuth client against the admin MCP, with the Toolbox beside it: Answerable staff onboard a client
// organisation through the tools, and its person uses the Toolbox. The registrations are the ones the admin MCP's setup page shows (`startAdminStack`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createEvidence } from "@answerable/mcp-postgres"
import { errorOf } from "@answerable/mcp/testing"
import type { Client } from "@modelcontextprotocol/client"
import type { BrowserContext } from "@playwright/test"
import { decodeJwt } from "jose"
import { z } from "zod"
import { adminResource, startAdminStack } from "../admin-mcp"
import {
  connect, grantOrganisation, intentSchema, launchBrowser, refreshRefused, refusal, serve, serveCallback, setSsoProvider, signIn, signInRefused, startId, step, tool, verifySignIn,
  type Id, type OAuthSession,
} from "../index"
import { toolboxResource } from "../toolbox"

const callback = "http://127.0.0.1:47603/callback"
const adminHost = { clientId: "admin-browser", redirectUri: callback }
const toolboxHost = { clientId: "toolbox-browser", redirectUri: callback }
const refusalText = "Access is unavailable for this organisation. Sign in again or ask its administrator to check your access."
// The window A6 gives a critical operation: a company sign-in at most this old.
const freshSeconds = 10

const reads = ["access_list", "audit_list", "groups_list", "members_get", "members_list", "organisations_get", "organisations_list", "sso_test", "staff_list"]
const ordinary = ["access_enable", "access_grant", "access_revoke", "domains_add", "groups_addmember", "groups_create", "groups_dropmember", "organisations_create", "organisations_update", "sso_set", "toolbox_enable"]
const critical = ["organisations_disable", "organisations_enable", "staff_grant", "staff_revoke"]
const commits = ["admin_commit", "admin_commit_confirmed"]
const teamTools = ["admin_whoami", ...reads].toSorted()
const adminTools = [...teamTools, ...ordinary, ...commits].toSorted()
const ownerTools = [...adminTools, ...critical].toSorted()
const toolboxTools = ["toolbox_whoami", "e2e_identity_get", "e2e_records_create", "e2e_records_delete", "e2e_records_list", "e2e_records_show", "toolbox_commit", "toolbox_commit_confirmed"].toSorted()

const receiptSchema = z.object({
  receipt_id: z.uuid(), intent_id: z.uuid(), status: z.literal("committed"), results: z.record(z.string(), z.unknown()),
  committed_by: z.object({ client_id: z.string() }), idempotent_replay: z.boolean(),
})
type Intent = z.infer<typeof intentSchema>
type Receipt = z.infer<typeof receiptSchema>
const auditPage = z.object({
  items: z.array(z.object({ id: z.uuid(), action: z.string(), actorType: z.string(), actorId: z.string(), outcome: z.string(), requestId: z.string().nullable(), operationId: z.uuid().nullable(), targetId: z.string().nullable() })),
})
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!

let id: Id
let stack: Awaited<ReturnType<typeof startAdminStack>>
let adminMcp: ReturnType<typeof stack.adminMcp>
let browser: Awaited<ReturnType<typeof launchBrowser>>
// The staff member's browser keeps ID's session between sign-ins, as a person's does.
let staffBrowser: BrowserContext
let staff: OAuthSession
let staffClient: Client
let staffMember: string
// A second member of the platform organisation, whose role the owner changes with staff_grant and staff_revoke.
let colleague: OAuthSession
let colleagueClient: Client
let colleagueMember: string
let newco: { organizationId: string; entitlementId: string; groupId: string }
let idem: string
const writes: { tool: string; receipt: Receipt }[] = []
// The new organisation's person in the Toolbox from A3 on: their session, and a client that asks the server on every list.
let person: OAuthSession
let toolbox: Client
// What the admin MCP asked ID, for the evidence report: each member access read with its latency, and token requests.
const asked = { access: [] as number[], tokens: 0 }

async function counted(input: string | URL | Request, init?: RequestInit) {
  const { pathname } = new URL(input instanceof Request ? input.url : input)
  const started = performance.now()
  const response = await fetch(input, init)
  if (/\/members\/[^/]+\/access$/.test(pathname)) asked.access.push(performance.now() - started)
  else if (pathname.endsWith("/token")) asked.tokens++
  return response
}

const platformOrganization = () => id.manifest.platform!.organizationId
const adminTarget = () => ({ idOrigin: id.manifest.idOrigin, resource: adminResource, clientId: adminHost.clientId, callback, scopes: ["admin"] })
const toolboxTarget = () => ({ idOrigin: id.manifest.idOrigin, resource: toolboxResource, clientId: toolboxHost.clientId, callback, scopes: ["toolbox"] })
const staffPerson = () => ({ slug: "answerable", email: id.manifest.platform!.email, scopes: ["admin"] })
const colleaguePerson = () => ({ slug: "answerable", email: `colleague@${id.manifest.platform!.domain}`, scopes: ["admin"] })
// A 2025 client asks the server on every list; a 2026-07-28 client may keep one for 30 seconds.
const on = (session: OAuthSession, resource = adminResource) => connect(resource, session.provider, "2025")
const names = async (client: Client) => (await client.listTools()).tools.map(item => item.name).toSorted()
const claims = (session: OAuthSession) => decodeJwt(session.state.tokens!.access_token)

const prepare = async (client: Client, name: string, args: Record<string, unknown>) => intentSchema.parse(await tool(client, name, args))
const confirm = async (client: Client, { intent_id, commit_token, preview }: Intent) =>
  receiptSchema.parse(await tool(client, "admin_commit_confirmed", { intent_id, commit_token, preview_summary: preview.summary }))
/** Prepare a write and commit it with its summary, as a host does once the person says yes. */
async function change(client: Client, name: string, args: Record<string, unknown>) {
  const intent = await prepare(client, name, args)
  expect(intent).toMatchObject({ policy_class: "controlled", commit_tool: "admin_commit_confirmed" })
  const receipt = await confirm(client, intent)
  expect(receipt).toMatchObject({ status: "committed", idempotent_replay: false, committed_by: { client_id: adminHost.clientId } })
  writes.push({ tool: name, receipt })
  return { intent, receipt }
}

type Row = {
  seq: number; kind: string; outcome: string; capability_identity: string | null; execution_id: string | null; intent_id: string | null; receipt_id: string | null
  actor_id: string; reason: string | null; error_code: string | null; upstream: string | null; data: Record<string, unknown>
}
/** Poll the Toolbox's tools/list with the person's own token until it is `wanted`, and return the milliseconds it took. */
async function until(wanted: string[]) {
  const started = performance.now()
  while (JSON.stringify(await names(toolbox)) !== JSON.stringify(wanted)) {
    if (performance.now() - started > 75_000) throw new Error(`The Toolbox still lists ${(await names(toolbox)).join(", ")} after 75 seconds`)
    await Bun.sleep(1_000)
  }
  return Math.round(performance.now() - started)
}

const chain = (): Promise<Row[]> => stack.database`select seq::int as seq, kind, outcome, capability_identity, execution_id::text as execution_id, intent_id::text as intent_id,
  receipt_id::text as receipt_id, actor_id, reason, error_code, upstream, data from evidence_events where organisation_id = ${platformOrganization()} order by seq`

/** ID's audit row of one operation, through the admin MCP's `audit_list` and through ID's admin API as root: the same single row, written by the machine client with the commit's execution id as `requestId`, which the commit call's own evidence row carries. */
async function audited(client: Client, receipt: Receipt) {
  const operationId = z.uuid().parse(receipt.results.operationId)
  const viaTool = auditPage.parse(await tool(client, "audit_list", { operationId })).items
  const viaApi = auditPage.parse(await id.admin("GET", `/audit-events?operationId=${operationId}`)).items
  expect(viaApi).toHaveLength(1)
  expect(viaTool).toEqual(viaApi)
  const [event] = viaApi
  // Read before the matchers: Bun's toMatchObject replaces a property of the received value with an asymmetric matcher it compared it to.
  const requestId = z.string().parse(event!.requestId)
  expect(event).toMatchObject({ actorType: "client", actorId: "admin-mcp", outcome: "success", operationId, requestId })
  const rows = (await chain()).filter(row => row.execution_id === requestId)
  expect(rows).toEqual([expect.objectContaining({ kind: "capability.completed", outcome: "success", capability_identity: "admin/commit_confirmed", upstream: "id" })])
  return event!
}

beforeAll(async () => {
  // Sign-ins each step consumes, in order. The platform directory: the staff member for A1, their colleague for A1, then the staff member's Verify sign-in for A6
  // (the authorisations after it reuse ID's session). The tenant's member: one ID refuses and one it lets through (A4). The spare directory's person: one ID refuses
  // before the Toolbox is enabled and one it lets through (A3).
  id = await startId({ tenants: [{ slug: "client", signIns: 2 }], platform: { signIns: ["staff", "colleague", "staff"] }, spares: [{ slug: "newco", signIns: 2 }] })
  stack = await startAdminStack(id, { adminHost, toolboxHost, fetch: counted })
  adminMcp = stack.adminMcp()
  serve(47_606, request => adminMcp.fetch(request))
  serve(47_604, stack.toolbox.fetch)
  serveCallback(callback)
  browser = await launchBrowser()
  staffBrowser = await browser.newContext()
})
afterAll(() => id?.stop())

describe("A1 roles without re-authorisation", () => {
  test("staff sign in to the admin MCP with their company directory; with no role they see admin_whoami alone", async () => {
    staff = await signIn(staffBrowser, adminTarget(), staffPerson())
    const token = claims(staff)
    expect(token).toMatchObject({ aud: adminResource, organization_id: platformOrganization(), client_id: adminHost.clientId })
    expect(String(token.scope).split(" ").toSorted()).toEqual(["admin", "offline_access"])
    expect(Number(token.upstream_auth_time)).toBeGreaterThan(Date.now() / 1000 - 60)
    staffClient = await on(staff)
    expect(await names(staffClient)).toEqual(["admin_whoami"])
    expect(await tool(staffClient, "admin_whoami")).toEqual({
      userId: token.sub, membershipId: token.membership_id, organizationId: platformOrganization(), clientId: adminHost.clientId, role: null,
      nextStep: expect.stringContaining("Ask an owner"), tools: ["admin_whoami"],
    })
    await expect(staffClient.callTool({ name: "organisations_list", arguments: {} })).rejects.toThrow("Tool organisations_list not found")
    staffMember = String(token.membership_id)
  })

  test("root makes the member the first owner: the same token lists every tool on the next call, one access read per request, and only the confirmed commit asks the host to stop", async () => {
    const token = staff.state.tokens!.access_token
    await id.admin("PUT", `/organizations/${platformOrganization()}/groups/${stack.groups.owner}/members/${staffMember}`, {})
    expect(await names(staffClient)).toEqual(ownerTools)
    expect(await tool(staffClient, "admin_whoami")).toMatchObject({ role: "owner", nextStep: null })
    // Claude Code asks before any tool that sets this, whatever the allow rules say: it must be the confirmed commit alone.
    const { tools } = await staffClient.listTools()
    expect(tools.filter(item => item._meta?.["anthropic/requiresUserInteraction"] === true).map(item => item.name)).toEqual(["admin_commit_confirmed"])
    const before = asked.access.length
    const latencies: number[] = []
    for (let call = 0; call < 25; call++) {
      const started = performance.now()
      await staffClient.listTools()
      latencies.push(performance.now() - started)
    }
    const accessReads = asked.access.slice(before)
    expect(accessReads).toHaveLength(25)
    step(`tools/list: 25 requests, median ${median(latencies).toFixed(1)} ms, max ${Math.max(...latencies).toFixed(1)} ms, each with one member-access read to ID`)
    step(`member-access reads for those 25 requests: median ${median(accessReads).toFixed(1)} ms, max ${Math.max(...accessReads).toFixed(1)} ms`)
    expect(staff.state.tokens!.access_token).toBe(token)
  })

  test("the owner gives a colleague team with staff_grant: the colleague's same token lists the reads on its next call; staff_revoke takes it away and the list shrinks", async () => {
    colleague = await signIn(browser, adminTarget(), colleaguePerson())
    colleagueMember = String(claims(colleague).membership_id)
    colleagueClient = await on(colleague)
    const token = colleague.state.tokens!.access_token
    expect(await names(colleagueClient)).toEqual(["admin_whoami"])
    const granted = await change(staffClient, "staff_grant", { memberId: colleagueMember, role: "team" })
    expect(granted.intent.preview.summary).toBe(`Make ${colleaguePerson().email} team of the admin MCP: add them to group “Answerable team” of the platform organisation`)
    expect(granted.receipt.results).toMatchObject({ memberId: colleagueMember, groupId: stack.groups.team, role: "team" })
    await audited(staffClient, granted.receipt)
    expect(await names(colleagueClient)).toEqual(teamTools)
    expect(await tool(colleagueClient, "admin_whoami")).toMatchObject({ role: "team", nextStep: null })
    const staffList = z.object({ items: z.array(z.object({ memberId: z.uuid(), role: z.string().nullable() })) })
    const roles = async () => new Map(staffList.parse(await tool(staffClient, "staff_list", { limit: 100 })).items.map(item => [item.memberId, item.role]))
    const listed = await roles()
    expect([listed.get(staffMember), listed.get(colleagueMember)]).toEqual(["owner", "team"])
    const revoked = await change(staffClient, "staff_revoke", { memberId: colleagueMember, role: "team" })
    expect(revoked.receipt.results).toMatchObject({ memberId: colleagueMember, groupIds: [stack.groups.team] })
    expect(await names(colleagueClient)).toEqual(["admin_whoami"])
    expect(await tool(colleagueClient, "admin_whoami")).toMatchObject({ role: null })
    await expect(colleagueClient.callTool({ name: "organisations_list", arguments: {} })).rejects.toThrow("Tool organisations_list not found")
    expect((await roles()).get(colleagueMember) ?? null).toBeNull()
    expect(colleague.state.tokens!.access_token).toBe(token)
    step(`roles: ${teamTools.length} tools for team, ${adminTools.length} for admin, ${ownerTools.length} for owner; the colleague's changed twice through staff_grant and staff_revoke on one access token`)
  })
})

describe("A2 onboarding through the MCP", () => {
  const spare = () => id.manifest.spares[0]!

  test("an existing client organisation is enabled for the Toolbox first, which links the Toolbox's host client in ID", async () => {
    const tenant = id.manifest.tenants[0]!
    const { receipt } = await change(staffClient, "toolbox_enable", { organizationId: tenant.organizationId, hostClientIds: [toolboxHost.clientId], providers: ["e2e"] })
    const { created, existing } = z.object({ created: z.array(z.string()), existing: z.array(z.string()) }).parse(receipt.results)
    expect([created.length, existing.length]).toEqual([9, 0])
    step(`toolbox_enable for ${tenant.slug}: ${created.length} rows made in ID and the catalogue: ${created.join("; ")}`)
  })

  test("an owner creates an organisation: prepare, admin_commit answers APPROVAL_REQUIRED, admin_commit_confirmed commits with the summary", async () => {
    const intent = await prepare(staffClient, "organisations_create", { slug: "newco", name: "Newco" })
    expect(intent).toMatchObject({ policy_class: "controlled", commit_tool: "admin_commit_confirmed", targets: [], preview: { summary: "Create organisation “Newco” with slug newco" } })
    expect(await refusal(staffClient, "admin_commit", { intent_id: intent.intent_id, commit_token: intent.commit_token })).toMatchObject({ code: "APPROVAL_REQUIRED" })
    const receipt = await confirm(staffClient, intent)
    writes.push({ tool: "organisations_create", receipt })
    expect(receipt).toMatchObject({ status: "committed", idempotent_replay: false, results: { slug: "newco" } })
    const organizationId = z.uuid().parse(receipt.results.organizationId)
    expect(await id.admin("GET", `/organizations/${organizationId}`)).toMatchObject({ slug: "newco", name: "Newco", status: "active" })
    newco = { organizationId, entitlementId: "", groupId: "" }
    const event = await audited(staffClient, receipt)
    step(`organisations_create: ID's audit row ${event.action} by ${event.actorId}, request id ${event.requestId}`)
  })

  test("domains_add routes the spare's domain; the SSO provider is set by the kit, because a directory with its own credentials needs a secret no tool takes", async () => {
    const { receipt } = await change(staffClient, "domains_add", { organizationId: newco.organizationId, domain: spare().domain })
    await audited(staffClient, receipt)
    const refused = await refusal(staffClient, "sso_set", { organizationId: newco.organizationId, issuer: spare().issuer, domain: spare().domain })
    expect(refused).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("no tool takes") })
    await setSsoProvider(id.admin, newco.organizationId, spare())
    expect(await tool(staffClient, "organisations_get", { organizationId: newco.organizationId })).toMatchObject({
      slug: "newco", domains: [{ domain: spare().domain, status: "active" }], sso: { issuer: spare().issuer, domain: spare().domain, oidc: { credentials: "own", hasClientSecret: true } },
    })
  })

  test("groups_create makes a group in the new organisation, which A8 grants one tool", async () => {
    const { receipt } = await change(staffClient, "groups_create", { organizationId: newco.organizationId, slug: "staff", name: "Staff" })
    newco.groupId = z.uuid().parse(receipt.results.groupId)
    await audited(staffClient, receipt)
    expect(await tool(staffClient, "groups_list", { organizationId: newco.organizationId })).toMatchObject({ items: [{ slug: "staff", name: "Staff", status: "active" }] })
  })

  test("A3, before toolbox_enable: ID refuses the new organisation's person at the organisation chooser, with its exact text", async () => {
    const started = performance.now()
    expect(await signInRefused(browser, toolboxTarget(), { slug: spare().slug, email: spare().email, scopes: ["toolbox"] })).toBe(refusalText)
    step(`newco: refused at the chooser after ${Math.round(performance.now() - started)} ms`)
  })

  test("toolbox_enable for the Toolbox's host client with provider e2e, then access_grant of the e2e grant string to the organisation", async () => {
    const { receipt } = await change(staffClient, "toolbox_enable", { organizationId: newco.organizationId, hostClientIds: [toolboxHost.clientId], providers: ["e2e"] })
    const { created, existing } = z.object({ created: z.array(z.string()), existing: z.array(z.string()) }).parse(receipt.results)
    expect(created).toContain("catalogue e2e")
    expect(existing).toContain(`link ${toolboxHost.clientId}`)
    step(`toolbox_enable for newco: ${created.length} rows made and ${existing.length} found, the host client's link and the resource's grant strings among them`)
    const granted = await change(staffClient, "access_grant", { organizationId: newco.organizationId, principal: { kind: "organization" }, resource: toolboxResource, scopes: ["e2e"] })
    newco.entitlementId = z.uuid().parse(granted.receipt.results.entitlementId)
    await audited(staffClient, granted.receipt)
    const { items } = z.object({ items: z.array(z.object({ id: z.uuid() }).passthrough()) }).parse(await tool(staffClient, "access_list", { organizationId: newco.organizationId, resource: toolboxResource }))
    // The enable call made the host client's own entitlement beside it.
    expect(items.map(item => item.clientId).toSorted()).toEqual([null, toolboxHost.clientId])
    expect(items.find(item => item.id === newco.entitlementId)).toMatchObject({ memberId: null, groupId: null, clientId: null, resource: toolboxResource, scopes: ["e2e"], status: "active" })
  })
})

describe("A3 the Toolbox outcome", () => {
  test("after the enable and the grant the new organisation's person signs in to the Toolbox, lists toolbox_whoami and the e2e tools, and calls one", async () => {
    const spare = id.manifest.spares[0]!
    person = await signIn(browser, toolboxTarget(), { slug: spare.slug, email: spare.email, scopes: ["toolbox"] })
    expect(claims(person)).toMatchObject({ aud: toolboxResource, organization_id: newco.organizationId, client_id: toolboxHost.clientId })
    toolbox = await on(person, toolboxResource)
    expect(await names(toolbox)).toEqual(toolboxTools)
    expect(await tool(toolbox, "toolbox_whoami")).toMatchObject({ organisation_id: newco.organizationId, client_id: toolboxHost.clientId, grants: ["e2e"] })
    expect(await tool(toolbox, "e2e_identity_get")).toMatchObject({ organizationId: newco.organizationId })
    expect(await tool(toolbox, "e2e_records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
  })

  test("the admin MCP answers 401 to the person's Toolbox token, which the Toolbox accepts: a token is good for its own audience only", async () => {
    const list = (url: string) => fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${person.state.tokens!.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect((await list(toolboxResource)).status).toBe(200)
    const refused = await list(adminResource)
    expect(refused.status).toBe(401)
    expect(refused.headers.get("www-authenticate")).toMatch(/resource_metadata=/)
  })

  test("access_revoke takes the tools away from the same token within the Toolbox's 60-second cache window", async () => {
    const { receipt } = await change(staffClient, "access_revoke", { organizationId: newco.organizationId, entitlementId: newco.entitlementId })
    await audited(staffClient, receipt)
    const gone = await until(["toolbox_whoami"])
    step(`toolbox: the e2e tools were gone ${gone} ms after access_revoke, polling tools/list every second with the same token`)
    expect(gone).toBeLessThan(60_000)
  })
})

// Some tools, not all: a grant string that names one capability, held through a group or by one member, while the organisation-wide grant is disabled.
describe("A8 tool-level access", () => {
  const memberPage = z.object({ items: z.array(z.object({ id: z.uuid(), email: z.string() })) })
  let member: string

  test("members_list by the person's email finds their member: the one their Toolbox token names", async () => {
    const { items } = memberPage.parse(await tool(staffClient, "members_list", { organizationId: newco.organizationId, email: id.manifest.spares[0]!.email }))
    expect(items).toHaveLength(1)
    member = items[0]!.id
    expect(claims(person).membership_id).toBe(member)
  })

  test("access_grant of e2e/records.list to the group, then groups_addmember: the same token lists that one tool and calls it; e2e_records_show is the unknown-tool error and a denial in the Toolbox's evidence", async () => {
    const granted = await change(staffClient, "access_grant", { organizationId: newco.organizationId, principal: { kind: "group", id: newco.groupId }, resource: toolboxResource, scopes: ["e2e/records.list"] })
    await audited(staffClient, granted.receipt)
    const added = await change(staffClient, "groups_addmember", { organizationId: newco.organizationId, groupId: newco.groupId, memberId: member })
    await audited(staffClient, added.receipt)
    const listed = await until(["e2e_records_list", "toolbox_whoami"])
    step(`toolbox: e2e_records_list alone listed ${listed} ms after the group's grant and the membership`)
    expect(listed).toBeLessThan(60_000)
    expect(await tool(toolbox, "toolbox_whoami")).toMatchObject({ grants: ["e2e/records.list"], capabilities: [{ identity: "e2e/records.list", kind: "read", policy_class: null }] })
    expect(await tool(toolbox, "e2e_records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
    await expect(toolbox.callTool({ name: "e2e_records_show", arguments: {} })).rejects.toThrow("Tool e2e_records_show not found")
    const denied = await stack.toolboxDatabase`select kind, outcome, capability_identity, reason from evidence_events where organisation_id = ${newco.organizationId} and kind = 'capability.denied'`
    expect(denied).toEqual([{ kind: "capability.denied", outcome: "denied", capability_identity: "e2e/records.show", reason: "not granted" }])
  })

  test("access_grant of e2e/records.create to the member alone: the list adds the prepare tool and the two commit tools, and toolbox_whoami shows both grants", async () => {
    const { receipt } = await change(staffClient, "access_grant", { organizationId: newco.organizationId, principal: { kind: "member", id: member }, resource: toolboxResource, scopes: ["e2e/records.create"] })
    await audited(staffClient, receipt)
    const listed = await until(["e2e_records_create", "e2e_records_list", "toolbox_commit", "toolbox_commit_confirmed", "toolbox_whoami"])
    step(`toolbox: e2e_records_create and the commit tools listed ${listed} ms after the member's grant`)
    expect(listed).toBeLessThan(60_000)
    expect(await tool(toolbox, "toolbox_whoami")).toMatchObject({ grants: ["e2e/records.create", "e2e/records.list"] })
  })

  test("groups_dropmember: the group's tool goes from the same token and the member's own stays", async () => {
    const { receipt } = await change(staffClient, "groups_dropmember", { organizationId: newco.organizationId, groupId: newco.groupId, memberId: member })
    await audited(staffClient, receipt)
    const left = await until(["e2e_records_create", "toolbox_commit", "toolbox_commit_confirmed", "toolbox_whoami"])
    step(`toolbox: e2e_records_list gone ${left} ms after groups_dropmember`)
    expect(left).toBeLessThan(60_000)
    expect(await tool(toolbox, "toolbox_whoami")).toMatchObject({ grants: ["e2e/records.create"] })
  })

  test("access_enable of the organisation-wide grant brings every e2e tool back; organisations_disable by an owner with a recent sign-in: the organisation's refresh answers invalid_grant", async () => {
    const again = await change(staffClient, "access_enable", { organizationId: newco.organizationId, entitlementId: newco.entitlementId })
    await audited(staffClient, again.receipt)
    const back = await until(toolboxTools)
    step(`toolbox: the e2e tools were back ${back} ms after access_enable`)
    expect(back).toBeLessThan(60_000)
    const { receipt } = await change(staffClient, "organisations_disable", { organizationId: newco.organizationId })
    expect(receipt.results).toMatchObject({ organizationId: newco.organizationId, status: "disabled" })
    await audited(staffClient, receipt)
    await refreshRefused(person, toolboxHost.clientId, toolboxResource)
  })
})

describe("A4 refusals", () => {
  test("a member of a client organisation is refused by ID at the chooser; given the admin resource deliberately, they get a token and the admin MCP lists nothing", async () => {
    const tenant = id.manifest.tenants[0]!
    const asTenant = { slug: tenant.slug, email: tenant.email, scopes: ["admin"] }
    expect(await signInRefused(browser, adminTarget(), asTenant)).toBe(refusalText)
    await grantOrganisation(id.admin, tenant.organizationId, { clientId: adminHost.clientId, resource: adminResource, scopes: ["admin"] })
    const member = await signIn(browser, adminTarget(), asTenant)
    expect(claims(member)).toMatchObject({ aud: adminResource, organization_id: tenant.organizationId })
    const client = await on(member)
    expect(await names(client)).toEqual([])
    await expect(client.callTool({ name: "admin_whoami", arguments: {} })).rejects.toThrow("Tool admin_whoami not found")
    expect((await chain()).filter(row => row.actor_id === claims(member).sub)).toEqual([
      expect.objectContaining({ kind: "capability.denied", outcome: "denied", capability_identity: "admin/admin.whoami", reason: "not_platform", data: { organisation_id: tenant.organizationId } }),
    ])
  })

  test("an admin is not an owner: organisations_disable is the unknown-tool error with a capability.denied row, and groups_addmember on the owner group of the platform organisation is PERMISSION_DENIED with nothing written", async () => {
    await change(staffClient, "staff_grant", { memberId: colleagueMember, role: "admin" })
    expect(await names(colleagueClient)).toEqual(adminTools)
    expect(await tool(colleagueClient, "admin_whoami")).toMatchObject({ role: "admin" })
    await expect(colleagueClient.callTool({ name: "organisations_disable", arguments: { organizationId: newco.organizationId } })).rejects.toThrow("Tool organisations_disable not found")
    const denials = (await chain()).filter(row => row.kind === "capability.denied" && row.actor_id === claims(colleague).sub)
    expect(denials.map(row => [row.capability_identity, row.reason, row.data])).toEqual([
      // A1 left the first, when the colleague held no role; this is the second.
      ["admin/organisations.list", "role_below_minimum", { held: null, needed: "team" }],
      ["admin/organisations.disable", "role_below_minimum", { held: "admin", needed: "owner" }],
    ])
    const intents = async () => (await stack.database`select count(*)::int as n from intents where capability_identity = 'admin/groups.addmember'`)[0].n as number
    const [before, members] = [await intents(), `/organizations/${platformOrganization()}/groups/${stack.groups.owner}/members`]
    const denied = await refusal(colleagueClient, "groups_addmember", { organizationId: platformOrganization(), groupId: stack.groups.owner, memberId: colleagueMember })
    expect(denied).toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringContaining("owner's critical operation") })
    expect(z.object({ items: z.array(z.object({ memberId: z.uuid() })) }).parse(await id.admin("GET", members)).items.map(item => item.memberId)).toEqual([staffMember])
    expect(await intents()).toBe(before)
    expect(await tool(colleagueClient, "admin_whoami")).toMatchObject({ role: "admin" })
  })

  test("renaming the organisation through the kit between prepare and commit of organisations_update answers INTENT_STALE with the ETags", async () => {
    const tenant = id.manifest.tenants[0]!
    const intent = await prepare(staffClient, "organisations_update", { organizationId: tenant.organizationId, name: "Renamed by the admin MCP" })
    const [target] = intent.targets
    expect(target).toMatchObject({ resource_type: "organization", resource_id: tenant.organizationId, version: { kind: "etag" } })
    await id.admin("PATCH", `/organizations/${tenant.organizationId}`, { name: "Renamed by root" })
    const stale = await refusal(staffClient, "admin_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary })
    const { targets } = z.object({ targets: z.array(z.object({ resource_id: z.string(), expected: z.string(), current: z.string() })) }).parse(stale.details)
    expect(stale.code).toBe("INTENT_STALE")
    expect(targets).toHaveLength(1)
    const [{ resource_id, expected, current }] = targets as [(typeof targets)[number]]
    expect([resource_id, expected]).toEqual([tenant.organizationId, target!.version.value])
    expect(current).toMatch(/^"[0-9a-f-]{36}:\d+"$/)
    expect(current).not.toBe(expected)
    expect(await id.admin("GET", `/organizations/${tenant.organizationId}`)).toMatchObject({ name: "Renamed by root" })
    step(`INTENT_STALE: expected ${expected}, current ${current}`)
  })
})

describe("A5 idempotency", () => {
  test("committing one intent twice at once and then again makes one organisation and one audit row, and the replay says so", async () => {
    const intent = await prepare(staffClient, "organisations_create", { slug: "idem", name: "Idem" })
    const arguments_ = { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary }
    const second = await on(staff)
    const settled = await Promise.all([staffClient, second].map(client => client.callTool({ name: "admin_commit_confirmed", arguments: arguments_ })))
    const answers: ({ error: string } | { receipt: Receipt })[] = settled.map(result => (result.isError ? { error: errorOf(result).code } : { receipt: receiptSchema.parse(result.structuredContent) }))
    const winners = answers.flatMap(answer => ("receipt" in answer && !answer.receipt.idempotent_replay ? [answer.receipt] : []))
    expect(winners).toHaveLength(1)
    const [winner] = winners as [Receipt]
    for (const answer of answers) {
      if ("error" in answer) expect(answer.error).toBe("COMMIT_IN_PROGRESS")
      else expect({ ...answer.receipt, idempotent_replay: false }).toEqual(winner)
    }
    step(`two concurrent commits answered: ${answers.map(answer => ("receipt" in answer ? `receipt, idempotent_replay ${answer.receipt.idempotent_replay}` : answer.error)).join("; ")}`)
    const replay = await confirm(staffClient, intent)
    expect(replay).toEqual({ ...winner, idempotent_replay: true })
    writes.push({ tool: "organisations_create", receipt: winner })
    idem = z.uuid().parse(winner.results.organizationId)
    const slugs = z.object({ items: z.array(z.object({ slug: z.string() })) }).parse(await id.admin("GET", "/organizations?q=idem")).items.filter(item => item.slug === "idem")
    expect(slugs).toHaveLength(1)
    const created = auditPage.parse(await id.admin("GET", `/audit-events?action=organization.created&targetId=${idem}`)).items
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ operationId: winner.results.operationId })
    await audited(staffClient, winner)
    expect((await chain()).filter(row => row.intent_id === intent.intent_id).map(row => row.kind)).toEqual(["intent.prepared", "intent.committed", "receipt.issued"])
  })
})

describe("A6 freshness", () => {
  let fresh: OAuthSession

  test(`with ADMIN_FRESH_SECONDS=${freshSeconds}, a critical tool's prepare answers ADMIN_REAUTHENTICATION_REQUIRED, naming the remedy; reads still work, and authorising again in the host alone changes nothing`, async () => {
    adminMcp = stack.adminMcp(freshSeconds)
    const stale = await refusal(staffClient, "organisations_disable", { organizationId: idem })
    expect(stale).toMatchObject({
      code: "ADMIN_REAUTHENTICATION_REQUIRED", retry: { policy: "after_state_change" },
      message: expect.stringContaining(`open ${id.manifest.idOrigin}/security and choose Verify sign-in; then, in your host, clear this server's authentication and authenticate again`),
      details: { upstream_auth_time: claims(staff).upstream_auth_time, max_age_seconds: freshSeconds },
    })
    expect(await tool(staffClient, "organisations_list", { q: "idem" })).toMatchObject({ items: [{ slug: "idem" }] })
    expect((await chain()).findLast(row => row.kind === "capability.denied")).toMatchObject({ capability_identity: "admin/organisations.disable", reason: "stale_authentication", data: { max_age_seconds: freshSeconds } })
    const again = await signIn(staffBrowser, adminTarget(), staffPerson())
    expect(claims(again)).toMatchObject({ sid: claims(staff).sid, upstream_auth_time: claims(staff).upstream_auth_time })
    expect(await refusal(await on(again), "organisations_disable", { organizationId: idem })).toMatchObject({ code: "ADMIN_REAUTHENTICATION_REQUIRED" })
  })

  test("the remedy: Verify sign-in on ID's Security page in the browser that holds the session, then a new authorisation in the host: the critical tool prepares and commits", async () => {
    const started = performance.now()
    await verifySignIn(staffBrowser, id.manifest.idOrigin)
    fresh = await signIn(staffBrowser, adminTarget(), staffPerson())
    expect(claims(fresh).sid).not.toBe(claims(staff).sid)
    expect(Number(claims(fresh).upstream_auth_time)).toBeGreaterThan(Number(claims(staff).upstream_auth_time))
    const client = await on(fresh)
    const { receipt } = await change(client, "organisations_disable", { organizationId: idem })
    expect(receipt.results).toMatchObject({ organizationId: idem, status: "disabled" })
    expect(await id.admin("GET", `/organizations/${idem}`)).toMatchObject({ status: "disabled" })
    await audited(client, receipt)
    step(`freshness: Verify sign-in, a new authorisation and the committed critical tool took ${Math.round(performance.now() - started)} ms against a ${freshSeconds}-second window`)
  })

  test("a refresh keeps the sign-in time: once the window has passed, the refreshed token is refused again", async () => {
    const time = Number(claims(fresh).upstream_auth_time)
    await Bun.sleep(Math.max(0, (time + freshSeconds + 1) * 1000 - Date.now()))
    const before = claims(fresh)
    fresh.state.tokens = { ...fresh.state.tokens!, access_token: "expired" }
    const client = await on(fresh)
    expect(await refusal(client, "organisations_enable", { organizationId: idem })).toMatchObject({ code: "ADMIN_REAUTHENTICATION_REQUIRED", details: { upstream_auth_time: time } })
    expect(claims(fresh)).toMatchObject({ sid: before.sid, upstream_auth_time: before.upstream_auth_time })
    expect(claims(fresh).jti).not.toBe(before.jti)
  })
})

describe("A7 evidence", () => {
  test("the platform organisation's chain verifies and holds every kind of row, and every write joins an ID audit row by request id", async () => {
    const rows = await chain()
    expect(await createEvidence(stack.database).verify(platformOrganization())).toEqual({ ok: true, length: rows.length })
    const kinds = rows.reduce<Record<string, number>>((count, row) => ({ ...count, [row.kind]: (count[row.kind] ?? 0) + 1 }), {})
    for (const kind of ["capability.completed", "capability.denied", "intent.prepared", "intent.committed", "receipt.issued", "intent.stale"]) expect(kinds[kind], kind).toBeGreaterThan(0)
    step(`evidence: ${rows.length} events on the platform organisation's chain, verified; ${Object.entries(kinds).map(([kind, count]) => `${kind} ${count}`).join(", ")}`)
    // Every write ID audited for the machine client names the execution id of a commit that succeeded (its token requests are audited too, with ids of their own).
    const audit = auditPage.parse(await id.admin("GET", "/audit-events?actorId=admin-mcp&limit=200")).items.filter(event => !event.action.startsWith("oauth."))
    const commitsDone = new Set(rows.filter(row => row.kind === "capability.completed" && row.capability_identity === "admin/commit_confirmed" && row.outcome === "success").map(row => row.execution_id))
    for (const event of audit) expect(commitsDone.has(event.requestId), `${event.action} ${event.requestId}`).toBe(true)
    // Each committed intent that wrote to ID wrote once: the Toolbox's enable is the Toolbox's own writes, under its own client.
    const [{ n }] = await stack.database`select count(*)::int as n from intents where status = 'committed' and capability_identity <> 'admin/toolbox.enable'`
    expect(new Set(audit.map(event => event.requestId)).size).toBe(n)
    for (const { tool: name, receipt } of writes.filter(write => write.tool !== "toolbox_enable")) {
      // staff_revoke leaves each group in turn, one operation each.
      for (const operationId of (receipt.results.operationIds as string[] | undefined) ?? [receipt.results.operationId]) {
        expect(audit.filter(event => event.operationId === operationId), `${name} ${receipt.receipt_id}`).toHaveLength(1)
      }
    }
    step(`ID's audit: ${audit.length} rows by the machine client, one per committed write (${n}), each joined to its commit's evidence; ${asked.access.length} member-access reads and ${asked.tokens} token requests by the admin MCP`)
  })
})
