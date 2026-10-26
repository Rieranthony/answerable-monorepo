// The MCPs the Toolbox serves alone, standalone or both: each at its own path, <origin>/<name>/mcp, with its own resource, beside the hub at /mcp,
// over the Toolbox's database and the suite's MCP database, with a local issuer and a fake ID.
import { afterAll, afterEach, expect, test } from "bun:test"
import { defineProvider, defineTool, type Mount } from "@answerable/mcp"
import { errorOf } from "@answerable/mcp/testing"
import { mcpDatabases, type Serve } from "@answerable/mcp-platform"
import { rowsOf } from "@answerable/mcp-postgres/testing"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { z } from "zod"
import { serving } from "./test/database"
import { createHub, names, type Hub } from "./test/hub"
import { databases, opened } from "./test/mcps"

const origin = "https://mcp.test"
const login = await serving()
const { db } = login
afterAll(() => login.drop())
const hubs: Hub[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(hubs.splice(0).map(hub => hub.mcp.close()))
})

const mounted = (name: string, serve: Serve) => ({ ...opened.mount.find(entry => entry.provider.id === name)!, serve })
// e2e in the hub and alone, as its mcp.json says; example alone only.
const both = [mounted("e2e", "both"), mounted("example", "standalone")]
async function hub(mount: readonly (Mount & { serve?: Serve })[] = both) {
  const created = await createHub(db, mount)
  hubs.push(created)
  return created
}
type Who = { organizationId: string; membershipId: string; userId: string }

/** A token for MCP `name`'s path, for a person of Acme whom the fake ID knows: of a fresh organisation, unless `who` names one. */
async function person({ id, mcp }: Hub, name: string, scopes: readonly string[], who: Partial<Who> = {}) {
  const { organizationId, membershipId, userId }: Who = { organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), userId: crypto.randomUUID(), ...who }
  id.organisation(organizationId, { name: "Acme", slug: `acme-${organizationId.slice(0, 8)}` })
  id.member(organizationId, { id: membershipId, userId, name: "Ada Lovelace", email: "ada@acme.test" })
  const token = await mcp.issuer.sign({ resource: `${origin}/${name}/mcp`, scopes, organizationId, userId, claims: { membership_id: membershipId } })
  return { token, organizationId, membershipId, userId }
}
/** The official MCP client at MCP `name`'s path, with a token for it. */
async function alone(hubbed: Hub, name: string, scopes: readonly string[], who?: Partial<Who>) {
  const { token, ...known } = await person(hubbed, name, scopes, who)
  const client = new Client({ name: "toolbox-test", version: "0.1.0" })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/${name}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: hubbed.mcp.fetch }))
  return { client, ...known }
}
const post = ({ mcp }: Hub, path: string, token: string, headers: Record<string, string> = {}) => mcp.fetch(`${origin}${path}`, {
  method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...headers },
})
const e2eScopes = ["e2e:identity", "e2e:read", "e2e:write"]

test("each MCP served alone answers at its own path to a token for that path alone: another MCP's, or the hub's, is refused with 401, and the hub refuses theirs", async () => {
  const hubbed = await hub()
  const { client: e2e } = await alone(hubbed, "e2e", e2eScopes)
  expect((await e2e.listTools()).tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show", "records_create", "records_delete", "e2e_commit", "e2e_commit_confirmed"])
  const { client: example } = await alone(hubbed, "example", ["example:read", "example:write"])
  // Who is calling reaches a tool served alone: the preview of notes_add names the organisation as the fake ID holds it.
  expect((await example.callTool({ name: "notes_add", arguments: { title: "First" } })).structuredContent).toMatchObject({ preview: { summary: "Add “First” to the notes of Acme" } })
  const { token } = await person(hubbed, "e2e", ["e2e:read"])
  expect((await post(hubbed, "/e2e/mcp", token)).status).toBe(200)
  for (const [path, metadata] of [["/example/mcp", "/example/mcp"], ["/mcp", "/mcp"]]) {
    const refused = await post(hubbed, path!, token)
    expect(refused.status, path).toBe(401)
    expect(refused.headers.get("www-authenticate"), path).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource${metadata}"`)
  }
  const member = await hubbed.member(["e2e"])
  const hubToken = await hubbed.mcp.issuer.sign({ resource: `${origin}/mcp`, scopes: ["toolbox"], organizationId: member.organizationId, userId: member.userId, claims: { membership_id: member.membershipId } })
  expect((await post(hubbed, "/mcp", hubToken)).status).toBe(200)
  expect((await post(hubbed, "/e2e/mcp", hubToken)).status).toBe(401)
})

test("each path has its own protected-resource metadata beside the hub's, and a path no MCP served alone has is the hub's 404", async () => {
  const hubbed = await hub([mounted("e2e", "both"), mounted("example", "toolbox")])
  expect(await (await hubbed.mcp.fetch(`${origin}/.well-known/oauth-protected-resource/e2e/mcp`)).json()).toEqual({
    resource: `${origin}/e2e/mcp`, authorization_servers: ["https://id.test"], scopes_supported: e2eScopes, bearer_methods_supported: ["header"], resource_name: "e2e",
  })
  expect(await (await hubbed.mcp.fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({ resource: `${origin}/mcp`, scopes_supported: ["toolbox"], resource_name: "toolbox" })
  // example is in the hub alone here, so it has no path.
  for (const path of ["/", "/nothing/mcp", "/e2e", "/e2e/other", "/e2e/health", "/example/mcp", "/.well-known/oauth-protected-resource/nothing/mcp", "/.well-known/oauth-protected-resource/example/mcp"]) {
    expect((await hubbed.mcp.fetch(`${origin}${path}`)).status, path).toBe(404)
  }
})

test("the Host check stays at each path: a request for another host is refused before its token is read", async () => {
  const hubbed = await hub()
  const { token } = await person(hubbed, "e2e", ["e2e:read"])
  expect((await post(hubbed, "/e2e/mcp", token, { Host: "127.0.0.1" })).status).toBe(403)
})

test("every call and every refusal at a path is evidence in the Toolbox's database, on the caller's organisation's chain, with a span", async () => {
  const hubbed = await hub()
  const { client, organizationId } = await alone(hubbed, "e2e", ["e2e:identity", "e2e:read"])
  expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ items: [], next_cursor: null, has_more: false })
  await expect(client.callTool({ name: "records_create", arguments: { title: "Nope" } })).rejects.toThrow("Tool records_create not found")
  expect(errorOf(await client.callTool({ name: "records_list", arguments: { limit: 0 } })).code).toBe("INVALID_INPUT")
  expect(await rowsOf(db)`select kind, outcome, capability_identity, reason, error_code, data from evidence_events where organisation_id = ${organizationId} order by seq`).toEqual([
    { kind: "capability.completed", outcome: "success", capability_identity: "e2e/records.list", reason: null, error_code: null, data: { result_bytes: 48 } },
    { kind: "capability.denied", outcome: "denied", capability_identity: "e2e/records.create", reason: "missing_scope", error_code: null, data: { missing: ["e2e:write"] } },
    { kind: "capability.completed", outcome: "failure", capability_identity: "e2e/records.list", reason: null, error_code: "INVALID_INPUT", data: {} },
  ])
  expect(hubbed.spans().filter(span => span.attributes["answerable.organisation.id"] === organizationId).map(span => span.name)).toEqual(["tools/call e2e/records.list", "tools/call e2e/records.list"])
})

test("a read served alone keeps no result limit, which the hub's 100 KiB is", async () => {
  const bulk = defineProvider({ id: "bulk", description: "A fixture provider for the Toolbox's tests: it serves the tools each test gives it.", version: "2026-09-29", tools: [
    defineTool({
      name: "items.dump", description: "Return every item at once, which can exceed the Toolbox's result limit; a fixture.", scopes: ["bulk:read"],
      input: z.object({ size: z.number().int() }), output: z.object({ text: z.string() }),
      async execute({ size }) { return { text: "x".repeat(size) } },
    }),
  ] })
  const hubbed = await hub([{ provider: bulk, serve: "both" }])
  const { client } = await alone(hubbed, "bulk", ["bulk:read"])
  expect(((await client.callTool({ name: "items_dump", arguments: { size: 110_000 } })).structuredContent as { text: string }).text).toHaveLength(110_000)
  const inHub = await (await hubbed.member(["bulk"])).connect()
  expect(errorOf(await inHub.callTool({ name: "bulk_items_dump", arguments: { size: 110_000 } })).code).toBe("RESULT_TOO_LARGE")
})

test("health lists every MCP the Toolbox serves, in its hub or alone; an MCP served alone only is not in the hub", async () => {
  const hubbed = await hub()
  expect(await (await hubbed.mcp.fetch(`${origin}/health`)).json()).toEqual({ status: "ok", databases: { toolbox: "ok" }, providers: ["e2e", "example"] })
  expect(await names(await (await hubbed.member(["e2e", "example"])).connect())).not.toContain("example_notes_list")
})

// A record through e2e's path: prepared with records_create, committed with e2e_commit.
async function create(client: Client, title: string) {
  const { intent_id, commit_token } = (await client.callTool({ name: "records_create", arguments: { title } })).structuredContent as { intent_id: string; commit_token: string }
  expect((await client.callTool({ name: "e2e_commit", arguments: { intent_id, commit_token } })).structuredContent).toMatchObject({ status: "committed" })
}
const titles = async (client: Client, name: string) => ((await client.callTool({ name, arguments: {} })).structuredContent as { items: { title: string }[] }).items.map(item => item.title)

test("e2e served both ways shares its rows: a record made at its path is listed in the hub, one made in the hub at its path, and another organisation sees neither", async () => {
  const hubbed = await hub()
  const ada = await hubbed.member(["e2e"])
  const { client: atPath } = await alone(hubbed, "e2e", e2eScopes, ada)
  const inHub = await ada.connect()
  await create(atPath, "Made alone")
  expect(await titles(inHub, "e2e_records_list")).toEqual(["Made alone"])
  const { intent_id, commit_token } = (await inHub.callTool({ name: "e2e_records_create", arguments: { title: "Made in the hub" } })).structuredContent as { intent_id: string; commit_token: string }
  await inHub.callTool({ name: "toolbox_commit", arguments: { intent_id, commit_token } })
  expect(await titles(atPath, "records_list")).toEqual(["Made alone", "Made in the hub"])
  const grace = await hubbed.member(["e2e"])
  expect([await titles((await alone(hubbed, "e2e", e2eScopes, grace)).client, "records_list"), await titles(await grace.connect(), "e2e_records_list")]).toEqual([[], []])
})

test("the records survive a restart: a Toolbox started again on fresh pools lists at e2e's path what the first one wrote", async () => {
  const fresh = () => mcpDatabases([{ provider: opened.mount.find(entry => entry.provider.id === "e2e")!.provider, serve: "standalone", database: "shared" }], { shared: databases.url, own: {} })
  const first = fresh()
  let ada: Who
  try {
    const { client, ...who } = await alone(await hub(first.mount), "e2e", e2eScopes)
    await create(client, "Before the restart")
    ada = who
  } finally {
    await first.close()
  }
  const again = fresh()
  try {
    expect(await titles((await alone(await hub(again.mount), "e2e", e2eScopes, ada)).client, "records_list")).toEqual(["Before the restart"])
  } finally {
    await again.close()
  }
})
