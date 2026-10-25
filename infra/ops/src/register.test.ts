import { describe, expect, test } from "bun:test"
import { register } from "./register"
import { fakeIdAdmin, memoryStore } from "./testing"

// The order and the keys of the two docs pages: apps/web/content/docs/toolbox/admin.mdx (Register the Toolbox in ID) and
// apps/web/content/docs/admin/setup.mdx (Register the admin MCP). The Toolbox's staff client is the operator's, not the services', and is left out.
// Then the standalone server's machine client, which reads who is calling, as the Toolbox's does.
const keys = [
  "toolbox-resource-v1", "toolbox-admin-resource-v1", "toolbox-hub-v1", "toolbox-hub-link-v1", "toolbox-hub-capability-v1", "claude-code-toolbox-v1",
  "admin-mcp-resource-v1", "claude-code-admin-v1", "claude-code-admin-link-v1",
  "admin-login-authorization_code-v1", "admin-resource-authorization_code-v1", "admin-login-refresh_token-v1", "admin-resource-refresh_token-v1",
  "admin-login-entitlement-v1", "admin-resource-entitlement-v1",
  "admin-group-team-v1", "admin-role-team-v1", "admin-group-admin-v1", "admin-role-admin-v1", "admin-group-owner-v1", "admin-role-owner-v1",
  "admin-mcp-v1", "admin-mcp-link-id-v1", "admin-mcp-capability-id-v1", "admin-mcp-link-toolbox-v1", "admin-mcp-capability-toolbox-v1",
  "standalone-hub-v1", "standalone-hub-link-v1", "standalone-hub-capability-v1",
]
const secrets = ["toolbox-id-client/TOOLBOX_ID_CLIENT_SECRET", "admin-id-client/ADMIN_ID_CLIENT_SECRET", "standalone-id-client/STANDALONE_ID_CLIENT_SECRET"]

function setup(id = fakeIdAdmin()) {
  const memory = memoryStore()
  const lines: string[] = []
  const run = (token = id.rootSecret) =>
    register({ id: "https://id.example", token, toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", platformSlug: "answerable", callbackPort: 47700, store: memory.store, fetch: id.fetch, log: line => lines.push(line) })
  return { id, memory, lines, run }
}

test("registers the Toolbox, the admin MCP and the standalone server's client in ID with the docs' keys, in their order, and stores the three machine clients' secrets", async () => {
  const { id, memory, lines, run } = setup()
  const result = await run()
  expect(id.state.calls.filter(call => call.key).map(call => call.key)).toEqual(keys)
  expect(id.state.resources).toEqual(new Set(["https://toolbox.example/mcp", "https://toolbox.example/admin", "https://admin-mcp.example/mcp"]))
  expect([...id.state.clients.keys()]).toEqual(["toolbox-hub", "claude-code-toolbox", "claude-code-admin", "admin-mcp", "standalone-hub"])
  expect(id.state.links).toEqual(new Set(["toolbox-hub https://id.example/api/admin", "claude-code-admin https://admin-mcp.example/mcp", "admin-mcp https://id.example/api/admin", "admin-mcp https://toolbox.example/admin", "standalone-hub https://id.example/api/admin"]))
  // The standalone server's client reads ID only: platform:read, on ID's admin API.
  expect(id.state.clients.get("standalone-hub")!.scopes).toEqual(["platform:read"])
  expect(id.state.capabilities).toContain(JSON.stringify([id.platform, "standalone-hub", "https://id.example/api/admin", "client_credentials"]))
  expect(memory.writes).toEqual(secrets)
  expect(memory.values[secrets[0]!]).toBe(id.state.clients.get("toolbox-hub")!.secret!)
  expect(memory.values[secrets[1]!]).toBe(id.state.clients.get("admin-mcp")!.secret!)
  expect(memory.values[secrets[2]!]).toBe(id.state.clients.get("standalone-hub")!.secret!)
  expect(result).toEqual({ platform: id.platform, ownerGroup: id.state.groups.get("answerable-owner")! })
  // It ends with what an operator does next, and never prints the token or a secret.
  const printed = lines.join("\n")
  expect(printed).toContain("claude mcp add --transport http answerable-admin https://admin-mcp.example/mcp --client-id claude-code-admin --callback-port 47700")
  expect(printed).toContain("claude mcp add --transport http answerable-toolbox https://toolbox.example/mcp --client-id claude-code-toolbox --callback-port 47700")
  expect(printed).toContain("sign in once at https://id.example/login with your work account, then run the ops Job make-admin with your email")
  for (const value of [id.rootSecret, ...Object.values(memory.values)]) expect(printed).not.toContain(value)
  // Without a staff directory, nothing of the platform organisation's sign-in is touched.
  expect(id.state.calls.some(call => call.path.endsWith("/domains") || call.path.includes("/sso-provider"))).toBe(false)
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

test("a call ID does not answer fails, naming it, rather than holding the Job; a network error is passed on as it is", async () => {
  const silent = (async (_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch
  const quiet = register({ id: "https://id.example", token: "t", toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", platformSlug: "answerable", callbackPort: 47700, store: memoryStore().store, fetch: silent, log: () => {}, timeoutMs: 20 })
  await expect(quiet).rejects.toThrow("GET /organizations?q=answerable&limit=100 got no answer from ID within 0.02 s")
  const refused = (async () => { throw new TypeError("connection refused") }) as unknown as typeof globalThis.fetch
  const down = register({ id: "https://id.example", token: "t", toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", platformSlug: "answerable", callbackPort: 47700, store: memoryStore().store, fetch: refused, log: () => {} })
  await expect(down).rejects.toThrow("connection refused")
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

describe("the staff directory", () => {
  const tenant = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`
  const staff = { domain: "answerable.org", entraTenant: tenant }
  function withStaff(id = fakeIdAdmin()) {
    const memory = memoryStore()
    const lines: string[] = []
    const run = (token = id.rootSecret) =>
      register({ id: "https://id.example", token, toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", platformSlug: "answerable", callbackPort: 47700, staff, store: memory.store, fetch: id.fetch, log: line => lines.push(line) })
    return { id, lines, run, printed: () => lines.join("\n") }
  }

  test("adds the staff domain, connects the Entra tenant with onboard.mdx's keys, and logs the connectivity test", async () => {
    const { id, run, printed } = withStaff()
    await run()
    expect(id.state.domains.get("answerable.org")).toBe(id.platform)
    expect(id.state.ssoProvider).toEqual({ issuer, domain: "answerable.org" })
    expect(id.state.calls.filter(call => call.key?.startsWith("platform-")).map(call => `${call.method} ${call.key}`)).toEqual(["POST platform-domain-setup", "PUT platform-sso-setup"])
    expect(id.state.calls.at(-1)).toMatchObject({ method: "GET", path: `/organizations/${id.platform}/sso-provider/test` })
    expect(printed()).toContain("Staff domain answerable.org: added")
    expect(printed()).toContain(`Staff directory ${issuer}: connected`)
    expect(printed()).toContain(`discovery  ${issuer}/.well-known/openid-configuration: reachable, HTTP 200, issuer matches`)
    expect(printed()).toContain("JWKS       reachable, 4 keys")
    expect(printed()).toContain("problems   none")
    expect(printed()).not.toContain("Warning")
    expect(printed()).not.toContain(id.rootSecret)
  })

  test("runs again: replays, then another caller finds the same domain and provider and leaves them", async () => {
    const { run, printed, lines } = withStaff()
    await run()
    lines.length = 0
    await run()
    expect(printed()).toContain("Staff domain answerable.org: done before (replayed)")
    expect(printed()).toContain(`Staff directory ${issuer}: done before (replayed)`)
    lines.length = 0
    await run("a-staff-token")
    expect(printed()).toContain("Staff domain answerable.org: already on the platform organisation")
    expect(printed()).toContain(`Staff directory ${issuer}: already connected`)
  })

  test("without a Microsoft client in ID it says so and goes on; with problems in the test it warns", async () => {
    const missing = withStaff(fakeIdAdmin({ microsoft: false }))
    expect(await missing.run()).toMatchObject({ platform: missing.id.platform })
    expect(missing.printed()).toContain("Staff directory not connected: ID has no Microsoft client (MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in id-env)")
    expect(missing.id.state.calls.some(call => call.path.endsWith("/sso-provider/test"))).toBe(false)
    expect(missing.printed()).toContain("Registered. Next:")
    const troubled = withStaff()
    troubled.id.state.testProblems.push({ code: "discovery_unreachable", detail: "timed out" })
    await troubled.run()
    expect(troubled.printed()).toContain("problems   discovery_unreachable: timed out\nWarning: the connectivity test found problems")
  })

  test("leaves another SSO provider as it is, with a warning, and refuses a domain of another organisation", async () => {
    const other = withStaff()
    other.id.state.ssoProvider = { issuer: "https://accounts.google.com", domain: "answerable.org" }
    await other.run()
    expect(other.id.state.ssoProvider).toEqual({ issuer: "https://accounts.google.com", domain: "answerable.org" })
    expect(other.printed()).toContain("Warning: the platform organisation's SSO provider is another one (issuer https://accounts.google.com, domain answerable.org), left as it is")
    expect(other.id.state.calls.some(call => call.path.endsWith("/sso-provider/test"))).toBe(false)
    const taken = withStaff()
    taken.id.state.domains.set("answerable.org", "another-organisation")
    await expect(taken.run()).rejects.toThrow("The staff domain answerable.org belongs to another organisation")
  })

  test("any other answer is an error naming the call", async () => {
    const organisation = "/organizations/0190a000-0000-7000-8000-000000000001"
    const cases: [(id: ReturnType<typeof fakeIdAdmin>) => void, string][] = [
      [id => id.state.failures.set(`POST ${organisation}/domains`, 503), `POST ${organisation}/domains answered 503 server_error`],
      [id => (id.state.domains.set("answerable.org", id.platform), id.state.failures.set(`GET ${organisation}/domains`, 500)), `GET ${organisation}/domains answered 500`],
      [id => id.state.failures.set(`PUT ${organisation}/sso-provider`, 500), `PUT ${organisation}/sso-provider answered 500`],
      [id => ((id.state.ssoProvider = { issuer, domain: "answerable.org" }), id.state.failures.set(`GET ${organisation}/sso-provider`, 500)), `GET ${organisation}/sso-provider answered 500`],
      [id => id.state.failures.set(`GET ${organisation}/sso-provider/test`, 502), `GET ${organisation}/sso-provider/test answered 502`],
    ]
    for (const [arrange, message] of cases) {
      const { id, run } = withStaff()
      arrange(id)
      await expect(run()).rejects.toThrow(message)
    }
  })
})
