// Answerable ID's token endpoint and the two admin reads the Toolbox makes, in memory, for tests.
type Target = { kind: "client" | "resource" | "client_resource"; id: string; resource?: string; scopes: string[] }
type Event = { id: string; occurredAt: string; action: string; organizationId: string | null; targetType: string; targetId: string | null }

const hubClient = { issuer: "https://id.test", adminResource: "https://id.test/api/admin", clientId: "toolbox-hub", clientSecret: "hub-secret" }

export function createFakeId({ expiresIn = 3600 } = {}) {
  const access = new Map<string, Target[]>()
  const events: Event[] = []
  const requests: string[] = []
  let issued = 0
  let down = false
  let latency = 0
  async function fetch(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}${url.search}`)
    if (latency) await Bun.sleep(latency)
    if (down) return new Response("Unavailable", { status: 503 })
    if (request.method === "POST" && url.pathname === "/auth/oauth2/token") {
      const form = new URLSearchParams(await request.text())
      const basic = `Basic ${Buffer.from(`${hubClient.clientId}:${hubClient.clientSecret}`).toString("base64")}`
      if (request.headers.get("Authorization") !== basic) return Response.json({ error: "invalid_client" }, { status: 401 })
      if (form.get("grant_type") !== "client_credentials" || form.get("resource") !== hubClient.adminResource || form.get("scope") !== "platform:read") {
        return Response.json({ error: "invalid_request" }, { status: 400 })
      }
      return Response.json({ access_token: `machine-${++issued}`, token_type: "Bearer", expires_in: expiresIn })
    }
    if (request.headers.get("Authorization") !== `Bearer machine-${issued}`) return Response.json({ code: "invalid_token" }, { status: 401 })
    const member = /^\/api\/admin\/v1\/organizations\/([^/]+)\/members\/([^/]+)\/access$/.exec(url.pathname)
    if (member) {
      const targets = access.get(`${member[1]}/${member[2]}`)
      return targets ? Response.json({ effective: true, targets: targets.map(target => ({ ...target, permission: { allowed: false, reason: "scope" }, via: [] })) }) : Response.json({ code: "not_found" }, { status: 404 })
    }
    if (url.pathname === "/api/admin/v1/audit-events") {
      const limit = Number(url.searchParams.get("limit"))
      const cursor = url.searchParams.get("cursor")
      const newest = events.toSorted((a, b) => (a.id < b.id ? 1 : -1)).filter(event => !cursor || event.id < cursor)
      const items = newest.slice(0, limit)
      return Response.json({ items, nextCursor: newest.length > limit ? items.at(-1)!.id : null })
    }
    return new Response("Not found", { status: 404 })
  }
  return {
    fetch,
    config: { ...hubClient, fetch },
    /** Every request, as `METHOD /path?query`. */
    requests,
    /** Set the targets of a member's access view. */
    grant(organizationId: string, memberId: string, targets: Target[]) { access.set(`${organizationId}/${memberId}`, targets) },
    /** Append an audit event, newer than every one before it. */
    event(action: string, organizationId: string | null) {
      const event = { id: Bun.randomUUIDv7(), occurredAt: new Date().toISOString(), action, organizationId, targetType: "entitlement", targetId: null }
      events.push(event)
      return event
    },
    outage(value: boolean) { down = value },
    slow(ms: number) { latency = ms },
    /** Revoke every token issued so far. */
    revoke() { issued++ },
  }
}
export type FakeId = ReturnType<typeof createFakeId>
