// Answerable ID's token endpoint and the admin routes its consumers call, in memory, for tests. Shapes follow apps/id/openapi.admin.json.
type Via = { entitlementId: string; principal: "organization" | "group" | "member"; groupId: string | null }
type Target = { kind: "client" | "resource" | "client_resource"; id: string; resource?: string; scopes: string[]; via?: Via[] }
type Row = Record<string, unknown> & { id: string; scopes: string[] }
type Resource = Record<string, unknown> & { id: string; revision: number; name: string; allowedScopes: string[]; clients: string[] }
type Stored = Record<string, unknown> & { id: string }
// What a command answered, kept under its Idempotency-Key as ID keeps its operation journal.
type Operation = { fingerprint: string; id: string; status: number; outcome: "applied" | "noop"; reference: { type: string; id: string } }

const issuer = "https://id.test"
const adminResource = `${issuer}/api/admin`
// ID's problem document (apps/id/src/http/problem.ts): `extra` adds fields such as `detail` and `retryable`, `headers` the response's own.
const problem = (status: number, code: string, title: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ type: "about:blank", title, status, code, request_id: "test", ...extra }, { status, headers: { "Content-Type": "application/problem+json", ...headers } })
const notFound = () => problem(404, "not_found", "Not found")
const invalidToken = () => problem(401, "invalid_token", "Invalid token", {}, { "WWW-Authenticate": 'Bearer error="invalid_token"' })
// What the fake answers for a method it does not implement on a route, where ID may implement it: never another command in its place.
const unsupported = (request: Request, ...methods: string[]) => methods.includes(request.method)
  ? undefined
  : problem(405, "method_not_allowed", `The fake ID does not implement ${request.method} here`, {}, { Allow: methods.join(", ") })
// The resource an operation's receipt names (apps/id/src/http/admin/*.ts): its type, and the id of the row or of its owner.
const references: [RegExp, string][] = [
  [/^\/organizations\/[^/]+\/domains/, "domain"], [/^\/organizations\/[^/]+\/sso-provider/, "sso_provider"], [/^\/organizations\/[^/]+\/groups/, "group"],
  [/^\/organizations\/[^/]+\/entitlements/, "entitlement"], [/^\/organizations\/[^/]+\/capabilities/, "capability"], [/^\/organizations/, "organization"],
  [/^\/resources\//, "resource"], [/^\/clients\//, "client"],
]
function referenceOf(path: string, body: Record<string, unknown> | null) {
  const type = references.find(([pattern]) => pattern.test(path))![1]
  const owner = /^\/organizations\/[^/]+\/groups\/([^/]+)\/members\//.exec(path)?.[1] ?? /^\/(?:resources|clients)\/([^/]+)/.exec(path)?.[1]
  return { type, id: owner ? decodeURIComponent(owner) : String(body?.id) }
}
// Wait as a slow ID would, and give up as fetch does when the caller's signal aborts.
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}
const now = () => new Date().toISOString()
const etag = ({ id, revision }: Stored) => `"${id}:${revision}"`
const tagged = (row: Stored, status = 200) => Response.json(row, { status, headers: { ETag: etag(row) } })
const contains = (value: unknown, text: string) => String(value).toLowerCase().includes(text.toLowerCase())
const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/
const host = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const invalid = (title: string) => problem(400, "validation_failed", title)
// The issuers ID signs in through Answerable's own Google or Microsoft application (services/federation.ts classifyIssuer).
const platformIssuer = (value: unknown) => value === "https://accounts.google.com" || /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(String(value))

/**
 * Answerable ID in memory, for the tests of a server that calls its admin API: `config` goes to `createIdAdmin`, the rest sets up what ID holds and
 * reads back what it received. The machine client is `clientId`, owned by the organisation `organizationId` (a fresh id), which is the platform
 * organisation unless `platform` is false; `resources` maps each audience its token endpoint issues for to the scopes it may carry. With
 * `operationInProgress`, a write whose method, path and Idempotency-Key a running write holds answers `409 operation_in_progress`, as ID does;
 * without it, the second write runs after the first. A method the fake does not implement on a route answers `405`.
 */
export function createFakeId({
  expiresIn = 3600, pageSize = 200, clientId = "toolbox-hub", clientSecret = "hub-secret", platform = true, operationInProgress = false,
  resources: audiences = { [adminResource]: ["platform:read", "platform:read platform:write"] } as Record<string, readonly string[]>,
} = {}) {
  const organizationId = crypto.randomUUID()
  const access = new Map<string, Target[]>()
  const events: Stored[] = []
  const requests: string[] = []
  // The scope and audience each token was issued with, and the scopes each token request asked for.
  const tokens = new Map<string, { scope: string; resource: string }>()
  const asked: string[] = []
  const received: { request: string; requestId: string | null; idempotencyKey: string | null; ifMatch: string | null; ifNoneMatch: string | null }[] = []
  const resources = new Map<string, Resource>()
  const clients = new Map<string, Stored>()
  const organisations = new Map<string, Stored>()
  const capabilities = new Map<string, Row[]>()
  const entitlements = new Map<string, Row[]>()
  // Per organisation: its domains, members and groups; per organisation, its SSO provider; per group, its assignments by member id.
  const domains = new Map<string, Stored[]>()
  const members = new Map<string, Stored[]>()
  const groups = new Map<string, Stored[]>()
  const providers = new Map<string, Stored>()
  const joined = new Map<string, Map<string, Stored>>()
  const journal = new Map<string, Operation>()
  // The commands running now, by method, path and key; and how many changes ID has made, so that a command knows whether it changed anything.
  const running = new Set<string>()
  let changes = 0
  let issued = 0
  let down = false
  let gone = false
  let latency = 0
  let failing: { remaining: number; status: number } | undefined
  const rows = <T>(table: Map<string, T[]>, organisation: string) => table.get(organisation) ?? table.set(organisation, []).get(organisation)!
  const assignments = (groupId: string) => joined.get(groupId) ?? joined.set(groupId, new Map()).get(groupId)!
  // ID's lists: newest id first, 50 by default and at most `pageSize`, the cursor the last key of the page before.
  function newest<T extends Record<string, unknown>>(items: T[], url: URL, key = "id") {
    const size = Math.min(Number(url.searchParams.get("limit") ?? 50), pageSize)
    const cursor = url.searchParams.get("cursor")
    const rest = items.toSorted((a, b) => (a[key]! < b[key]! ? 1 : -1)).filter(row => !cursor || String(row[key]) < cursor)
    const shown = rest.slice(0, size)
    return Response.json({ items: shown, nextCursor: rest.length > size ? shown.at(-1)![key] : null })
  }
  // The rows whose fields equal every filter the query names.
  const matching = <T extends Record<string, unknown>>(items: T[], url: URL, fields: string[]) =>
    items.filter(row => fields.every(field => !url.searchParams.has(field) || String(row[field]) === url.searchParams.get(field)))
  function outsideVocabulary(resource: unknown, scopes: string[]) {
    return typeof resource === "string" && scopes.some(scope => !resources.get(resource)?.allowedScopes.includes(scope))
  }
  // ID's revision preconditions (http/admin/revision.ts): If-Match names the revision a write expects, If-None-Match: * that nothing exists yet.
  function precondition(request: Request, current: Stored | undefined, put = false) {
    const ifMatch = request.headers.get("If-Match")
    const ifNoneMatch = request.headers.get("If-None-Match")
    if (put && ifNoneMatch !== null && (ifNoneMatch !== "*" || ifMatch !== null)) return problem(400, "invalid_revision", "Supply exactly one supported precondition")
    if (ifMatch !== null && !/^"[0-9a-f-]{36}:[1-9][0-9]*"$/.test(ifMatch)) return problem(400, "invalid_revision", "Supply one strong revision ETag in If-Match")
    if ((put && ifNoneMatch === "*" && current) || (ifMatch !== null && (!current || ifMatch !== etag(current)))) {
      return problem(412, "revision_mismatch", "Configuration changed; read its current revision before issuing a new command")
    }
  }
  // Change a row's fields as a command does: a real change advances its revision.
  function change(row: Stored, fields: Record<string, unknown>) {
    const changed = Object.entries(fields).some(([key, value]) => JSON.stringify(row[key]) !== JSON.stringify(value))
    if (changed) {
      Object.assign(row, fields, { revision: Number(row.revision) + 1, updatedAt: now() })
      changes++
    }
    return changed
  }
  // What ID's SSO connectivity test answers for a provider: it refuses an issuer over plain HTTP, as it refuses loopback HTTP issuers.
  function ssoTest({ issuer: providerIssuer }: Stored) {
    const insecure = String(providerIssuer).startsWith("http://")
    const kind = String(providerIssuer).startsWith("https://login.microsoftonline.com/") ? "entra" : providerIssuer === "https://accounts.google.com" ? "google" : "oidc"
    return {
      issuer: providerIssuer, kind,
      discovery: {
        url: `${providerIssuer}/.well-known/openid-configuration`, reachable: !insecure, status: insecure ? null : 200, issuerMatches: insecure ? null : true,
        authorizationEndpoint: insecure ? null : `${providerIssuer}/authorize`, tokenEndpoint: insecure ? null : `${providerIssuer}/token`, jwksUri: insecure ? null : `${providerIssuer}/keys`,
      },
      jwks: { reachable: !insecure, keys: insecure ? null : 1 },
      elapsedMs: 12,
      problems: insecure ? [{ code: "insecure_issuer", detail: "The issuer must use HTTPS" }] : [],
    }
  }
  function groupRoute(request: Request, organisation: string, groupId: string, rest: string, body: Record<string, unknown>) {
    const group = rows(groups, organisation).find(row => row.id === groupId)
    if (!group) return notFound()
    if (rest === "") return unsupported(request, "GET") ?? tagged(group)
    const member = /^\/members\/([^/]+)$/.exec(rest)
    if (!member) return
    const memberId = member[1]!
    const current = assignments(groupId).get(memberId)
    const refusedMethod = unsupported(request, "GET", "PUT", "DELETE")
    if (refusedMethod) return refusedMethod
    if (request.method === "GET") return current ? tagged(current) : notFound()
    const person = rows(members, organisation).find(row => row.id === memberId)
    if (!person) return notFound()
    if (group.externalId !== null) return problem(409, "group_directory_managed", "Directory group membership cannot be edited by hand")
    if (request.method === "DELETE") {
      if (!current) return notFound()
      assignments(groupId).delete(memberId)
      changes++
      return new Response(null, { status: 204 })
    }
    if (person.membershipStatus === "revoked") return problem(409, "membership_revoked", "Reinstate the membership before assigning access")
    const refused = precondition(request, current, true)
    if (refused) return refused
    const window = { ...("validFrom" in body ? { validFrom: body.validFrom } : {}), ...("validUntil" in body ? { validUntil: body.validUntil } : {}) }
    if (current) {
      change(current, window)
      return tagged(current)
    }
    const row = { id: Bun.randomUUIDv7(), revision: 1, organizationId: organisation, groupId, memberId, validFrom: null, validUntil: null, createdAt: now(), ...window }
    assignments(groupId).set(memberId, row)
    changes++
    return tagged(row, 201)
  }
  function organisationRoute(request: Request, url: URL, organisation: string, rest: string, body: Record<string, unknown>) {
    const row = organisations.get(organisation)!
    if (rest === "") {
      const refusedMethod = unsupported(request, "GET", "PATCH")
      if (refusedMethod) return refusedMethod
      if (request.method === "GET") return tagged(row)
      const refused = precondition(request, row)
      if (refused) return refused
      change(row, body)
      return tagged(row)
    }
    if (rest === "/disable" || rest === "/enable") {
      const refusedMethod = unsupported(request, "POST")
      if (refusedMethod) return refusedMethod
      const status = rest === "/disable" ? "disabled" : "active"
      if (row.status !== status) {
        Object.assign(row, { status, disabledAt: status === "disabled" ? now() : null, revision: Number(row.revision) + 1, updatedAt: now() })
        if (status === "disabled") row.authorizationVersion = Number(row.authorizationVersion) + 1
        changes++
      }
      return Response.json(row)
    }
    if (rest === "/domains") {
      const refusedMethod = unsupported(request, "GET", "POST")
      if (refusedMethod) return refusedMethod
      if (request.method === "GET") return newest(matching(rows(domains, organisation), url, ["status"]), url)
      const domain = String(body.domain).trim().toLowerCase()
      if (!host.test(domain)) return invalid("The request is invalid")
      if ([...domains.values()].flat().some(existing => existing.domain === domain)) return problem(409, "conflict", "Conflict")
      const created = { id: Bun.randomUUIDv7(), organizationId: organisation, domain, status: "active", createdAt: now(), updatedAt: now() }
      rows(domains, organisation).push(created)
      changes++
      return Response.json(created, { status: 201 })
    }
    if (rest === "/sso-provider" || rest === "/sso-provider/test") {
      const refusedMethod = rest === "/sso-provider" ? unsupported(request, "GET", "PUT") : unsupported(request, "GET")
      if (refusedMethod) return refusedMethod
      const provider = providers.get(organisation)
      if (request.method === "PUT") {
        const oidc = (body.oidc ?? { credentials: "platform" }) as Record<string, unknown>
        if (oidc.credentials === "platform" && !platformIssuer(body.issuer)) {
          return problem(400, "platform_credentials_unsupported", "Platform credentials require a Google Workspace or Microsoft Entra issuer")
        }
        const refused = precondition(request, provider, true)
        if (refused) return refused
        const fields = { issuer: body.issuer, domain: String(body.domain).toLowerCase(), oidc: { credentials: oidc.credentials ?? "own", hasClientSecret: oidc.clientSecret !== undefined } }
        if (provider) {
          change(provider, fields)
          return tagged(provider)
        }
        const created = { id: Bun.randomUUIDv7(), revision: 1, organizationId: organisation, providerId: row.slug, createdAt: now(), updatedAt: now(), ...fields }
        providers.set(organisation, created)
        changes++
        return tagged(created, 201)
      }
      if (!provider) return notFound()
      return rest === "/sso-provider" ? tagged(provider) : Response.json(ssoTest(provider))
    }
    if (rest === "/members") {
      const refusedMethod = unsupported(request, "GET")
      if (refusedMethod) return refusedMethod
      const q = url.searchParams.get("q")
      const email = url.searchParams.get("email")
      return newest(matching(rows(members, organisation), url, ["effective"])
        .filter(member => (!q || contains(member.email, q) || contains(member.name, q)) && (!email || member.email === email.toLowerCase())), url)
    }
    const member = /^\/members\/([^/]+)$/.exec(rest)
    if (member) {
      const refusedMethod = unsupported(request, "GET")
      if (refusedMethod) return refusedMethod
      const found = rows(members, organisation).find(row => row.id === member[1])
      if (!found) return notFound()
      const held = rows(groups, organisation).flatMap(group => {
        const assignment = assignments(group.id).get(found.id)
        return assignment ? [{ groupId: group.id, slug: group.slug, name: group.name, validFrom: assignment.validFrom, validUntil: assignment.validUntil }] : []
      })
      return Response.json({ ...found, groups: held })
    }
    if (rest === "/access") {
      const refusedMethod = unsupported(request, "GET")
      if (refusedMethod) return refusedMethod
      const resource = url.searchParams.get("resource")
      const client = url.searchParams.get("clientId")
      if (!resource && !client) return problem(400, "validation_failed", "A client, resource or exact pair is required")
      const kind = !client ? "resource" : resource ? "client_resource" : "client"
      const fits = (target: Target) => target.kind === kind && target.id === (client ?? resource) && (kind !== "client_resource" || target.resource === resource)
      const items = rows(members, organisation).filter(row => row.effective).flatMap(row => {
        const target = access.get(`${organisation}/${row.id}`)?.find(fits)
        return target ? [{ memberId: row.id, userId: row.userId, email: row.email, name: row.name, scopes: target.scopes, permission: { allowed: false, reason: "scope" } }] : []
      })
      return newest(items, url, "memberId")
    }
    if (rest === "/groups") {
      const refusedMethod = unsupported(request, "GET", "POST")
      if (refusedMethod) return refusedMethod
      if (request.method === "GET") {
        const q = url.searchParams.get("q")
        return newest(matching(rows(groups, organisation), url, ["status"]).filter(group => !q || contains(group.name, q) || contains(group.slug, q)), url)
      }
      if (!slug.test(String(body.slug)) || typeof body.name !== "string" || !body.name) return invalid("The request is invalid")
      if (rows(groups, organisation).some(group => group.slug === body.slug)) return problem(409, "conflict", "Conflict")
      const created = { id: Bun.randomUUIDv7(), revision: 1, organizationId: organisation, slug: body.slug, name: body.name, externalId: body.externalId ?? null, status: "active", createdAt: now(), updatedAt: now() }
      rows(groups, organisation).push(created)
      changes++
      return Response.json(created, { status: 201 })
    }
    const group = /^\/groups\/([^/]+)(\/.*)?$/.exec(rest)
    if (group) return groupRoute(request, organisation, group[1]!, group[2] ?? "", body)
    const entitlement = /^\/entitlements\/([^/]+)(\/disable|\/enable)?$/.exec(rest)
    if (entitlement) {
      const refusedMethod = entitlement[2] ? unsupported(request, "POST") : unsupported(request, "GET")
      if (refusedMethod) return refusedMethod
      const found = rows(entitlements, organisation).find(item => item.id === entitlement[1])
      if (!found) return notFound()
      if (!entitlement[2]) return tagged(found)
      change(found, { status: entitlement[2] === "/disable" ? "disabled" : "active" })
      return Response.json(found)
    }
  }
  async function admin(request: Request, url: URL, path: string) {
    const token = tokens.get(request.headers.get("Authorization")!.slice(7))!
    if (token.resource !== adminResource) return invalidToken()
    const write = request.method !== "GET"
    if (write && !token.scope.includes("platform:write")) return problem(403, "forbidden", "The principal is not allowed")
    const body = write && request.headers.get("Content-Type") ? await request.json() as Record<string, unknown> : {}
    if (path === "/me") {
      return unsupported(request, "GET") ?? Response.json({
        principal: { type: "client", clientId, organizationId },
        grants: [{ organizationId, organizationSlug: organisations.get(organizationId)!.slug, isPlatform: platform, scopes: token.scope.split(" ") }],
      })
    }
    if (!write) return route(request, url, path, body)
    // A write is a command: it needs an Idempotency-Key, and the same key with the same input answers what the first call answered.
    const key = request.headers.get("Idempotency-Key")
    if (!key) return problem(400, "invalid_idempotency_key", "A 1–256 character Idempotency-Key is required")
    if (failing && --failing.remaining === 0) {
      const { status } = failing
      failing = undefined
      return problem(status, "database_busy", "Database is busy", { detail: "Retry with the same idempotency key and input." }, { "Retry-After": "1" })
    }
    const name = `${request.method} ${path} ${key}`
    const fingerprint = JSON.stringify([body, request.headers.get("If-Match"), request.headers.get("If-None-Match")])
    const done = journal.get(name)
    if (done && done.fingerprint !== fingerprint) return problem(409, "idempotency_key_reused", "Idempotency key was used for different input", { retryable: false })
    if (done) {
      const headers = { "Operation-Id": done.id, "Idempotency-Replayed": "true" }
      const receipt = { operationId: done.id, outcome: done.outcome, statusCode: done.status, resultReference: done.reference }
      return done.status === 204 ? new Response(null, { status: 204, headers }) : Response.json(receipt, { status: done.status, headers })
    }
    const before = changes
    const response = (await route(request, url, path, body))!
    if (!response.ok) return response
    const id = Bun.randomUUIDv7()
    const reference = referenceOf(path, response.status === 204 ? null : await response.clone().json())
    journal.set(name, { fingerprint, id, status: response.status, outcome: changes > before ? "applied" : "noop", reference })
    response.headers.set("Operation-Id", id)
    response.headers.set("Idempotency-Replayed", "false")
    return response
  }
  async function route(request: Request, url: URL, path: string, body: Record<string, unknown>) {
    const resource = /^\/resources\/([^/]+)$/.exec(path)
    if (resource) {
      const refusedMethod = unsupported(request, "GET", "PATCH")
      if (refusedMethod) return refusedMethod
      const found = resources.get(decodeURIComponent(resource[1]!))
      if (!found) return problem(404, "not_found", "Resource not found")
      const shown = () => Response.json({ identifier: decodeURIComponent(resource[1]!), ...found }, { headers: { ETag: etag(found) } })
      if (request.method === "GET") return shown()
      const ifMatch = request.headers.get("If-Match")
      if (ifMatch && ifMatch !== etag(found)) return problem(412, "revision_mismatch", "Configuration revision does not match")
      const allowedScopes = [...new Set(body.allowedScopes as string[])].sort()
      if (JSON.stringify(allowedScopes) !== JSON.stringify(found.allowedScopes)) {
        found.allowedScopes = allowedScopes
        found.revision++
        changes++
      }
      return shown()
    }
    const client = /^\/clients\/([^/]+)$/.exec(path)
    if (client) {
      const found = clients.get(decodeURIComponent(client[1]!))
      const linked = [...resources].filter(([, row]) => row.clients.includes(String(found?.clientId))).map(([identifier]) => identifier)
      return unsupported(request, "GET") ?? (found ? tagged({ ...found, resources: linked }) : notFound())
    }
    const link = /^\/clients\/([^/]+)\/resources\/([^/]+)$/.exec(path)
    if (link) {
      const refusedMethod = unsupported(request, "PUT")
      if (refusedMethod) return refusedMethod
      const found = resources.get(decodeURIComponent(link[2]!))
      if (!clients.has(link[1]!) || !found) return problem(404, "not_found", "Client or resource not found")
      const created = !found.clients.includes(link[1]!)
      if (created) {
        found.clients.push(link[1]!)
        changes++
      }
      return Response.json({ created }, { status: created ? 201 : 200 })
    }
    if (path === "/organizations") {
      const refusedMethod = unsupported(request, "GET", "POST")
      if (refusedMethod) return refusedMethod
      if (request.method === "GET") {
        const q = url.searchParams.get("q")
        return newest(matching([...organisations.values()], url, ["status"]).filter(row => !q || contains(row.name, q) || contains(row.slug, q)), url)
      }
      if (!slug.test(String(body.slug)) || typeof body.name !== "string" || !body.name || body.name.length > 200) return invalid("The request is invalid")
      if ([...organisations.values()].some(row => row.slug === body.slug)) return problem(409, "conflict", "Conflict")
      changes++
      return Response.json(organisation(Bun.randomUUIDv7(), { slug: body.slug, name: body.name, logo: body.logo ?? null, metadata: body.metadata ?? null }), { status: 201 })
    }
    const organisationTable = /^\/organizations\/([^/]+)\/(capabilities|entitlements)$/.exec(path)
    if (organisationTable) {
      const refusedMethod = unsupported(request, "GET", "POST")
      if (refusedMethod) return refusedMethod
      if (!organisations.has(organisationTable[1]!)) return problem(404, "not_found", "Organisation not found")
      const table = organisationTable[2] === "capabilities" ? capabilities : entitlements
      const held = rows(table, organisationTable[1]!)
      if (request.method === "GET") return newest(matching(held, url, ["clientId", "resource", "memberId", "groupId", "status"]), url)
      const scopes = body.scopes as string[]
      const key = (row: Record<string, unknown>) => ["clientId", "resource", "grantKind", "memberId", "groupId"].map(field => row[field] ?? null).join("|")
      if (outsideVocabulary(body.resource, scopes)) return problem(400, "validation_failed", "Capability scopes exceed the client/resource ceiling or mix login and resource scopes")
      // One row per principal and target (entitlements_principal_target_unique), whatever its scopes or status.
      if (held.some(row => key(row) === key(body))) return problem(409, "conflict", "A row already exists")
      const row = {
        id: Bun.randomUUIDv7(), revision: 1, organizationId: organisationTable[1], memberId: null, groupId: null, clientId: null, resource: null, status: "active",
        validFrom: null, validUntil: null, createdAt: now(), updatedAt: now(), ...body, scopes,
      } as Row
      held.push(row)
      changes++
      return Response.json(row, { status: 201 })
    }
    const member = /^\/organizations\/([^/]+)\/members\/([^/]+)\/access$/.exec(path)
    if (member) {
      const targets = access.get(`${member[1]}/${member[2]}`)
      return unsupported(request, "GET") ?? (targets ? Response.json({ effective: true, targets: targets.map(target => ({ ...target, permission: { allowed: false, reason: "scope" }, via: target.via ?? [] })) }) : notFound())
    }
    const within = /^\/organizations\/([^/]+)(\/.*)?$/.exec(path)
    if (within) return organisations.has(within[1]!) ? organisationRoute(request, url, within[1]!, within[2] ?? "", body) ?? notFound() : notFound()
    if (path === "/audit-events") {
      const from = url.searchParams.get("from")
      const to = url.searchParams.get("to")
      return unsupported(request, "GET") ?? newest(matching(events, url, ["organizationId", "operationId", "actorId", "action", "outcome", "targetType", "targetId"])
        .filter(event => (!from || String(event.occurredAt) >= from) && (!to || String(event.occurredAt) < to)), url)
    }
    return notFound()
  }
  async function fetch(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}${url.search}`)
    const key = request.headers.get("Idempotency-Key")
    // A write that arrives while another with its method, path and key runs: decided on arrival, answered after the fake's latency.
    const command = request.method !== "GET" && key !== null && url.pathname.startsWith("/api/admin/v1") ? `${request.method} ${url.pathname} ${key}` : undefined
    const busy = operationInProgress && command !== undefined && running.has(command)
    if (command && !busy) running.add(command)
    try {
      if (latency) await wait(latency, request.signal)
      if (gone) throw new TypeError("Unable to connect")
      if (url.pathname.startsWith("/api/admin/v1")) {
        const header = (name: string) => request.headers.get(name)
        received.push({ request: `${request.method} ${url.pathname}${url.search}`, requestId: header("x-request-id"), idempotencyKey: key, ifMatch: header("If-Match"), ifNoneMatch: header("If-None-Match") })
      }
      if (down) return new Response("Unavailable", { status: 503 })
      if (busy) return problem(409, "operation_in_progress", "Operation is in progress", { detail: "Retry with the same key and input.", retryable: true })
      if (request.method === "POST" && url.pathname === "/auth/oauth2/token") {
        const form = new URLSearchParams(await request.text())
        const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
        if (request.headers.get("Authorization") !== basic) return Response.json({ error: "invalid_client" }, { status: 401 })
        const scope = form.get("scope")!
        const resource = form.get("resource")!
        if (form.get("grant_type") !== "client_credentials" || !audiences[resource]?.includes(scope)) return Response.json({ error: "invalid_request" }, { status: 400 })
        asked.push(scope)
        tokens.set(`machine-${++issued}`, { scope, resource })
        return Response.json({ access_token: `machine-${issued}`, token_type: "Bearer", expires_in: expiresIn })
      }
      if (!tokens.has(request.headers.get("Authorization")?.slice(7) ?? "")) return invalidToken()
      const path = url.pathname.replace(/^\/api\/admin\/v1/, "")
      return path === url.pathname ? notFound() : admin(request, url, path)
    } finally {
      if (command && !busy) running.delete(command)
    }
  }
  // Store a row and return it, so that a test can change it as ID would.
  function add<T extends Stored>(table: Map<string, Stored[]>, organisation: string, row: T) {
    rows(table, organisation).push(row)
    return row
  }
  const organisation = (id: string, fields: Record<string, unknown> = {}) => {
    const row = { id, revision: 1, name: "Organisation", slug: `org-${id.slice(0, 8)}`, logo: null, metadata: null, status: "active", authorizationVersion: 1, disabledAt: null, createdAt: now(), updatedAt: now(), ...organisations.get(id), ...fields }
    organisations.set(id, row)
    return row
  }
  organisation(organizationId, platform ? { name: "Answerable", slug: "answerable" } : {})
  return {
    config: { issuer, adminResource, clientId, clientSecret, fetch },
    /** The machine client's organisation: the platform organisation unless `platform` was false. */
    organizationId,
    /** Every request, as `METHOD /path?query`. */
    requests,
    /** The `scope` of each token request, in order. */
    scopesAsked: asked,
    /**
     * Every request to the admin API, in order, with the `x-request-id`, `Idempotency-Key`, `If-Match` and `If-None-Match` it carried (`null` when it
     * carried none); the ones refused with `401` too.
     */
    received,
    /** The audience and scope a token was issued with, or undefined when this ID never issued it: how a fake of another service checks a bearer. */
    issued: (token: string) => tokens.get(token),
    /** Set the targets of a member's access view; a target's `via` defaults to none. */
    grant(organizationId: string, memberId: string, targets: Target[]) { access.set(`${organizationId}/${memberId}`, targets) },
    /** Append an audit event, newer than every one before it, with ID's fields: an action of the machine client on an entitlement unless `fields` say otherwise. */
    event(action: string, organizationId: string | null, fields: Record<string, unknown> = {}) {
      const event = {
        operationId: null, schemaVersion: 1, id: Bun.randomUUIDv7(), occurredAt: now(), actorType: "client", actorId: clientId, organizationId, action,
        targetType: "entitlement", targetId: null, outcome: "success", reason: null, requestId: null, ip: null, userAgent: null, data: null, ...fields,
      }
      events.push(event)
      return event
    },
    outage(value: boolean) { down = value },
    /** Make every request fail without an answer, as a refused connection does. */
    unreachable(value: boolean) { gone = value },
    slow(ms: number) { latency = ms },
    /** Revoke every token issued so far. */
    revoke() { tokens.clear() },
    /** Register a resource with the scopes it allows, named after its identifier, as staff do; its linked clients and revision are read back. */
    resource(identifier: string, allowedScopes: string[]) {
      resources.set(identifier, {
        classification: "platform_shared", organizationId: null, id: crypto.randomUUID(), name: identifier, accessTokenTtl: null, refreshTokenTtl: null,
        signingAlgorithm: null, signingKeyId: null, allowedScopes, customClaims: null, dpopBoundAccessTokensRequired: false, disabled: false, revision: 1,
        policyVersion: 1, metadata: null, createdAt: now(), updatedAt: now(), clients: [],
      })
    },
    /** What ID holds for a resource. */
    resourceOf: (identifier: string) => resources.get(identifier)!,
    /** Register a client, as staff do. */
    client(clientId: string) {
      const unset = Object.fromEntries([
        "userId", "organizationId", "metadata", "clientDiscoveryId", "referenceId", "uri", "icon", "tos", "policy", "softwareId", "softwareVersion", "softwareStatement",
        "backchannelLogoutUri", "tokenEndpointAuthMethod", "applicationType", "jwks", "jwksUri", "subjectType", "contacts", "postLogoutRedirectUris", "grantTypes",
        "responseTypes", "scopes", "clientCredentialsScopes", "backchannelLogoutSessionRequired", "requirePKCE", "skipConsent", "enableEndSession",
      ].map(field => [field, null]))
      clients.set(clientId, {
        ...unset, id: crypto.randomUUID(), clientId, name: clientId, revision: 1, authorizationVersion: 1, hasClientSecret: true, redirectUris: [],
        dpopBoundAccessTokens: false, disabled: false, createdAt: now(), updatedAt: now(),
      })
    },
    /** Create an organisation, or change the fields of one, and return its row. */
    organisation,
    /** The organisation's capability and entitlement rows, in the order created; push a row to seed one. */
    capabilities: (organizationId: string) => rows(capabilities, organizationId),
    entitlements: (organizationId: string) => rows(entitlements, organizationId),
    /** Add an organisation-wide entitlement, or one of `memberId` or `groupId` when `fields` name it, and return its row. */
    entitlement: (organizationId: string, fields: Record<string, unknown> & { scopes: string[] }) => add(entitlements, organizationId, {
      id: Bun.randomUUIDv7(), revision: 1, organizationId, memberId: null, groupId: null, clientId: null, resource: null, status: "active",
      validFrom: null, validUntil: null, createdAt: now(), updatedAt: now(), ...fields,
    }) as Row,
    /** Add a domain to an organisation and return its row. */
    domain: (organizationId: string, domain: string, fields: Record<string, unknown> = {}) => add(domains, organizationId, {
      id: Bun.randomUUIDv7(), organizationId, domain, status: "active", createdAt: now(), updatedAt: now(), ...fields,
    }),
    /** Set an organisation's SSO provider, signing in with Answerable's platform application unless `fields` say otherwise, and return its row. */
    ssoProvider(organizationId: string, fields: Record<string, unknown> & { issuer: string; domain: string }) {
      const row = { id: Bun.randomUUIDv7(), revision: 1, organizationId, providerId: `sso-${organizationId}`, oidc: { credentials: "platform", hasClientSecret: false }, createdAt: now(), updatedAt: now(), ...fields }
      providers.set(organizationId, row)
      return row
    },
    /** Add a member, a person who signed in, to an organisation and return its row. */
    member: (organizationId: string, fields: Record<string, unknown> = {}) => add(members, organizationId, {
      id: Bun.randomUUIDv7(), revision: 1, organizationId, userId: crypto.randomUUID(), email: "person@example.test", name: "A person", status: "active",
      membershipStatus: "active", revokedAt: null, validFrom: null, validUntil: null, createdAt: now(), effective: true, ...fields,
    }),
    /** Add a group to an organisation and return its row. */
    group: (organizationId: string, fields: Record<string, unknown> & { slug: string }) => add(groups, organizationId, {
      id: Bun.randomUUIDv7(), revision: 1, organizationId, name: fields.slug, externalId: null, status: "active", createdAt: now(), updatedAt: now(), ...fields,
    }),
    /** Put a member in a group and return the assignment, which carries its own revision. */
    join(groupId: string, memberId: string, fields: Record<string, unknown> = {}) {
      const group = [...groups.values()].flat().find(row => row.id === groupId)
      const row = { id: Bun.randomUUIDv7(), revision: 1, organizationId: group?.organizationId ?? null, groupId, memberId, validFrom: null, validUntil: null, createdAt: now(), ...fields }
      assignments(groupId).set(memberId, row)
      return row
    },
    /** Whether a member is in a group now. */
    joined: (groupId: string, memberId: string) => assignments(groupId).has(memberId),
    /** Advance the revision of the row with this id, or of the resource with this identifier, as another writer's change would. */
    revise(id: string) {
      const stored = [
        ...organisations.values(), ...providers.values(), ...[...groups.values(), ...entitlements.values(), ...capabilities.values()].flat(),
        ...[...joined.values()].flatMap(table => [...table.values()]),
      ]
      const row = stored.find(item => item.id === id) ?? resources.get(id) ?? [...resources.values()].find(item => item.id === id)
      if (!row) throw new Error(`The fake ID holds no row ${id}`)
      row.revision = Number(row.revision) + 1
    },
    /** Make the `after`th write from now on answer `status` with a problem, once. */
    failWrite(after: number, status = 503) { failing = { remaining: after, status } },
  }
}
