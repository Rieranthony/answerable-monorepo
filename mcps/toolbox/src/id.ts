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

const issued = z.object({ access_token: z.string(), expires_in: z.number() })

/** Read ID's admin API as the Toolbox's machine client, with a `platform:read` token reused until 30 seconds before it expires. */
export function createIdAdmin({ issuer, adminResource, clientId, clientSecret, fetch = globalThis.fetch }: IdConfig) {
  let token: { value: string; expiresAt: number } | undefined
  let pending: Promise<string> | undefined
  async function issue() {
    const response = await fetch(new URL("/auth/oauth2/token", issuer), {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: adminResource, scope: "platform:read" }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      throw new Error(`Answerable ID refused the Toolbox's client credentials (${response.status}); check TOOLBOX_ID_CLIENT_ID, TOOLBOX_ID_CLIENT_SECRET and the client's platform:read capability for the admin resource`)
    }
    const body = issued.parse(await response.json())
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return token.value
  }
  const accessToken = async () => token && Date.now() < token.expiresAt - 30_000 ? token.value : (pending ??= issue().finally(() => { pending = undefined }))
  const request = async (path: string) => fetch(new URL(path, issuer), { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(5000) })
  return {
    /** GET a path of the admin API, such as `/audit-events?limit=200`: its JSON, or undefined for 404. A refused token is renewed once. */
    async get(path: string): Promise<unknown> {
      const url = `/api/admin/v1${path}`
      let response = await request(url)
      if (response.status === 401) {
        token = undefined
        response = await request(url)
      }
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`Answerable ID answered GET ${url} with ${response.status}`)
      return response.json()
    },
  }
}
