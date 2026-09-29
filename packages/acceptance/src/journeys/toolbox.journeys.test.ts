// Real Answerable ID, a real browser and the official MCP OAuth client against the Toolbox, with the e2e provider mounted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SQL } from "bun"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
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
  grantOrganisation,
  launchBrowser,
  linkClient,
  registerClient,
  registerResource,
  serve,
  signIn,
  startId,
  step,
  tool,
  type Id,
  type OAuthSession,
} from "../index"

const resource = "http://127.0.0.1:47604/mcp"
const callback = "http://127.0.0.1:47603/callback"
const clientId = "toolbox-browser"
const hubClientId = "toolbox-hub"
const database = "answerable_toolbox_acceptance"
const tenants = [
  { slug: "toolbox-alpha", grants: ["e2e"] },
  { slug: "toolbox-beta", grants: ["e2e/records"] },
  { slug: "toolbox-gamma", grants: [] },
]
const providers = [createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html><title>Records</title>" })]
const records = ["e2e_records_create", "e2e_records_delete", "e2e_records_list", "e2e_records_show"]
const commits = ["toolbox_commit", "toolbox_commit_confirmed"]
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

let id: Id
let db: SQL
let browser: Awaited<ReturnType<typeof launchBrowser>>
let poller: ReturnType<typeof startGrantsPoller> | undefined
const { tracer, spans } = createMemoryTracer()
const sessions = new Map<string, { organizationId: string; oauth: OAuthSession }>()
// What the Toolbox asked ID, for the evidence report: each access-view read with its latency, token requests and audit-log polls.
const asked = { access: [] as number[], tokens: 0, polls: 0 }
let reads = 0

async function counted(input: string | URL | Request, init?: RequestInit) {
  const { pathname } = new URL(input instanceof Request ? input.url : input)
  const started = performance.now()
  const response = await fetch(input, init)
  if (pathname.endsWith("/access")) asked.access.push(performance.now() - started)
  else if (pathname.endsWith("/token")) asked.tokens++
  else asked.polls++
  return response
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
  id = await startId({ tenants: tenants.map(({ slug }) => ({ slug, signIns: 1 })) })
  const { admin, manifest } = id
  step("Registering the Toolbox resource, a public client and each organisation's access")
  await registerResource(admin, { identifier: resource, scopes: allowedScopes(providers), accessTokenTtl: 60 })
  await registerClient(admin, { clientId, redirectUri: callback, scopes: ["toolbox"] })
  await linkClient(admin, clientId, resource)
  for (const { slug, grants } of tenants) {
    const { organizationId } = tenant(slug)
    await grantOrganisation(admin, organizationId, { clientId, resource, scopes: ["toolbox"] })
    if (grants.length) await entitle(admin, organizationId, { resource, scopes: grants })
  }
  step("Registering the Toolbox's machine client in the platform organisation")
  const organisations = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", "/organizations?q=answerable"))
  const platform = organisations.items.find(organisation => organisation.slug === "answerable")!
  const hub = z.object({ clientSecret: z.string() }).parse(await admin("POST", "/clients", {
    clientId: hubClientId, name: "Toolbox", organizationId: platform.id, tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"], clientCredentialsScopes: ["platform:read"],
  }))
  await linkClient(admin, hubClientId, manifest.adminResource)
  await admin("POST", `/organizations/${platform.id}/capabilities`, { clientId: hubClientId, resource: manifest.adminResource, grantKind: "client_credentials", scopes: ["platform:read"] })
  step(`Creating and migrating ${database}`)
  const server = new SQL({ url: "postgres://answerable:answerable@127.0.0.1:47532/answerable_id_test", max: 1 })
  await server.unsafe(`create database ${database}`)
  await server.close()
  db = new SQL({ url: `postgres://answerable:answerable@127.0.0.1:47532/${database}`, max: 4 })
  await migrate(db)
  const hubId = { issuer: manifest.idOrigin, adminResource: manifest.adminResource, clientId: hubClientId, clientSecret: hub.clientSecret, fetch: counted }
  const toolbox = await createToolbox({ providers, auth: { issuer: manifest.idOrigin, resource }, db, id: hubId, spans: tracer })
  const read = toolbox.grants.read
  toolbox.grants.read = principal => {
    reads++
    return read(principal)
  }
  poller = startGrantsPoller({ id: hubId, grants: toolbox.grants })
  // Enabling a provider for an organisation is B7's admin API; until then the catalogue is written directly. It is the ceiling:
  // gamma may use e2e but has no entitlement to any of it until J3.
  for (const { slug } of tenants) await writeCatalogue(db, tenant(slug).organizationId, "e2e", { enabled: true })
  serve(47_604, toolbox.fetch)
  serve(Number(new URL(callback).port), () => new Response("Signed in. You can close this page."))
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

describe("J3 grant change without re-authorisation", () => {
  test("an entitlement added to gamma in ID reaches the same token within 60 seconds", async () => {
    const { oauth, organizationId } = session("toolbox-gamma")
    // Start from a fresh access token, so that the whole wait fits in its 60 seconds.
    oauth.state.tokens = { ...oauth.state.tokens!, access_token: "expired" }
    const client = await clientFor("toolbox-gamma", "2025")
    expect(await names(client)).toEqual(["toolbox_whoami"])
    const token = oauth.state.tokens!.access_token
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
  test("alpha's chain verifies, one event for each of its two calls", async () => {
    expect(await createEvidence(db).verify(session("toolbox-alpha").organizationId)).toEqual({ ok: true, length: 2 })
  })

  test("an update and a delete through the superuser connection are refused by the trigger", async () => {
    const organisation = session("toolbox-alpha").organizationId
    const run = async (query: PromiseLike<unknown>) => { await query }
    await expect(run(db`update evidence_events set outcome = 'failure' where organisation_id = ${organisation}`)).rejects.toThrow("evidence_events is append-only: UPDATE is refused")
    await expect(run(db`delete from evidence_events where organisation_id = ${organisation}`)).rejects.toThrow("evidence_events is append-only: DELETE is refused")
    expect(await createEvidence(db).verify(organisation)).toEqual({ ok: true, length: 2 })
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
