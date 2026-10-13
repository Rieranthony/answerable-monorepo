import { expect, test } from "bun:test"
import { register } from "./register"
import { fakeIdAdmin, memoryStore } from "./testing"

// The order and the keys of the two docs pages: apps/web/content/docs/toolbox/admin.mdx (Register the Toolbox in ID) and
// apps/web/content/docs/admin/setup.mdx (Register the admin MCP). The Toolbox's staff client is the operator's, not the services', and is left out.
const keys = [
  "toolbox-resource-v1", "toolbox-admin-resource-v1", "toolbox-hub-v1", "toolbox-hub-link-v1", "toolbox-hub-capability-v1", "claude-code-toolbox-v1",
  "admin-mcp-resource-v1", "claude-code-admin-v1", "claude-code-admin-link-v1",
  "admin-login-authorization_code-v1", "admin-resource-authorization_code-v1", "admin-login-refresh_token-v1", "admin-resource-refresh_token-v1",
  "admin-login-entitlement-v1", "admin-resource-entitlement-v1",
  "admin-group-team-v1", "admin-role-team-v1", "admin-group-admin-v1", "admin-role-admin-v1", "admin-group-owner-v1", "admin-role-owner-v1",
  "admin-mcp-v1", "admin-mcp-link-id-v1", "admin-mcp-capability-id-v1", "admin-mcp-link-toolbox-v1", "admin-mcp-capability-toolbox-v1",
]
const secrets = ["toolbox-id-client/TOOLBOX_ID_CLIENT_SECRET", "admin-id-client/ADMIN_ID_CLIENT_SECRET"]

function setup(id = fakeIdAdmin()) {
  const memory = memoryStore()
  const lines: string[] = []
  const run = (token = id.rootSecret) =>
    register({ id: "https://id.example", token, toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", platformSlug: "answerable", callbackPort: 47700, store: memory.store, fetch: id.fetch, log: line => lines.push(line) })
  return { id, memory, lines, run }
}

test("registers the Toolbox and the admin MCP in ID with the docs' keys, in their order, and stores the two machine clients' secrets", async () => {
  const { id, memory, lines, run } = setup()
  const result = await run()
  expect(id.state.calls.filter(call => call.key).map(call => call.key)).toEqual(keys)
  expect(id.state.resources).toEqual(new Set(["https://toolbox.example/mcp", "https://toolbox.example/admin", "https://admin-mcp.example/mcp"]))
  expect([...id.state.clients.keys()]).toEqual(["toolbox-hub", "claude-code-toolbox", "claude-code-admin", "admin-mcp"])
  expect(id.state.links).toEqual(new Set(["toolbox-hub https://id.example/api/admin", "claude-code-admin https://admin-mcp.example/mcp", "admin-mcp https://id.example/api/admin", "admin-mcp https://toolbox.example/admin"]))
  expect(memory.writes).toEqual(secrets)
  expect(memory.values[secrets[0]!]).toBe(id.state.clients.get("toolbox-hub")!.secret!)
  expect(memory.values[secrets[1]!]).toBe(id.state.clients.get("admin-mcp")!.secret!)
  expect(result).toEqual({ platform: id.platform, ownerGroup: id.state.groups.get("answerable-owner")! })
  // It ends with what an operator does next, and never prints the token or a secret.
  const printed = lines.join("\n")
  expect(printed).toContain("claude mcp add --transport http answerable-admin https://admin-mcp.example/mcp --client-id claude-code-admin --callback-port 47700")
  expect(printed).toContain("claude mcp add --transport http answerable-toolbox https://toolbox.example/mcp --client-id claude-code-toolbox --callback-port 47700")
  expect(printed).toContain(`/groups/${id.state.groups.get("answerable-owner")}/members/`)
  for (const value of [id.rootSecret, ...Object.values(memory.values)]) expect(printed).not.toContain(value)
})

test("a second run is all replays: nothing new in ID, no rotation, nothing written", async () => {
  const { id, memory, lines, run } = setup()
  await run()
  const before = { clients: id.state.clients.size, groups: id.state.groups.size, values: { ...memory.values } }
  memory.writes.length = 0
  lines.length = 0
  await run()
  expect(id.state.rotations).toBe(0)
  expect(memory.writes).toEqual([])
  expect(memory.values).toEqual(before.values)
  expect({ clients: id.state.clients.size, groups: id.state.groups.size }).toEqual({ clients: before.clients, groups: before.groups })
  expect(lines.filter(line => line.includes("replayed")).length).toBe(keys.length)
})

test("a machine client that exists while its Secret is empty gets a new secret, rotated in ID and stored", async () => {
  const { id, memory, lines, run } = setup()
  await run()
  delete memory.values[secrets[1]!]
  memory.writes.length = 0
  await run()
  expect(id.state.rotations).toBe(1)
  expect(memory.writes).toEqual([secrets[1]])
  expect(memory.values[secrets[1]!]).toBe(id.state.clients.get("admin-mcp")!.secret!)
  expect(lines.join("\n")).toContain("admin-mcp: its secret was not stored, so ID rotated it")
})

test("another caller's run finds each object already there, which is not an error", async () => {
  const { id, memory, lines, run } = setup()
  await run()
  memory.writes.length = 0
  await run("a-staff-token")
  expect(id.state.rotations).toBe(0)
  expect(memory.writes).toEqual([])
  expect(lines.filter(line => line.includes("already there")).length).toBeGreaterThan(20)
})

test("a key used before with other input is reported with the key, not swallowed", async () => {
  const { id, run } = setup()
  id.state.operations.set(`${id.rootSecret} toolbox-admin-resource-v1`, { fingerprint: "something else", status: 201 })
  await expect(run()).rejects.toThrow("ID refused Idempotency-Key toolbox-admin-resource-v1: it was used before with different input")
})

test("a locked root secret asks for a staff token", async () => {
  const { run } = setup(fakeIdAdmin({ rootLocked: true }))
  await expect(run()).rejects.toThrow("ID refused the root secret (root_locked): a platform administrator exists. Pass a staff token as OPS_ID_TOKEN")
})

test("an unknown platform organisation and any other refusal are errors naming the call", async () => {
  await expect(setup(fakeIdAdmin({ platformSlug: "elsewhere" })).run()).rejects.toThrow("ID has no organisation with the slug answerable: set OPS_PLATFORM_SLUG")
  const failing = setup()
  failing.id.state.failures.set("POST /resources", 503)
  await expect(failing.run()).rejects.toThrow("POST /resources (Idempotency-Key toolbox-resource-v1) answered 503 server_error")
  const listing = setup()
  listing.id.state.failures.set("GET /organizations", 500)
  await expect(listing.run()).rejects.toThrow("GET /organizations answered 500 server_error")
})
