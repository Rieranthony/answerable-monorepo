import type { SecretRef, SecretStore } from "./secret-store"

type Options = {
  /** Answerable ID's origin: its issuer and its admin API's base. */
  id: string
  /** The root secret while no person is a platform administrator, then a staff token (docs/id/onboard). */
  token: string
  /** The Toolbox's origin: `/mcp` is its resource, `/admin` its admin resource. */
  toolbox: string
  /** The admin MCP's origin: `/mcp` is its resource. */
  adminMcp: string
  /** The platform organisation's slug (ID's PLATFORM_ORGANIZATION_SLUG). */
  platformSlug: string
  /** Claude Code's `--callback-port`, in the host clients' redirect URI. */
  callbackPort: number
  store: SecretStore
  fetch?: typeof globalThis.fetch
  log?: (line: string) => void
}

/** Where each machine client's secret goes: the Secrets the Toolbox and the admin MCP read. */
export const clientSecrets = {
  "toolbox-hub": { secret: "toolbox-id-client", key: "TOOLBOX_ID_CLIENT_SECRET" },
  "admin-mcp": { secret: "admin-id-client", key: "ADMIN_ID_CLIENT_SECRET" },
} as const satisfies Record<string, SecretRef>

const roles = ["team", "admin", "owner"] as const
type Problem = { code?: string; title?: string }

/**
 * Register the Toolbox and the admin MCP in ID as their docs do (apps/web/content/docs/toolbox/admin.mdx and admin/setup.mdx), with the same
 * calls and `Idempotency-Key`s, and store each machine client's secret the moment ID answers it. Safe to run again: a call ID has seen
 * replays, and an object that already exists (made under another key or by another caller) is left as it is. A machine client that exists
 * while its secret is not stored gets a new one, rotated in ID. Prints the Claude Code commands and the first owner's step; never a secret.
 */
export async function register({ id, token, toolbox, adminMcp, platformSlug, callbackPort, store, fetch = globalThis.fetch, log = console.log }: Options) {
  const admin = `${id}/api/admin`
  const toolboxResource = `${toolbox}/mcp`
  const toolboxAdmin = `${toolbox}/admin`
  const adminResource = `${adminMcp}/mcp`
  const callback = `http://localhost:${callbackPort}/callback`

  async function call(method: string, path: string, key?: string, body?: unknown) {
    const response = await fetch(`${admin}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown> & Problem
    if (response.status === 403 && parsed.code === "root_locked")
      throw new Error("ID refused the root secret (root_locked): a platform administrator exists. Pass a staff token as OPS_ID_TOKEN (docs/id/onboard#get-a-staff-token)")
    if (response.status === 409 && parsed.code === "idempotency_key_reused")
      throw new Error(`ID refused Idempotency-Key ${key}: it was used before with different input. A registration changed: give it a new key suffix here and in the docs`)
    return { response, body: parsed }
  }
  /** A write with its key: created, replayed, or already there (a conflict on create, or 200 on a PUT that links). Anything else throws. */
  async function write(method: string, path: string, key: string, body?: unknown) {
    const { response, body: answer } = await call(method, path, key, body)
    const existed = (response.status === 409 && answer.code === "conflict") || (method === "PUT" && response.status === 200)
    if (!response.ok && !existed) throw new Error(`${method} ${path} (Idempotency-Key ${key}) answered ${response.status} ${answer.code ?? ""}`.trimEnd())
    log(`${key}: ${response.headers.get("Idempotency-Replayed") === "true" ? "replayed" : existed ? "already there" : "done"}`)
    return answer
  }
  async function list(path: string, slug: string) {
    const { response, body } = await call("GET", `${path}?q=${encodeURIComponent(slug)}&limit=100`)
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status} ${body.code ?? ""}`.trimEnd())
    return (body.items as { id: string; slug: string }[]).find(item => item.slug === slug)?.id
  }
  /** A machine client of the platform organisation: its secret stored from the creation's answer, or rotated when it exists unstored. */
  async function machine(clientId: keyof typeof clientSecrets, key: string, scopes: string[]) {
    const ref = clientSecrets[clientId]
    const created = await write("POST", "/clients", key, { clientId, name: clientId === "admin-mcp" ? "Admin MCP" : "Toolbox", organizationId: platform, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], clientCredentialsScopes: scopes })
    if (typeof created.clientSecret === "string") {
      await store.put(ref, created.clientSecret)
      log(`${clientId}: secret stored in ${ref.secret}/${ref.key}`)
    } else if (!(await store.get(ref))) {
      const rotated = await write("POST", `/clients/${clientId}/rotate-secret`, `${clientId}-rotate-${crypto.randomUUID()}`)
      await store.put(ref, String(rotated.clientSecret))
      log(`${clientId}: its secret was not stored, so ID rotated it; stored in ${ref.secret}/${ref.key}`)
    }
  }
  const capability = (key: string, clientId: string, resource: string | null, grantKind: string, scopes: string[]) =>
    write("POST", `/organizations/${platform}/capabilities`, key, { clientId, resource, grantKind, scopes })
  const link = (key: string, clientId: string, resource: string) => write("PUT", `/clients/${clientId}/resources/${encodeURIComponent(resource)}`, key)

  const platform = await list("/organizations", platformSlug)
  if (!platform) throw new Error(`ID has no organisation with the slug ${platformSlug}: set OPS_PLATFORM_SLUG to the platform organisation's`)

  // The Toolbox: its resource and admin resource, its machine client on ID's admin API, and Claude Code as its host client. The first enable
  // call that names the host client links it and approves it for the organisation (docs/toolbox/admin).
  await write("POST", "/resources", "toolbox-resource-v1", { classification: "platform_shared", organizationId: null, identifier: toolboxResource, name: "Toolbox", allowedScopes: ["offline_access", "toolbox"], accessTokenTtl: 900 })
  await write("POST", "/resources", "toolbox-admin-resource-v1", { classification: "platform_shared", organizationId: null, identifier: toolboxAdmin, name: "Toolbox admin", allowedScopes: ["toolbox:admin"], accessTokenTtl: 300 })
  await machine("toolbox-hub", "toolbox-hub-v1", ["platform:read", "platform:write"])
  await link("toolbox-hub-link-v1", "toolbox-hub", admin)
  await capability("toolbox-hub-capability-v1", "toolbox-hub", admin, "client_credentials", ["platform:read", "platform:write"])
  await write("POST", "/clients", "claude-code-toolbox-v1", { clientId: "claude-code-toolbox", name: "Claude Code (Toolbox)", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], redirectUris: [callback], scopes: ["openid", "offline_access", "toolbox"] })

  // The admin MCP: its resource, Claude Code as its host client with the platform organisation's access, a group per role, and its machine
  // client on ID's admin API and the Toolbox's admin API (docs/admin/setup).
  await write("POST", "/resources", "admin-mcp-resource-v1", { classification: "platform_shared", organizationId: null, identifier: adminResource, name: "Admin MCP", allowedScopes: ["admin", "answerable-team", "answerable-admin", "answerable-owner", "offline_access"], accessTokenTtl: 900 })
  await write("POST", "/clients", "claude-code-admin-v1", { clientId: "claude-code-admin", name: "Claude Code (admin MCP)", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], redirectUris: [callback], scopes: ["openid", "offline_access", "admin"] })
  await link("claude-code-admin-link-v1", "claude-code-admin", adminResource)
  for (const grant of ["authorization_code", "refresh_token"]) {
    await capability(`admin-login-${grant}-v1`, "claude-code-admin", null, grant, ["openid", "offline_access"])
    await capability(`admin-resource-${grant}-v1`, "claude-code-admin", adminResource, grant, ["admin"])
  }
  await write("POST", `/organizations/${platform}/entitlements`, "admin-login-entitlement-v1", { clientId: "claude-code-admin", scopes: ["openid", "offline_access"] })
  await write("POST", `/organizations/${platform}/entitlements`, "admin-resource-entitlement-v1", { clientId: "claude-code-admin", resource: adminResource, scopes: ["admin"] })
  const groups = {} as Record<(typeof roles)[number], string>
  for (const role of roles) {
    await write("POST", `/organizations/${platform}/groups`, `admin-group-${role}-v1`, { slug: `answerable-${role}`, name: `Answerable ${role}` })
    // A replay answers the receipt, not the group, so the group is found by its slug.
    groups[role] = (await list(`/organizations/${platform}/groups`, `answerable-${role}`))!
    await write("POST", `/organizations/${platform}/entitlements`, `admin-role-${role}-v1`, { groupId: groups[role], resource: adminResource, scopes: [`answerable-${role}`] })
  }
  await machine("admin-mcp", "admin-mcp-v1", ["platform:read", "platform:write", "toolbox:admin"])
  await link("admin-mcp-link-id-v1", "admin-mcp", admin)
  await capability("admin-mcp-capability-id-v1", "admin-mcp", admin, "client_credentials", ["platform:read", "platform:write"])
  await link("admin-mcp-link-toolbox-v1", "admin-mcp", toolboxAdmin)
  await capability("admin-mcp-capability-toolbox-v1", "admin-mcp", toolboxAdmin, "client_credentials", ["toolbox:admin"])

  log(`
Registered. Next:
1. Connect Claude Code to the admin MCP and the Toolbox:
   claude mcp add --transport http answerable-admin ${adminResource} --client-id claude-code-admin --callback-port ${callbackPort}
   claude mcp add --transport http answerable-toolbox ${toolboxResource} --client-id claude-code-toolbox --callback-port ${callbackPort}
2. The first owner: sign in once at ${id}/login, find your membership with
   curl --get "${admin}/v1/organizations/${platform}/members" -H "Authorization: Bearer $TOKEN" --data-urlencode "email=you@answerable.org"
   and put it in the owner group:
   curl -X PUT "${admin}/v1/organizations/${platform}/groups/${groups.owner}/members/$MEMBER" -H "Idempotency-Key: admin-first-owner-v1" -H "If-None-Match: *" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'`)
  return { platform, ownerGroup: groups.owner }
}
