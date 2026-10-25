import { adminApi, type Call, failure, findBySlug, platformOrganisation } from "./admin-api"
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
  /** The platform organisation's slug, `answerable` in ID. */
  platformSlug: string
  /** Claude Code's `--callback-port`, in the host clients' redirect URI. */
  callbackPort: number
  /** The staff email domain and the Microsoft Entra tenant that signs the staff in, to connect to the platform organisation. */
  staff?: { domain: string; entraTenant: string }
  store: SecretStore
  fetch?: typeof globalThis.fetch
  log?: (line: string) => void
  /** How long one call to ID may take before register fails naming it. */
  timeoutMs?: number
}

/** Where each machine client's secret goes: the Secrets the Toolbox, the admin MCP and the standalone server read. */
export const clientSecrets = {
  "toolbox-hub": { secret: "toolbox-id-client", key: "TOOLBOX_ID_CLIENT_SECRET" },
  "admin-mcp": { secret: "admin-id-client", key: "ADMIN_ID_CLIENT_SECRET" },
  "standalone-hub": { secret: "standalone-id-client", key: "STANDALONE_ID_CLIENT_SECRET" },
} as const satisfies Record<string, SecretRef>
const clientNames: Record<keyof typeof clientSecrets, string> = { "toolbox-hub": "Toolbox", "admin-mcp": "Admin MCP", "standalone-hub": "Standalone server" }

/** The `Idempotency-Key`s of the staff domain and directory: those of `apps/web/content/docs/id/onboard.mdx` § First run. */
const STAFF_KEYS = { domain: "platform-domain-setup", sso: "platform-sso-setup" } as const

const roles = ["team", "admin", "owner"] as const

/**
 * Register the Toolbox and the admin MCP in ID as their docs do (apps/web/content/docs/toolbox/admin.mdx and admin/setup.mdx), with the same
 * calls and `Idempotency-Key`s, then the standalone server's machine client, `standalone-hub` (`platform:read` on ID's admin API), and store each
 * machine client's secret the moment ID answers it. Safe to run again: a call ID has seen
 * replays, and an object that already exists (made under another key or by another caller) is left as it is. A machine client that exists
 * while its secret is not stored gets a new one, rotated in ID. With `staff`, then connects the staff domain and directory (see
 * {@link connectStaff}). Prints the Claude Code commands and the first owner's step; never a secret.
 */
export async function register({ id, token, toolbox, adminMcp, platformSlug, callbackPort, staff, store, fetch = globalThis.fetch, log = console.log, timeoutMs = 30_000 }: Options) {
  const admin = `${id}/api/admin`
  const toolboxResource = `${toolbox}/mcp`
  const toolboxAdmin = `${toolbox}/admin`
  const adminResource = `${adminMcp}/mcp`
  const callback = `http://localhost:${callbackPort}/callback`
  const call = adminApi({ id, token, fetch, timeoutMs, rootLocked: "ID refused the root secret (root_locked): a platform administrator exists. Pass a staff token as OPS_ID_TOKEN (docs/id/onboard#get-a-staff-token)" })

  /** A write with its key: created, replayed, or already there (a conflict on create, or 200 on a PUT that links). Anything else throws. */
  async function write(method: string, path: string, key: string, body?: unknown) {
    const answer = await call(method, path, { key, body })
    const existed = (answer.status === 409 && answer.body.code === "conflict") || (method === "PUT" && answer.status === 200)
    if (!answer.ok && !existed) throw new Error(`${method} ${path} (Idempotency-Key ${key}) answered ${answer.status} ${answer.body.code ?? ""}`.trimEnd())
    log(`${key}: ${answer.replayed ? "replayed" : existed ? "already there" : "done"}`)
    return answer.body
  }
  /** A machine client of the platform organisation: its secret stored from the creation's answer, or rotated when it exists unstored. */
  async function machine(clientId: keyof typeof clientSecrets, key: string, scopes: string[]) {
    const ref = clientSecrets[clientId]
    const created = await write("POST", "/clients", key, { clientId, name: clientNames[clientId], organizationId: platform, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], clientCredentialsScopes: scopes })
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

  const platform = await platformOrganisation(call, platformSlug)

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
    groups[role] = (await findBySlug(call, `/organizations/${platform}/groups`, `answerable-${role}`))!
    await write("POST", `/organizations/${platform}/entitlements`, `admin-role-${role}-v1`, { groupId: groups[role], resource: adminResource, scopes: [`answerable-${role}`] })
  }
  await machine("admin-mcp", "admin-mcp-v1", ["platform:read", "platform:write", "toolbox:admin"])
  await link("admin-mcp-link-id-v1", "admin-mcp", admin)
  await capability("admin-mcp-capability-id-v1", "admin-mcp", admin, "client_credentials", ["platform:read", "platform:write"])
  await link("admin-mcp-link-toolbox-v1", "admin-mcp", toolboxAdmin)
  await capability("admin-mcp-capability-toolbox-v1", "admin-mcp", toolboxAdmin, "client_credentials", ["toolbox:admin"])

  // The standalone server's machine client, which reads who is calling from ID's admin API, as the Toolbox's does. Registering each MCP it
  // serves is not yet automatic.
  await machine("standalone-hub", "standalone-hub-v1", ["platform:read"])
  await link("standalone-hub-link-v1", "standalone-hub", admin)
  await capability("standalone-hub-capability-v1", "standalone-hub", admin, "client_credentials", ["platform:read"])

  if (staff) await connectStaff(call, platform, staff, log)

  log(`
Registered. Next:
1. Connect Claude Code to the admin MCP and the Toolbox:
   claude mcp add --transport http answerable-admin ${adminResource} --client-id claude-code-admin --callback-port ${callbackPort}
   claude mcp add --transport http answerable-toolbox ${toolboxResource} --client-id claude-code-toolbox --callback-port ${callbackPort}
2. The first owner: sign in once at ${id}/login with your work account, then run the ops Job make-admin with your email,
   which puts you in the owner and platform-admins groups and locks ID's root secret.`)
  return { platform, ownerGroup: groups.owner }
}

/**
 * The staff domain on the platform organisation and the Entra tenant as its SSO provider, through Answerable's Microsoft
 * platform application, then the provider's connectivity test: `onboard.mdx` § First run, step 3, with its keys. Safe to
 * run again: a step ID has seen replays, and an equal domain or provider is left as it is. A provider that differs is left
 * as it is too, with a warning: replacing it would sign everyone out of it. Without a Microsoft application in ID the
 * provider is skipped with a line, and register goes on.
 */
async function connectStaff(call: Call, platform: string, { domain, entraTenant }: { domain: string; entraTenant: string }, log: (line: string) => void) {
  const issuer = `https://login.microsoftonline.com/${entraTenant}/v2.0`
  const domains = `/organizations/${platform}/domains`
  const added = await call("POST", domains, { key: STAFF_KEYS.domain, body: { domain } })
  if (added.status === 201) log(`Staff domain ${domain}: ${added.replayed ? "done before (replayed)" : "added"}`)
  else if (added.status === 409) {
    const listed = await call("GET", `${domains}?limit=200`)
    if (!listed.ok) throw failure("GET", domains, listed)
    if (!(listed.body.items as { domain: string }[]).some(item => item.domain === domain))
      throw new Error(`The staff domain ${domain} belongs to another organisation: remove it there, then run register again`)
    log(`Staff domain ${domain}: already on the platform organisation`)
  } else throw failure("POST", domains, added)

  const provider = `/organizations/${platform}/sso-provider`
  const put = await call("PUT", provider, { key: STAFF_KEYS.sso, ifNoneMatch: true, body: { issuer, domain } })
  if (put.status === 200 || put.status === 201) log(`Staff directory ${issuer}: ${put.replayed ? "done before (replayed)" : "connected"}`)
  else if (put.status === 412) {
    const current = await call("GET", provider)
    if (!current.ok) throw failure("GET", provider, current)
    if (current.body.issuer !== issuer || current.body.domain !== domain) {
      log(`Warning: the platform organisation's SSO provider is another one (issuer ${String(current.body.issuer)}, domain ${String(current.body.domain)}), left as it is. Replacing it signs everyone out of it: do that by hand with If-Match (docs/id/onboard)`)
      return
    }
    log(`Staff directory ${issuer}: already connected`)
  } else if (put.body.code === "platform_application_missing") {
    log("Staff directory not connected: ID has no Microsoft client (MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in id-env). Set them in the GitHub environment, deploy, and run register again")
    return
  } else throw failure("PUT", provider, put)

  const test = await call("GET", `${provider}/test`)
  if (!test.ok) throw failure("GET", `${provider}/test`, test)
  const result = test.body as unknown as {
    kind: string
    discovery: { url: string; reachable: boolean; status: number | null; issuerMatches: boolean | null }
    jwks: { reachable: boolean; keys: number | null }
    elapsedMs: number
    problems: { code: string; detail: string }[]
  }
  log(`Connectivity test (${result.kind}, ${result.elapsedMs} ms):
  discovery  ${result.discovery.url}: ${result.discovery.reachable ? "reachable" : "unreachable"}, HTTP ${result.discovery.status ?? "none"}, issuer ${result.discovery.issuerMatches ? "matches" : "does not match"}
  JWKS       ${result.jwks.reachable ? "reachable" : "unreachable"}, ${result.jwks.keys ?? 0} keys
  problems   ${result.problems.length ? result.problems.map(problem => `${problem.code}: ${problem.detail}`).join("; ") : "none"}${result.problems.length ? "\nWarning: the connectivity test found problems; fix them before anyone signs in" : ""}
The test cannot prove the credentials; a sign-in does.`)
}
