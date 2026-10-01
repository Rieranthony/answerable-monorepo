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
  /**
   * Sent as `Idempotency-Key` on every method but GET. Default: a random UUID per call. ID replays the receipt of the same key with the same input and
   * refuses a different input with `409 idempotency_key_reused`. The key stays the same when the call is resent after a `401`.
   */
  idempotencyKey?: string
}

/** ID's admin API, or its token endpoint, did not answer as needed. `status` is 0 when there was no answer at all; `code` is the problem's `code`, absent when the body is not a problem. */
export class IdError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
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
 * ID's admin API as a server's machine client, one per server. Reads (`get`) use a `platform:read` token; `manage` uses a `platform:read
 * platform:write` token of its own. Each is reused until 30 seconds before it expires and renewed once when ID refuses it. A status outside 2xx
 * throws `IdError`.
 */
export function createIdAdmin({ issuer, adminResource, clientId, clientSecret, fetch = globalThis.fetch }: IdConfig) {
  const tokens = new Map<string, { value: string; expiresAt: number }>()
  const pending = new Map<string, Promise<string>>()
  async function issue(scope: string) {
    const response = await reach("the token request", async () => fetch(new URL("/auth/oauth2/token", issuer), {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: adminResource, scope }),
      signal: AbortSignal.timeout(5000),
    }))
    if (!response.ok) {
      throw new IdError(response.status, undefined, `Answerable ID refused the client credentials of ${clientId} (${response.status}); check the client id, the client secret and the client's ${scope.replace(" ", " and ")} capability for the admin resource`)
    }
    const body = issued.parse(await response.json())
    tokens.set(scope, { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 })
    return body.access_token
  }
  function accessToken(scope: string) {
    const token = tokens.get(scope)
    if (token && Date.now() < token.expiresAt - 30_000) return token.value
    let renewing = pending.get(scope)
    if (!renewing) {
      renewing = issue(scope).finally(() => pending.delete(scope))
      pending.set(scope, renewing)
    }
    return renewing
  }
  async function call(scope: string, method: string, path: string, { body, ifMatch, requestId, idempotencyKey }: IdWriteOptions = {}) {
    const url = `/api/admin/v1${path}`
    // One key per call: a renewed token repeats the same command.
    const key = idempotencyKey ?? crypto.randomUUID()
    const send = async () => {
      const authorization = `Bearer ${await accessToken(scope)}`
      return reach(`${method} ${url}`, async () => fetch(new URL(url, issuer), {
        method,
        headers: {
          Authorization: authorization,
          ...(requestId === undefined ? {} : { "x-request-id": requestId }),
          ...(method === "GET" ? {} : { "Idempotency-Key": key }),
          ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }))
    }
    let response = await send()
    if (response.status === 401) {
      tokens.delete(scope)
      response = await send()
    }
    if (response.ok) return response
    const answer = problem.safeParse(await response.json().catch(() => undefined))
    const said = answer.success ? ` ${answer.data.code}: ${answer.data.title}` : ""
    throw new IdError(response.status, answer.data?.code, `Answerable ID answered ${method} ${url} with ${response.status}${said}`)
  }
  return {
    /** GET a path of the admin API, such as `/audit-events?limit=200`, and return its JSON. */
    async get(path: string, options?: IdCallOptions): Promise<unknown> {
      return (await call(read, "GET", path, options)).json()
    },
    /**
     * Call the admin API with `platform:read` and `platform:write`: a JSON `body`, an `If-Match` tag, an `Idempotency-Key` on every write (a random
     * one unless `idempotencyKey` names it) and an `x-request-id`. Returns the JSON, the response's `ETag` and its `Operation-Id`, the id of the
     * operation ID recorded for a write; both are `null` when ID sent none.
     */
    async manage(method: "GET" | "POST" | "PATCH" | "PUT", path: string, options?: IdWriteOptions): Promise<{ body: unknown; etag: string | null; operationId: string | null }> {
      const response = await call(write, method, path, options)
      return { body: await response.json(), etag: response.headers.get("ETag"), operationId: response.headers.get("Operation-Id") }
    },
  }
}
/** ID's admin API as a server's machine client. */
export type IdAdmin = ReturnType<typeof createIdAdmin>
