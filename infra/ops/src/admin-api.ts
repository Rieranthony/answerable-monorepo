/** A problem answer of ID's admin API, as far as the ops commands read it. */
type Problem = { code?: string; title?: string; detail?: string }

/** ID's answer: its status, its body (a problem when it refused), and whether it replayed an earlier call with the same key. */
export type Answer = { status: number; ok: boolean; body: Record<string, unknown> & Problem; replayed: boolean }

/** A call: the `Idempotency-Key` of a write, its JSON body, and `If-None-Match: *` for a write that must not replace. */
type CallOptions = { key?: string; body?: unknown; ifNoneMatch?: boolean }

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
  /** The root secret or a staff token. */
  token: string
  /** What a 403 root_locked means to this command: the message of the RootLocked it throws. */
  rootLocked: string
  fetch?: typeof globalThis.fetch
  /** How long one call may take before it fails naming it. */
  timeoutMs?: number
}

/**
 * ID's admin API (`/api/admin/v1`) with a bearer. Throws, naming the call, when ID does not answer in time, with
 * {@link RootLocked} on 403 root_locked, and when ID refuses a key used before with other input; answers everything else.
 * Never puts the token in a message.
 */
export function adminApi({ id, token, rootLocked, fetch = globalThis.fetch, timeoutMs = 30_000 }: Options): Call {
  return async (method, path, { key, body, ifNoneMatch } = {}) => {
    const response = await fetch(`${id}/api/admin/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(key ? { "Idempotency-Key": key } : {}),
        ...(ifNoneMatch ? { "If-None-Match": "*" } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: Error) => {
      throw error.name === "TimeoutError" ? new Error(`${method} ${path} got no answer from ID within ${timeoutMs / 1000} s`) : error
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
    return { status: response.status, ok: response.ok, body: parsed, replayed: response.headers.get("Idempotency-Replayed") === "true" }
  }
}

/** The error for an answer a command did not expect: the call, the status and ID's problem code. */
export function failure(method: string, path: string, answer: Answer) {
  return new Error(`${method} ${path} answered ${answer.status} ${answer.body.code ?? ""}`.trimEnd())
}

/** The id of the item with this slug in a list ID answers to `?q=<slug>`, which matches by prefix; undefined when there is none. */
export async function findBySlug(call: Call, path: string, slug: string) {
  const answer = await call("GET", `${path}?q=${encodeURIComponent(slug)}&limit=100`)
  if (!answer.ok) throw failure("GET", path, answer)
  return (answer.body.items as { id: string; slug: string }[]).find(item => item.slug === slug)?.id
}

/** The platform organisation's id, by its slug. */
export async function platformOrganisation(call: Call, slug: string) {
  const platform = await findBySlug(call, "/organizations", slug)
  if (!platform) throw new Error(`ID has no organisation with the slug ${slug}: set OPS_PLATFORM_SLUG to the platform organisation's`)
  return platform
}
