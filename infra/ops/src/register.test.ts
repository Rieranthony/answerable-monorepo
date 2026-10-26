import { describe, expect, test } from "bun:test"
import { register, type RegisteredMcp } from "./register"
import { fakeIdAdmin, memoryStore } from "./testing"

const admin = "https://id.example/api/admin"
const toolboxResource = "https://toolbox.example/mcp"
const acme = "https://mcp.example/acme/mcp"
const acmeScopes = ["acme:read", "acme:write"]
const declared: RegisteredMcp[] = [
  { name: "acme", serve: "standalone", scopes: acmeScopes },
  { name: "notes", serve: "toolbox", scopes: ["notes:read"] },
]

// The first run: register's own client with the bearer, then, as that client, the docs' keys of apps/web/content/docs/toolbox/admin.mdx (Register
// the Toolbox in ID) and apps/web/content/docs/admin/setup.mdx (Register the admin MCP), in their order, and each standalone MCP. The Toolbox's
// staff client is the operator's, not the services', and is left out. A link's key carries the revision its client had when register read it.
const minting = ["ops-register-v1", "ops-register-link-v1-r1", "ops-register-capability-v1"]
const keys = [
  "toolbox-resource-v1", "toolbox-admin-resource-v1", "toolbox-hub-v1", "toolbox-hub-link-v1-r1", "toolbox-hub-capability-v1", "claude-code-toolbox-v1",
  "admin-mcp-resource-v1", "claude-code-admin-v1", "claude-code-admin-link-v1-r1",
  "admin-login-authorization_code-v1", "admin-resource-authorization_code-v1", "admin-login-refresh_token-v1", "admin-resource-refresh_token-v1",
  "admin-login-entitlement-v1", "admin-resource-entitlement-v1",
  "admin-group-team-v1", "admin-role-team-v1", "admin-group-admin-v1", "admin-role-admin-v1", "admin-group-owner-v1", "admin-role-owner-v1",
  "admin-mcp-v1", "admin-mcp-link-id-v1-r1", "admin-mcp-capability-id-v1", "admin-mcp-link-toolbox-v1-r1", "admin-mcp-capability-toolbox-v1",
  "mcp-acme-resource-v1", "claude-code-acme-v1", "claude-code-acme-link-v1-r1",
]
const secrets = ["ops-id-client/OPS_ID_CLIENT_SECRET", "toolbox-id-client/TOOLBOX_ID_CLIENT_SECRET", "admin-id-client/ADMIN_ID_CLIENT_SECRET"]

function setup(id = fakeIdAdmin(), memory = memoryStore()) {
  const lines: string[] = []
  // The root secret unless `token` is given; `token: undefined` is no bearer at all.
  const run = (options: { token?: string; mcps?: RegisteredMcp[]; staff?: { domain: string; entraTenant: string } } = {}) =>
    register({ id: "https://id.example", token: "token" in options ? options.token : id.rootSecret, toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", mcpOrigin: "https://mcp.example", mcps: options.mcps ?? declared, platformSlug: "answerable", callbackPort: 47700, staff: options.staff, store: memory.store, fetch: id.fetch, log: line => lines.push(line) })
  /** The writes since `from`, as `<caller> <method> <path>`. */
  const writes = (from = 0) => id.state.calls.slice(from).filter(call => call.method !== "GET").map(call => `${id.caller(call)} ${call.method} ${call.path}`)
  return { id, memory, lines, run, writes, printed: () => lines.join("\n") }
}

describe("register's own machine client", () => {
  test("the first run, with root, mints ops-register first and registers everything else as ops-register, with the docs' keys in their order", async () => {
    const { id, memory, run, printed } = setup()
    const result = await run()
    const keyed = id.state.calls.filter(call => call.key)
    expect(keyed.map(call => call.key)).toEqual([...minting, ...keys])
    // Root mints the client, its link and its capability; nothing else.
    expect(keyed.map(call => id.caller(call))).toEqual([...minting.map(() => "root"), ...keys.map(() => "ops-register")])
    expect(id.state.clients.get("ops-register")).toMatchObject({ organizationId: id.platform, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], clientCredentialsScopes: ["platform:read", "platform:write"] })
    expect(id.state.links).toContain(`ops-register ${admin}`)
    expect(id.state.capabilities).toContain(JSON.stringify([id.platform, "ops-register", admin, "client_credentials"]))
    expect([...id.state.resources.keys()]).toEqual([toolboxResource, "https://toolbox.example/admin", "https://admin-mcp.example/mcp", acme])
    expect([...id.state.clients.keys()]).toEqual(["ops-register", "toolbox-hub", "claude-code-toolbox", "claude-code-admin", "admin-mcp", "claude-code-acme"])
    expect(id.state.links).toEqual(new Set([
      `ops-register ${admin}`, `toolbox-hub ${admin}`, "claude-code-admin https://admin-mcp.example/mcp", `admin-mcp ${admin}`, "admin-mcp https://toolbox.example/admin", `claude-code-acme ${acme}`,
    ]))
    expect(memory.writes).toEqual(secrets)
    for (const [index, clientId] of ["ops-register", "toolbox-hub", "admin-mcp"].entries()) expect(memory.values[secrets[index]!]).toBe(id.state.clients.get(clientId)!.secret!)
    expect(result).toEqual({ platform: id.platform, ownerGroup: id.state.groups.get("answerable-owner")! })
    expect(printed()).toContain("ops-register is minted: register goes on as its own machine client, and needs no root secret or staff token again")
    expect(printed()).toMatch(new RegExp(`Registered in \\d+\\.\\d s: ${minting.length + keys.length} created, 0 changed, 0 as declared already; 1 standalone MCP\\.`))
    expect(printed()).toContain("claude mcp add --transport http answerable-admin https://admin-mcp.example/mcp --client-id claude-code-admin --callback-port 47700")
    expect(printed()).toContain("claude mcp add --transport http answerable-toolbox https://toolbox.example/mcp --client-id claude-code-toolbox --callback-port 47700")
    expect(printed()).toContain(`claude mcp add --transport http acme ${acme} --client-id claude-code-acme --callback-port 47700`)
    expect(printed()).toContain("sign in once at https://id.example/login with your work account, then run the ops Job make-admin with your email")
    for (const value of [id.rootSecret, ...Object.values(memory.values)]) expect(printed()).not.toContain(value)
    // Without a staff directory, nothing of the platform organisation's sign-in is touched.
    expect(id.state.calls.some(call => call.path.endsWith("/domains") || call.path.includes("/sso-provider"))).toBe(false)
  })

  test("every later run is ops-register's alone, with no bearer: it reads every row, finds each as declared, and writes nothing", async () => {
    const { id, memory, run, writes, lines, printed } = setup()
    await run()
    const [from, stored] = [id.state.calls.length, { ...memory.values }]
    memory.writes.length = lines.length = 0
    await run({ token: undefined })
    expect(new Set(id.state.calls.slice(from).map(call => id.caller(call)))).toEqual(new Set(["ops-register"]))
    // Capabilities, entitlements and groups are created when missing: this caller made them, so ID replays its receipts.
    expect(writes(from).every(write => write.includes("/organizations/"))).toBe(true)
    expect(id.state.rotations).toBe(0)
    expect(memory.writes).toEqual([])
    expect(memory.values).toEqual(stored)
    expect(printed()).toContain("Registering as ops-register, register's own machine client")
    expect(printed()).toContain(` s: 0 created, 0 changed, ${keys.length} as declared already`)
  })

  test("root locked and no client of its own: it stops with the one-time remedy, before any write", async () => {
    const { id, run } = setup(fakeIdAdmin({ rootLocked: true }))
    await expect(run()).rejects.toThrow("register has no machine client of its own yet (the Secret ops-id-client is empty), and ID refuses the root secret (root_locked): a platform administrator exists. Once: put a staff token in the Secret ops-staff-token (key OPS_ID_TOKEN) and run register again")
    expect(id.state.calls.filter(call => call.method !== "GET")).toEqual([])
    await expect(setup().run({ token: undefined })).rejects.toThrow("register has no machine client of its own yet (the Secret ops-id-client is empty), and no root secret or staff token to mint one. Once: put a staff token")
  })

  test("the transition when root is locked first: a staff token mints ops-register once, and then no token is needed", async () => {
    // A release whose servers were registered with root before make-admin, and register's own client never minted.
    const memory = memoryStore()
    const before = setup(fakeIdAdmin(), memory)
    await before.run()
    for (const clientId of ["ops-register"]) before.id.state.clients.delete(clientId)
    before.id.state.links.delete(`ops-register ${admin}`)
    delete memory.values["ops-id-client/OPS_ID_CLIENT_SECRET"]
    before.id.state.rootLocked = true
    const { id, run, writes, printed } = before
    await expect(run()).rejects.toThrow("ID refuses the root secret (root_locked)")
    const from = id.state.calls.length
    await run({ token: "a-staff-token" })
    expect(writes(from).filter(write => !write.startsWith("ops-register"))).toEqual([
      "a-staff-token POST /clients", `a-staff-token PUT /clients/ops-register/resources/${encodeURIComponent(admin)}`, `a-staff-token POST /organizations/${id.platform}/capabilities`,
    ])
    expect(printed()).toContain("ops-register is minted")
    const after = id.state.calls.length
    await run({ token: undefined })
    expect(new Set(id.state.calls.slice(after).map(call => id.caller(call)))).toEqual(new Set(["ops-register"]))
  })

  test("its own Secret emptied: the bearer rotates its secret in ID, and the run goes on with it; a secret ID does not hold names the remedy", async () => {
    const { id, memory, run, lines } = setup()
    await run()
    delete memory.values["ops-id-client/OPS_ID_CLIENT_SECRET"]
    await run()
    expect(id.state.rotations).toBe(1)
    expect(memory.values["ops-id-client/OPS_ID_CLIENT_SECRET"]).toBe(id.state.clients.get("ops-register")!.secret!)
    expect(lines.join("\n")).toContain("ops-register: its secret was not stored, so ID rotated it; stored in ops-id-client/OPS_ID_CLIENT_SECRET")
    memory.values["ops-id-client/OPS_ID_CLIENT_SECRET"] = "not-the-secret"
    await expect(run()).rejects.toThrow("ID refused ops-register's client credentials: the Secret ops-id-client holds a secret ID does not. Empty its key OPS_ID_CLIENT_SECRET, put a staff token in ops-staff-token and run register again, which rotates it (infra/README.md#register-again) (ID answered 401)")
  })

  test("a machine client that exists while its Secret is empty gets a new secret, rotated in ID and stored", async () => {
    const { id, memory, run, lines } = setup()
    await run()
    delete memory.values["admin-id-client/ADMIN_ID_CLIENT_SECRET"]
    memory.writes.length = 0
    await run({ token: undefined })
    expect(id.state.rotations).toBe(1)
    expect(memory.writes).toEqual(["admin-id-client/ADMIN_ID_CLIENT_SECRET"])
    expect(memory.values["admin-id-client/ADMIN_ID_CLIENT_SECRET"]).toBe(id.state.clients.get("admin-mcp")!.secret!)
    expect(lines.join("\n")).toContain("admin-mcp: its secret was not stored, so ID rotated it")
  })
})

describe("the MCPs of the list", () => {
  test("each standalone or both MCP gets its resource with the manifest's scopes and offline_access, its Claude Code client and their link; a toolbox MCP none", async () => {
    const { id, run } = setup()
    await run({ mcps: [...declared, { name: "beta", serve: "both", scopes: ["beta:read"] }] })
    expect(id.state.resources.get(acme)).toMatchObject({ classification: "platform_shared", organizationId: null, name: "acme", allowedScopes: ["acme:read", "acme:write", "offline_access"], accessTokenTtl: 900 })
    expect(id.state.clients.get("claude-code-acme")).toMatchObject({
      name: "Claude Code (acme)", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], redirectUris: ["http://localhost:47700/callback"],
      scopes: ["acme:read", "acme:write", "offline_access", "openid"],
    })
    expect(id.state.links).toContain("claude-code-beta https://mcp.example/beta/mcp")
    expect(id.state.resources.get("https://mcp.example/beta/mcp")!.allowedScopes).toEqual(["beta:read", "offline_access"])
    expect([...id.state.resources.keys()].some(identifier => identifier.includes("notes"))).toBe(false)
    expect(id.state.clients.has("claude-code-notes")).toBe(false)
  })

  test("a scope the manifest adds: only the MCP's resource and client change, each with If-Match on what register read, under <key>-r<revision>", async () => {
    const { id, run, writes, printed } = setup()
    await run()
    const [resource, client] = [id.state.resources.get(acme)!, id.state.clients.get("claude-code-acme")!]
    const [resourceRevision, clientRevision] = [resource.revision, client.revision]
    const from = id.state.calls.length
    await run({ token: undefined, mcps: [{ name: "acme", serve: "standalone", scopes: [...acmeScopes, "acme:admin"] }] })
    const changes = id.state.calls.slice(from).filter(call => call.method === "PATCH")
    expect(changes.map(call => [call.path, call.key, call.ifMatch])).toEqual([
      [`/resources/${encodeURIComponent(acme)}`, `mcp-acme-resource-v1-r${resourceRevision}`, `"${resource.id}:${resourceRevision}"`],
      ["/clients/claude-code-acme", `claude-code-acme-v1-r${clientRevision}`, `"${client.id}:${clientRevision}"`],
    ])
    expect(writes(from).filter(write => !write.includes("/organizations/"))).toEqual(["ops-register PATCH " + `/resources/${encodeURIComponent(acme)}`, "ops-register PATCH /clients/claude-code-acme"])
    expect(id.state.resources.get(acme)!.allowedScopes).toEqual(["acme:admin", "acme:read", "acme:write", "offline_access"])
    expect(id.state.clients.get("claude-code-acme")!.scopes).toEqual(["acme:admin", "acme:read", "acme:write", "offline_access", "openid"])
    expect(printed()).toContain("mcp-acme-resource-v1: changed allowedScopes")
    expect(printed()).toContain("claude-code-acme-v1: changed scopes")
    expect(printed()).toContain(" s: 0 created, 2 changed")
  })

  test("an MCP's own resource follows its manifest: a dropped scope stops being allowed, and the log says so; its client keeps what it holds", async () => {
    const { id, run, printed } = setup()
    await run()
    await run({ token: undefined, mcps: [{ name: "acme", serve: "standalone", scopes: ["acme:read"] }] })
    expect(id.state.resources.get(acme)!.allowedScopes).toEqual(["acme:read", "offline_access"])
    expect(id.state.clients.get("claude-code-acme")!.scopes).toEqual(["acme:read", "acme:write", "offline_access", "openid"])
    expect(printed()).toContain(`${acme}: its manifest no longer declares acme:write, so its resource stops allowing it`)
  })

  test("the Toolbox's resource is never narrowed: what enable calls added stays, and a deploy writes nothing to it", async () => {
    const { id, run, writes } = setup()
    await run()
    // The Toolbox's enable operation widens its resource with each enabled provider's grant strings (mcps/toolbox/src/admin-enable.ts).
    const toolbox = id.state.resources.get(toolboxResource)!
    Object.assign(toolbox, { allowedScopes: ["e2e", "e2e/records", "offline_access", "toolbox"], revision: toolbox.revision + 1 })
    const from = id.state.calls.length
    await run({ token: undefined })
    expect(id.state.resources.get(toolboxResource)!.allowedScopes).toEqual(["e2e", "e2e/records", "offline_access", "toolbox"])
    expect(writes(from).filter(write => write.includes("/resources/"))).toEqual([])
    // A name changed by hand is put back, and the scopes it holds stay with it.
    Object.assign(toolbox, { name: "Renamed", revision: toolbox.revision + 1 })
    await run({ token: undefined })
    expect(id.state.resources.get(toolboxResource)).toMatchObject({ name: "Toolbox", allowedScopes: ["e2e", "e2e/records", "offline_access", "toolbox"] })
  })

  test("an MCP removed from the list keeps its rows, and register no longer reads them", async () => {
    const { id, run } = setup()
    const beta = { name: "beta", serve: "both" as const, scopes: ["beta:read"] }
    await run({ mcps: [...declared, beta] })
    const from = id.state.calls.length
    await run({ token: undefined, mcps: declared })
    expect(id.state.resources.has("https://mcp.example/beta/mcp")).toBe(true)
    expect(id.state.clients.has("claude-code-beta")).toBe(true)
    expect(id.state.links).toContain("claude-code-beta https://mcp.example/beta/mcp")
    expect(id.state.calls.slice(from).some(call => call.path.includes("beta"))).toBe(false)
  })

  test("a link the client's read lacks is made again under its revision now; a row changed between the read and the change is refused, naming the call", async () => {
    const { id, run } = setup()
    await run()
    id.state.links.delete(`claude-code-acme ${acme}`)
    id.state.clients.get("claude-code-acme")!.revision++
    const from = id.state.calls.length
    await run({ token: undefined })
    const linked = id.state.calls.slice(from).find(call => call.method === "PUT")!
    expect(linked.key).toBe(`claude-code-acme-link-v1-r${id.state.clients.get("claude-code-acme")!.revision - 1}`)
    expect(id.state.links).toContain(`claude-code-acme ${acme}`)
    // Another writer moves the resource on between register's read and its change.
    const racing = setup(id)
    const fetch = id.fetch
    racing.id.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await fetch(input, init)
      if (String(input).endsWith(encodeURIComponent(acme)) && (init?.method ?? "GET") === "GET") id.state.resources.get(acme)!.revision++
      return answer
    }) as typeof globalThis.fetch
    const memory = memoryStore({ "ops-id-client/OPS_ID_CLIENT_SECRET": id.state.clients.get("ops-register")!.secret! })
    const raced = register({ id: "https://id.example", toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", mcpOrigin: "https://mcp.example", mcps: [{ name: "acme", serve: "standalone", scopes: ["acme:read"] }], platformSlug: "answerable", callbackPort: 47700, store: memory.store, fetch: racing.id.fetch, log: () => {} })
    await expect(raced).rejects.toThrow(/^PATCH \/resources\/https%3A%2F%2Fmcp\.example%2Facme%2Fmcp \(Idempotency-Key mcp-acme-resource-v1-r\d+\) answered 412 revision_mismatch$/)
  })

  test("200 standalone MCPs: three rows each on the first run, and two reads each on the next", async () => {
    const { id, run, writes } = setup()
    const many = Array.from({ length: 200 }, (_, index) => ({ name: `m${index}`, serve: "standalone" as const, scopes: [`m${index}:read`] }))
    await run({ mcps: many })
    expect(id.state.resources.size).toBe(3 + 200)
    expect(id.state.clients.size).toBe(5 + 200)
    const from = id.state.calls.length
    await run({ token: undefined, mcps: many })
    const later = id.state.calls.slice(from)
    expect(later.filter(call => call.path.startsWith("/resources/https%3A%2F%2Fmcp.example") || call.path.startsWith("/clients/claude-code-m")).length).toBe(400)
    expect(writes(from).filter(write => !write.includes("/organizations/"))).toEqual([])
  })
})

describe("failures", () => {
  test("a key used before with other input is reported with the key, not swallowed", async () => {
    const { id, run } = setup()
    await run()
    id.state.resources.delete(acme)
    // ops-register created the resource under this key with other scopes; a manifest change after an erasure reuses it.
    await expect(run({ token: undefined, mcps: [{ name: "acme", serve: "standalone", scopes: ["acme:read"] }] })).rejects.toThrow("ID refused Idempotency-Key mcp-acme-resource-v1: it was used before with different input")
  })

  test("a call ID does not answer fails, naming it, rather than holding the Job; a network error is passed on as it is", async () => {
    const options = { id: "https://id.example", token: "t", toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", mcpOrigin: "https://mcp.example", mcps: [], platformSlug: "answerable", callbackPort: 47700, store: memoryStore().store, log: () => {} }
    const silent = (async (_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch
    await expect(register({ ...options, fetch: silent, timeoutMs: 20 })).rejects.toThrow("GET /organizations?q=answerable&limit=100 got no answer from ID within 0.02 s")
    const refused = (async () => { throw new TypeError("connection refused") }) as unknown as typeof globalThis.fetch
    await expect(register({ ...options, fetch: refused })).rejects.toThrow("connection refused")
  })

  test("an unknown platform organisation and any other refusal are errors naming the call", async () => {
    await expect(setup(fakeIdAdmin({ platformSlug: "elsewhere" })).run()).rejects.toThrow("ID has no organisation with the slug answerable: set OPS_PLATFORM_SLUG")
    const failing = setup()
    failing.id.state.failures.set("POST /resources", 503)
    await expect(failing.run()).rejects.toThrow("POST /resources (Idempotency-Key toolbox-resource-v1) answered 503 server_error")
    const reading = setup()
    reading.id.state.failures.set(`GET /resources/${encodeURIComponent(toolboxResource)}`, 500)
    await expect(reading.run()).rejects.toThrow(`GET /resources/${encodeURIComponent(toolboxResource)} answered 500 server_error`)
    const listing = setup()
    listing.id.state.failures.set("GET /organizations", 500)
    await expect(listing.run()).rejects.toThrow("GET /organizations answered 500 server_error")
  })
})

describe("the staff directory", () => {
  const tenant = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`
  const staff = { domain: "answerable.org", entraTenant: tenant }
  function withStaff(id = fakeIdAdmin()) {
    const { lines, run, printed } = setup(id)
    return { id, lines, printed, run: (token: string | undefined = id.rootSecret) => run({ token, staff }) }
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
    const { id, run, printed, lines } = withStaff()
    await run()
    lines.length = 0
    await run(undefined)
    expect(printed()).toContain("Staff domain answerable.org: done before (replayed)")
    expect(printed()).toContain(`Staff directory ${issuer}: done before (replayed)`)
    // A caller without ops-register's receipts, as ID keys its journal by caller, finds what is there.
    lines.length = 0
    id.state.operations.clear()
    await run(undefined)
    expect(printed()).toContain("Staff domain answerable.org: already on the platform organisation")
    expect(printed()).toContain(`Staff directory ${issuer}: already connected`)
  })

  test("without a Microsoft client in ID it says so and goes on; with problems in the test it warns", async () => {
    const missing = withStaff(fakeIdAdmin({ microsoft: false }))
    expect(await missing.run()).toMatchObject({ platform: missing.id.platform })
    expect(missing.printed()).toContain("Staff directory not connected: ID has no Microsoft client (MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in id-env)")
    expect(missing.id.state.calls.some(call => call.path.endsWith("/sso-provider/test"))).toBe(false)
    expect(missing.printed()).toContain("Registered in ")
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
