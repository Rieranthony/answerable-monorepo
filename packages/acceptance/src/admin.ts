import { z } from "zod"
import type { Spare } from "./id"

/** Call ID's admin API as root: `admin("POST", "/organizations", { slug, name })`, with any extra `headers`. Every call carries a fresh `Idempotency-Key`; a status outside 2xx throws with the body. A `204` answers `{}`. */
export type Admin = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Record<string, unknown>>

export function createAdmin({ idOrigin, rootSecret }: { idOrigin: string; rootSecret: string }): Admin {
  return async (method, path, body, headers) => {
    const response = await fetch(`${idOrigin}/api/admin/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${rootSecret}`,
        "Idempotency-Key": crypto.randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`)
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>
  }
}

const signIn = ["openid", "offline_access"]

/** Register an MCP's resource in ID, as an operator does for a new MCP. `scopes` are what its tools ask for; `offline_access` is added unless listed. */
export function registerResource(admin: Admin, { identifier, scopes, accessTokenTtl }: { identifier: string; scopes: readonly string[]; accessTokenTtl: number }) {
  return admin("POST", "/resources", { classification: "platform_shared", organizationId: null, identifier, name: identifier, allowedScopes: [...new Set([...scopes, "offline_access"])], accessTokenTtl })
}

/** Register a public client that signs people in with the authorisation code flow and refresh tokens, limited to `scopes`. */
export function registerClient(admin: Admin, { clientId, redirectUri, scopes }: { clientId: string; redirectUri: string; scopes: readonly string[] }) {
  return admin("POST", "/clients", {
    clientId,
    name: clientId,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    redirectUris: [redirectUri],
    scopes: [...signIn, ...scopes],
  })
}

/** Let a client ask for a resource's scopes. */
export function linkClient(admin: Admin, clientId: string, resource: string) {
  return admin("PUT", `/clients/${clientId}/resources/${encodeURIComponent(resource)}`)
}

/** Approve a client and a resource for an organisation (the capabilities, for both grant kinds) and entitle its members to `entitledScopes`, all of `scopes` by default. */
export async function grantOrganisation(
  admin: Admin,
  organizationId: string,
  { clientId, resource, scopes, entitledScopes = scopes }: { clientId: string; resource: string; scopes: readonly string[]; entitledScopes?: readonly string[] },
) {
  const path = `/organizations/${organizationId}`
  for (const grantKind of ["authorization_code", "refresh_token"]) {
    await admin("POST", `${path}/capabilities`, { clientId, resource: null, grantKind, scopes: signIn })
    await admin("POST", `${path}/capabilities`, { clientId, resource, grantKind, scopes })
  }
  await admin("POST", `${path}/entitlements`, { clientId, scopes: signIn })
  await admin("POST", `${path}/entitlements`, { clientId, resource, scopes: entitledScopes })
}

/**
 * Register a machine client owned by an organisation, for the `client_credentials` grant. `audiences` maps each resource it may ask a token for to the scopes it may ask there: `{ [adminResource]: ["platform:read"], [other]: ["other:admin"] }`.
 * Links the client to each resource and approves those scopes there. Returns the client id and its secret, which ID shows only once: spread it into `createIdAdmin`.
 */
export async function registerMachine(admin: Admin, organizationId: string, clientId: string, audiences: Readonly<Record<string, readonly string[]>>) {
  const entries = Object.entries(audiences)
  const created = z.object({ clientSecret: z.string() }).parse(
    await admin("POST", "/clients", {
      clientId,
      name: clientId,
      organizationId,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      clientCredentialsScopes: [...new Set(entries.flatMap(([, scopes]) => scopes))],
    }),
  )
  for (const [audience, scopes] of entries) {
    await linkClient(admin, clientId, audience)
    await admin("POST", `/organizations/${organizationId}/capabilities`, { clientId, resource: audience, grantKind: "client_credentials", scopes })
  }
  return { clientId, clientSecret: created.clientSecret }
}

/** Route `domain` to an organisation. */
export function addDomain(admin: Admin, organizationId: string, domain: string) {
  return admin("POST", `/organizations/${organizationId}/domains`, { domain })
}

/** Set an organisation's single sign-on to a directory of the fixture, such as a spare, with the directory's own credentials. The organisation must already hold `spare.domain` and have no single sign-on yet: the call sends `If-None-Match: *`. */
export function setSsoProvider(admin: Admin, organizationId: string, { issuer, domain, clientId, clientSecret, authorizationEndpoint, tokenEndpoint, jwksEndpoint }: Spare) {
  const body = { issuer, domain, oidc: { credentials: "own", clientId, clientSecret, authorizationEndpoint, tokenEndpoint, jwksEndpoint } }
  return admin("PUT", `/organizations/${organizationId}/sso-provider`, body, { "If-None-Match": "*" })
}
