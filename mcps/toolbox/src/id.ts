import { z } from "zod"

/** How the Toolbox reaches Answerable ID's admin API: ID's origin, the admin resource and the Toolbox's machine client. */
export type IdConfig = {
  issuer: string
  /** The identifier of ID's admin resource, ID's `ADMIN_RESOURCE_IDENTIFIER`. */
  adminResource: string
  clientId: string
  clientSecret: string
  /** HTTP client. Default: the global fetch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
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

/**
 * ID's admin API as the Toolbox's machine client. Reads (`get`) use a `platform:read` token; the enable operation (`manage`) uses a
 * `platform:read platform:write` token of its own. Each is reused until 30 seconds before it expires and renewed once when ID refuses it.
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
      throw new IdError(response.status, undefined, `Answerable ID refused the Toolbox's client credentials (${response.status}); check TOOLBOX_ID_CLIENT_ID, TOOLBOX_ID_CLIENT_SECRET and the client's ${scope.replace(" ", " and ")} capability for the admin resource`)
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
  async function call(scope: string, method: string, path: string, { body, ifMatch }: { body?: unknown; ifMatch?: string } = {}) {
    const url = `/api/admin/v1${path}`
    // One key per call: a renewed token repeats the same command.
    const key = crypto.randomUUID()
    const send = async () => {
      const authorization = `Bearer ${await accessToken(scope)}`
      return reach(`${method} ${url}`, async () => fetch(new URL(url, issuer), {
        method,
        headers: {
          Authorization: authorization,
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
    const found = problem.safeParse(await response.json().catch(() => undefined))
    const said = found.success ? ` ${found.data.code}: ${found.data.title}` : ""
    throw new IdError(response.status, found.data?.code, `Answerable ID answered ${method} ${url} with ${response.status}${said}`)
  }
  return {
    /** GET a path of the admin API, such as `/audit-events?limit=200`: its JSON, or undefined for 404. A refused token is renewed once. */
    async get(path: string): Promise<unknown> {
      try {
        return await (await call(read, "GET", path)).json()
      } catch (error) {
        if (error instanceof IdError && error.status === 404) return undefined
        throw error
      }
    },
    /**
     * Call the admin API with `platform:read` and `platform:write`, as the enable operation does: a JSON `body`, an `If-Match` tag, a fresh `Idempotency-Key`
     * on every write. Returns the JSON and the response's `ETag`; a status outside 2xx throws `IdError`.
     */
    async manage(method: "GET" | "POST" | "PATCH" | "PUT", path: string, options?: { body?: unknown; ifMatch?: string }): Promise<{ body: unknown; etag: string | null }> {
      const response = await call(write, method, path, options)
      return { body: await response.json(), etag: response.headers.get("ETag") }
    },
  }
}
/** ID's admin API as the Toolbox's machine client. */
export type IdAdmin = ReturnType<typeof createIdAdmin>
