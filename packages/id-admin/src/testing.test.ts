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
type Options = { body?: unknown; key?: string | null; token?: "read" | "write" | "users" | "other" | "root" | null; ifMatch?: string; ifNoneMatch?: "*" }
// One answer: the status the fake gives, the request, and what else to check in it.
type Row = [status: number, method: string, path: string, options?: Options, check?: (body: unknown, response: globalThis.Response) => void]

test("every answer the fake gives is one Answerable ID's admin contract declares for the operation: its status, its body's schema and its headers", async () => {
  const id = createFakeId({ operationInProgress: true, rootSecret: "root-secret", resources: { [admin]: ["platform:read", "platform:read platform:write", "platform:read platform:users"], "https://other.test/api": ["other"] } })
  const tokens: Record<string, string> = { root: "root-secret" }
  for (const [name, resource, scope] of [["read", admin, "platform:read"], ["write", admin, "platform:read platform:write"], ["users", admin, "platform:read platform:users"], ["other", "https://other.test/api", "other"]] as const) {
    const answer = await id.config.fetch("https://id.test/auth/oauth2/token", {
      method: "POST", headers: { Authorization: `Basic ${btoa("toolbox-hub:hub-secret")}` }, body: new URLSearchParams({ grant_type: "client_credentials", resource, scope }),
    })
    tokens[name] = (await answer.json()).access_token
  }
  const organisation = id.organisation(Bun.randomUUIDv7(), { name: "Newco", slug: "newco" }).id
  const bare = id.organisation(Bun.randomUUIDv7(), { name: "Bare", slug: "bare" }).id
  const ada = id.member(organisation, { email: "ada@newco.example", name: "Ada" })
  const member = ada.id
  const joiner = id.member(organisation, { email: "bob@newco.example" }).id
  // A person who leaves the organisation: in a group and with a grant of their own, which a removal takes away; and a user of two organisations.
  const leaver = id.member(organisation, { email: "lee@newco.example", name: "Lee" })
  const staying = id.member(bare, { email: "lee@newco.example", userId: leaver.userId, name: "Lee" })
  const leavers = id.group(organisation, { slug: "leavers" }).id
  id.join(leavers, leaver.id)
  id.entitlement(organisation, { memberId: leaver.id, resource: toolbox, scopes: ["toolbox"] })
  id.grant(organisation, leaver.id, [{ kind: "resource", id: toolbox, scopes: ["toolbox"] }])
  const user = String(ada.userId)
  const tenant = String(leaver.userId)
  const revoked = id.member(organisation, { email: "eve@newco.example", membershipStatus: "revoked", revokedAt: new Date().toISOString() }).id
  const group = id.group(organisation, { slug: "engineers" }).id
  const assignment = id.join(group, member)
  const domainRow = id.domain(organisation, "newco.example")
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
    [200, "GET", at(""), {}, body => expect(body).toMatchObject({ magicLink: { enabled: false } })],
    [200, "POST", at("/magic-link/enable"), {}, body => expect(body).toMatchObject({ id: organisation, magicLink: { enabled: true } })],
    [200, "POST", at("/magic-link/disable"), { key: "magic-link-off" }, body => expect(body).toMatchObject({ id: organisation, magicLink: { enabled: false } })],
    [200, "POST", at("/magic-link/disable"), { key: "magic-link-off" }, receipt("applied", "organization")],
    [200, "POST", at("/magic-link/disable"), { key: "magic-link-off-again" }],
    [200, "POST", at("/magic-link/disable"), { key: "magic-link-off-again" }, receipt("noop", "organization")],
    [200, "GET", at(""), {}, body => expect(body).toMatchObject({ magicLink: { enabled: false } })],
    [200, "POST", at("/magic-link/enable"), {}, body => expect(body).toMatchObject({ id: organisation, magicLink: { enabled: true } })],
    [200, "GET", "/organizations?q=newco", {}, body => expect((body as { items: unknown[] }).items).toMatchObject([{ magicLink: { enabled: true } }])],
    [409, "POST", `/organizations/${id.organizationId}/magic-link/enable`, {}, body => expect(body).toMatchObject({ code: "platform_magic_link" })],
    [200, "POST", `/organizations/${id.organizationId}/magic-link/disable`, { key: "platform-off" }, body => expect(body).toMatchObject({ id: id.organizationId, magicLink: { enabled: false } })],
    [200, "POST", `/organizations/${id.organizationId}/magic-link/disable`, { key: "platform-off" }, receipt("noop", "organization")],
    [403, "POST", at("/magic-link/disable"), { token: "read" }],
    // Who may ask: listed always, domain with every active domain proved, and never the platform organisation's.
    [200, "GET", at(""), {}, body => expect(body).toMatchObject({ magicLink: { enabled: true, admission: "listed", listed: expect.any(Number) } })],
    [200, "GET", "/organizations?q=newco", {}, body => {
      const [row] = (body as { items: { magicLink: Record<string, unknown> }[] }).items
      expect(row!.magicLink).toEqual({ enabled: true, admission: "listed" })
    }],
    [200, "GET", at("/domains"), {}, body => expect((body as { items: unknown[] }).items[0]).toMatchObject({
      domain: "newco.example", verifiedAt: null, verificationRecord: { type: "TXT", name: "_answerable-challenge.newco.example", value: expect.stringMatching(/^answerable-domain-verification=[0-9a-f]{32}$/) },
    })],
    [409, "PATCH", at("/magic-link"), { body: { admission: "domain" } }, body => expect(body).toMatchObject({ code: "domain_not_verified", details: { unverified: ["newco.example"] } })],
    [409, "PATCH", `/organizations/${bare}/magic-link`, { body: { admission: "domain" } }, body => expect(body).toMatchObject({ code: "domain_not_verified", details: { unverified: [] } })],
    [409, "PATCH", `/organizations/${id.organizationId}/magic-link`, { body: { admission: "domain" } }, body => expect(body).toMatchObject({ code: "platform_magic_link" })],
    [400, "PATCH", at("/magic-link"), { body: { admission: "anyone" } }],
    [403, "PATCH", at("/magic-link"), { token: "read", body: { admission: "listed" } }],
    [403, "PATCH", at("/magic-link"), { token: "users", body: { admission: "listed" } }],
    [200, "PATCH", at("/magic-link"), { key: "listed-noop", body: { admission: "listed" } }, body => expect(body).toMatchObject({ magicLink: { admission: "listed" } })],
    [200, "PATCH", at("/magic-link"), { key: "listed-noop", body: { admission: "listed" } }, receipt("noop", "organization")],
    [405, "GET", at("/magic-link")],
    // A domain's proof: what DNS holds, which a failure takes away.
    [409, "POST", at(`/domains/${domainRow.id}/verify`), {}, body => expect(body).toMatchObject({ code: "domain_verification_failed", expected: { type: "TXT", name: "_answerable-challenge.newco.example" } })],
    [404, "POST", at(`/domains/${missing}/verify`)],
    [403, "POST", at(`/domains/${domainRow.id}/verify`), { token: "read" }],
    [403, "POST", at(`/domains/${domainRow.id}/verify`), { token: "users" }],
    [405, "GET", at(`/domains/${domainRow.id}/verify`)],
    // An import: each address its own answer, with platform:users, and its preview with platform:read.
    [200, "POST", at("/members/import/preview"), { token: "read", body: { addresses: ["Ada@newco.example", "ada@newco.example", "fresh@newco.example", "x@elsewhere.example", "nonsense"] } }, body => expect(body).toEqual({
      counts: { created: 1, added: 0, alreadyMember: 1, refused: 2 },
      items: [
        { address: "ada@newco.example", outcome: "alreadyMember" }, { address: "fresh@newco.example", outcome: "created" },
        { address: "x@elsewhere.example", outcome: "refused", reason: "outside_domains" }, { address: "nonsense", outcome: "refused", reason: "invalid" },
      ],
    })],
    [200, "POST", at("/members/import/preview"), { token: "read", body: { addresses: ["fresh@newco.example"] } }, body => expect(body).toMatchObject({ counts: { created: 1 } })],
    [401, "POST", at("/members/import/preview"), { token: null, body: { addresses: ["a@b.example"] } }],
    [400, "POST", at("/members/import"), { token: "users", body: { addresses: [] } }],
    [404, "POST", `/organizations/${missing}/members/import`, { token: "users", body: { addresses: ["a@b.example"] } }],
    [403, "POST", at("/members/import"), { token: "write", body: { addresses: ["a@b.example"] } }, body => expect(body).toMatchObject({ code: "insufficient_scope" })],
    [200, "POST", at("/members/import"), { token: "users", key: "import", body: { addresses: ["fresh@newco.example"] } }, body => expect(body).toMatchObject({ counts: { created: 1 }, items: [{ address: "fresh@newco.example", outcome: "created" }] })],
    [200, "POST", at("/members/import"), { token: "users", key: "import", body: { addresses: ["fresh@newco.example"] } }, receipt("applied", "organization")],
    [200, "POST", at("/members/import"), { token: "users", key: "import-again", body: { addresses: ["fresh@newco.example"] } }, body => expect(body).toMatchObject({ counts: { alreadyMember: 1 } })],
    [200, "POST", at("/members/import"), { token: "users", key: "import-again", body: { addresses: ["fresh@newco.example"] } }, receipt("noop", "organization")],
    [405, "GET", at("/members/import")],
    [404, "POST", `/organizations/${missing}/magic-link/enable`],
    [405, "GET", at("/magic-link/enable")],
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
    [405, "PATCH", at(`/members/${member}`), { token: "users" }],
    [405, "PUT", at(`/members/${member}`), { token: "users" }],
    [405, "GET", at(`/members/${member}/reinstate`)],
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
    // ID takes no filter on its list of capabilities, so one the query names does not narrow it; an entitlement list's filters do.
    [200, "GET", at("/capabilities?clientId=nobody&status=disabled"), {}, body => expect((body as { items: unknown[] }).items.length).toBeGreaterThan(0)],
    [200, "GET", at("/entitlements?clientId=nobody"), {}, body => expect((body as { items: unknown[] }).items).toEqual([])],
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
    // A user is found by their exact address in any case, listed with ID's filters, and read with their memberships, accounts and sessions.
    [200, "GET", "/users?email=ADA@newco.example", {}, body => expect(body).toMatchObject({ items: [{ id: user, email: "ada@newco.example", status: "active", retiredEmail: null }], nextCursor: null })],
    [200, "GET", "/users?email=nobody@newco.example", {}, body => expect(body).toMatchObject({ items: [] })],
    [200, "GET", `/users?q=ada&status=active&organizationId=${organisation}`, {}, body => expect((body as { items: unknown[] }).items).toHaveLength(1)],
    [200, "GET", `/users?organizationId=${bare}`, {}, body => expect((body as { items: { id: string }[] }).items.map(item => item.id)).toEqual([tenant])],
    [405, "POST", "/users", { body: {} }],
    [200, "GET", `/users/${tenant}`, {}, body => expect(body).toMatchObject({
      id: tenant, memberships: [{ memberId: expect.any(String), organizationId: expect.any(String), slug: expect.any(String), effective: true }, { effective: true }], accounts: [], sessionCount: 0,
    })],
    [404, "GET", `/users/${missing}`],
    [405, "DELETE", `/users/${user}`, { token: "write" }],
    [405, "POST", `/users/${user}`],
    [405, "GET", `/users/${user}/disable`],
    // As ID refuses a machine that holds platform:write without platform:users, and one that holds platform:users without platform:write.
    [403, "POST", `/users/${user}/disable`, { token: "write" }, (body, response) => {
      expect(body).toMatchObject({ code: "insufficient_scope" })
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer error="insufficient_scope"')
    }],
    [403, "POST", `/users/${user}/enable`, { token: "read" }],
    [403, "POST", `/users/${user}/retire-email`, { token: "write" }],
    [403, "DELETE", at(`/members/${leaver.id}`), { token: "write" }],
    [403, "POST", at(`/members/${leaver.id}/reinstate`), { token: "write" }],
    [403, "POST", "/organizations", { token: "users", body: { slug: "users-only", name: "Users only" } }],
    [409, "POST", `/users/${user}/retire-email`, { token: "users" }, body => expect(body).toMatchObject({ code: "user_not_disabled" })],
    [200, "POST", `/users/${user}/enable`, { token: "users", key: "enable-ada" }, body => expect(body).toMatchObject({ id: user, status: "active" })],
    [200, "POST", `/users/${user}/enable`, { token: "users", key: "enable-ada" }, receipt("noop", "user")],
    [404, "POST", `/users/${missing}/disable`, { token: "users" }],
    [200, "POST", `/users/${user}/disable`, { token: "users", key: "disable-ada" }, body => expect(body).toMatchObject({ id: user, status: "disabled", disabledAt: expect.any(String), retiredEmail: null })],
    [200, "POST", `/users/${user}/disable`, { token: "users", key: "disable-ada" }, receipt("applied", "user")],
    [409, "POST", `/users/${user}/disable`, { token: "users", key: "disable-ada", body: { reason: "other input" } }],
    [200, "POST", `/users/${user}/disable`, { token: "users", key: "disable-ada-again" }],
    [200, "POST", `/users/${user}/disable`, { token: "users", key: "disable-ada-again" }, receipt("noop", "user")],
    [200, "GET", at(`/members/${member}`), {}, body => expect(body).toMatchObject({ status: "disabled", email: "ada@newco.example" })],
    [200, "POST", `/users/${user}/retire-email`, { token: "users", key: "retire-ada" }, body => expect(body).toMatchObject({ id: user, status: "disabled", retiredEmail: "ada@newco.example", email: `${user}@retired.invalid` })],
    [200, "POST", `/users/${user}/retire-email`, { token: "users", key: "retire-ada" }, receipt("applied", "user")],
    [200, "POST", `/users/${user}/retire-email`, { token: "users", key: "retire-ada-again" }, body => expect(body).toMatchObject({ retiredEmail: "ada@newco.example" })],
    [200, "POST", `/users/${user}/retire-email`, { token: "users", key: "retire-ada-again" }, receipt("noop", "user")],
    [409, "POST", `/users/${user}/enable`, { token: "users" }, body => expect(body).toMatchObject({ code: "user_email_retired" })],
    [200, "GET", `/users?email=ada@newco.example`, {}, body => expect(body).toMatchObject({ items: [] })],
    [200, "GET", at(`/members/${member}`), {}, body => expect(body).toMatchObject({ status: "disabled", email: `${user}@retired.invalid` })],
    // A removal revokes one membership, takes its group assignments and direct grants, and leaves the user and their other memberships.
    [204, "DELETE", at(`/members/${leaver.id}`), { token: "users", key: "remove-lee" }, () => {
      expect([id.joined(leavers, leaver.id), id.entitlements(organisation).some(row => row.memberId === leaver.id)]).toEqual([false, false])
    }],
    [204, "DELETE", at(`/members/${leaver.id}`), { token: "users", key: "remove-lee" }],
    [200, "GET", at(`/members/${leaver.id}`), {}, body => expect(body).toMatchObject({ membershipStatus: "revoked", effective: false, status: "active", revokedAt: expect.any(String), groups: [] })],
    [404, "GET", at(`/members/${leaver.id}/access`)],
    [200, "GET", `/users/${tenant}`, {}, body => expect((body as { memberships: { memberId: string; effective: boolean }[] }).memberships.map(item => [item.memberId, item.effective]).toSorted()).toEqual([[leaver.id, false], [staying.id, true]].toSorted())],
    [204, "DELETE", at(`/members/${leaver.id}`), { token: "users" }],
    [404, "DELETE", at(`/members/${missing}`), { token: "users" }],
    [200, "POST", at(`/members/${leaver.id}/reinstate`), { token: "users", key: "reinstate-lee" }, body => expect(body).toMatchObject({ membershipStatus: "active", effective: true, revokedAt: null, groups: [] })],
    [200, "POST", at(`/members/${leaver.id}/reinstate`), { token: "users", key: "reinstate-lee" }, receipt("applied", "member")],
    [200, "POST", at(`/members/${leaver.id}/reinstate`), { token: "users", key: "reinstate-lee-again" }],
    [200, "POST", at(`/members/${leaver.id}/reinstate`), { token: "users", key: "reinstate-lee-again" }, receipt("noop", "member")],
    [404, "POST", at(`/members/${missing}/reinstate`), { token: "users" }],
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

for (const method of ["client_secret_basic", "client_secret_post"] as const) {
  test(`${method} client creation and rotation show the secret once; retries return receipts without changing the active secret`, async () => {
    const id = createFakeId({ rootSecret: "root-secret" })
    const send = (verb: string, path: string, key: string, body?: unknown) => id.config.fetch(`https://id.test/api/admin/v1${path}`, {
      method: verb,
      headers: { Authorization: "Bearer root-secret", "Idempotency-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const registration = {
      clientId: "app", name: "App", organizationId: id.organizationId, tokenEndpointAuthMethod: method,
      grantTypes: ["authorization_code", "refresh_token"], scopes: ["openid", "profile", "email", "offline_access"], redirectUris: ["https://app.test/oauth/openid/callback"],
    }
    const created = await send("POST", "/clients", "create-app", registration)
    expect(created.status).toBe(201)
    const first = await created.json()
    expect(first).toMatchObject({ clientId: "app", tokenEndpointAuthMethod: method, hasClientSecret: true })
    expect(first.clientSecret).toMatch(/^secret-/)
    expect(id.clientOf("app")?.secret).toBe(first.clientSecret)

    const replayedCreation = await send("POST", "/clients", "create-app", registration)
    expect(replayedCreation.headers.get("Idempotency-Replayed")).toBe("true")
    const creationReceipt = await replayedCreation.json()
    expect(creationReceipt).toMatchObject({ outcome: "applied", resultReference: { type: "client", id: first.id } })
    expect(creationReceipt).not.toHaveProperty("clientSecret")
    expect(id.clientOf("app")?.secret).toBe(first.clientSecret)
    expect(await (await send("GET", "/clients/app", "read-app")).json()).not.toHaveProperty("clientSecret")

    const rotated = await send("POST", "/clients/app/rotate-secret", "rotate-app")
    expect(rotated.status).toBe(200)
    const replacement = await rotated.json()
    expect(replacement.clientId).toBe("app")
    expect(replacement.clientSecret).toMatch(/^rotated-/)
    expect(replacement.clientSecret).not.toBe(first.clientSecret)
    expect(id.clientOf("app")?.secret).toBe(replacement.clientSecret)

    const replayedRotation = await send("POST", "/clients/app/rotate-secret", "rotate-app")
    expect(replayedRotation.headers.get("Idempotency-Replayed")).toBe("true")
    const rotationReceipt = await replayedRotation.json()
    expect(rotationReceipt).toMatchObject({ outcome: "applied", resultReference: { type: "client", id: "app" } })
    expect(rotationReceipt).not.toHaveProperty("clientSecret")
    expect(id.clientOf("app")?.secret).toBe(replacement.clientSecret)
  })
}

test("public and private-key registrations have no shared secret to return or rotate", async () => {
  const id = createFakeId({ rootSecret: "root-secret" })
  for (const method of ["none", "private_key_jwt"] as const) {
    const send = (verb: string, path: string, body?: unknown) => id.config.fetch(`https://id.test/api/admin/v1${path}`, {
      method: verb,
      headers: { Authorization: "Bearer root-secret", "Idempotency-Key": crypto.randomUUID(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const created = await send("POST", "/clients", { clientId: method, name: method, tokenEndpointAuthMethod: method, grantTypes: ["authorization_code"], redirectUris: ["https://app.test/callback"] })
    expect(created.status).toBe(201)
    const registration = await created.json()
    expect(registration).toMatchObject({ tokenEndpointAuthMethod: method, hasClientSecret: false })
    expect(registration).not.toHaveProperty("clientSecret")
    const read = await send("GET", `/clients/${method}`)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ tokenEndpointAuthMethod: method, hasClientSecret: false })
    expect(id.clientOf(method)?.secret).toBeUndefined()
    const rotation = await send("POST", `/clients/${method}/rotate-secret`)
    expect(rotation.status).toBe(409)
    expect(await rotation.json()).toMatchObject({ code: "client_has_no_secret" })
    expect(id.clientOf(method)?.secret).toBeUndefined()
    expect((await send("POST", "/clients/missing/rotate-secret")).status).toBe(404)
  }
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

test("a user is one person with a membership in each organisation: disabling ends their sessions and every membership's access, enabling brings the status back and not the sessions, and a retired address finds nobody", async () => {
  const id = createFakeId({ rootSecret: "root-secret" })
  const send = (method: string, path: string) => id.config.fetch(`https://id.test/api/admin/v1${path}`, {
    method, headers: { Authorization: "Bearer root-secret", ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }) },
  })
  const [alpha, beta] = ["alpha", "beta"].map(slug => id.organisation(Bun.randomUUIDv7(), { slug, name: slug }).id) as [string, string]
  const inAlpha = id.member(alpha, { email: "lee@firm.example", name: "Lee" })
  const inBeta = id.member(beta, { email: "lee@firm.example", name: "Lee", userId: inAlpha.userId })
  const person = String(inAlpha.userId)
  id.userOf(person)!.sessionCount = 3
  for (const [firm, member] of [[alpha, inAlpha], [beta, inBeta]] as const) id.grant(firm, member.id, [{ kind: "resource", id: "https://mcp.test", scopes: ["x"] }])
  const detail = async () => (await send("GET", `/users/${person}`)).json() as Promise<{ status: string; sessionCount: number; memberships: { slug: string }[] }>
  expect(await detail()).toMatchObject({ status: "active", sessionCount: 3, memberships: expect.arrayContaining([expect.objectContaining({ slug: "alpha" }), expect.objectContaining({ slug: "beta" })]) })
  await send("POST", `/users/${person}/disable`)
  expect(await detail()).toMatchObject({ status: "disabled", sessionCount: 0 })
  expect([inAlpha.status, inBeta.status]).toEqual(["disabled", "disabled"])
  for (const [firm, member] of [[alpha, inAlpha], [beta, inBeta]] as const) expect((await send("GET", `/organizations/${firm}/members/${member.id}/access`)).status).toBe(404)
  await send("POST", `/users/${person}/enable`)
  expect(await detail()).toMatchObject({ status: "active", sessionCount: 0 })
  expect([inAlpha.status, inBeta.status]).toEqual(["active", "active"])
  // A user with no membership, as ID can hold one.
  const alone = id.user({ email: "alone@firm.example", status: "disabled" })
  expect(await (await send("GET", `/users/${alone.id}`)).json()).toMatchObject({ status: "disabled", disabledAt: expect.any(String), memberships: [], sessionCount: 0 })
  await send("POST", `/users/${person}/disable`)
  await send("POST", `/users/${person}/retire-email`)
  expect(await (await send("GET", "/users?email=lee@firm.example")).json()).toMatchObject({ items: [] })
  expect(id.userOf(person)).toMatchObject({ retiredEmail: "lee@firm.example", email: `${person}@retired.invalid` })
  expect([inAlpha.email, inBeta.email]).toEqual([`${person}@retired.invalid`, `${person}@retired.invalid`])
})

test("ID answers its liveness check, and a fake that is down answers it 503", async () => {
  const id = createFakeId()
  expect(await (await id.config.fetch("https://id.test/healthz")).json()).toEqual({ status: "ok" })
  id.outage(true)
  expect((await id.config.fetch("https://id.test/healthz")).status).toBe(503)
})

test("an import's preview needs platform:read, as ID's does: a token without it is refused", async () => {
  const id = createFakeId({ resources: { [admin]: ["platform:users"] } })
  const organisation = id.organisation(Bun.randomUUIDv7(), { name: "Newco" })
  const issued = await id.config.fetch("https://id.test/auth/oauth2/token", {
    method: "POST", headers: { Authorization: `Basic ${btoa("toolbox-hub:hub-secret")}` }, body: new URLSearchParams({ grant_type: "client_credentials", resource: admin, scope: "platform:users" }),
  })
  const { access_token: token } = await issued.json() as { access_token: string }
  const answer = await id.config.fetch(`https://id.test/api/admin/v1/organizations/${organisation.id}/members/import/preview`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ addresses: ["a@b.example"] }),
  })
  expect(answer.status).toBe(403)
  expect(await answer.json()).toMatchObject({ code: "insufficient_scope" })
})
