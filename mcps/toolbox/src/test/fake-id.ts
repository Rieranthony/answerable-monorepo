// Answerable ID's token endpoint and the admin routes the Toolbox calls, in memory, for tests. Shapes follow apps/id/openapi.admin.json.
type Target = { kind: "client" | "resource" | "client_resource"; id: string; resource?: string; scopes: string[] }
type Event = { id: string; occurredAt: string; action: string; organizationId: string | null; targetType: string; targetId: string | null }
type Row = Record<string, unknown> & { id: string; scopes: string[] }
type Resource = { id: string; revision: number; allowedScopes: string[]; clients: string[] }

const hubClient = { issuer: "https://id.test", adminResource: "https://id.test/api/admin", clientId: "toolbox-hub", clientSecret: "hub-secret" }
const problem = (status: number, code: string, title: string) =>
  Response.json({ type: "about:blank", title, status, code, request_id: "test" }, { status, headers: { "Content-Type": "application/problem+json" } })

export function createFakeId({ expiresIn = 3600, pageSize = 200 } = {}) {
  const access = new Map<string, Target[]>()
  const events: Event[] = []
  const requests: string[] = []
  // The scope each token was issued with, and the scopes each token request asked for.
  const tokens = new Map<string, string>()
  const asked: string[] = []
  const keys: string[] = []
  const resources = new Map<string, Resource>()
  const clients = new Set<string>()
  const organisations = new Set<string>()
  const capabilities = new Map<string, Row[]>()
  const entitlements = new Map<string, Row[]>()
  let issued = 0
  let down = false
  let gone = false
  let latency = 0
  let failing: { remaining: number; status: number } | undefined
  const rows = (table: Map<string, Row[]>, organisation: string) => table.get(organisation) ?? table.set(organisation, []).get(organisation)!
  const etag = ({ id, revision }: Resource) => `"${id}:${revision}"`
  const page = (items: Row[], url: URL) => {
    const size = Math.min(Number(url.searchParams.get("limit")), pageSize)
    const cursor = url.searchParams.get("cursor")
    const rest = items.filter(row => !cursor || row.id > cursor)
    const shown = rest.slice(0, size)
    return { items: shown, nextCursor: rest.length > size ? shown.at(-1)!.id : null }
  }
  // A write: an Idempotency-Key is required, and one can be made to fail.
  function refuse(request: Request) {
    const key = request.headers.get("Idempotency-Key")
    if (!key) return problem(400, "invalid_idempotency_key", "A 1–256 character Idempotency-Key is required")
    keys.push(key)
    if (failing && --failing.remaining === 0) {
      const { status } = failing
      failing = undefined
      return problem(status, "database_busy", "Database is busy")
    }
  }
  function outsideVocabulary(resource: unknown, scopes: string[]) {
    return typeof resource === "string" && scopes.some(scope => !resources.get(resource)?.allowedScopes.includes(scope))
  }
  async function admin(request: Request, url: URL, path: string) {
    const write = request.method !== "GET"
    if (write && !tokens.get(request.headers.get("Authorization")!.slice(7))!.includes("platform:write")) return problem(403, "forbidden", "The principal is not allowed")
    const body = write && request.headers.get("Content-Type") ? await request.json() as Record<string, unknown> : {}
    const resource = /^\/resources\/([^/]+)$/.exec(path)
    if (resource) {
      const found = resources.get(decodeURIComponent(resource[1]!))
      if (!found) return problem(404, "not_found", "Resource not found")
      if (request.method === "GET") return Response.json({ identifier: decodeURIComponent(resource[1]!), ...found }, { headers: { ETag: etag(found) } })
      const refused = refuse(request)
      if (refused) return refused
      const ifMatch = request.headers.get("If-Match")
      if (ifMatch && ifMatch !== etag(found)) return problem(412, "revision_mismatch", "Configuration revision does not match")
      found.allowedScopes = [...new Set(body.allowedScopes as string[])].sort()
      found.revision++
      return Response.json({ identifier: decodeURIComponent(resource[1]!), ...found }, { headers: { ETag: etag(found) } })
    }
    const link = /^\/clients\/([^/]+)\/resources\/([^/]+)$/.exec(path)
    if (link && request.method === "PUT") {
      const refused = refuse(request)
      if (refused) return refused
      const found = resources.get(decodeURIComponent(link[2]!))
      if (!clients.has(link[1]!) || !found) return problem(404, "not_found", "Client or resource not found")
      const created = !found.clients.includes(link[1]!)
      if (created) found.clients.push(link[1]!)
      return Response.json({ created }, { status: created ? 201 : 200 })
    }
    const organisation = /^\/organizations\/([^/]+)\/(capabilities|entitlements)$/.exec(path)
    if (organisation) {
      if (!organisations.has(organisation[1]!)) return problem(404, "not_found", "Organisation not found")
      const table = organisation[2] === "capabilities" ? capabilities : entitlements
      const held = rows(table, organisation[1]!)
      if (request.method === "GET") {
        const client = url.searchParams.get("clientId")
        return Response.json(page(held.filter(row => !client || row.clientId === client), url))
      }
      const refused = refuse(request)
      if (refused) return refused
      const scopes = body.scopes as string[]
      const key = (row: Record<string, unknown>) => ["clientId", "resource", "grantKind", "memberId", "groupId"].map(field => row[field] ?? null).join("|")
      if (outsideVocabulary(body.resource, scopes)) return problem(400, "validation_failed", "Capability scopes exceed the client/resource ceiling or mix login and resource scopes")
      if (held.some(row => key(row) === key(body))) return problem(409, "conflict", "A row already exists")
      const row = { id: Bun.randomUUIDv7(), organizationId: organisation[1], memberId: null, groupId: null, clientId: null, resource: null, status: "active", ...body, scopes } as Row
      held.push(row)
      return Response.json(row, { status: 201 })
    }
    const member = /^\/organizations\/([^/]+)\/members\/([^/]+)\/access$/.exec(path)
    if (member) {
      const targets = access.get(`${member[1]}/${member[2]}`)
      return targets ? Response.json({ effective: true, targets: targets.map(target => ({ ...target, permission: { allowed: false, reason: "scope" }, via: [] })) }) : Response.json({ code: "not_found" }, { status: 404 })
    }
    if (path === "/audit-events") {
      const limit = Number(url.searchParams.get("limit"))
      const cursor = url.searchParams.get("cursor")
      const newest = events.toSorted((a, b) => (a.id < b.id ? 1 : -1)).filter(event => !cursor || event.id < cursor)
      const items = newest.slice(0, limit)
      return Response.json({ items, nextCursor: newest.length > limit ? items.at(-1)!.id : null })
    }
    return new Response("Not found", { status: 404 })
  }
  async function fetch(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}${url.search}`)
    if (latency) await Bun.sleep(latency)
    if (gone) throw new TypeError("Unable to connect")
    if (down) return new Response("Unavailable", { status: 503 })
    if (request.method === "POST" && url.pathname === "/auth/oauth2/token") {
      const form = new URLSearchParams(await request.text())
      const basic = `Basic ${Buffer.from(`${hubClient.clientId}:${hubClient.clientSecret}`).toString("base64")}`
      if (request.headers.get("Authorization") !== basic) return Response.json({ error: "invalid_client" }, { status: 401 })
      const scope = form.get("scope")!
      if (form.get("grant_type") !== "client_credentials" || form.get("resource") !== hubClient.adminResource || !["platform:read", "platform:read platform:write"].includes(scope)) {
        return Response.json({ error: "invalid_request" }, { status: 400 })
      }
      asked.push(scope)
      tokens.set(`machine-${++issued}`, scope)
      return Response.json({ access_token: `machine-${issued}`, token_type: "Bearer", expires_in: expiresIn })
    }
    if (!tokens.has(request.headers.get("Authorization")?.slice(7) ?? "")) return Response.json({ code: "invalid_token" }, { status: 401 })
    const path = url.pathname.replace(/^\/api\/admin\/v1/, "")
    return path === url.pathname ? new Response("Not found", { status: 404 }) : admin(request, url, path)
  }
  return {
    fetch,
    config: { ...hubClient, fetch },
    /** Every request, as `METHOD /path?query`. */
    requests,
    /** The `scope` of each token request, in order. */
    scopesAsked: asked,
    /** The Idempotency-Key of each write, in order. */
    keys,
    /** Set the targets of a member's access view. */
    grant(organizationId: string, memberId: string, targets: Target[]) { access.set(`${organizationId}/${memberId}`, targets) },
    /** Append an audit event, newer than every one before it. */
    event(action: string, organizationId: string | null) {
      const event = { id: Bun.randomUUIDv7(), occurredAt: new Date().toISOString(), action, organizationId, targetType: "entitlement", targetId: null }
      events.push(event)
      return event
    },
    outage(value: boolean) { down = value },
    /** Make every request fail without an answer, as a refused connection does. */
    unreachable(value: boolean) { gone = value },
    slow(ms: number) { latency = ms },
    /** Revoke every token issued so far. */
    revoke() { tokens.clear() },
    /** Register a resource with the scopes it allows, as staff do; its linked clients and revision are read back. */
    resource(identifier: string, allowedScopes: string[]) { resources.set(identifier, { id: crypto.randomUUID(), revision: 1, allowedScopes, clients: [] }) },
    /** What ID holds for a resource. */
    resourceOf: (identifier: string) => resources.get(identifier)!,
    /** Register clients, and organisations, as staff do. */
    client(clientId: string) { clients.add(clientId) },
    organisation(organizationId: string) { organisations.add(organizationId) },
    /** The organisation's capability and entitlement rows, in the order created; push a row to seed one. */
    capabilities: (organizationId: string) => rows(capabilities, organizationId),
    entitlements: (organizationId: string) => rows(entitlements, organizationId),
    /** Make the `after`th write from now on answer `status` with a problem, once. */
    failWrite(after: number, status = 503) { failing = { remaining: after, status } },
  }
}
