/** Call ID's admin API as root: `admin("POST", "/organizations", { slug, name })`. Every call carries a fresh `Idempotency-Key`; a status outside 2xx throws with the body. */
export type Admin = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Record<string, unknown>>

export function createAdmin({ idOrigin, rootSecret }: { idOrigin: string; rootSecret: string }): Admin {
  return async (method, path, body, headers = {}) => {
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
    return (await response.json()) as Record<string, unknown>
  }
}

const signIn = ["openid", "offline_access"]

/** Register an MCP's resource in ID, as an operator does for a new MCP. `scopes` are what its tools ask for; `offline_access` is added. */
export function registerResource(admin: Admin, { identifier, scopes, accessTokenTtl }: { identifier: string; scopes: readonly string[]; accessTokenTtl: number }) {
  return admin("POST", "/resources", { classification: "platform_shared", organizationId: null, identifier, name: identifier, allowedScopes: [...scopes, "offline_access"], accessTokenTtl })
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

/** Entitle an organisation, one member (`memberId`) or one group (`groupId`) to a resource's scopes, for every client. */
export function entitle(admin: Admin, organizationId: string, { resource, scopes, memberId, groupId }: { resource: string; scopes: readonly string[]; memberId?: string; groupId?: string }) {
  return admin("POST", `/organizations/${organizationId}/entitlements`, { resource, scopes, memberId, groupId })
}
