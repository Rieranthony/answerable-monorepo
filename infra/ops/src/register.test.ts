import { describe, expect, test } from "bun:test"
import type { DeclaredMcp } from "@answerable/mcp-postgres"
import { register } from "./register"
import { fakeId, memoryStore, type FakeId } from "./testing"

const admin = "https://id.example/api/admin"
const toolboxResource = "https://toolbox.example/mcp"
const acme = "https://mcp.example/acme/mcp"
const acmeScopes = ["acme:read", "acme:write"]
const declared: DeclaredMcp[] = [
  { name: "acme", serve: "standalone", database: "shared", scopes: acmeScopes },
  { name: "notes", serve: "toolbox", database: "shared", scopes: ["notes:read"] },
]
const sorted = (values: unknown) => [...(values as string[])].sort()

// The first run: register's own client with the root secret, then, as that client, the docs' keys of apps/web/content/docs/toolbox/admin.mdx
// (Register the Toolbox in ID) and apps/web/content/docs/admin/setup.mdx (Register the admin MCP), in their order, and each standalone MCP. The
// Toolbox's staff client is the operator's, not the services', and is left out. A link's key carries the revision its client had when register read it.
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

function setup(id = fakeId(), memory = memoryStore()) {
  const lines: string[] = []
  // The root secret unless `rootSecret` is given; `rootSecret: undefined` is none at all.
  const run = (options: { rootSecret?: string; mcps?: DeclaredMcp[]; staff?: { domain: string; entraTenant: string } } = {}) =>
    register({ id: "https://id.example", rootSecret: "rootSecret" in options ? options.rootSecret : id.rootSecret, toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", mcpOrigin: "https://mcp.example", mcps: options.mcps ?? declared, callbackPort: 47700, staff: options.staff, store: memory.store, fetch: id.fetch, log: line => lines.push(line) })
  /** The writes since `from`, as `<caller> <method> <path>`. */
  const writes = (from = 0) => id.calls().slice(from).filter(call => call.method !== "GET").map(call => `${call.caller} ${call.method} ${call.path}`)
  return { id, memory, lines, run, writes, printed: () => lines.join("\n") }
}

const rotations = (id: FakeId) => id.calls().filter(call => call.path.endsWith("/rotate-secret")).length

describe("register's own machine client", () => {
  test("the first run, with root, mints ops-register first and registers everything else as ops-register, with the docs' keys in their order", async () => {
    const { id, memory, run, printed } = setup()
    const result = await run()
    const keyed = id.calls().filter(call => call.key)
    expect(keyed.map(call => call.key)).toEqual([...minting, ...keys])
    // Root mints the client, its link and its capability; nothing else.
    expect(keyed.map(call => call.caller)).toEqual([...minting.map(() => "root"), ...keys.map(() => "ops-register")])
    expect(id.clientOf("ops-register")).toMatchObject({ organizationId: id.platform, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], clientCredentialsScopes: ["platform:read", "platform:write"], resources: [admin] })
    expect(id.capabilities(id.platform).filter(row => row.grantKind === "client_credentials").map(row => [row.clientId, row.resource, row.scopes])).toEqual([
      ["ops-register", admin, ["platform:read", "platform:write"]],
      ["toolbox-hub", admin, ["platform:read", "platform:write"]],
      ["admin-mcp", admin, ["platform:read", "platform:write"]],
      ["admin-mcp", "https://toolbox.example/admin", ["toolbox:admin"]],
    ])
    for (const identifier of [toolboxResource, "https://toolbox.example/admin", "https://admin-mcp.example/mcp", acme]) expect(id.resourceOf(identifier), identifier).toBeDefined()
    expect(id.calls().filter(call => call.method === "POST" && call.path === "/clients").length).toBe(6)
    for (const [clientId, resources] of Object.entries({
      "ops-register": [admin], "toolbox-hub": [admin], "claude-code-toolbox": [], "claude-code-admin": ["https://admin-mcp.example/mcp"], "admin-mcp": ["https://toolbox.example/admin", admin], "claude-code-acme": [acme],
    })) expect(id.clientOf(clientId)!.resources, clientId).toEqual(resources)
    expect(memory.writes).toEqual(secrets)
    for (const [index, clientId] of ["ops-register", "toolbox-hub", "admin-mcp"].entries()) expect(memory.values[secrets[index]!]).toBe(id.clientOf(clientId)!.secret!)
    expect(result).toEqual({ platform: id.platform, ownerGroup: expect.any(String) })
    expect(id.entitlements(id.platform).find(row => row.groupId === result.ownerGroup)).toMatchObject({ resource: "https://admin-mcp.example/mcp", scopes: ["answerable-owner"] })
    expect(printed()).toContain("ops-register is minted: register goes on as its own machine client, and needs no root secret again")
    expect(printed()).toMatch(new RegExp(`Registered in \\d+\\.\\d s: ${minting.length + keys.length} created, 0 changed, 0 as declared already; 1 standalone MCP\\.`))
    expect(printed()).toContain("claude mcp add --transport http answerable-admin https://admin-mcp.example/mcp --client-id claude-code-admin --callback-port 47700")
    expect(printed()).toContain("claude mcp add --transport http answerable-toolbox https://toolbox.example/mcp --client-id claude-code-toolbox --callback-port 47700")
    expect(printed()).toContain(`claude mcp add --transport http acme ${acme} --client-id claude-code-acme --callback-port 47700`)
    expect(printed()).toContain("sign in once at https://id.example/login with your work account, then run the ops Job make-admin with your email")
    for (const value of [id.rootSecret, ...Object.values(memory.values)]) expect(printed()).not.toContain(value)
    // Without a staff directory, nothing of the platform organisation's sign-in is touched.
    expect(id.calls().some(call => call.path.endsWith("/domains") || call.path.includes("/sso-provider"))).toBe(false)
  })

  test("every later run is ops-register's alone, with no root secret: it reads every row, finds each as declared, and writes nothing", async () => {
    const { id, memory, run, writes, lines, printed } = setup()
    await run()
    const [from, stored] = [id.calls().length, { ...memory.values }]
    memory.writes.length = lines.length = 0
    await run({ rootSecret: undefined })
    expect(new Set(id.calls().slice(from).map(call => call.caller))).toEqual(new Set(["ops-register"]))
    // Capabilities, entitlements and groups are created when missing: this caller made them, so ID replays its receipts.
    expect(writes(from).every(write => write.includes("/organizations/"))).toBe(true)
    expect(rotations(id)).toBe(0)
    expect(memory.writes).toEqual([])
    expect(memory.values).toEqual(stored)
    expect(printed()).toContain("Registering as ops-register, register's own machine client")
    expect(printed()).toContain(` s: 0 created, 0 changed, ${keys.length} as declared already`)
  })

  test("root locked and no client of its own: it stops with the one-time remedy, break glass, before any write", async () => {
    const locked = fakeId()
    locked.lockRoot(true)
    const { id, run } = setup(locked)
    const remedy = "Once: add ROOT_ADMIN_BREAK_GLASS: \"true\" under id.env in the environment's overlay and ship it; register mints its client, ops-register, with the root secret and needs it no more. Then remove the line and ship again (infra/README.md#register-again)"
    await expect(run()).rejects.toThrow(`register has no machine client of its own yet (the Secret ops-id-client is empty), and ID refuses the root secret (root_locked): a platform administrator exists. ${remedy}`)
    expect(id.calls().filter(call => call.method !== "GET")).toEqual([])
    await expect(setup().run({ rootSecret: undefined })).rejects.toThrow(`register has no machine client of its own yet (the Secret ops-id-client is empty), and no root secret to mint one. ${remedy}`)
  })

  test("the transition when root is locked first: break glass lets the root secret mint ops-register once, and then none is needed", async () => {
    const { id, run, writes, printed } = setup()
    id.lockRoot(true)
    await expect(run()).rejects.toThrow("ID refuses the root secret (root_locked)")
    // The ship with ROOT_ADMIN_BREAK_GLASS: "true".
    id.lockRoot(false)
    const from = id.calls().length
    await run()
    expect(writes(from).filter(write => !write.startsWith("ops-register"))).toEqual([
      "root POST /clients", `root PUT /clients/ops-register/resources/${encodeURIComponent(admin)}`, `root POST /organizations/${id.platform}/capabilities`,
    ])
    expect(printed()).toContain("ops-register is minted")
    // The ship that removes it: root is locked again, and register needs no root secret.
    id.lockRoot(true)
    const after = id.calls().length
    await run({ rootSecret: undefined })
    expect(new Set(id.calls().slice(after).map(call => call.caller))).toEqual(new Set(["ops-register"]))
  })

  test("its own Secret emptied: the root secret rotates its secret in ID, and the run goes on with it; a secret ID does not hold names the remedy", async () => {
    const { id, memory, run, lines } = setup()
    await run()
    delete memory.values["ops-id-client/OPS_ID_CLIENT_SECRET"]
    await run()
    expect(rotations(id)).toBe(1)
    expect(memory.values["ops-id-client/OPS_ID_CLIENT_SECRET"]).toBe(id.clientOf("ops-register")!.secret!)
    expect(lines.join("\n")).toContain("ops-register: its secret was not stored, so ID rotated it; stored in ops-id-client/OPS_ID_CLIENT_SECRET")
    memory.values["ops-id-client/OPS_ID_CLIENT_SECRET"] = "not-the-secret"
    await expect(run()).rejects.toThrow("ID refused ops-register's client credentials: the Secret ops-id-client holds a secret ID does not. Empty its key OPS_ID_CLIENT_SECRET and run register again, which rotates it with the root secret: with break glass once root is locked (infra/README.md#register-again) (ID answered 401)")
  })

  test("a machine client that exists while its Secret is empty gets a new secret, rotated in ID and stored", async () => {
    const { id, memory, run, lines } = setup()
    await run()
    delete memory.values["admin-id-client/ADMIN_ID_CLIENT_SECRET"]
    memory.writes.length = 0
    await run({ rootSecret: undefined })
    expect(rotations(id)).toBe(1)
    expect(memory.writes).toEqual(["admin-id-client/ADMIN_ID_CLIENT_SECRET"])
    expect(memory.values["admin-id-client/ADMIN_ID_CLIENT_SECRET"]).toBe(id.clientOf("admin-mcp")!.secret!)
    expect(lines.join("\n")).toContain("admin-mcp: its secret was not stored, so ID rotated it")
  })
})

describe("the MCPs of the list", () => {
  test("each standalone or both MCP gets its resource with the manifest's scopes and offline_access, its Claude Code client and their link; a toolbox MCP none", async () => {
    const { id, run } = setup()
    await run({ mcps: [...declared, { name: "beta", serve: "both", database: "own", scopes: ["beta:read"] }] })
    expect(id.resourceOf(acme)).toMatchObject({ classification: "platform_shared", organizationId: null, name: "acme", allowedScopes: ["acme:read", "acme:write", "offline_access"], accessTokenTtl: 900 })
    const client = id.clientOf("claude-code-acme")!
    expect(client).toMatchObject({ name: "Claude Code (acme)", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], redirectUris: ["http://localhost:47700/callback"] })
    expect(sorted(client.scopes)).toEqual(["acme:read", "acme:write", "offline_access", "openid"])
    expect(id.clientOf("claude-code-beta")!.resources).toEqual(["https://mcp.example/beta/mcp"])
    expect(id.resourceOf("https://mcp.example/beta/mcp").allowedScopes).toEqual(["beta:read", "offline_access"])
    expect(id.calls().some(call => call.path.includes("notes"))).toBe(false)
    expect(id.clientOf("claude-code-notes")).toBeUndefined()
  })

  test("a scope the manifest adds: only the MCP's resource and client change, each with If-Match on what register read, under <key>-r<revision>", async () => {
    const { id, run, writes, printed } = setup()
    await run()
    const [resource, client] = [id.resourceOf(acme), id.clientOf("claude-code-acme")!]
    const [resourceRevision, clientRevision] = [resource.revision, client.revision as number]
    const from = id.calls().length
    await run({ rootSecret: undefined, mcps: [{ name: "acme", serve: "standalone", database: "shared", scopes: [...acmeScopes, "acme:admin"] }] })
    const changes = id.calls().slice(from).filter(call => call.method === "PATCH")
    expect(changes.map(call => [call.path, call.key, call.ifMatch])).toEqual([
      [`/resources/${encodeURIComponent(acme)}`, `mcp-acme-resource-v1-r${resourceRevision}`, `"${resource.id}:${resourceRevision}"`],
      ["/clients/claude-code-acme", `claude-code-acme-v1-r${clientRevision}`, `"${client.id}:${clientRevision}"`],
    ])
    expect(writes(from).filter(write => !write.includes("/organizations/"))).toEqual(["ops-register PATCH " + `/resources/${encodeURIComponent(acme)}`, "ops-register PATCH /clients/claude-code-acme"])
    expect(id.resourceOf(acme).allowedScopes).toEqual(["acme:admin", "acme:read", "acme:write", "offline_access"])
    expect(id.clientOf("claude-code-acme")!.scopes).toEqual(["acme:admin", "acme:read", "acme:write", "offline_access", "openid"])
    expect(printed()).toContain("mcp-acme-resource-v1: changed allowedScopes")
    expect(printed()).toContain("claude-code-acme-v1: changed scopes")
    expect(printed()).toContain(" s: 0 created, 2 changed")
  })

  test("an MCP's own resource follows its manifest: a dropped scope stops being allowed, and the log says so; its client keeps what it holds", async () => {
    const { id, run, printed } = setup()
    await run()
    await run({ rootSecret: undefined, mcps: [{ name: "acme", serve: "standalone", database: "shared", scopes: ["acme:read"] }] })
    expect(id.resourceOf(acme).allowedScopes).toEqual(["acme:read", "offline_access"])
    expect(sorted(id.clientOf("claude-code-acme")!.scopes)).toEqual(["acme:read", "acme:write", "offline_access", "openid"])
    expect(printed()).toContain(`${acme}: its manifest no longer declares acme:write, so its resource stops allowing it`)
  })

  test("the Toolbox's resource is never narrowed: what enable calls added stays, and a deploy writes nothing to it", async () => {
    const { id, run, writes } = setup()
    await run()
    // The Toolbox's enable operation widens its resource with each enabled provider's grant strings (mcps/toolbox/src/admin-enable.ts).
    const toolbox = id.resourceOf(toolboxResource)
    Object.assign(toolbox, { allowedScopes: ["e2e", "e2e/records", "offline_access", "toolbox"], revision: toolbox.revision + 1 })
    const from = id.calls().length
    await run({ rootSecret: undefined })
    expect(id.resourceOf(toolboxResource).allowedScopes).toEqual(["e2e", "e2e/records", "offline_access", "toolbox"])
    expect(writes(from).filter(write => write.includes("/resources/"))).toEqual([])
    // A name changed by hand is put back, and the scopes it holds stay with it.
    Object.assign(toolbox, { name: "Renamed", revision: toolbox.revision + 1 })
    await run({ rootSecret: undefined })
    expect(id.resourceOf(toolboxResource)).toMatchObject({ name: "Toolbox", allowedScopes: ["e2e", "e2e/records", "offline_access", "toolbox"] })
  })

  test("an MCP removed from the list keeps its rows, and register no longer reads them", async () => {
    const { id, run } = setup()
    const beta: DeclaredMcp = { name: "beta", serve: "both", database: "shared", scopes: ["beta:read"] }
    await run({ mcps: [...declared, beta] })
    const from = id.calls().length
    await run({ rootSecret: undefined, mcps: declared })
    expect(id.resourceOf("https://mcp.example/beta/mcp")).toBeDefined()
    expect(id.clientOf("claude-code-beta")!.resources).toEqual(["https://mcp.example/beta/mcp"])
    expect(id.calls().slice(from).some(call => call.path.includes("beta"))).toBe(false)
  })

  test("a link the client's read lacks is made again under its revision now; a row changed between the read and the change is refused, naming the call", async () => {
    const { id, run } = setup()
    await run()
    const linked = id.resourceOf(acme).clients
    linked.splice(linked.indexOf("claude-code-acme"), 1)
    id.revise(id.clientOf("claude-code-acme")!.id)
    const from = id.calls().length
    await run({ rootSecret: undefined })
    const link = id.calls().slice(from).find(call => call.method === "PUT")!
    expect(link.key).toBe(`claude-code-acme-link-v1-r${(id.clientOf("claude-code-acme")!.revision as number) - 1}`)
    expect(id.clientOf("claude-code-acme")!.resources).toEqual([acme])
    // Another writer moves the resource on between register's read and its change.
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await id.fetch(input, init)
      if (String(input).endsWith(encodeURIComponent(acme)) && (init?.method ?? "GET") === "GET") id.revise(acme)
      return answer
    }) as typeof globalThis.fetch
    const memory = memoryStore({ "ops-id-client/OPS_ID_CLIENT_SECRET": id.clientOf("ops-register")!.secret! })
    const raced = register({ id: "https://id.example", toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", mcpOrigin: "https://mcp.example", mcps: [{ name: "acme", serve: "standalone", scopes: ["acme:read"] }], callbackPort: 47700, store: memory.store, fetch: racing, log: () => {} })
    await expect(raced).rejects.toThrow(/^PATCH \/resources\/https%3A%2F%2Fmcp\.example%2Facme%2Fmcp \(Idempotency-Key mcp-acme-resource-v1-r\d+\) answered 412 revision_mismatch$/)
  })

  test("200 standalone MCPs: three rows each on the first run, and two reads each on the next", async () => {
    const { id, run, writes } = setup()
    const many = Array.from({ length: 200 }, (_, index): DeclaredMcp => ({ name: `m${index}`, serve: "standalone", database: "shared", scopes: [`m${index}:read`] }))
    await run({ mcps: many })
    const created = (path: string) => id.calls().filter(call => call.method === "POST" && call.path === path).length
    expect([created("/resources"), created("/clients")]).toEqual([3 + 200, 5 + 200])
    const from = id.calls().length
    await run({ rootSecret: undefined, mcps: many })
    const later = id.calls().slice(from)
    expect(later.filter(call => call.path.startsWith("/resources/https%3A%2F%2Fmcp.example") || call.path.startsWith("/clients/claude-code-m")).length).toBe(400)
    expect(writes(from).filter(write => !write.includes("/organizations/"))).toEqual([])
  })
})

describe("failures", () => {
  test("a key used before with other input is reported with the key, not swallowed", async () => {
    const { id, run } = setup()
    await run()
    // ops-register created the resource under this key with other scopes; a manifest change after an erasure, which ID reads as missing, reuses it.
    id.fail(`GET /resources/${encodeURIComponent(acme)}`, 404, "not_found")
    await expect(run({ rootSecret: undefined, mcps: [{ name: "acme", serve: "standalone", database: "shared", scopes: ["acme:read"] }] })).rejects.toThrow("ID refused Idempotency-Key mcp-acme-resource-v1: it was used before with different input")
  })

  test("a call ID does not answer fails, naming it, rather than holding the Job; a network error is passed on as it is", async () => {
    const options = { id: "https://id.example", rootSecret: "t", toolbox: "https://toolbox.example", adminMcp: "https://admin-mcp.example", mcpOrigin: "https://mcp.example", mcps: [], callbackPort: 47700, store: memoryStore().store, log: () => {} }
    const silent = (async (_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch
    await expect(register({ ...options, fetch: silent, timeoutMs: 20 })).rejects.toThrow("GET /organizations?q=answerable&limit=100 got no answer from ID within 0.02 s")
    const refused = (async () => { throw new TypeError("connection refused") }) as unknown as typeof globalThis.fetch
    await expect(register({ ...options, fetch: refused })).rejects.toThrow("connection refused")
  })

  test("an ID without the platform organisation, and any other refusal, are errors naming the call", async () => {
    await expect(setup(fakeId({ platform: false })).run()).rejects.toThrow("ID has no organisation with the slug answerable, its platform organisation's: is this Answerable ID?")
    const failing = setup()
    failing.id.fail("POST /resources", 503, "database_busy")
    await expect(failing.run()).rejects.toThrow("POST /resources (Idempotency-Key toolbox-resource-v1) answered 503 database_busy")
    const reading = setup()
    reading.id.fail(`GET /resources/${encodeURIComponent(toolboxResource)}`, 500)
    await expect(reading.run()).rejects.toThrow(`GET /resources/${encodeURIComponent(toolboxResource)} answered 500 internal_error`)
    const listing = setup()
    listing.id.fail("GET /organizations", 500)
    await expect(listing.run()).rejects.toThrow("GET /organizations answered 500 internal_error")
  })
})

describe("the staff directory", () => {
  const tenant = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`
  const staff = { domain: "answerable.org", entraTenant: tenant }
  function withStaff(id = fakeId()) {
    const { lines, run, printed } = setup(id)
    return { id, lines, printed, run: (rootSecret: string | undefined = id.rootSecret) => run({ rootSecret, staff }) }
  }

  test("adds the staff domain, connects the Entra tenant with onboard.mdx's keys, and logs the connectivity test", async () => {
    const { id, run, printed } = withStaff()
    await run()
    expect(id.domainsOf(id.platform).map(row => row.domain)).toEqual(["answerable.org"])
    expect(id.ssoProviderOf(id.platform)).toMatchObject({ issuer, domain: "answerable.org" })
    expect(id.calls().filter(call => call.key?.startsWith("platform-")).map(call => `${call.method} ${call.key}`)).toEqual(["POST platform-domain-setup", "PUT platform-sso-setup"])
    expect(id.calls().at(-1)).toMatchObject({ method: "GET", path: `/organizations/${id.platform}/sso-provider/test` })
    expect(printed()).toContain("Staff domain answerable.org: added")
    expect(printed()).toContain(`Staff directory ${issuer}: connected`)
    expect(printed()).toContain(`discovery  ${issuer}/.well-known/openid-configuration: reachable, HTTP 200, issuer matches`)
    expect(printed()).toContain("JWKS       reachable, 1 keys")
    expect(printed()).toContain("problems   none")
    expect(printed()).not.toContain("Warning")
    expect(printed()).not.toContain(id.rootSecret)
  })

  test("runs again: replays, then a caller without those receipts finds the same domain and provider and leaves them", async () => {
    const { id, run, printed, lines } = withStaff()
    await run()
    lines.length = 0
    await run(undefined)
    expect(printed()).toContain("Staff domain answerable.org: done before (replayed)")
    expect(printed()).toContain(`Staff directory ${issuer}: done before (replayed)`)
    lines.length = 0
    id.forgetCommands()
    await run(undefined)
    expect(printed()).toContain("Staff domain answerable.org: already on the platform organisation")
    expect(printed()).toContain(`Staff directory ${issuer}: already connected`)
  })

  test("without a Microsoft client in ID it says so and goes on; with problems in the test it warns", async () => {
    const missing = withStaff(fakeId({ microsoft: false }))
    expect(await missing.run()).toMatchObject({ platform: missing.id.platform })
    expect(missing.printed()).toContain("Staff directory not connected: ID has no Microsoft client (MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in id-env)")
    expect(missing.id.calls().some(call => call.path.endsWith("/sso-provider/test"))).toBe(false)
    expect(missing.printed()).toContain("Registered in ")
    // ID's connectivity test finds a problem.
    const troubled = fakeId()
    const fetch = troubled.fetch
    troubled.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await fetch(input, init)
      if (!String(input).endsWith("/sso-provider/test")) return answer
      return Response.json({ ...(await answer.json()), problems: [{ code: "discovery_unreachable", detail: "timed out" }] })
    }) as typeof globalThis.fetch
    const warned = withStaff(troubled)
    await warned.run()
    expect(warned.printed()).toContain("problems   discovery_unreachable: timed out\nWarning: the connectivity test found problems")
  })

  test("leaves another SSO provider as it is, with a warning, and refuses a domain of another organisation", async () => {
    const other = withStaff()
    other.id.ssoProvider(other.id.platform, { issuer: "https://accounts.google.com", domain: "answerable.org" })
    await other.run()
    expect(other.id.ssoProviderOf(other.id.platform)).toMatchObject({ issuer: "https://accounts.google.com", domain: "answerable.org" })
    expect(other.printed()).toContain("Warning: the platform organisation's SSO provider is another one (issuer https://accounts.google.com, domain answerable.org), left as it is")
    expect(other.id.calls().some(call => call.path.endsWith("/sso-provider/test"))).toBe(false)
    const taken = withStaff()
    taken.id.domain(taken.id.organisation(Bun.randomUUIDv7()).id, "answerable.org")
    await expect(taken.run()).rejects.toThrow("The staff domain answerable.org belongs to another organisation")
  })

  test("any other answer is an error naming the call", async () => {
    const cases: [(id: FakeId, organisation: string) => void, string][] = [
      [(id, organisation) => id.fail(`POST ${organisation}/domains`, 503, "database_busy"), "/domains answered 503 database_busy"],
      [(id, organisation) => (id.domain(id.platform, "answerable.org"), id.fail(`GET ${organisation}/domains`, 500)), "/domains answered 500"],
      [(id, organisation) => id.fail(`PUT ${organisation}/sso-provider`, 500), "/sso-provider answered 500"],
      [(id, organisation) => (id.ssoProvider(id.platform, { issuer, domain: "answerable.org" }), id.fail(`GET ${organisation}/sso-provider`, 500)), "/sso-provider answered 500"],
      [(id, organisation) => id.fail(`GET ${organisation}/sso-provider/test`, 502, "bad_gateway"), "/sso-provider/test answered 502"],
    ]
    for (const [arrange, message] of cases) {
      const { id, run } = withStaff()
      arrange(id, `/organizations/${id.platform}`)
      await expect(run()).rejects.toThrow(message)
    }
  })
})
