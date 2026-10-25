import { afterAll, beforeAll, expect, test } from "bun:test"
import { errorOf } from "@answerable/mcp/testing"
import { rowsOf } from "@answerable/mcp-postgres/testing"
import { serving } from "./test/database"
import { origin, startStandalone } from "./test/standalone"

const login = await serving()
let standalone: Awaited<ReturnType<typeof startStandalone>>
beforeAll(async () => { standalone = await startStandalone(login.db) })
afterAll(async () => {
  await standalone.close()
  await login.drop()
})
const post = (path: string, token: string, headers: Record<string, string> = {}) => standalone.fetch(`${origin}${path}`, {
  method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...headers },
})

test("each MCP is served on its own path, to a token for that path alone: the other MCP's token is refused with 401", async () => {
  const { client: e2e } = await standalone.connect("e2e", ["e2e:identity", "e2e:read", "e2e:write"])
  expect((await e2e.listTools()).tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show", "records_create", "records_delete", "e2e_commit", "e2e_commit_confirmed"])
  const { client: example } = await standalone.connect("example", ["example:read", "example:write"])
  expect((await example.callTool({ name: "example_status", arguments: {} })).structuredContent).toEqual({ status: "ok", person: "Ada Lovelace", organisation: "Acme" })
  const { token } = await standalone.person("e2e", ["e2e:read"])
  expect((await post("/e2e/mcp", token)).status).toBe(200)
  const refused = await post("/example/mcp", token)
  expect(refused.status).toBe(401)
  expect(refused.headers.get("www-authenticate")).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/example/mcp"`)
})

test("each path has its own protected-resource metadata, and a path no MCP has is 404", async () => {
  for (const [name, scopes] of [["e2e", ["e2e:identity", "e2e:read", "e2e:write"]], ["example", ["example:read", "example:write"]]] as const) {
    expect(await (await standalone.fetch(`${origin}/.well-known/oauth-protected-resource/${name}/mcp`)).json()).toEqual({
      resource: `${origin}/${name}/mcp`, authorization_servers: ["https://id.test"], scopes_supported: scopes, bearer_methods_supported: ["header"], resource_name: name,
    })
  }
  for (const path of ["/", "/mcp", "/nothing/mcp", "/e2e", "/e2e/other", "/.well-known/oauth-protected-resource/nothing/mcp", "/.well-known/oauth-protected-resource/mcp", "/e2e/health"]) {
    expect((await standalone.fetch(`${origin}${path}`)).status, path).toBe(404)
  }
})

test("the Host check stays: a request for another host is refused before its token is read", async () => {
  const { token } = await standalone.person("e2e", ["e2e:read"])
  const response = await post("/e2e/mcp", token, { Host: "127.0.0.1" })
  expect(response.status).toBe(403)
})

test("every call and every refusal is evidence in the server's database, on the caller's organisation's chain, with a span", async () => {
  const { client, organizationId } = await standalone.connect("e2e", ["e2e:identity", "e2e:read"])
  expect((await client.callTool({ name: "records_list", arguments: {} })).structuredContent).toEqual({ items: [], next_cursor: null, has_more: false })
  await expect(client.callTool({ name: "records_create", arguments: { title: "Nope" } })).rejects.toThrow("Tool records_create not found")
  expect(errorOf(await client.callTool({ name: "records_list", arguments: { limit: 0 } })).code).toBe("INVALID_INPUT")
  expect(await rowsOf(login.db)`select kind, outcome, capability_identity, reason, error_code, data from evidence_events where organisation_id = ${organizationId} order by seq`).toEqual([
    { kind: "capability.completed", outcome: "success", capability_identity: "e2e/records.list", reason: null, error_code: null, data: { result_bytes: 48 } },
    { kind: "capability.denied", outcome: "denied", capability_identity: "e2e/records.create", reason: "missing_scope", error_code: null, data: { missing: ["e2e:write"] } },
    { kind: "capability.completed", outcome: "failure", capability_identity: "e2e/records.list", reason: null, error_code: "INVALID_INPUT", data: {} },
  ])
  expect(standalone.spans().filter(span => span.attributes["answerable.organisation.id"] === organizationId).map(span => span.name)).toEqual(["tools/call e2e/records.list", "tools/call e2e/records.list"])
})

test("health checks the server's database and the MCPs', and lists the MCPs it serves", async () => {
  const healthy = await standalone.fetch(`${origin}/health`)
  expect([healthy.status, await healthy.json()]).toEqual([200, { status: "ok", databases: { standalone: "ok", mcps: "ok" }, providers: ["e2e", "example"] }])
})
