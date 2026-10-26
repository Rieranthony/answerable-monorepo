// Real Answerable ID, a real browser and the official MCP OAuth client against MCPs the CLI made, with ID registered the way bun mcp setup and bun mcp dev
// register it (scripts/mcp): mcp-dev made with the root secret, then, as mcp-dev, the Toolbox's host client, e2e's resource and client and the
// organisations' access. mcps/example is the CLI's own, served in the Toolbox; e2e is served both ways, here at its path on the standalone server.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { stackAt } from "@answerable/scripts/local"
import { enableInToolbox, giveStandaloneAccess } from "@answerable/scripts/local-access"
import { adminCall, createRegistrar, machineToken, makeMcpDev, registerStandalone, registerToolbox } from "@answerable/scripts/local-id"
import { decodeJwt } from "jose"
import { z } from "zod"
import { connect, intentSchema, launchBrowser, serve, serveCallback, signIn, startId, step, tool, type Id, type OAuthSession } from "../index"
import { startStandaloneStack } from "../standalone"
import { startToolboxStack } from "../toolbox"

const stack = stackAt({ id: "http://127.0.0.1:47600", toolbox: "http://127.0.0.1:47604", standalone: "http://127.0.0.1:47602", callbackPort: 47603, callbackHost: "127.0.0.1" })
const e2e = `${stack.standalone}/e2e/mcp`
const e2eScopes = ["e2e:identity", "e2e:read", "e2e:write"]
// Two organisations, each signing in to the Toolbox and to e2e's path.
const tenants = ["cli-alpha", "cli-beta"]

let id: Id
let browser: Awaited<ReturnType<typeof launchBrowser>>
let mcpDev: { clientId: string; clientSecret: string }
let mcpDevCall: ReturnType<typeof adminCall>
const sessions = new Map<string, { organizationId: string; toolbox: OAuthSession; e2e: OAuthSession }>()
const tenant = (slug: string) => id.manifest.tenants.find(entry => entry.slug === slug)!
function session(slug: string) {
  const found = sessions.get(slug)
  if (!found) throw new Error(`${slug} never signed in; the first test shows why`)
  return found
}
const inToolbox = (slug: string) => connect(stack.toolboxResource, session(slug).toolbox.provider, "2026-07-28")
const atPath = (slug: string) => connect(e2e, session(slug).e2e.provider, "2026-07-28")
const notes = async (slug: string) => z.object({ items: z.array(z.object({ title: z.string() })) }).parse(await tool(await inToolbox(slug), "example_notes_list")).items.map(item => item.title)

beforeAll(async () => {
  id = await startId({ tenants: tenants.map(slug => ({ slug, signIns: 2 })) })
  const toolbox = await startToolboxStack(id, { hosts: [], database: "answerable_toolbox_cli_acceptance" })
  const standalone = await startStandaloneStack(id)
  serve(47_602, standalone.start(stack.standalone).fetch)
  serve(47_604, toolbox.toolbox.fetch)
  serveCallback(stack.callback)

  step("bun mcp setup, as the root secret does it: the Toolbox's resources and host client, and mcp-dev with its capabilities")
  const root = createRegistrar(adminCall(fetch, id.manifest.rootSecret, stack))
  const platform = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await id.admin("GET", "/organizations?q=answerable")).items.find(item => item.slug === "answerable")!.id
  await registerToolbox(root, stack)
  mcpDev = await makeMcpDev(root, platform, stack)
  // ID makes its signing key when it signs its first token: mcp-dev's first token comes before anything asks for two at once.
  const token = await machineToken(fetch, mcpDev, stack.adminResource, "platform:read platform:write", stack)
  mcpDevCall = adminCall(fetch, token!, stack)

  step("bun mcp dev, as mcp-dev does it: e2e's resource and client at its path, and for each organisation its access there and example in the Toolbox")
  await registerStandalone(createRegistrar(mcpDevCall), { name: "e2e", scopes: e2eScopes }, stack)
  for (const slug of tenants) {
    const { organizationId } = tenant(slug)
    await giveStandaloneAccess(mcpDevCall, organizationId, "e2e", stack)
    await enableInToolbox({ fetch }, mcpDevCall, mcpDev, organizationId, "example", stack)
  }
  browser = await launchBrowser()
})
afterAll(() => id?.stop())

test("each organisation signs in to the Toolbox through claude-code-toolbox and to e2e at its path through claude-code-e2e, as bun mcp dev registered them", async () => {
  for (const slug of tenants) {
    step(`${slug}: signing in to the Toolbox, then to e2e at its path`)
    const { organizationId, email } = tenant(slug)
    const toolbox = await signIn(browser, { idOrigin: id.manifest.idOrigin, resource: stack.toolboxResource, clientId: "claude-code-toolbox", callback: stack.callback, scopes: ["toolbox"] }, { slug, email, scopes: ["toolbox"] })
    const e2eSession = await signIn(browser, { idOrigin: id.manifest.idOrigin, resource: e2e, clientId: "claude-code-e2e", callback: stack.callback, scopes: e2eScopes }, { slug, email, scopes: e2eScopes })
    expect(decodeJwt(e2eSession.state.tokens!.access_token).aud).toBe(e2e)
    expect(String(decodeJwt(e2eSession.state.tokens!.access_token).scope).split(" ").sort()).toEqual([...e2eScopes, "offline_access"].sort())
    sessions.set(slug, { organizationId, toolbox, e2e: e2eSession })
  }
})

test("example, made by the CLI: a person prepares a note and commits it, and example_notes_list returns it; the other organisation sees none of it", async () => {
  const [alpha, beta] = tenants as [string, string]
  step(`${alpha}: example_notes_add prepares, toolbox_commit_confirmed commits, example_notes_list returns the note; ${beta} lists none`)
  const client = await inToolbox(alpha)
  const intent = intentSchema.parse(await tool(client, "example_notes_add", { title: "Pour the footings" }))
  const organisation = z.object({ name: z.string() }).parse(await id.admin("GET", `/organizations/${session(alpha).organizationId}`))
  // A note is a normal-risk change: the person sees the preview's summary, which names their organisation as ID holds it, and confirms it.
  expect(intent).toMatchObject({ policy_class: "controlled", commit_tool: "toolbox_commit_confirmed" })
  expect(intent.preview.summary).toBe(`Add “Pour the footings” to the notes of ${organisation.name}`)
  expect(await notes(alpha)).toEqual([])
  const receipt = z.object({ status: z.string(), results: z.object({ id: z.uuid(), title: z.string() }) }).parse(await tool(client, "toolbox_commit_confirmed", { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary }))
  expect([receipt.status, receipt.results.title]).toEqual(["committed", "Pour the footings"])
  expect(await notes(alpha)).toEqual(["Pour the footings"])
  expect(await notes(beta)).toEqual([])
})

test("e2e at its path, served alone: its tools are named without the Toolbox's prefix, and an organisation lists and creates its own records", async () => {
  const [alpha, beta] = tenants as [string, string]
  step(`${alpha} and ${beta}: records_list at e2e's path; ${alpha} creates a record`)
  const client = await atPath(alpha)
  const names = (await client.listTools()).tools.map(item => item.name)
  expect(names).toContain("records_list")
  expect(names.some(name => name.startsWith("e2e_records"))).toBe(false)
  expect(await tool(client, "records_list")).toEqual({ items: [], next_cursor: null, has_more: false })
  const intent = intentSchema.parse(await tool(client, "records_create", { title: "Alpha's" }))
  await tool(client, "e2e_commit", { intent_id: intent.intent_id, commit_token: intent.commit_token })
  const listed = (slug: string) => atPath(slug).then(connected => tool(connected, "records_list")).then(answer => z.object({ items: z.array(z.object({ title: z.string() })) }).parse(answer).items.map(item => item.title))
  expect([await listed(alpha), await listed(beta)]).toEqual([["Alpha's"], []])
})

test("a token that is valid for another resource, the Toolbox's, is refused at e2e's path with 401, which proves the audience binding with one standalone MCP", async () => {
  const [alpha] = tenants as [string]
  step(`${alpha}: the Toolbox's access token against /e2e/mcp`)
  const call = (token: string) => fetch(e2e, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
  const toolboxToken = session(alpha).toolbox.state.tokens!.access_token
  expect(decodeJwt(toolboxToken).aud).toBe(stack.toolboxResource)
  const refused = await call(toolboxToken)
  expect(refused.status).toBe(401)
  expect(refused.headers.get("www-authenticate")).toMatch(/resource_metadata=/)
  // e2e's own token is accepted there, so the refusal is about the audience and not the expiry.
  expect((await call(session(alpha).e2e.state.tokens!.access_token)).status).toBe(200)
})

test("registering again, as bun mcp dev does on every run, changes nothing in ID and gives the organisations nothing new", async () => {
  step("registering e2e and giving both organisations access again, as mcp-dev")
  const registrar = createRegistrar(mcpDevCall)
  await registerStandalone(registrar, { name: "e2e", scopes: e2eScopes }, stack)
  expect(registrar.tally).toEqual({ made: 0, changed: 0, found: 3 })
  for (const slug of tenants) expect(await giveStandaloneAccess(mcpDevCall, tenant(slug).organizationId, "e2e", stack)).toBe("already in place")
  // One secret opens both admin APIs, ID's and the Toolbox's.
  expect(await machineToken(fetch, mcpDev, stack.adminResource, "platform:read platform:write", stack)).toBeString()
  expect(await machineToken(fetch, mcpDev, stack.toolboxAdminResource, "toolbox:admin", stack)).toBeString()
})

test("a scope an MCP gains later, and a second MCP enabled in the Toolbox, widen the rows ID holds, as bun mcp dev does after its first run, rather than making second ones", async () => {
  const { organizationId } = tenant(tenants[0]!)
  step("cli-alpha: gadget gains gadget:write; e2e is enabled in the Toolbox beside example")
  const gadget = `${stack.standalone}/gadget/mcp`
  await registerStandalone(createRegistrar(mcpDevCall), { name: "gadget", scopes: ["gadget:read"] }, stack)
  expect(await giveStandaloneAccess(mcpDevCall, organizationId, "gadget", stack)).toBe("6 made, 0 widened")
  const gained = createRegistrar(mcpDevCall)
  await registerStandalone(gained, { name: "gadget", scopes: ["gadget:read", "gadget:write"] }, stack)
  expect(gained.tally).toEqual({ made: 0, changed: 2, found: 1 })
  expect(await giveStandaloneAccess(mcpDevCall, organizationId, "gadget", stack)).toBe("0 made, 3 widened")
  const held = async (path: string) => z.object({ items: z.array(z.object({ clientId: z.string().nullable(), resource: z.string().nullable(), scopes: z.array(z.string()), status: z.string() })) }).parse(await id.admin("GET", path)).items
  expect((await held(`/organizations/${organizationId}/entitlements?resource=${encodeURIComponent(gadget)}`)).map(row => [row.clientId, row.scopes, row.status])).toEqual([["claude-code-gadget", ["gadget:read", "gadget:write"], "active"]])
  expect((await held(`/organizations/${organizationId}/capabilities`)).filter(row => row.resource === gadget).map(row => row.scopes)).toEqual([["gadget:read", "gadget:write"], ["gadget:read", "gadget:write"]])
  expect(await giveStandaloneAccess(mcpDevCall, organizationId, "gadget", stack)).toBe("already in place")
  expect(await enableInToolbox({ fetch }, mcpDevCall, mcpDev, organizationId, "e2e", stack)).toMatch(/ rows made in ID and the catalogue; e2e granted to the organisation$/)
  const toolbox = (await held(`/organizations/${organizationId}/entitlements?resource=${encodeURIComponent(stack.toolboxResource)}`)).filter(row => !row.clientId)
  expect(toolbox.map(row => [row.scopes, row.status])).toEqual([[["e2e", "example"], "active"]])
})
