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
type Options = { body?: unknown; key?: string | null; token?: "read" | "write" | "other" | null; ifMatch?: string; ifNoneMatch?: "*" }
// One answer: the status the fake gives, the request, and what else to check in it.
type Row = [status: number, method: string, path: string, options?: Options, check?: (body: unknown, response: globalThis.Response) => void]

test("every answer the fake gives is one Answerable ID's admin contract declares for the operation: its status, its body's schema and its headers", async () => {
  const id = createFakeId({ operationInProgress: true, resources: { [admin]: ["platform:read", "platform:read platform:write"], "https://other.test/api": ["other"] } })
  const tokens: Record<string, string> = {}
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
  const directory = id.group(organisation, { slug: "directory", externalId: "directory-1" }).id
  const assignment = id.join(group, member)
  id.domain(organisation, "newco.example")
  const provider = id.ssoProvider(organisation, { issuer: google, domain: "newco.example" })
  const entitlement = id.entitlement(organisation, { memberId: member, resource: toolbox, scopes: ["e2e"] }).id
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
    [403, "POST", "/organizations", { token: "read", body: { slug: "acme", name: "Acme" } }],
    [400, "POST", "/organizations", { key: null, body: { slug: "acme", name: "Acme" } }],
    [200, "GET", "/me"],
    [405, "POST", "/me"],
    [200, "GET", "/organizations?q=newco"],
    [201, "POST", "/organizations", { key: "create-acme", body: { slug: "acme", name: "Acme" } }, keep("acme")],
    [201, "POST", "/organizations", { key: "create-acme", body: { slug: "acme", name: "Acme" } }, receipt("applied", "organization")],
    [409, "POST", "/organizations", { key: "create-acme", body: { slug: "acme", name: "Acme Ltd" } }],
    [409, "POST", "/organizations", { body: { slug: "acme", name: "Acme" } }],
    [400, "POST", "/organizations", { body: { slug: "Not a slug", name: "Acme" } }],
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
    [409, "POST", at("/domains"), { body: { domain: "mail.newco.example" } }],
    [400, "POST", at("/domains"), { body: { domain: "not a domain" } }],
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
    [400, "GET", at("/access")],
    [200, "GET", at(`/members/${member}/access`)],
    [404, "GET", at(`/members/${joiner}/access`)],
    [200, "GET", at("/groups")],
    [201, "POST", at("/groups"), { body: { slug: "designers", name: "Designers" } }],
    [409, "POST", at("/groups"), { body: { slug: "designers", name: "Designers" } }],
    [400, "POST", at("/groups"), { body: { slug: "designers" } }],
    [200, "GET", at(`/groups/${group}`)],
    [404, "GET", at(`/groups/${missing}`)],
    [405, "PATCH", at(`/groups/${group}`)],
    [200, "GET", at(`/groups/${group}/members/${member}`)],
    [404, "GET", at(`/groups/${group}/members/${joiner}`)],
    [201, "PUT", at(`/groups/${group}/members/${joiner}`), { key: "join-bob", body: {}, ifNoneMatch: "*" }],
    [201, "PUT", at(`/groups/${group}/members/${joiner}`), { key: "join-bob", body: {}, ifNoneMatch: "*" }, receipt("applied", "group")],
    [200, "PUT", at(`/groups/${group}/members/${member}`), { body: { validUntil: "2027-01-01T00:00:00.000Z" }, ifMatch: `"${assignment.id}:1"` }],
    [412, "PUT", at(`/groups/${group}/members/${member}`), { body: {}, ifNoneMatch: "*" }],
    [409, "PUT", at(`/groups/${directory}/members/${member}`), { body: {} }],
    [409, "PUT", at(`/groups/${group}/members/${revoked}`), { body: {} }],
    [405, "POST", at(`/groups/${group}/members/${member}`), { body: {} }],
    [204, "DELETE", at(`/groups/${group}/members/${joiner}`)],
    [404, "DELETE", at(`/groups/${group}/members/${joiner}`)],
    [200, "GET", at("/entitlements")],
    [201, "POST", at("/entitlements"), { body: { groupId: group, resource: toolbox, scopes: ["toolbox"] } }],
    [409, "POST", at("/entitlements"), { body: { groupId: group, resource: toolbox, scopes: ["e2e"] } }],
    [400, "POST", at("/entitlements"), { body: { memberId: joiner, resource: toolbox, scopes: ["admin"] } }],
    [404, "GET", `/organizations/${missing}/entitlements`],
    [405, "DELETE", at("/entitlements")],
    [200, "GET", at(`/entitlements/${entitlement}`)],
    [404, "GET", at(`/entitlements/${missing}`)],
    [200, "POST", at(`/entitlements/${entitlement}/disable`)],
    [200, "POST", at(`/entitlements/${entitlement}/enable`)],
    [405, "GET", at(`/entitlements/${entitlement}/disable`)],
    [405, "PATCH", at(`/entitlements/${entitlement}`), { body: {} }],
    [200, "GET", at("/capabilities")],
    [201, "POST", at("/capabilities"), { body: { clientId: "claude-code", resource: toolbox, grantKind: "authorization_code", scopes: ["e2e"] } }],
    [200, "GET", resource],
    [200, "PATCH", resource, { body: { allowedScopes: ["e2e", "toolbox", "admin"] }, ifMatch: `"${id.resourceOf(toolbox).id}:1"` }],
    [412, "PATCH", resource, { body: { allowedScopes: ["e2e"] }, ifMatch: `"${id.resourceOf(toolbox).id}:1"` }],
    [404, "GET", `/resources/${encodeURIComponent("https://nothing.test/mcp")}`],
    [405, "DELETE", resource],
    [200, "GET", "/clients/claude-code"],
    [404, "GET", "/clients/nobody"],
    [405, "PATCH", "/clients/claude-code", { body: {} }],
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
