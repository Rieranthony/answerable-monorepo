// Real Answerable ID, a real browser and the official MCP OAuth client against the MCPs as the deployment serves them: the Toolbox mounting its
// generated list in its hub and serving e2e alone at its path, in one process, over the shared MCP database.
import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/client"
import { decodeJwt } from "jose"
import { z } from "zod"
import { connect, grantOrganisation, intentSchema, launchBrowser, linkClient, refusal, registerClient, registerResource, serve, serveCallback, signIn, startId, step, tool, type Id, type OAuthSession } from "../index"
import { startToolboxStack, toolboxResource } from "../toolbox"

const callback = "http://127.0.0.1:47603/callback"
const e2eResource = `${new URL(toolboxResource).origin}/e2e/mcp`
const e2eScopes = ["e2e:identity", "e2e:read", "e2e:write"]
const [toolboxClient, e2eClient] = ["mcps-toolbox", "mcps-e2e"]
// One sign-in each to the Toolbox and to e2e's path.
const tenants = ["mcps-alpha", "mcps-beta"]

let id: Id
let browser: Awaited<ReturnType<typeof launchBrowser>>
let stack: Awaited<ReturnType<typeof startToolboxStack>>
// The Toolbox behind port 47604, which a test restarts on fresh pools.
let current: { fetch: (request: Request) => Promise<Response>; close: () => Promise<void> }
const sessions = new Map<string, { organizationId: string; toolbox: OAuthSession; e2e: OAuthSession }>()
const tenant = (slug: string) => id.manifest.tenants.find(entry => entry.slug === slug)!
function session(slug: string) {
  const found = sessions.get(slug)
  if (!found) throw new Error(`${slug} never signed in; the first test shows why`)
  return found
}
const inToolbox = (slug: string) => connect(toolboxResource, session(slug).toolbox.provider, "2026-07-28")
const atPath = (slug: string) => connect(e2eResource, session(slug).e2e.provider, "2026-07-28")
const titles = async (client: Client, name: string) => z.object({ items: z.array(z.object({ title: z.string() })) }).parse(await tool(client, name)).items.map(item => item.title)

beforeAll(async () => {
  id = await startId({ tenants: tenants.map(slug => ({ slug, signIns: 2 })) })
  const { admin } = id
  stack = await startToolboxStack(id, { hosts: [{ clientId: toolboxClient, redirectUri: callback }], database: "answerable_toolbox_acceptance" })
  current = { fetch: stack.toolbox.fetch, close: stack.stop }
  serve(47_604, request => current.fetch(request))
  serveCallback(callback)
  step("Registering e2e's path resource and its client, and giving both organisations e2e there and e2e and example in the Toolbox")
  await registerResource(admin, { identifier: e2eResource, scopes: e2eScopes, accessTokenTtl: 60 })
  await registerClient(admin, { clientId: e2eClient, redirectUri: callback, scopes: e2eScopes })
  await linkClient(admin, e2eClient, e2eResource)
  for (const slug of tenants) {
    const { organizationId } = tenant(slug)
    await grantOrganisation(admin, organizationId, { clientId: e2eClient, resource: e2eResource, scopes: e2eScopes })
    const enabled = await stack.adminApi("POST", `/organisations/${organizationId}/enable`, { hostClientIds: [toolboxClient], providers: ["e2e", "example"] })
    if (enabled.status !== 200) throw new Error(`Enabling ${slug} answered ${enabled.status}: ${JSON.stringify(enabled.body)}`)
    await admin("POST", `/organizations/${organizationId}/entitlements`, { resource: toolboxResource, scopes: ["e2e", "example"] })
  }
  browser = await launchBrowser()
})
afterAll(() => id?.stop())

test("each organisation signs in to the Toolbox and to e2e at its path, which the Toolbox serves alone", async () => {
  for (const slug of tenants) {
    step(`${slug}: signing in to the Toolbox, then to e2e at its path`)
    const { organizationId, email } = tenant(slug)
    const toolbox = await signIn(browser, { idOrigin: id.manifest.idOrigin, resource: toolboxResource, clientId: toolboxClient, callback, scopes: ["toolbox"] }, { slug, email, scopes: ["toolbox"] })
    const e2e = await signIn(browser, { idOrigin: id.manifest.idOrigin, resource: e2eResource, clientId: e2eClient, callback, scopes: e2eScopes }, { slug, email, scopes: e2eScopes })
    expect(decodeJwt(e2e.state.tokens!.access_token).aud).toBe(e2eResource)
    sessions.set(slug, { organizationId, toolbox, e2e })
  }
})

test("a person's name and their organisation's, which only ID holds, reach a tool: example_status through the Toolbox", async () => {
  for (const slug of tenants) {
    const { organizationId, toolbox } = session(slug)
    const membership = z.string().parse(decodeJwt(toolbox.state.tokens!.access_token).membership_id)
    const member = z.object({ name: z.string() }).parse(await id.admin("GET", `/organizations/${organizationId}/members/${membership}`))
    const organisation = z.object({ name: z.string() }).parse(await id.admin("GET", `/organizations/${organizationId}`))
    step(`${slug}: example_status names ${member.name} of ${organisation.name}`)
    expect(await tool(await inToolbox(slug), "example_example_status")).toEqual({ status: "ok", person: member.name, organisation: organisation.name })
  }
})

test("a tool call through the Toolbox, with who is calling cached and read from ID for every call: the latency, for the evidence report", async () => {
  const client = await inToolbox("mcps-alpha")
  const { organizationId } = session("mcps-alpha")
  const timed = async (before: () => void) => {
    const latencies: number[] = []
    for (let run = 0; run < 20; run++) {
      before()
      const started = performance.now()
      await tool(client, "example_example_status")
      latencies.push(performance.now() - started)
    }
    return latencies.toSorted((a, b) => a - b)
  }
  const cached = await timed(() => {})
  // Dropping the organisation's profiles makes each call read the member and the organisation from ID again; the grants stay cached.
  const uncached = await timed(() => stack.toolbox.profiles.invalidate([organizationId]))
  for (const [label, latencies] of [["cached", cached], ["read from ID", uncached]] as const) {
    step(`example_example_status through the Toolbox, who is calling ${label}: 20 calls, median ${latencies[10]!.toFixed(1)} ms, max ${latencies.at(-1)!.toFixed(1)} ms`)
  }
  expect(cached).toHaveLength(20)
})

test("two organisations, through real tokens, see only their own e2e records, at e2e's path and in the Toolbox alike, over one schema", async () => {
  step("mcps-alpha: a record at e2e's path; mcps-beta: one in the Toolbox")
  const alpha = await atPath("mcps-alpha")
  const created = intentSchema.parse(await tool(alpha, "records_create", { title: "Alpha's" }))
  const record = z.object({ results: z.object({ id: z.uuid() }) }).parse(await tool(alpha, "e2e_commit", { intent_id: created.intent_id, commit_token: created.commit_token })).results
  const beta = await inToolbox("mcps-beta")
  const theirs = intentSchema.parse(await tool(beta, "e2e_records_create", { title: "Beta's" }))
  await tool(beta, "toolbox_commit", { intent_id: theirs.intent_id, commit_token: theirs.commit_token })
  expect([await titles(alpha, "records_list"), await titles(await inToolbox("mcps-alpha"), "e2e_records_list")]).toEqual([["Alpha's"], ["Alpha's"]])
  expect([await titles(await atPath("mcps-beta"), "records_list"), await titles(beta, "e2e_records_list")]).toEqual([["Beta's"], ["Beta's"]])
  expect((await refusal(await atPath("mcps-beta"), "records_delete", { id: record.id })).code).toBe("NOT_FOUND")
  expect((await refusal(beta, "e2e_records_delete", { id: record.id })).code).toBe("NOT_FOUND")
})

test("the records survive a restart: the Toolbox started again on fresh pools lists at e2e's path what the first one wrote", async () => {
  await current.close()
  current = await stack.start()
  step("mcps-alpha: listing at e2e's path after the Toolbox restarted")
  expect(await titles(await atPath("mcps-alpha"), "records_list")).toEqual(["Alpha's"])
})
