// Real Answerable ID, a real browser and the official MCP OAuth client against the Toolbox, with the e2e provider mounted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SQL } from "bun"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { toolboxAdminResource } from "@answerable/mcp-toolbox/admin"
import { writeCatalogue } from "@answerable/mcp-toolbox/catalogue"
import { createEvidence } from "@answerable/mcp-toolbox/evidence"
import { allowedScopes } from "@answerable/mcp-toolbox/grants"
import { migrate } from "@answerable/mcp-toolbox/migrate"
import { startGrantsPoller } from "@answerable/mcp-toolbox/poller"
import { createMemoryTracer } from "@answerable/mcp-toolbox/spans"
import { createToolbox } from "@answerable/mcp-toolbox/toolbox"
import type { Client } from "@modelcontextprotocol/client"
import { decodeJwt } from "jose"
import { z } from "zod"
import {
  connect,
  entitle,
  launchBrowser,
  linkClient,
  refusal,
  registerClient,
  registerResource,
  serve,
  signIn,
  startId,
  step,
  tool,
  type Admin,
  type Id,
  type OAuthSession,
} from "../index"

const resource = "http://127.0.0.1:47604/mcp"
const toolboxAdmin = toolboxAdminResource(resource)
const callback = "http://127.0.0.1:47603/callback"
const clientId = "toolbox-browser"
// A second host client, set to the meta projection in the Toolbox; alpha signs in through it too.
const metaClientId = "toolbox-meta"
const hubClientId = "toolbox-hub"
const staffClientId = "toolbox-staff"
const database = "answerable_toolbox_acceptance"
const tenants = [
  { slug: "toolbox-alpha", grants: ["e2e"], signIns: 2 },
  { slug: "toolbox-beta", grants: ["e2e/records"], signIns: 1 },
  { slug: "toolbox-gamma", grants: [], signIns: 1 },
]
const providers = [createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html><title>Records</title>" })]
const records = ["e2e_records_create", "e2e_records_delete", "e2e_records_list", "e2e_records_show"]
const commits = ["toolbox_commit", "toolbox_commit_confirmed"]
const metaTools = ["toolbox_whoami", "toolbox_search", "toolbox_describe", "toolbox_execute", "toolbox_prepare", ...commits]
const intentSchema = z.object({ intent_id: z.uuid(), commit_token: z.string(), commit_tool: z.string(), policy_class: z.string(), preview: z.object({ summary: z.string() }) })
const commitArgs = ({ intent_id, commit_token }: z.infer<typeof intentSchema>) => ({ intent_id, commit_token })
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

let id: Id
let staffSecret: string
let db: SQL
let browser: Awaited<ReturnType<typeof launchBrowser>>
let poller: ReturnType<typeof startGrantsPoller> | undefined
const { tracer, spans } = createMemoryTracer()
const sessions = new Map<string, { organizationId: string; oauth: OAuthSession }>()
let meta: OAuthSession
// What the Toolbox asked ID, for the evidence report: each access-view read with its latency, token requests and audit-log polls.
const asked = { access: [] as number[], tokens: 0, polls: 0 }
let reads = 0

async function counted(input: string | URL | Request, init?: RequestInit) {
  const { pathname } = new URL(input instanceof Request ? input.url : input)
  const started = performance.now()
  const response = await fetch(input, init)
  if (pathname.endsWith("/access")) asked.access.push(performance.now() - started)
  else if (pathname.endsWith("/token")) asked.tokens++
  else if (pathname.endsWith("/audit-events")) asked.polls++
  return response
}
// A machine client of the platform organisation: its secret, once, with the capability to ask for `scopes` for `audience`.
async function registerMachine(admin: Admin, organizationId: string, clientId: string, scopes: string[], audience: string) {
  const created = z.object({ clientSecret: z.string() }).parse(await admin("POST", "/clients", {
    clientId, name: clientId, organizationId, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], clientCredentialsScopes: scopes,
  }))
  await linkClient(admin, clientId, audience)
  await admin("POST", `/organizations/${organizationId}/capabilities`, { clientId, resource: audience, grantKind: "client_credentials", scopes })
  return created.clientSecret
}
// A token for the Toolbox's admin resource from ID, as the staff client.
async function staffToken() {
  const response = await fetch(new URL("/auth/oauth2/token", id.manifest.idOrigin), {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${staffClientId}:${staffSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: toolboxAdmin, scope: "toolbox:admin" }),
  })
  if (!response.ok) throw new Error(`ID refused the staff client a token for ${toolboxAdmin} (${response.status}): ${await response.text()}`)
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token
}
// The Toolbox's admin API as staff.
async function toolboxAdminCall(method: string, path: string, body?: unknown) {
  const response = await fetch(`${new URL(resource).origin}/admin/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${await staffToken()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
}
function session(slug: string) {
  const found = sessions.get(slug)
  if (!found) throw new Error(`${slug} never signed in; the first test shows why`)
  return found
}
const tenant = (slug: string) => id.manifest.tenants.find(entry => entry.slug === slug)!
const clientFor = (slug: string, protocol: "2025" | "2026-07-28" = "2026-07-28") => connect(resource, session(slug).oauth.provider, protocol)
const names = async (client: Client) => (await client.listTools()).tools.map(item => item.name)
const events = (organisation: string) => db`select kind, outcome, capability_identity, execution_id::text as execution_id, trace_id, span_id from evidence_events where organisation_id = ${organisation} order by seq`

beforeAll(async () => {
  id = await startId({ tenants: tenants.map(({ slug, signIns }) => ({ slug, signIns })) })
  const { admin, manifest } = id
  step("Registering the Toolbox resource, its admin resource and two public clients")
  // The resource allows only `toolbox` and `offline_access`: enabling an organisation widens it to the providers' grant strings.
  await registerResource(admin, { identifier: resource, scopes: ["toolbox"], accessTokenTtl: 60 })
  await registerResource(admin, { identifier: toolboxAdmin, scopes: ["toolbox:admin"], accessTokenTtl: 300 })
  await registerClient(admin, { clientId, redirectUri: callback, scopes: ["toolbox"] })
  await registerClient(admin, { clientId: metaClientId, redirectUri: callback, scopes: ["toolbox"] })
  step("Registering the Toolbox's machine client and a staff client in the platform organisation")
  const organisations = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", "/organizations?q=answerable"))
  const platform = organisations.items.find(organisation => organisation.slug === "answerable")!
  const hubSecret = await registerMachine(admin, platform.id, hubClientId, ["platform:read", "platform:write"], manifest.adminResource)
  staffSecret = await registerMachine(admin, platform.id, staffClientId, ["toolbox:admin"], toolboxAdmin)
  // ID makes its signing key when it signs its first token, and two first tokens at once make two keys: a verifier that read the keys between them
  // refuses the second's token for 30 seconds. The Toolbox's poller and the first enable call would ask together, so one token comes first.
  await staffToken()
  step(`Creating and migrating ${database}`)
  const server = new SQL({ url: "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test", max: 1 })
  await server.unsafe(`create database ${database}`)
  await server.close()
  db = new SQL({ url: `postgres://answerable:answerable@127.0.0.1:47532/${database}`, max: 4 })
  await migrate(db)
  const hubId = { issuer: manifest.idOrigin, adminResource: manifest.adminResource, clientId: hubClientId, clientSecret: hubSecret, fetch: counted }
  const toolbox = await createToolbox({ providers, auth: { issuer: manifest.idOrigin, resource }, db, id: hubId, spans: tracer })
  const read = toolbox.grants.read
  toolbox.grants.read = principal => {
    reads++
    return read(principal)
  }
  poller = startGrantsPoller({ id: hubId, grants: toolbox.grants })
  serve(47_604, toolbox.fetch)
  serve(Number(new URL(callback).port), () => new Response("Signed in. You can close this page."))
  // The catalogue is the ceiling: gamma may use e2e but has no entitlement to any of it until J3. Alpha also signs in through the meta host client.
  step("Enabling the Toolbox for each organisation through its admin API, then entitling members and setting the meta host client")
  for (const { slug, grants } of tenants) {
    const { organizationId } = tenant(slug)
    const hostClientIds = slug === "toolbox-alpha" ? [clientId, metaClientId] : [clientId]
    const enabled = await toolboxAdminCall("POST", `/organisations/${organizationId}/enable`, { hostClientIds, providers: providers.map(provider => provider.id) })
    if (enabled.status !== 200) throw new Error(`Enabling ${slug} answered ${enabled.status}: ${JSON.stringify(enabled.body)}`)
    if (grants.length) await entitle(admin, organizationId, { resource, scopes: grants })
  }
  const host = await toolboxAdminCall("PUT", `/host-clients/${metaClientId}`, { projection: "meta" })
  if (host.status !== 200) throw new Error(`Setting ${metaClientId} to meta answered ${host.status}: ${JSON.stringify(host.body)}`)
  browser = await launchBrowser()
})
afterAll(async () => {
  poller?.stop()
  await db?.close()
  await id?.stop()
})

test("each organisation signs in to the Toolbox through ID, and its token carries toolbox and offline_access only", async () => {
  for (const { slug } of tenants) {
    step(`${slug}: signing in to the Toolbox`)
    const { organizationId, email } = tenant(slug)
    const oauth = await signIn(browser, { idOrigin: id.manifest.idOrigin, resource, clientId, callback, scopes: ["toolbox"] }, { slug, email, scopes: ["toolbox"] })
    const claims = decodeJwt(oauth.state.tokens!.access_token)
    expect(claims.aud).toBe(resource)
    expect(String(claims.scope).split(" ").sort()).toEqual(["offline_access", "toolbox"])
    sessions.set(slug, { organizationId, oauth })
  }
  step("toolbox-alpha: signing in again through the meta host client")
  const { slug, email } = tenant("toolbox-alpha")
  meta = await signIn(browser, { idOrigin: id.manifest.idOrigin, resource, clientId: metaClientId, callback, scopes: ["toolbox"] }, { slug, email, scopes: ["toolbox"] })
})

describe("J1 direct list", () => {
  test("alpha, granted e2e, lists toolbox_whoami, every e2e capability by domain and operation, then the commit tools, described honestly", async () => {
    const tools = (await (await clientFor("toolbox-alpha")).listTools()).tools
    expect(tools.map(item => item.name)).toEqual(["toolbox_whoami", "e2e_identity_get", ...records, ...commits])
    const byName = new Map(tools.map(item => [item.name, item]))
    for (const name of ["toolbox_whoami", "e2e_identity_get", "e2e_records_list", "e2e_records_show", "e2e_records_create", "e2e_records_delete"]) {
      expect(byName.get(name)!.annotations, name).toEqual(readOnly)
    }
    expect(byName.get("e2e_records_list")!._meta).toEqual({ "com.answerable/capability": { identity: "e2e/records.list", version: "2026-09-29", kind: "read" } })
    expect(byName.get("e2e_records_show")!._meta).toMatchObject({ ui: { resourceUri: "ui://records/index.html" } })
    expect(byName.get("e2e_records_create")!._meta).toEqual({ "com.answerable/capability": { identity: "e2e/records.create", version: "2026-09-29", kind: "mutate", risk: "low", policy_class: "agent" } })
    expect(byName.get("e2e_records_delete")!._meta).toMatchObject({ "com.answerable/capability": { risk: "normal", policy_class: "controlled" } })
    expect(byName.get("toolbox_commit")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.get("toolbox_commit_confirmed")!).toMatchObject({ annotations: { destructiveHint: true }, _meta: { "anthropic/requiresUserInteraction": true } })
  })

  test("toolbox_whoami returns the person, the organisation, the host client and the grants", async () => {
    const { oauth, organizationId } = session("toolbox-alpha")
    const claims = decodeJwt(oauth.state.tokens!.access_token)
    expect(await tool(await clientFor("toolbox-alpha"), "toolbox_whoami")).toEqual({
      user_id: claims.sub, organisation_id: organizationId, membership_id: claims.membership_id, client_id: clientId, grants: ["e2e"],
      capabilities: [
        { identity: "e2e/identity.get", kind: "read", policy_class: null },
        { identity: "e2e/records.create", kind: "mutate", policy_class: "agent" },
        { identity: "e2e/records.delete", kind: "mutate", policy_class: "controlled" },
        { identity: "e2e/records.list", kind: "read", policy_class: null },
        { identity: "e2e/records.show", kind: "read", policy_class: null },
      ],
    })
  })

  test("e2e_records_list succeeds and leaves a capability.completed row and a span for the call", async () => {
    const { organizationId } = session("toolbox-alpha")
    expect(await tool(await clientFor("toolbox-alpha"), "e2e_records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
    const span = spans().findLast(item => item.name === "tools/call e2e/records.list" && item.attributes["answerable.organisation.id"] === organizationId)!
    expect(span.attributes).toMatchObject({ "mcp.method.name": "tools/call", "gen_ai.tool.name": "e2e_records_list", "answerable.outcome": "success", "answerable.client.name": clientId })
    const row = (await events(organizationId)).find((event: { execution_id: string }) => event.execution_id === span.attributes["gen_ai.tool.call.id"])
    expect(row).toEqual({
      kind: "capability.completed", outcome: "success", capability_identity: "e2e/records.list", execution_id: span.attributes["gen_ai.tool.call.id"],
      trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId,
    })
  })
})

describe("J2 partial and denied", () => {
  test("beta, granted e2e/records, lists toolbox_whoami, the records domain and the commit tools", async () => {
    expect(await names(await clientFor("toolbox-beta"))).toEqual(["toolbox_whoami", ...records, ...commits])
  })

  test("gamma, granted nothing, lists only toolbox_whoami; calling e2e_records_list is the unknown-tool error and a denial in evidence", async () => {
    const client = await clientFor("toolbox-gamma")
    expect(await names(client)).toEqual(["toolbox_whoami"])
    await expect(client.callTool({ name: "e2e_records_list", arguments: {} })).rejects.toThrow("Tool e2e_records_list not found")
    expect(await events(session("toolbox-gamma").organizationId)).toEqual([
      { kind: "capability.denied", outcome: "denied", capability_identity: "e2e/records.list", execution_id: null, trace_id: null, span_id: null },
    ])
  })
})

describe("J6 human class", () => {
  test("with e2e/records.delete set to human for beta, its prepare waits for an approval: both commit tools answer APPROVAL_REQUIRED, pending", async () => {
    const { organizationId } = session("toolbox-beta")
    await writeCatalogue(db, organizationId, "e2e", { enabled: true, overrides: { policy_class: { "e2e/records.delete": "human" } } })
    const client = await clientFor("toolbox-beta")
    const created = intentSchema.parse(await tool(client, "e2e_records_create", { title: "Beta's record" }))
    const record = z.object({ results: z.object({ id: z.uuid() }) }).parse(await tool(client, "toolbox_commit", commitArgs(created))).results
    const prepared = await tool(client, "e2e_records_delete", { id: record.id })
    expect(prepared).toMatchObject({ policy_class: "human", commit_tool: "toolbox_commit_confirmed", approval: { required: true, status: "pending" } })
    const intent = intentSchema.parse(prepared)
    for (const [name, args] of [["toolbox_commit", commitArgs(intent)], ["toolbox_commit_confirmed", { ...commitArgs(intent), preview_summary: intent.preview.summary }]] as const) {
      const refused = await refusal(client, name, args)
      expect(refused).toMatchObject({ code: "APPROVAL_REQUIRED", retry: { policy: "after_approval" } })
      // No approval.url: approval pages are Not yet.
      expect(refused.details).toEqual({ approval: { class: "human", commit_tool: "toolbox_commit_confirmed", status: "pending" } })
    }
    expect<unknown>(await db`select status from intents where intent_id = ${intent.intent_id}`).toEqual([{ status: "awaiting_approval" }])
    const kinds = await db`select kind from evidence_events where intent_id = ${intent.intent_id} order by seq`
    expect(kinds.map((row: { kind: string }) => row.kind)).toEqual(["intent.prepared", "intent.approval_requested", "capability.completed"])
    step("toolbox-beta: the intent waits as awaiting_approval; the approval page is Not yet")
  })
})

describe("J7 meta projection", () => {
  const metaClient = () => connect(resource, meta.provider, "2026-07-28")

  test("alpha, through the host client set to meta, lists exactly toolbox_whoami, the four meta tools and the two commit tools", async () => {
    expect(await names(await metaClient())).toEqual(metaTools)
  })

  test("toolbox_search finds e2e/records.list by a word of its description; toolbox_describe gives its schemas; toolbox_execute runs it", async () => {
    const client = await metaClient()
    const latencies: number[] = []
    for (let run = 0; run < 20; run++) {
      const started = performance.now()
      const found = await tool(client, "toolbox_search", { query: "oldest" })
      latencies.push(performance.now() - started)
      expect(found).toEqual({
        items: [{ identity: "e2e/records.list", title: null, description: "List your organisation's test records, oldest first, 20 per page by default and at most 100.", kind: "read", policy_class: null }],
        next_cursor: null, has_more: false,
      })
    }
    latencies.sort((a, b) => a - b)
    step(`toolbox_search: 20 calls, median ${latencies[10]!.toFixed(1)} ms, max ${latencies.at(-1)!.toFixed(1)} ms`)
    const [described] = z.object({ capabilities: z.array(z.object({ identity: z.string(), input: z.record(z.string(), z.unknown()), output: z.record(z.string(), z.unknown()) })) })
      .parse(await tool(client, "toolbox_describe", { identities: ["e2e/records.list"] })).capabilities
    expect(described!.input).toMatchObject({ type: "object", properties: { limit: {}, cursor: {} }, additionalProperties: false })
    expect(described!.output).toMatchObject({ type: "object", required: ["items", "next_cursor", "has_more"] })
    expect(await tool(client, "toolbox_execute", { identity: "e2e/records.list" })).toEqual({ items: [], next_cursor: null, has_more: false })
  })

  test("toolbox_prepare prepares e2e/records.create and toolbox_commit commits it; e2e/records.delete commits with toolbox_commit_confirmed and the summary", async () => {
    const client = await metaClient()
    const created = intentSchema.parse(await tool(client, "toolbox_prepare", { identity: "e2e/records.create", arguments: { title: "Through the meta tools" } }))
    expect(created).toMatchObject({ policy_class: "agent", commit_tool: "toolbox_commit" })
    const record = z.object({ results: z.object({ id: z.uuid(), title: z.string() }) }).parse(await tool(client, "toolbox_commit", commitArgs(created))).results
    expect(record.title).toBe("Through the meta tools")
    const removed = intentSchema.parse(await tool(client, "toolbox_prepare", { identity: "e2e/records.delete", arguments: { id: record.id } }))
    expect(removed).toMatchObject({ policy_class: "controlled", commit_tool: "toolbox_commit_confirmed" })
    expect(await tool(client, "toolbox_commit_confirmed", { ...commitArgs(removed), preview_summary: removed.preview.summary })).toMatchObject({ status: "committed", results: { deleted: true, id: record.id } })
    expect(await tool(client, "toolbox_execute", { identity: "e2e/records.list" })).toEqual({ items: [], next_cursor: null, has_more: false })
  })
})

describe("J3 grant change without re-authorisation", () => {
  test("an entitlement added to gamma in ID reaches the same token within 60 seconds, and a listening client hears tools/list_changed", async () => {
    const { oauth, organizationId } = session("toolbox-gamma")
    // Start from a fresh access token, so that the whole wait fits in its 60 seconds.
    oauth.state.tokens = { ...oauth.state.tokens!, access_token: "expired" }
    const client = await clientFor("toolbox-gamma", "2025")
    expect(await names(client)).toEqual(["toolbox_whoami"])
    const token = oauth.state.tokens!.access_token
    // A 2026-07-28 client that listens: on each tools/list_changed it lists again; it resolves once the list holds the new tool.
    let heard!: (at: number) => void
    const changed = new Promise<number>(resolve => { heard = resolve })
    await connect(resource, oauth.provider, "2026-07-28", (error, tools) => {
      if (error) throw error
      if (tools?.some(item => item.name === "e2e_identity_get")) heard(performance.now())
    })
    step("toolbox-gamma: adding an entitlement to e2e/identity in ID")
    await entitle(id.admin, organizationId, { resource, scopes: ["e2e/identity"] })
    const started = performance.now()
    let listed = await names(client)
    while (!listed.includes("e2e_identity_get") && performance.now() - started < 60_000) {
      await Bun.sleep(5_000)
      listed = await names(client)
    }
    const latency = Math.round(performance.now() - started)
    step(`toolbox-gamma: e2e_identity_get listed ${latency} ms after the entitlement, polling tools/list every 5 s`)
    expect(listed).toEqual(["toolbox_whoami", "e2e_identity_get"])
    expect(latency).toBeLessThan(60_000)
    expect(oauth.state.tokens!.access_token).toBe(token)
    const notified = Math.round(await Promise.race([changed, Bun.sleep(Math.max(0, 60_000 - latency)).then(() => Infinity)]) - started)
    step(`toolbox-gamma: tools/list_changed heard ${notified} ms after the entitlement, and the listening client's new list held e2e_identity_get`)
    expect(notified).toBeLessThan(60_000)
  })
})

test("J2: disabling gamma's organisation stops refresh with invalid_grant", async () => {
  const { oauth, organizationId } = session("toolbox-gamma")
  await id.admin("POST", `/organizations/${organizationId}/disable`)
  const refused = await fetch(oauth.state.discovery!.authorizationServerMetadata!.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: String(oauth.state.tokens?.refresh_token), resource }),
  })
  expect(refused.status).toBe(400)
  expect(await refused.json()).toMatchObject({ error: "invalid_grant" })
})

describe("J10 evidence", () => {
  const alpha = () => session("toolbox-alpha").organizationId
  const length = async () => (await db`select count(*)::int as events from evidence_events where organisation_id = ${alpha()}`)[0].events as number

  test("alpha's chain verifies: its calls, intents, commits and receipts", async () => {
    const events = await length()
    expect(events).toBeGreaterThan(2)
    expect(await createEvidence(db).verify(alpha())).toEqual({ ok: true, length: events })
  })

  test("an update and a delete through the superuser connection are refused by the trigger", async () => {
    const organisation = alpha()
    const run = async (query: PromiseLike<unknown>) => { await query }
    await expect(run(db`update evidence_events set outcome = 'failure' where organisation_id = ${organisation}`)).rejects.toThrow("evidence_events is append-only: UPDATE is refused")
    await expect(run(db`delete from evidence_events where organisation_id = ${organisation}`)).rejects.toThrow("evidence_events is append-only: DELETE is refused")
    expect(await createEvidence(db).verify(organisation)).toEqual({ ok: true, length: await length() })
  })

  test("erasing the preview of alpha's first intent.prepared keeps the chain valid and the row's payload_hash unchanged", async () => {
    const [prepared] = await db`select id::text, payload_ref::text, payload_hash from evidence_events where organisation_id = ${alpha()} and kind = 'intent.prepared' order by seq limit 1`
    expect<unknown>(await db`select body ->> 'summary' as summary from evidence_payloads where id = ${prepared.payload_ref}`).toEqual([{ summary: "Create record “Through the meta tools”" }])
    await createEvidence(db).erase(prepared.payload_ref)
    expect<unknown>(await db`select body, hash, erased_at is not null as erased from evidence_payloads where id = ${prepared.payload_ref}`).toEqual([{ body: null, hash: prepared.payload_hash, erased: true }])
    expect<unknown>(await db`select payload_hash from evidence_events where id = ${prepared.id}`).toEqual([{ payload_hash: prepared.payload_hash }])
    expect(await createEvidence(db).verify(alpha())).toEqual({ ok: true, length: await length() })
  })
})

test("the grant cache answered most reads; what the Toolbox asked ID is logged for the evidence report", async () => {
  const latencies = asked.access.toSorted((a, b) => a - b)
  const [chains] = await db`select count(*)::int as events, count(distinct organisation_id)::int as organisations from evidence_events`
  step(`grants: ${reads} reads, ${latencies.length} access-view calls to ID, hit rate ${((1 - latencies.length / reads) * 100).toFixed(1)}%`)
  step(`access view latency: median ${latencies[Math.floor(latencies.length / 2)]!.toFixed(1)} ms, max ${latencies.at(-1)!.toFixed(1)} ms`)
  step(`other ID calls: ${asked.tokens} token requests, ${asked.polls} audit-log reads; evidence: ${chains.events} events in ${chains.organisations} chains`)
  expect(latencies.length).toBeLessThan(reads)
})

describe("administration", () => {
  const alpha = () => session("toolbox-alpha").organizationId
  const held = async (path: string) => id.admin("GET", path)

  test("the admin API refuses a person's token, and lists what can be enabled to staff", async () => {
    const person = session("toolbox-alpha").oauth.state.tokens!.access_token
    const refused = await fetch(`${new URL(resource).origin}/admin/v1/providers`, { headers: { Authorization: `Bearer ${person}` } })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: { code: "unauthorized" } })
    const listed = await toolboxAdminCall("GET", "/providers")
    expect(listed).toMatchObject({ status: 200, body: { items: [{ id: "e2e", capabilities: expect.arrayContaining([{ identity: "e2e/records.show", version: "2026-09-29", kind: "read", risk: null, title: "Test records" }]) }] } })
  })

  test("the enable calls left the Toolbox resource allowing the providers' grant strings and linked to the host client; a repeat reports everything as existing and changes nothing in ID", async () => {
    const resourcePath = `/resources/${encodeURIComponent(resource)}`
    expect(await held(resourcePath)).toMatchObject({ allowedScopes: allowedScopes(providers), clients: expect.arrayContaining([clientId, metaClientId]) })
    const state = async () => ({ resource: await held(resourcePath), capabilities: await held(`/organizations/${alpha()}/capabilities`), entitlements: await held(`/organizations/${alpha()}/entitlements`) })
    const before = await state()
    step("toolbox-alpha: calling the enable operation a second time")
    const again = await toolboxAdminCall("POST", `/organisations/${alpha()}/enable`, { hostClientIds: [clientId], providers: ["e2e"] })
    expect(again).toMatchObject({ status: 200, body: { organisation_id: alpha(), created: [] } })
    expect(again.body.existing).toHaveLength(9)
    expect(await state()).toEqual(before)
  })

  test("PUT catalogue with a disabled identity hides that tool from alpha at once, and from no one else", async () => {
    // A 2026-07-28 client keeps tools/list for the 30 seconds the server allows, so this one speaks the 2025 protocol, as J3's does.
    const client = await clientFor("toolbox-alpha", "2025")
    expect(await names(client)).toContain("e2e_records_list")
    const put = await toolboxAdminCall("PUT", `/organisations/${alpha()}/catalogue/e2e`, { enabled: true, overrides: { disabled: ["e2e/records.list"] } })
    expect(put).toMatchObject({ status: 200, body: { provider_id: "e2e", enabled: true, overrides: { disabled: ["e2e/records.list"], policy_class: {} } } })
    const started = performance.now()
    expect(await names(client)).toEqual(["toolbox_whoami", "e2e_identity_get", "e2e_records_create", "e2e_records_delete", "e2e_records_show", ...commits])
    step(`toolbox-alpha: e2e_records_list hidden ${Math.round(performance.now() - started)} ms after the catalogue call`)
    expect(await names(await clientFor("toolbox-beta", "2025"))).toContain("e2e_records_list")
    const listed = await toolboxAdminCall("GET", `/organisations/${alpha()}/catalogue`)
    expect(listed.body).toEqual({ items: [{ provider_id: "e2e", enabled: true, overrides: { disabled: ["e2e/records.list"], policy_class: {} } }] })
    // Leave alpha as it was for the tests that follow.
    await toolboxAdminCall("PUT", `/organisations/${alpha()}/catalogue/e2e`, { enabled: true })
    expect(await names(client)).toContain("e2e_records_list")
  })

  test("the evidence check runs through the admin API, and host clients are stored", async () => {
    expect(await toolboxAdminCall("GET", `/organisations/${alpha()}/evidence/verify`)).toMatchObject({ status: 200, body: { ok: true } })
    expect(await toolboxAdminCall("PUT", `/host-clients/${clientId}`, { projection: "meta", direct_limit: 20 })).toMatchObject({ status: 200, body: { client_id: clientId, projection: "meta", direct_limit: 20 } })
    expect(await toolboxAdminCall("GET", "/host-clients")).toMatchObject({ body: { items: expect.arrayContaining([{ client_id: clientId, projection: "meta", direct_limit: 20 }, { client_id: metaClientId, projection: "meta", direct_limit: 40 }]) } })
    expect((await toolboxAdminCall("DELETE", `/host-clients/${clientId}`)).status).toBe(204)
  })
})
