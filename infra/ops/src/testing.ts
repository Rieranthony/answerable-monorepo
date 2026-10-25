// Test support for the ops commands: in-memory stand-ins for Kubernetes, ID's admin API, the secret store and the
// database's TLS fetch. Not shipped behaviour.
import { X509Certificate } from "node:crypto"
import type { FetchChain } from "./database-ca"
import type { Kubernetes } from "./kubernetes"
import type { SecretRef, SecretStore } from "./secret-store"

type KubernetesState = { secrets?: Record<string, Record<string, string>>; configMaps?: Record<string, Record<string, string>>; deployments?: Record<string, number> }

/** An in-memory Kubernetes: `secrets`, `configMaps` and `deployments` (replicas by name) are the live state, for a test to read and seed. */
export function fakeKubernetes({ secrets = {}, configMaps = {}, deployments = {} }: KubernetesState = {}) {
  const client: Kubernetes = {
    async readSecret(name) {
      return secrets[name] ? { ...secrets[name] } : undefined
    },
    async writeSecretKey(name, key, value) {
      secrets[name] = { ...secrets[name], [key]: value }
    },
    async readConfigMap(name) {
      return configMaps[name] ? { ...configMaps[name] } : undefined
    },
    async writeConfigMap(name, data) {
      configMaps[name] = { ...configMaps[name], ...data }
    },
    async replicas(name) {
      return deployments[name]
    },
    async setReplicas(name, replicas) {
      if (!(name in deployments)) throw new Error(`Kubernetes answered 404 NotFound to PATCH Deployment ${name}`)
      deployments[name] = replicas
    },
  }
  return { client, secrets, configMaps, deployments }
}

/** The TLS fetch, answering the certificates of `chain` (PEM, leaf first), or failing with it, and recording each host and port it was asked for. */
export function fakeFetchChain(chain: string[] | Error) {
  const calls: string[] = []
  const fetchChain: FetchChain = async (host, port) => {
    calls.push(`${host}:${port}`)
    if (chain instanceof Error) throw chain
    return chain.map(pem => Buffer.from(new X509Certificate(pem).raw))
  }
  return { fetchChain, calls }
}

type FakeIdOptions = {
  rootSecret?: string
  platformSlug?: string
  rootLocked?: boolean
  /** Whether ID has Answerable's Microsoft platform application; without it an Entra provider is platform_application_missing. */
  microsoft?: boolean
  /** Whether joining platform-admins leaves the root secret working, as ROOT_ADMIN_BREAK_GLASS=true does. */
  breakGlass?: boolean
}

/**
 * ID's admin API as the ops commands use it, in memory, behaving as ID does where it matters: writes are idempotent per caller and key (a
 * replay answers the receipt, not the object, so no client secret; the same key with other input is `409 idempotency_key_reused`), a second
 * object with the same identity is `409 conflict`, a client's secret is answered once and rotation answers a new one, `If-None-Match: *` on
 * an existing membership or SSO provider is `412`, joining platform-admins locks the root secret, and a locked root secret is refused with
 * `403 root_locked`. `calls` records each request's method, path, key and bearer token.
 */
export function fakeIdAdmin({ rootSecret = "root-secret", platformSlug = "answerable", rootLocked = false, microsoft = true, breakGlass = false }: FakeIdOptions = {}) {
  const platform = "0190a000-0000-7000-8000-000000000001"
  const state = {
    rootLocked,
    resources: new Set<string>(),
    clients: new Map<string, { secret?: string; scopes?: unknown }>(),
    links: new Set<string>(),
    capabilities: new Set<string>(),
    entitlements: new Set<string>(),
    // ID seeds platform-admins at its first start; register creates the role groups.
    groups: new Map<string, string>([["platform-admins", "0190a000-0000-7000-8000-0000000000a1"]]),
    domains: new Map<string, string>(),
    ssoProvider: undefined as { issuer: string; domain: string } | undefined,
    testProblems: [] as { code: string; detail: string }[],
    members: new Map<string, string>(),
    memberships: new Set<string>(),
    operations: new Map<string, { fingerprint: string; status: number }>(),
    rotations: 0,
    calls: [] as { method: string; path: string; key: string | null; token: string | undefined }[],
    failures: new Map<string, number>(),
  }
  const problem = (status: number, code: string) => Response.json({ type: "about:blank", title: code, status, code, request_id: "r" }, { status, headers: { "Content-Type": "application/problem+json" } })
  // One object of an identity, as ID's unique indexes allow: a second answers 409 conflict.
  const unique = (set: Set<string>, identity: string) => (set.has(identity) ? false : (set.add(identity), true))
  async function handle(method: string, path: string, body: Record<string, unknown>, headers: Headers): Promise<Response> {
    let match: RegExpMatchArray | null
    if (method === "POST" && path === "/resources") return unique(state.resources, String(body.identifier)) ? Response.json({ id: crypto.randomUUID() }, { status: 201 }) : problem(409, "conflict")
    if (method === "POST" && path === "/clients") {
      const clientId = String(body.clientId)
      if (state.clients.has(clientId)) return problem(409, "conflict")
      const secret = body.tokenEndpointAuthMethod === "client_secret_basic" ? `secret-of-${clientId}-${crypto.randomUUID()}` : undefined
      state.clients.set(clientId, { secret, scopes: body.clientCredentialsScopes })
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
    if (method === "POST" && (match = path.match(/^\/organizations\/([^/]+)\/domains$/))) {
      const domain = String(body.domain)
      if (state.domains.has(domain)) return problem(409, "conflict")
      state.domains.set(domain, match[1]!)
      return Response.json({ id: crypto.randomUUID(), domain }, { status: 201 })
    }
    if (method === "PUT" && path === `/organizations/${platform}/sso-provider`) {
      // As ID: the platform application first, then the precondition.
      if (!microsoft && String(body.issuer).startsWith("https://login.microsoftonline.com/")) return problem(409, "platform_application_missing")
      if (headers.get("If-None-Match") === "*" && state.ssoProvider) return problem(412, "precondition_failed")
      state.ssoProvider = { issuer: String(body.issuer), domain: String(body.domain) }
      return Response.json({ id: crypto.randomUUID(), ...state.ssoProvider }, { status: 201 })
    }
    if (method === "PUT" && (match = path.match(/^\/organizations\/[^/]+\/groups\/([^/]+)\/members\/([^/]+)$/))) {
      if (![...state.groups.values()].includes(match[1]!) || !state.members.has(match[2]!)) return problem(404, "not_found")
      if (!unique(state.memberships, `${match[1]} ${match[2]}`)) return problem(412, "precondition_failed")
      if (match[1] === state.groups.get("platform-admins") && !breakGlass) state.rootLocked = true
      return Response.json({ groupId: match[1], memberId: match[2] }, { status: 201 })
    }
    return problem(404, "not_found")
  }
  function read(path: string, url: URL): Response | undefined {
    if (path === "/organizations") {
      const items = [{ id: platform, slug: platformSlug }, { id: crypto.randomUUID(), slug: `${platformSlug}-lookalike` }]
      return Response.json({ items: items.filter(item => item.slug.includes(url.searchParams.get("q") ?? "")), nextCursor: null })
    }
    if (/^\/organizations\/[^/]+\/groups$/.test(path)) {
      const q = url.searchParams.get("q") ?? ""
      return Response.json({ items: [...state.groups].filter(([slug]) => slug.includes(q)).map(([slug, id]) => ({ id, slug })), nextCursor: null })
    }
    if (path === `/organizations/${platform}/domains`)
      return Response.json({ items: [...state.domains].filter(([, organization]) => organization === platform).map(([domain]) => ({ domain })), nextCursor: null })
    if (path === `/organizations/${platform}/sso-provider`) return state.ssoProvider ? Response.json(state.ssoProvider) : problem(404, "not_found")
    if (path === `/organizations/${platform}/sso-provider/test`) {
      const issuer = state.ssoProvider!.issuer
      return Response.json({ issuer, kind: "entra", discovery: { url: `${issuer}/.well-known/openid-configuration`, reachable: true, status: 200, issuerMatches: true }, jwks: { reachable: true, keys: 4 }, elapsedMs: 312, problems: state.testProblems })
    }
    if (path === `/organizations/${platform}/members`) {
      const email = url.searchParams.get("email")?.toLowerCase()
      return Response.json({ items: [...state.members].filter(([, address]) => address.toLowerCase() === email).map(([id, address]) => ({ id, email: address })), nextCursor: null })
    }
    return undefined
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
    if (method === "GET") return read(path, url) ?? problem(404, "not_found")
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    // Idempotency per caller and key, as ID keys its journal by actor.
    const operation = `${token} ${key}`
    const fingerprint = JSON.stringify([method, path, body])
    const seen = state.operations.get(operation)
    if (seen) {
      if (seen.fingerprint !== fingerprint) return problem(409, "idempotency_key_reused")
      return Response.json({ operationId: crypto.randomUUID(), outcome: "applied", statusCode: seen.status, resultReference: null }, { status: seen.status, headers: { "Idempotency-Replayed": "true" } })
    }
    const response = await handle(method, path, body, headers)
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
