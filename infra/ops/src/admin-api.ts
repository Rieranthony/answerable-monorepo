/** A problem answer of ID's admin API, as far as the ops commands read it. */
type Problem = { code?: string; title?: string; detail?: string }

/** ID's answer: its status, its body (a problem when it refused), its ETag (`null` without one), and whether it replayed an earlier call with the same key. */
export type Answer = { status: number; ok: boolean; body: Record<string, unknown> & Problem; etag: string | null; replayed: boolean }

/** A call: the `Idempotency-Key` of a write, its JSON body, `If-Match` with the ETag a change expects, and `If-None-Match: *` for a write that must not replace. */
type CallOptions = { key?: string; body?: unknown; ifMatch?: string; ifNoneMatch?: boolean }

export type Call = (method: string, path: string, options?: CallOptions) => Promise<Answer>

/** ID refused the bearer because a person is a platform administrator (403 root_locked). */
export class RootLocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RootLocked"
  }
}

type Options = {
  /** Answerable ID's origin. */
  id: string
  /** The root secret, or what answers a machine client's current token (`clientToken`). */
  token: string | (() => Promise<string>)
  /** What a 403 root_locked means to this command: the message of the RootLocked it throws. */
  rootLocked: string
  fetch?: typeof globalThis.fetch
  /** How long one call may take before it fails naming it. */
  timeoutMs?: number
}

/** `fetch`, failing with a message that names the call when ID does not answer within `timeoutMs`. */
function within(fetch: typeof globalThis.fetch, what: string, timeoutMs: number, url: string, init: RequestInit) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch((error: Error) => {
    throw error.name === "TimeoutError" ? new Error(`${what} got no answer from ID within ${timeoutMs / 1000} s`) : error
  })
}

/**
 * ID's admin API (`/api/admin/v1`) with a bearer. Throws, naming the call, when ID does not answer in time, with
 * {@link RootLocked} on 403 root_locked, and when ID refuses a key used before with other input; answers everything else.
 * Never puts the token in a message.
 */
export function adminApi({ id, token, rootLocked, fetch = globalThis.fetch, timeoutMs = 30_000 }: Options): Call {
  return async (method, path, { key, body, ifMatch, ifNoneMatch } = {}) => {
    const bearer = typeof token === "string" ? token : await token()
    const response = await within(fetch, `${method} ${path}`, timeoutMs, `${id}/api/admin/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(key ? { "Idempotency-Key": key } : {}),
        ...(ifMatch ? { "If-Match": ifMatch } : {}),
        ...(ifNoneMatch ? { "If-None-Match": "*" } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed: Answer["body"]
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = { detail: text.slice(0, 200) }
    }
    if (response.status === 403 && parsed.code === "root_locked") throw new RootLocked(rootLocked)
    if (response.status === 409 && parsed.code === "idempotency_key_reused")
      throw new Error(`ID refused Idempotency-Key ${key}: it was used before with different input. A registration changed: give it a new key suffix here and in the docs`)
    return { status: response.status, ok: response.ok, body: parsed, etag: response.headers.get("ETag"), replayed: response.headers.get("Idempotency-Replayed") === "true" }
  }
}

/**
 * A machine client's bearer for ID's admin API: a `client_credentials` token with `platform:read platform:write`, asked for on first use and
 * again a minute before it expires. Throws `refused` with ID's status when ID refuses the client's credentials. Never puts the secret in a message.
 */
export function clientToken({ id, clientId, clientSecret, refused, fetch = globalThis.fetch, timeoutMs = 30_000 }: {
  id: string
  clientId: string
  clientSecret: string
  refused: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}) {
  let current: { value: string; renewAt: number } | undefined
  return async () => {
    if (current && Date.now() < current.renewAt) return current.value
    const response = await within(fetch, `${clientId}'s token request`, timeoutMs, `${id}/auth/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: `${id}/api/admin`, scope: "platform:read platform:write" }),
    })
    if (!response.ok) throw new Error(`${refused} (ID answered ${response.status})`)
    const issued = (await response.json()) as { access_token: string; expires_in: number }
    current = { value: issued.access_token, renewAt: Date.now() + (issued.expires_in - 60) * 1000 }
    return current.value
  }
}

/** The error for an answer a command did not expect: the call, its `Idempotency-Key` when it had one, the status and ID's problem code. */
export function failure(method: string, path: string, answer: Answer, key?: string) {
  return new Error(`${method} ${path}${key ? ` (Idempotency-Key ${key})` : ""} answered ${answer.status} ${answer.body.code ?? ""}`.trimEnd())
}

/** The id of the item with this slug in a list ID answers to `?q=<slug>`, which matches by prefix; undefined when there is none. */
export async function findBySlug(call: Call, path: string, slug: string) {
  const answer = await call("GET", `${path}?q=${encodeURIComponent(slug)}&limit=100`)
  if (!answer.ok) throw failure("GET", path, answer)
  return (answer.body.items as { id: string; slug: string }[]).find(item => item.slug === slug)?.id
}

/** The platform organisation's slug, a constant of ID's (apps/id/src/env.ts). */
const PLATFORM_SLUG = "answerable"

/** The platform organisation's id, by its slug. */
export async function platformOrganisation(call: Call) {
  const platform = await findBySlug(call, "/organizations", PLATFORM_SLUG)
  if (!platform) throw new Error(`ID has no organisation with the slug ${PLATFORM_SLUG}, its platform organisation's: is this Answerable ID?`)
  return platform
}
