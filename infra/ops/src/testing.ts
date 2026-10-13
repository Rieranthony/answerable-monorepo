// Test support for the ops commands: in-memory stand-ins for Kubernetes and the secret store. Not shipped behaviour.
import type { Kubernetes } from "./kubernetes"
import type { SecretRef, SecretStore } from "./secret-store"

/** An in-memory Kubernetes: `secrets` and `deployments` (replicas by name) are the live state, for a test to read and seed. */
export function fakeKubernetes({ secrets = {}, deployments = {} }: { secrets?: Record<string, Record<string, string>>; deployments?: Record<string, number> } = {}) {
  const client: Kubernetes = {
    async readSecret(name) {
      return secrets[name] ? { ...secrets[name] } : undefined
    },
    async writeSecretKey(name, key, value) {
      secrets[name] = { ...secrets[name], [key]: value }
    },
    async replicas(name) {
      return deployments[name]
    },
    async setReplicas(name, replicas) {
      if (!(name in deployments)) throw new Error(`Kubernetes answered 404 NotFound to PATCH Deployment ${name}`)
      deployments[name] = replicas
    },
  }
  return { client, secrets, deployments }
}

/**
 * ID's admin API as `register` uses it, in memory, behaving as ID does where it matters: writes are idempotent per caller and key (a replay
 * answers the receipt, not the object, so no client secret; the same key with other input is `409 idempotency_key_reused`), a second object
 * with the same identity is `409 conflict`, a client's secret is answered once and rotation answers a new one, and `rootLocked` refuses the
 * root secret with `403 root_locked`. `calls` records each request's method, path, key and bearer token.
 */
export function fakeIdAdmin({ rootSecret = "root-secret", platformSlug = "answerable", rootLocked = false }: { rootSecret?: string; platformSlug?: string; rootLocked?: boolean } = {}) {
  const platform = "0190a000-0000-7000-8000-000000000001"
  const state = {
    rootLocked,
    resources: new Set<string>(),
    clients: new Map<string, { secret?: string }>(),
    links: new Set<string>(),
    capabilities: new Set<string>(),
    entitlements: new Set<string>(),
    groups: new Map<string, string>(),
    operations: new Map<string, { fingerprint: string; status: number }>(),
    rotations: 0,
    calls: [] as { method: string; path: string; key: string | null; token: string | undefined }[],
    failures: new Map<string, number>(),
  }
  const problem = (status: number, code: string) => Response.json({ type: "about:blank", title: code, status, code, request_id: "r" }, { status, headers: { "Content-Type": "application/problem+json" } })
  // One object of an identity, as ID's unique indexes allow: a second answers 409 conflict.
  const unique = (set: Set<string>, identity: string) => (set.has(identity) ? false : (set.add(identity), true))
  async function handle(method: string, path: string, body: Record<string, unknown>): Promise<Response> {
    let match: RegExpMatchArray | null
    if (method === "POST" && path === "/resources") return unique(state.resources, String(body.identifier)) ? Response.json({ id: crypto.randomUUID() }, { status: 201 }) : problem(409, "conflict")
    if (method === "POST" && path === "/clients") {
      const clientId = String(body.clientId)
      if (state.clients.has(clientId)) return problem(409, "conflict")
      const secret = body.tokenEndpointAuthMethod === "client_secret_basic" ? `secret-of-${clientId}-${crypto.randomUUID()}` : undefined
      state.clients.set(clientId, { secret })
      return Response.json({ clientId, ...(secret ? { clientSecret: secret } : {}) }, { status: 201 })
    }
    if (method === "POST" && (match = path.match(/^\/clients\/([^/]+)\/rotate-secret$/))) {
      const client = state.clients.get(match[1]!)
      if (!client) return problem(404, "not_found")
      client.secret = `rotated-${++state.rotations}-${crypto.randomUUID()}`
      return Response.json({ clientId: match[1], clientSecret: client.secret })
    }
    if (method === "PUT" && (match = path.match(/^\/clients\/([^/]+)\/resources\/(.+)$/))) {
      return unique(state.links, `${match[1]} ${decodeURIComponent(match[2]!)}`) ? Response.json({}, { status: 201 }) : Response.json({}, { status: 200 })
    }
    if (method === "POST" && (match = path.match(/^\/organizations\/([^/]+)\/capabilities$/))) {
      return unique(state.capabilities, JSON.stringify([match[1], body.clientId, body.resource, body.grantKind])) ? Response.json({ id: crypto.randomUUID() }, { status: 201 }) : problem(409, "conflict")
    }
    if (method === "POST" && (match = path.match(/^\/organizations\/([^/]+)\/entitlements$/))) {
      return unique(state.entitlements, JSON.stringify([match[1], body.groupId ?? body.clientId, body.resource ?? null])) ? Response.json({ id: crypto.randomUUID() }, { status: 201 }) : problem(409, "conflict")
    }
    if (method === "POST" && (match = path.match(/^\/organizations\/([^/]+)\/groups$/))) {
      const slug = String(body.slug)
      if (state.groups.has(slug)) return problem(409, "conflict")
      const id = crypto.randomUUID()
      state.groups.set(slug, id)
      return Response.json({ id, slug }, { status: 201 })
    }
    return problem(404, "not_found")
  }
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/api\/admin\/v1/, "")
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    const key = headers.get("Idempotency-Key")
    const token = headers.get("Authorization")?.replace(/^Bearer /, "")
    state.calls.push({ method, path, key, token })
    if (token === rootSecret && state.rootLocked) return problem(403, "root_locked")
    if (!token) return problem(401, "unauthorized")
    const failing = state.failures.get(`${method} ${path}`)
    if (failing) return problem(failing, "server_error")
    if (method === "GET" && path === "/organizations") {
      const items = [{ id: platform, slug: platformSlug }, { id: crypto.randomUUID(), slug: `${platformSlug}-lookalike` }]
      return Response.json({ items: items.filter(item => item.slug.includes(url.searchParams.get("q") ?? "")), nextCursor: null })
    }
    const groupsList = path.match(/^\/organizations\/([^/]+)\/groups$/)
    if (method === "GET" && groupsList) {
      const q = url.searchParams.get("q") ?? ""
      return Response.json({ items: [...state.groups].filter(([slug]) => slug.includes(q)).map(([slug, id]) => ({ id, slug })), nextCursor: null })
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    // Idempotency per caller and key, as ID keys its journal by actor.
    const operation = `${token} ${key}`
    const fingerprint = JSON.stringify([method, path, body])
    const seen = state.operations.get(operation)
    if (seen) {
      if (seen.fingerprint !== fingerprint) return problem(409, "idempotency_key_reused")
      return Response.json({ operationId: crypto.randomUUID(), outcome: "applied", statusCode: seen.status, resultReference: null }, { status: seen.status, headers: { "Idempotency-Replayed": "true" } })
    }
    const response = await handle(method, path, body)
    if (response.ok) state.operations.set(operation, { fingerprint, status: response.status })
    return response
  }) as typeof globalThis.fetch
  return { fetch, state, platform, rootSecret }
}

/** An in-memory secret store whose `values` are keyed `secret/key`, recording every write. */
export function memoryStore(values: Record<string, string> = {}) {
  const writes: string[] = []
  const store: SecretStore = {
    async get({ secret, key }: SecretRef) {
      return values[`${secret}/${key}`] || undefined
    },
    async put({ secret, key }: SecretRef, value: string) {
      writes.push(`${secret}/${key}`)
      values[`${secret}/${key}`] = value
    },
  }
  return { store, values, writes }
}
