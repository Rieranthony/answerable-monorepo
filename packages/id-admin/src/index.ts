import { z } from "zod"

/** How a server reaches Answerable ID's admin API: ID's origin, the admin resource and the server's machine client. */
export type IdConfig = {
  issuer: string
  /** The identifier of ID's admin resource, ID's `ADMIN_RESOURCE_IDENTIFIER`. */
  adminResource: string
  clientId: string
  clientSecret: string
  /** HTTP client. Default: the global fetch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** How long to wait for ID to answer the token request or an admin call, in milliseconds; past it the call throws `IdError` with status 0. Default: 5,000. */
  timeoutMs?: number
}

/** What a call to ID may carry besides its path. */
export type IdCallOptions = {
  /** Sent as `x-request-id`; ID stores it on the audit row of a write and echoes it. ID ignores one that does not match `[A-Za-z0-9._:-]{1,128}`. */
  requestId?: string
}

/** What a write to ID may carry besides its call options. */
export type IdWriteOptions = IdCallOptions & {
  /** The JSON body. */
  body?: unknown
  /** Sent as `If-Match`: the ETag the write expects the resource to have. */
  ifMatch?: string
  /** Sent as `If-None-Match`: `*` asserts that the resource does not exist yet, where ID takes it (`PUT` of an SSO provider or a group member). */
  ifNoneMatch?: "*"
  /**
   * Sent as `Idempotency-Key` on every method but GET. Default: a random UUID per call. ID replays the receipt of the same key with the same input and
   * refuses a different input with `409 idempotency_key_reused`. The key stays the same when the call is resent after a `401`.
   */
  idempotencyKey?: string
}

/**
 * ID's admin API, or its token endpoint, did not answer as needed. `status` is 0 when there was no answer at all; `code` is the problem's `code`, absent
 * when the body is not a problem; `retryAfterMs` is ID's `Retry-After` in milliseconds, absent when ID sent none (it sends one with `503 database_busy`).
 */
export class IdError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string, readonly retryAfterMs?: number) {
    super(message)
    this.name = "IdError"
  }
}

const issued = z.object({ access_token: z.string(), expires_in: z.number() })
const problem = z.object({ code: z.string(), title: z.string() })
const read = "platform:read"
const write = "platform:read platform:write"

// A request that got no answer: a refused connection or a timeout.
async function reach(what: string, request: () => Promise<Response>) {
  try {
    return await request()
  } catch (cause) {
    throw new IdError(0, undefined, `Answerable ID did not answer ${what}: ${(cause as Error).message}`)
  }
}

/** ID's 404 for something a caller names is an answer, not a failure: `undefined`, so that the caller can say what was missing. */
export async function found<T>(answer: Promise<T>): Promise<T | undefined> {
  try {
    return await answer
  } catch (error) {
    if (error instanceof IdError && error.status === 404) return undefined
    throw error
  }
}

/**
 * ID's admin API as a server's machine client, one per server. Reads (`get`, `read`) use a `platform:read` token; `manage` uses a `platform:read
 * platform:write` token of its own; `withToken` gets a token for another service that trusts the client. Each token is reused until 30 seconds
 * before it expires and renewed once when it is refused. A status outside 2xx from the admin API throws `IdError`.
 */
export function createIdAdmin({ issuer, adminResource, clientId, clientSecret, fetch = globalThis.fetch, timeoutMs = 5000 }: IdConfig) {
  // One token per audience and scope.
  const tokens = new Map<string, { value: string; expiresAt: number }>()
  const pending = new Map<string, Promise<string>>()
  async function issue(resource: string, scope: string) {
    const response = await reach("the token request", async () => fetch(new URL("/auth/oauth2/token", issuer), {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource, scope }),
      signal: AbortSignal.timeout(timeoutMs),
    }))
    if (!response.ok) {
      const audience = resource === adminResource ? "the admin resource" : resource
      throw new IdError(response.status, undefined, `Answerable ID refused the client credentials of ${clientId} (${response.status}); check the client id, the client secret and the client's ${scope.replace(" ", " and ")} capability for ${audience}`)
    }
    const body = issued.parse(await response.json())
    return { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
  }
  function accessToken(resource: string, scope: string) {
    const key = `${resource} ${scope}`
    const token = tokens.get(key)
    if (token && Date.now() < token.expiresAt - 30_000) return token.value
    let renewing = pending.get(key)
    if (!renewing) {
      renewing = issue(resource, scope).then(fresh => {
        tokens.set(key, fresh)
        return fresh.value
      }).finally(() => pending.delete(key))
      pending.set(key, renewing)
    }
    return renewing
  }
  // Send with a token, and once more with a new one when the token is refused.
  async function withToken(resource: string, scope: string, send: (token: string) => Promise<Response>) {
    const response = await send(await accessToken(resource, scope))
    if (response.status !== 401) return response
    tokens.delete(`${resource} ${scope}`)
    return send(await accessToken(resource, scope))
  }
  async function call(scope: string, method: string, path: string, { body, ifMatch, ifNoneMatch, requestId, idempotencyKey }: IdWriteOptions = {}) {
    const url = `/api/admin/v1${path}`
    // One key per call: a renewed token repeats the same command.
    const key = idempotencyKey ?? crypto.randomUUID()
    const response = await withToken(adminResource, scope, token => reach(`${method} ${url}`, async () => fetch(new URL(url, issuer), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(requestId === undefined ? {} : { "x-request-id": requestId }),
        ...(method === "GET" ? {} : { "Idempotency-Key": key }),
        ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
        ...(ifNoneMatch === undefined ? {} : { "If-None-Match": ifNoneMatch }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })))
    if (response.ok) return response
    const answer = problem.safeParse(await response.json().catch(() => undefined))
    const said = answer.success ? ` ${answer.data.code}: ${answer.data.title}` : ""
    const retryAfter = response.headers.get("Retry-After")
    throw new IdError(response.status, answer.data?.code, `Answerable ID answered ${method} ${url} with ${response.status}${said}`, retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined)
  }
  return {
    /** GET a path of the admin API, such as `/audit-events?limit=200`, and return its JSON. */
    async get(path: string, options?: IdCallOptions): Promise<unknown> {
      return (await call(read, "GET", path, options)).json()
    },
    /** GET a path of the admin API and return its JSON with the response's `ETag`, `null` when ID sent none: the version a later `If-Match` names. */
    async read(path: string, options?: IdCallOptions): Promise<{ body: unknown; etag: string | null }> {
      const response = await call(read, "GET", path, options)
      return { body: await response.json(), etag: response.headers.get("ETag") }
    },
    /**
     * Call the admin API with `platform:read` and `platform:write`: a JSON `body`, an `If-Match` or `If-None-Match` precondition, an `Idempotency-Key`
     * on every write (a random one unless `idempotencyKey` names it) and an `x-request-id`. Returns the JSON (`null` for `204`), the response's
     * `ETag`, its `Operation-Id`, the id of the operation ID recorded for a write, and whether ID replayed an earlier answer to the same key
     * (`Idempotency-Replayed: true`), whose body is then ID's operation receipt rather than the resource; `etag` and `operationId` are `null`
     * when ID sent none.
     */
    async manage(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, options?: IdWriteOptions): Promise<{ body: unknown; etag: string | null; operationId: string | null; replayed: boolean }> {
      const response = await call(write, method, path, options)
      return {
        body: response.status === 204 ? null : await response.json(), etag: response.headers.get("ETag"),
        operationId: response.headers.get("Operation-Id"), replayed: response.headers.get("Idempotency-Replayed") === "true",
      }
    },
    /**
     * Call another service that trusts this machine client, such as the Toolbox's admin API: `send` runs with a `client_credentials` token for
     * `resource` carrying `scope`, and once more with a renewed token when the service answers `401`. Returns `send`'s response, whatever its
     * status; throws `IdError` when ID refuses or does not answer the token request.
     */
    withToken,
  }
}
/** ID's admin API as a server's machine client. */
export type IdAdmin = ReturnType<typeof createIdAdmin>
