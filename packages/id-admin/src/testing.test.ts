import { expect, test } from "bun:test"
import { z } from "zod"
import { createFakeId } from "./testing"

// ID's admin contract, read from the repository: every answer the fake gives must be one ID declares for that operation.
type Response = { headers?: Record<string, unknown>; content?: Record<string, { schema: z.core.JSONSchema.JSONSchema }> }
const contract: { paths: Record<string, Record<string, { responses: Record<string, Response> }>> } = await Bun.file(new URL("../../../apps/id/openapi.admin.json", import.meta.url)).json()
const operations = Object.entries(contract.paths).flatMap(([template, methods]) => Object.entries(methods).map(([method, operation]) => ({
  method: method.toUpperCase(), pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`), template, responses: operation.responses,
})))

const admin = "https://id.test/api/admin"
const toolbox = "https://toolbox.test/mcp"
const google = "https://accounts.google.com"
type Options = { body?: unknown; key?: string | null; token?: "read" | "write" | "other" | "root" | null; ifMatch?: string; ifNoneMatch?: "*" }
// One answer: the status the fake gives, the request, and what else to check in it.
type Row = [status: number, method: string, path: string, options?: Options, check?: (body: unknown, response: globalThis.Response) => void]

test("every answer the fake gives is one Answerable ID's admin contract declares for the operation: its status, its body's schema and its headers", async () => {
  const id = createFakeId({ operationInProgress: true, rootSecret: "root-secret", resources: { [admin]: ["platform:read", "platform:read platform:write"], "https://other.test/api": ["other"] } })
  const tokens: Record<string, string> = { root: "root-secret" }
  for (const [name, resource, scope] of [["read", admin, "platform:read"], ["write", admin, "platform:read platform:write"], ["other", "https://other.test/api", "other"]] as const) {
    const answer = await id.config.fetch("https://id.test/auth/oauth2/token", {
      method: "POST", headers: { Authorization: `Basic ${btoa("toolbox-hub:hub-secret")}` }, body: new URLSearchParams({ grant_type: "client_credentials", resource, scope }),
    })
    tokens[name] = (await answer.json()).access_token
  }
  const organisation = id.organisation(Bun.randomUUIDv7(), { name: "Newco", slug: "newco" }).id
  const bare = id.organisation(Bun.randomUUIDv7(), { name: "Bare", slug: "bare" }).id
  const member = id.member(organisation, { email: "ada@newco.example", name: "Ada" }).id
  const joiner = id.member(organisation, { email: "bob@newco.example" }).id
  const revoked = id.member(organisation, { email: "eve@newco.example", membershipStatus: "revoked", revokedAt: new Date().toISOString() }).id
  const group = id.group(organisation, { slug: "engineers" }).id
  const assignment = id.join(group, member)
  id.domain(organisation, "newco.example")
  const provider = id.ssoProvider(organisation, { issuer: google, domain: "newco.example" })
  const entitlement = id.entitlement(organisation, { memberId: member, resource: toolbox, scopes: ["e2e"] }).id
  const capability = Bun.randomUUIDv7()
  id.capabilities(organisation).push({ id: capability, revision: 1, organizationId: organisation, clientId: "claude-code", resource: toolbox, grantKind: "refresh_token", scopes: ["e2e"], status: "active", memberId: null, groupId: null, validFrom: null, validUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never)
  id.grant(organisation, member, [{ kind: "resource", id: toolbox, scopes: ["e2e"] }])
  id.event("organization.created", organisation, { targetType: "organization", targetId: organisation })
  id.resource(toolbox, ["e2e", "toolbox"])
  id.client("claude-code")
  const missing = Bun.randomUUIDv7()
  const at = (path: string) => `/organizations/${organisation}${path}`
  const resource = `/resources/${encodeURIComponent(toolbox)}`
  const created: Record<string, string> = {}
  const keep = (name: string) => (body: unknown) => { created[name] = (body as { id: string }).id }
  const receipt = (outcome: string, type: string) => (body: unknown) => expect(body).toMatchObject({ outcome, resultReference: { type } })

  const rows: Row[] = [
    [401, "GET", "/organizations", { token: null }],
    [401, "GET", "/organizations", { token: "other" }],
    // As ID refuses a machine without the scope: insufficient_scope, with the challenge naming it.
    [403, "POST", "/organizations", { token: "read", body: { slug: "acme", name: "Acme" } }, (body, response) => {
      expect(body).toMatchObject({ code: "insufficient_scope" })
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer error="insufficient_scope"')
    }],
    [400, "POST", "/organizations", { key: "", body: { slug: "acme", name: "Acme" } }],
    [200, "GET", "/me"],
    [405, "POST", "/me"],
    [200, "GET", "/organizations?q=newco"],
    [201, "POST", "/organizations", { key: "create-acme", body: { slug: "acme", name: "Acme" } }, keep("acme")],
    [201, "POST", "/organizations", { key: "create-acme", body: { slug: "acme", name: "Acme" } }, receipt("applied", "organization")],
    [409, "POST", "/organizations", { key: "create-acme", body: { slug: "acme", name: "Acme Ltd" } }],
    [409, "POST", "/organizations", { body: { slug: "acme", name: "Acme" } }, body => expect(body).toMatchObject({ code: "conflict", detail: "A row already exists for organizations_slug_unique." })],
    // Without a key, a write is a new command each time: the second is refused as the duplicate it is, not replayed.
    [201, "POST", "/organizations", { key: null, body: { slug: "keyless", name: "Keyless" } }],
    [409, "POST", "/organizations", { key: null, body: { slug: "keyless", name: "Keyless" } }],
    [400, "POST", "/organizations", { body: { slug: "Not a slug", name: "Acme" } }, body => expect(body).toMatchObject({ code: "validation_failed", title: "The request is invalid", errors: [{ path: "slug" }] })],
    [200, "GET", at("")],
    [404, "GET", `/organizations/${missing}`],
    [200, "PATCH", at(""), { key: "rename", body: { name: "Newco" } }],
    [200, "PATCH", at(""), { key: "rename", body: { name: "Newco" } }, receipt("noop", "organization")],
    [412, "PATCH", at(""), { body: { name: "Renamed" }, ifMatch: `"${organisation}:9"` }],
    [400, "PATCH", at(""), { body: { name: "Renamed" }, ifMatch: 'W/"weak"' }],
    [405, "DELETE", at("")],
    [200, "POST", at("/disable")],
    [200, "POST", at("/enable")],
    [405, "GET", at("/disable")],
    [200, "GET", at("/domains")],
    [201, "POST", at("/domains"), { body: { domain: "mail.newco.example" } }],
    [409, "POST", at("/domains"), { body: { domain: "mail.newco.example" } }, body => expect(body).toMatchObject({ detail: "A row already exists for organization_domains_active_domain_idx." })],
    [400, "POST", at("/domains"), { body: { domain: "not a domain" } }, body => expect(body).toMatchObject({ errors: [{ path: "domain" }] })],
    [405, "DELETE", at("/domains")],
    [200, "GET", at("/sso-provider")],
    [200, "PUT", at("/sso-provider"), { body: { issuer: google, domain: "mail.newco.example" }, ifMatch: `"${provider.id}:1"` }],
    [412, "PUT", at("/sso-provider"), { body: { issuer: google, domain: "newco.example" }, ifNoneMatch: "*" }],
    [400, "PUT", at("/sso-provider"), { body: { issuer: "https://idp.example", domain: "newco.example" } }],
    [405, "DELETE", at("/sso-provider")],
    [200, "GET", at("/sso-provider/test")],
    [404, "GET", `/organizations/${bare}/sso-provider`],
    [201, "PUT", `/organizations/${bare}/sso-provider`, { body: { issuer: google, domain: "bare.example" }, ifNoneMatch: "*" }],
    [200, "GET", at("/members?q=ada")],
    [200, "GET", at(`/members/${member}`)],
    [404, "GET", at(`/members/${missing}`)],
    [405, "PATCH", at(`/members/${member}`)],
    [405, "DELETE", at(`/members/${member}`)],
    [200, "GET", at(`/access?resource=${encodeURIComponent(toolbox)}`)],
    [400, "GET", at("/access"), {}, body => expect(body).toMatchObject({ errors: [{ path: "", message: "A client, resource or exact pair is required" }] })],
    [200, "GET", at(`/members/${member}/access`)],
    [404, "GET", at(`/members/${joiner}/access`)],
    [200, "GET", at("/groups")],
    [201, "POST", at("/groups"), { body: { slug: "designers", name: "Designers" } }],
    [409, "POST", at("/groups"), { body: { slug: "designers", name: "Designers" } }, body => expect(body).toMatchObject({ detail: "A row already exists for groups_organization_id_slug_unique." })],
    [400, "POST", at("/groups"), { body: { slug: "designers" } }, body => expect(body).toMatchObject({ errors: [{ path: "name" }] })],
    [200, "GET", at(`/groups/${group}`)],
    [404, "GET", at(`/groups/${missing}`)],
    [405, "PATCH", at(`/groups/${group}`)],
    [200, "GET", at(`/groups/${group}/members/${member}`)],
    [404, "GET", at(`/groups/${group}/members/${joiner}`)],
    [201, "PUT", at(`/groups/${group}/members/${joiner}`), { key: "join-bob", body: {}, ifNoneMatch: "*" }],
    [201, "PUT", at(`/groups/${group}/members/${joiner}`), { key: "join-bob", body: {}, ifNoneMatch: "*" }, receipt("applied", "group")],
    [200, "PUT", at(`/groups/${group}/members/${member}`), { body: { validUntil: "2027-01-01T00:00:00.000Z" }, ifMatch: `"${assignment.id}:1"` }],
    [412, "PUT", at(`/groups/${group}/members/${member}`), { body: {}, ifNoneMatch: "*" }],
    [409, "PUT", at(`/groups/${group}/members/${revoked}`), { body: {} }],
    [405, "POST", at(`/groups/${group}/members/${member}`), { body: {} }],
    [204, "DELETE", at(`/groups/${group}/members/${joiner}`)],
    [404, "DELETE", at(`/groups/${group}/members/${joiner}`)],
    [200, "GET", at("/entitlements")],
    [201, "POST", at("/entitlements"), { body: { groupId: group, resource: toolbox, scopes: ["toolbox"] } }],
    [409, "POST", at("/entitlements"), { body: { groupId: group, resource: toolbox, scopes: ["e2e"] } }, body => expect(body).toMatchObject({ detail: "A row already exists for entitlements_principal_target_unique." })],
    [400, "POST", at("/entitlements"), { body: { memberId: joiner, resource: toolbox, scopes: ["admin"] } }],
    [404, "GET", `/organizations/${missing}/entitlements`],
    [405, "DELETE", at("/entitlements")],
    [200, "GET", at(`/entitlements/${entitlement}`)],
    [404, "GET", at(`/entitlements/${missing}`)],
    [200, "POST", at(`/entitlements/${entitlement}/disable`)],
    [200, "POST", at(`/entitlements/${entitlement}/enable`)],
    [405, "GET", at(`/entitlements/${entitlement}/disable`)],
    [412, "PATCH", at(`/entitlements/${entitlement}`), { body: { scopes: ["toolbox"] }, ifMatch: `"${entitlement}:1"` }],
    [200, "PATCH", at(`/entitlements/${entitlement}`), { body: { scopes: ["toolbox", "e2e", "e2e"] }, ifMatch: `"${entitlement}:3"` }, body => expect(body).toMatchObject({ scopes: ["e2e", "toolbox"], revision: 4 })],
    [400, "PATCH", at(`/entitlements/${entitlement}`), { body: { scopes: ["nothing"] }, ifMatch: `"${entitlement}:4"` }],
    [404, "PATCH", at(`/entitlements/${missing}`), { body: { scopes: ["toolbox"] } }],
    [200, "GET", at(`/capabilities/${capability}`)],
    [404, "GET", at(`/capabilities/${missing}`)],
    [200, "PATCH", at(`/capabilities/${capability}`), { body: { scopes: ["toolbox", "e2e"] }, ifMatch: `"${capability}:1"` }, body => expect(body).toMatchObject({ scopes: ["e2e", "toolbox"], revision: 2 })],
    [412, "PATCH", at(`/capabilities/${capability}`), { body: { scopes: ["e2e"] }, ifMatch: `"${capability}:1"` }],
    [405, "DELETE", at(`/capabilities/${capability}`)],
    [200, "GET", at("/capabilities")],
    [201, "POST", at("/capabilities"), { body: { clientId: "claude-code", resource: toolbox, grantKind: "authorization_code", scopes: ["e2e"] } }],
    [200, "GET", resource],
    [200, "PATCH", resource, { body: { allowedScopes: ["e2e", "toolbox", "admin"] }, ifMatch: `"${id.resourceOf(toolbox).id}:1"` }],
    [412, "PATCH", resource, { body: { allowedScopes: ["e2e"] }, ifMatch: `"${id.resourceOf(toolbox).id}:1"` }],
    [404, "GET", `/resources/${encodeURIComponent("https://nothing.test/mcp")}`],
    [405, "DELETE", resource],
    [200, "GET", "/clients/claude-code"],
    [404, "GET", "/clients/nobody"],
    [200, "GET", "/organizations?q=newco", { token: "root" }],
    [201, "POST", "/resources", { body: { classification: "platform_shared", organizationId: null, identifier: "https://acme.test/mcp", name: "Acme", allowedScopes: ["acme:write", "acme:read", "acme:read"], accessTokenTtl: 900 } }, body => {
      expect(body).toMatchObject({ identifier: "https://acme.test/mcp", name: "Acme", allowedScopes: ["acme:read", "acme:write"], accessTokenTtl: 900, revision: 1, clients: [] })
    }],
    [409, "POST", "/resources", { body: { classification: "platform_shared", organizationId: null, identifier: "https://acme.test/mcp", name: "Acme", allowedScopes: ["acme:read"] } }],
    [400, "POST", "/resources", { body: { identifier: "https://nothing.test/mcp" } }, body => expect(body).toMatchObject({ errors: [{ path: "identifier" }] })],
    [405, "GET", "/resources"],
    [200, "PATCH", `/resources/${encodeURIComponent("https://acme.test/mcp")}`, { body: { name: "Acme MCP", accessTokenTtl: 600, allowedScopes: ["acme:write", "acme:read", "acme:admin"] } }, body => {
      expect(body).toMatchObject({ name: "Acme MCP", accessTokenTtl: 600, allowedScopes: ["acme:admin", "acme:read", "acme:write"], revision: 2 })
    }],
    [201, "POST", "/clients", { body: { clientId: "ops", name: "Ops", organizationId: organisation, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], redirectUris: [], clientCredentialsScopes: ["platform:read"] } }, body => {
      expect(body).toMatchObject({ clientId: "ops", name: "Ops", clientCredentialsScopes: ["platform:read"], hasClientSecret: true, clientSecret: expect.stringMatching(/^secret-/), resources: [] })
    }],
    [201, "POST", "/clients", { body: { clientId: "browser", name: "Browser", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code"], redirectUris: ["http://localhost:47700/callback"] } }, body => {
      expect(body).not.toHaveProperty("clientSecret")
    }],
    [409, "POST", "/clients", { body: { clientId: "ops", name: "Ops", tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], redirectUris: [] } }],
    [400, "POST", "/clients", { body: { clientId: "nameless" } }, body => expect(body).toMatchObject({ errors: [{ path: "name" }] })],
    [405, "GET", "/clients"],
    [200, "PATCH", "/clients/ops", { body: { name: "Ops client", clientCredentialsScopes: ["platform:read", "platform:write"] } }, body => {
      expect(body).toMatchObject({ name: "Ops client", clientCredentialsScopes: ["platform:read", "platform:write"], revision: 2 })
    }],
    [412, "PATCH", "/clients/ops", { body: { name: "Stale" }, ifMatch: `"${missing}:9"` }],
    [404, "PATCH", "/clients/nobody", { body: { name: "Nobody" } }],
    [200, "POST", "/clients/ops/rotate-secret", {}, body => expect(body).toMatchObject({ clientId: "ops", clientSecret: expect.stringMatching(/^rotated-/) })],
    [404, "POST", "/clients/nobody/rotate-secret"],
    [405, "GET", "/clients/ops/rotate-secret"],
    [201, "PUT", `/clients/ops/resources/${encodeURIComponent(admin)}`],
    [200, "PUT", `/clients/ops/resources/${encodeURIComponent(admin)}`],
    [201, "POST", at("/capabilities"), { body: { clientId: "ops", resource: admin, grantKind: "client_credentials", scopes: ["platform:read"] } }],
    [201, "PUT", `/clients/claude-code${resource}`],
    [200, "PUT", `/clients/claude-code${resource}`],
    [404, "PUT", `/clients/nobody${resource}`],
    [405, "DELETE", `/clients/claude-code${resource}`],
    [200, "GET", `/audit-events?organizationId=${organisation}`],
    [405, "POST", "/audit-events", { body: {} }],
  ]
  async function send([, method, path, { body, key, token = "write", ifMatch, ifNoneMatch } = {}]: Row) {
    const headers: Record<string, string> = {
      ...(token ? { Authorization: `Bearer ${tokens[token]}` } : {}),
      ...(method !== "GET" && key !== null ? { "Idempotency-Key": key ?? crypto.randomUUID() } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(ifMatch ? { "If-Match": ifMatch } : {}), ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}),
    }
    return id.config.fetch(`https://id.test/api/admin/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  async function conforms(row: Row, response: globalThis.Response) {
    const [status, method, path, , check] = row
    const label = `${method} ${path}`
    expect(response.status, label).toBe(status)
    const body = status === 204 ? null : await response.json()
    // A route the fake does not implement for this method: never an answer ID would give in its place.
    if (status === 405) return expect(body, label).toMatchObject({ code: "method_not_allowed" })
    const operation = operations.find(item => item.method === method && item.pattern.test(`/api/admin/v1${path.split("?")[0]}`))
    const declared = operation?.responses[String(status)]
    expect(declared, `${label}: ${status} is not an answer of ${operation?.template ?? "any operation"}`).toBeDefined()
    // ID sends a replayed command's receipt without the resource's ETag (apps/id/src/http/admin/command.ts).
    const replayed = response.headers.get("Idempotency-Replayed") === "true"
    for (const header of Object.keys(declared!.headers ?? {})) if (!(replayed && header === "ETag")) expect(response.headers.has(header), `${label}: header ${header}`).toBe(true)
    if (status === 401) expect(response.headers.get("WWW-Authenticate"), label).toBe('Bearer error="invalid_token"')
    if (body !== null) {
      const [type, { schema }] = Object.entries(declared!.content!)[0]!
      expect(response.headers.get("Content-Type"), label).toStartWith(type)
      const parsed = z.fromJSONSchema(schema).safeParse(body)
      expect(parsed.error?.issues ?? [], `${label}: ${JSON.stringify(body)}`).toEqual([])
    }
    check?.(body, response)
  }
  for (const row of rows) await conforms(row, await send(row))
  expect(created.acme).toBeDefined()

  // ID's busy database, and a command whose key a running command holds.
  id.failWrite(1)
  await conforms([503, "POST", at("/disable"), {}, (_body, response) => expect(response.headers.get("Retry-After")).toBe("1")], await send([503, "POST", at("/disable")]))
  id.slow(20)
  const running: Row = [200, "POST", at("/enable"), { key: "enable-once" }]
  const [first, second] = await Promise.all([send(running), send(running)])
  id.slow(0)
  await conforms(running, first!)
  await conforms([409, "POST", at("/enable"), {}, body => expect(body).toMatchObject({ code: "operation_in_progress", retryable: true })], second!)
})

test("a link moves the revision of the resource and of the client it joins, as ID does, so a later change bound to the old ETag is refused; a link that exists moves nothing", async () => {
  const id = createFakeId()
  id.resource(toolbox, ["toolbox"])
  id.client("claude-code")
  const answer = await id.config.fetch("https://id.test/auth/oauth2/token", {
    method: "POST", headers: { Authorization: `Basic ${btoa("toolbox-hub:hub-secret")}` }, body: new URLSearchParams({ grant_type: "client_credentials", resource: admin, scope: "platform:read platform:write" }),
  })
  const authorization = `Bearer ${(await answer.json()).access_token}`
  const send = (method: string, path: string, init: { body?: unknown; ifMatch?: string } = {}) => id.config.fetch(`https://id.test/api/admin/v1${path}`, {
    method,
    headers: { Authorization: authorization, "Idempotency-Key": crypto.randomUUID(), ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.ifMatch ? { "If-Match": init.ifMatch } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const at = `/resources/${encodeURIComponent(toolbox)}`
  const [resourceBefore, clientBefore] = await Promise.all([send("GET", at), send("GET", "/clients/claude-code")])
  const stale = resourceBefore.headers.get("ETag")!
  expect((await send("PUT", `/clients/claude-code${at}`)).status).toBe(201)
  const [resourceAfter, clientAfter] = await Promise.all([send("GET", at), send("GET", "/clients/claude-code")])
  expect([resourceAfter.headers.get("ETag"), clientAfter.headers.get("ETag")]).toEqual([`"${id.resourceOf(toolbox).id}:2"`, clientBefore.headers.get("ETag")!.replace(/:1"$/, ':2"')])
  expect(stale).toBe(`"${id.resourceOf(toolbox).id}:1"`)
  expect((await send("PATCH", at, { body: { allowedScopes: ["toolbox", "e2e"] }, ifMatch: stale })).status).toBe(412)
  expect((await send("PUT", `/clients/claude-code${at}`)).status).toBe(200)
  expect((await send("GET", at)).headers.get("ETag")).toBe(resourceAfter.headers.get("ETag"))
  expect((await send("PATCH", at, { body: { allowedScopes: ["toolbox", "e2e"] }, ifMatch: resourceAfter.headers.get("ETag")! })).status).toBe(200)
})

test("a client created through the API is shown its secret once and gets a token only for an audience it is linked to and holds a capability for; rotating the secret ends the old one", async () => {
  const id = createFakeId({ rootSecret: "root-secret" })
  const toolboxAdmin = "https://toolbox.test/admin"
  const send = (method: string, path: string, body?: unknown) => id.config.fetch(`https://id.test/api/admin/v1${path}`, {
    method, headers: { Authorization: "Bearer root-secret", "Idempotency-Key": crypto.randomUUID(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  const token = async (secret: string, resource: string, scope: string) => (await id.config.fetch("https://id.test/auth/oauth2/token", {
    method: "POST", headers: { Authorization: `Basic ${btoa(`dev:${secret}`)}` }, body: new URLSearchParams({ grant_type: "client_credentials", resource, scope }),
  })).status
  const created = await (await send("POST", "/clients", { clientId: "dev", name: "Dev", organizationId: id.organizationId, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], redirectUris: [], clientCredentialsScopes: ["platform:read", "toolbox:admin"] })).json()
  await send("POST", "/resources", { classification: "platform_shared", organizationId: null, identifier: toolboxAdmin, name: "Toolbox admin", allowedScopes: ["toolbox:admin"] })
  // Neither linked nor entitled: ID refuses.
  expect([await token(created.clientSecret, admin, "platform:read"), await token(created.clientSecret, toolboxAdmin, "toolbox:admin")]).toEqual([400, 400])
  await send("PUT", `/clients/dev/resources/${encodeURIComponent(admin)}`)
  await send("PUT", `/clients/dev/resources/${encodeURIComponent(toolboxAdmin)}`)
  // Linked, without a capability.
  expect([await token(created.clientSecret, admin, "platform:read"), await token(created.clientSecret, toolboxAdmin, "toolbox:admin")]).toEqual([400, 400])
  for (const [resource, scopes] of [[admin, ["platform:read"]], [toolboxAdmin, ["toolbox:admin"]]] as const) {
    await send("POST", `/organizations/${id.organizationId}/capabilities`, { clientId: "dev", resource, grantKind: "client_credentials", scopes })
  }
  expect([await token(created.clientSecret, admin, "platform:read"), await token(created.clientSecret, toolboxAdmin, "toolbox:admin")]).toEqual([200, 200])
  // The capability covers platform:read only.
  expect(await token(created.clientSecret, admin, "platform:read platform:write")).toBe(400)
  expect(await token("wrong", admin, "platform:read")).toBe(401)
  const rotated = await (await send("POST", "/clients/dev/rotate-secret")).json()
  expect([await token(created.clientSecret, admin, "platform:read"), await token(rotated.clientSecret, admin, "platform:read")]).toEqual([401, 200])
  expect(id.clientOf("dev")).toMatchObject({ clientId: "dev", resources: [toolboxAdmin, admin], secret: rotated.clientSecret })
  expect(id.clientOf("nobody")).toBeUndefined()
})

test("as the ops Jobs meet it: each caller keeps its own keys, a route can be made to fail, an Entra provider needs ID's Microsoft application, and joining platform-admins locks the root secret unless break glass keeps it", async () => {
  const send = (id: ReturnType<typeof createFakeId>, method: string, path: string, { body, key = crypto.randomUUID(), bearer = "root-secret", ifNoneMatch = false }: { body?: unknown; key?: string; bearer?: string; ifNoneMatch?: boolean } = {}) =>
    id.config.fetch(`https://id.test/api/admin/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, ...(method === "GET" ? {} : { "Idempotency-Key": key }), ...(ifNoneMatch ? { "If-None-Match": "*" } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  const id = createFakeId({ rootSecret: "root-secret", microsoft: false })
  id.staffToken("staff-token")
  const platform = id.organizationId
  const groups = `/organizations/${platform}/groups`
  // The same key from another caller is another command: here, a second group of the same slug, which ID refuses.
  expect((await send(id, "POST", groups, { body: { slug: "staff", name: "Staff" }, key: "one-key" })).status).toBe(201)
  expect((await send(id, "POST", groups, { body: { slug: "staff", name: "Staff" }, key: "one-key" })).headers.get("Idempotency-Replayed")).toBe("true")
  expect(await (await send(id, "POST", groups, { body: { slug: "staff", name: "Staff" }, key: "one-key", bearer: "staff-token" })).json()).toMatchObject({ status: 409, code: "conflict" })
  expect(id.received.slice(-3).map(({ caller }) => caller)).toEqual(["root", "root", null])
  // A failing route answers so on every call, reads included.
  id.fail("GET /organizations", 502, "bad_gateway")
  for (let call = 0; call < 2; call++) expect(await (await send(id, "GET", "/organizations?q=answerable")).json()).toMatchObject({ status: 502, code: "bad_gateway" })
  id.fail(`POST ${groups}`, 500)
  expect(await (await send(id, "POST", groups, { body: { slug: "other", name: "Other" } })).json()).toMatchObject({ status: 500, code: "internal_error" })
  // Without Answerable's Microsoft application, ID refuses an Entra provider with platform credentials, before its precondition.
  const entra = await send(id, "PUT", `/organizations/${platform}/sso-provider`, { body: { issuer: "https://login.microsoftonline.com/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/v2.0", domain: "answerable.org" }, ifNoneMatch: true })
  expect(await entra.json()).toMatchObject({ status: 409, code: "platform_application_missing" })
  expect(operations.find(({ method, pattern }) => method === "PUT" && pattern.test(`/api/admin/v1/organizations/${platform}/sso-provider`))!.responses["409"]).toBeDefined()
  // A member who joins platform-admins locks the root secret; another group does not, nor does break glass.
  for (const [breakGlass, locked] of [[false, true], [true, false]] as const) {
    const fake = createFakeId({ rootSecret: "root-secret", breakGlass })
    const ada = fake.member(fake.organizationId, { email: "ada@answerable.org" }).id
    for (const slug of ["answerable-owner", "platform-admins"]) {
      const group = fake.group(fake.organizationId, { slug }).id
      expect((await send(fake, "PUT", `/organizations/${fake.organizationId}/groups/${group}/members/${ada}`, { body: {}, ifNoneMatch: true })).status).toBe(201)
      expect(fake.rootLocked(), slug).toBe(slug === "platform-admins" && locked)
    }
  }
})

test("the root secret works as a platform administrator's until it is locked, then ID answers it 403 root_locked; a staff token keeps working", async () => {
  const id = createFakeId({ rootSecret: "root-secret" })
  id.staffToken("staff-token")
  const status = async (bearer: string) => (await id.config.fetch("https://id.test/api/admin/v1/organizations?q=answerable", { headers: { Authorization: `Bearer ${bearer}` } })).status
  expect([await status("root-secret"), await status("staff-token"), await status("other")]).toEqual([200, 200, 401])
  id.lockRoot(true)
  const locked = await id.config.fetch("https://id.test/api/admin/v1/organizations", { headers: { Authorization: "Bearer root-secret" } })
  expect([locked.status, await locked.json()]).toMatchObject([403, { code: "root_locked" }])
  expect(await status("staff-token")).toBe(200)
})

test("ID answers its liveness check, and a fake that is down answers it 503", async () => {
  const id = createFakeId()
  expect(await (await id.config.fetch("https://id.test/healthz")).json()).toEqual({ status: "ok" })
  id.outage(true)
  expect((await id.config.fetch("https://id.test/healthz")).status).toBe(503)
})
