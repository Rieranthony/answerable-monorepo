import { adminApi, type Call, clientToken, failure, findBySlug, platformOrganisation } from "./admin-api"
import { createRegistrar, hostClient, hostGrants, registerStandalone, signIn, toolboxRows } from "./registrar"
import type { SecretRef, SecretStore } from "./secret-store"

/** An MCP of charts/answerable/mcps.json as register reads it: its name, where it runs and its manifest's scopes. */
export type RegisteredMcp = { name: string; serve: "toolbox" | "standalone" | "both"; scopes: readonly string[] }

type Options = {
  /** Answerable ID's origin: its issuer and its admin API's base. */
  id: string
  /**
   * The bearer that mints register's own machine client, ops-register, while the Secret ops-id-client holds none: ID's root secret before a person
   * is a platform administrator, a staff token after (docs/id/onboard). Unused once ops-register's secret is stored.
   */
  token?: string
  /** The Toolbox's origin: `/mcp` is its resource, `/admin` its admin resource. */
  toolbox: string
  /** The admin MCP's origin: `/mcp` is its resource. */
  adminMcp: string
  /** The standalone server's origin: each standalone or both MCP is the resource `<origin>/<name>/mcp`. */
  mcpOrigin: string
  /** The MCPs of charts/answerable/mcps.json: each standalone or both one is registered. */
  mcps: readonly RegisteredMcp[]
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

/** Where each machine client's secret goes: register's own, and the Secrets the Toolbox, the admin MCP and the standalone server read. */
const clientSecrets = {
  "ops-register": { secret: "ops-id-client", key: "OPS_ID_CLIENT_SECRET" },
  "toolbox-hub": { secret: "toolbox-id-client", key: "TOOLBOX_ID_CLIENT_SECRET" },
  "admin-mcp": { secret: "admin-id-client", key: "ADMIN_ID_CLIENT_SECRET" },
  "standalone-hub": { secret: "standalone-id-client", key: "STANDALONE_ID_CLIENT_SECRET" },
} as const satisfies Record<string, SecretRef>
type Machine = keyof typeof clientSecrets
const clientNames: Record<Machine, string> = { "ops-register": "Ops register", "toolbox-hub": "Toolbox", "admin-mcp": "Admin MCP", "standalone-hub": "Standalone server" }

/** The one-time remedy when register has no client of its own and nothing to mint it with. */
const once = "Once: put a staff token in the Secret ops-staff-token (key OPS_ID_TOKEN) and run register again; it mints its client, ops-register, and needs no token after that (infra/README.md#register-again)"
const noClient = "register has no machine client of its own yet (the Secret ops-id-client is empty)"
const remedy = `${noClient}, and ID refuses the root secret (root_locked): a platform administrator exists. ${once}`

/** The `Idempotency-Key`s of the staff domain and directory: those of `apps/web/content/docs/id/onboard.mdx` § First run. */
const STAFF_KEYS = { domain: "platform-domain-setup", sso: "platform-sso-setup" } as const

const roles = ["team", "admin", "owner"] as const

/**
 * Register in ID what the deployment needs, as register's own machine client, `ops-register` (`platform:read platform:write`): the run that finds no
 * secret in `ops-id-client` mints that client with `token` first, stores its secret, and goes on with it; every later run needs neither the root
 * secret nor a staff token. Then the Toolbox and the admin MCP, as their docs register them (apps/web/content/docs/toolbox/admin.mdx and
 * admin/setup.mdx), the standalone server's machine client, `standalone-hub`, and for each standalone or both MCP of `mcps` its resource,
 * `<mcpOrigin>/<name>/mcp`, its Claude Code client, `claude-code-<name>`, and their link.
 *
 * Every resource and client is read first: one ID lacks is created with its docs' `Idempotency-Key`; one that differs is changed with `If-Match`,
 * under `<key>-r<revision>`, in the fields that differ. Scopes and redirect URIs only widen: the Toolbox's resource keeps what enable calls added. An
 * MCP's own resource follows its manifest, and a scope the manifest dropped is logged as it goes. An MCP removed from the list keeps its rows.
 * Links are made under `<key>-r<revision>` of the client when its read lacks them; capabilities, entitlements and groups are created when missing.
 * Each machine client's secret is stored the moment ID answers it, and one that exists while its secret is not stored is rotated. With `staff`,
 * then connects the staff domain and directory (see {@link connectStaff}). Prints the Claude Code commands and the first owner's step; never a secret.
 */
export async function register({ id, token, toolbox, adminMcp, mcpOrigin, mcps, platformSlug, callbackPort, staff, store, fetch = globalThis.fetch, log = console.log, timeoutMs = 30_000 }: Options) {
  const admin = `${id}/api/admin`
  const toolboxAdmin = `${toolbox}/admin`
  const adminResource = `${adminMcp}/mcp`
  const callback = `http://localhost:${callbackPort}/callback`
  const started = performance.now()
  const asOpsRegister = (clientSecret: string) => adminApi({
    id, fetch, timeoutMs, rootLocked: remedy,
    token: clientToken({
      id, clientId: "ops-register", clientSecret, fetch, timeoutMs,
      refused: "ID refused ops-register's client credentials: the Secret ops-id-client holds a secret ID does not. Empty its key OPS_ID_CLIENT_SECRET, put a staff token in ops-staff-token and run register again, which rotates it (infra/README.md#register-again)",
    }),
  })

  const stored = await store.get(clientSecrets["ops-register"])
  if (!stored && !token) throw new Error(`${noClient}, and no root secret or staff token to mint one. ${once}`)
  let call: Call = stored ? asOpsRegister(stored) : adminApi({ id, token: token!, fetch, timeoutMs, rootLocked: remedy })
  // The registrar calls ID as whoever `call` is at the time: the bearer until ops-register is minted, then ops-register.
  const registrar = createRegistrar((...args) => call(...args), log)
  const { tally, write, link } = registrar

  /**
   * A machine client of the platform organisation with, on each audience, its link and its capability: its secret stored from the creation's
   * answer, or rotated when it exists unstored.
   */
  async function machine(clientId: Machine, audiences: [string, string, string[]][]) {
    const ref = clientSecrets[clientId]
    const scopes = [...new Set(audiences.flatMap(([, , granted]) => granted))]
    const held = await registrar.client(`${clientId}-v1`, { clientId, name: clientNames[clientId], organizationId: platform, tokenEndpointAuthMethod: "client_secret_basic", grantTypes: ["client_credentials"], clientCredentialsScopes: scopes })
    if (typeof held.created?.clientSecret === "string") {
      await store.put(ref, held.created.clientSecret)
      log(`${clientId}: secret stored in ${ref.secret}/${ref.key}`)
    } else if (!(await store.get(ref))) {
      const rotated = await write("POST", `/clients/${clientId}/rotate-secret`, `${clientId}-rotate-${crypto.randomUUID()}`)
      await store.put(ref, String(rotated.clientSecret))
      log(`${clientId}: its secret was not stored, so ID rotated it; stored in ${ref.secret}/${ref.key}`)
    }
    for (const [suffix, audience, granted] of audiences) {
      await link(`${clientId}-link${suffix}-v1`, clientId, audience, held)
      await capability(`${clientId}-capability${suffix}-v1`, clientId, audience, "client_credentials", granted)
    }
  }
  const capability = (key: string, clientId: string, target: string | null, grantKind: string, scopes: string[]) =>
    write("POST", `/organizations/${platform}/capabilities`, key, { clientId, resource: target, grantKind, scopes }, { create: true })
  const entitlement = (key: string, body: Record<string, unknown>) => write("POST", `/organizations/${platform}/entitlements`, key, body, { create: true })

  const platform = await platformOrganisation(call, platformSlug)
  if (stored) log("Registering as ops-register, register's own machine client")
  else {
    // Its own machine client first, so that every later run needs neither the root secret nor a staff token; this run goes on with it.
    await machine("ops-register", [["", admin, ["platform:read", "platform:write"]]])
    call = asOpsRegister((await store.get(clientSecrets["ops-register"]))!)
    log("ops-register is minted: register goes on as its own machine client, and needs no root secret or staff token again")
  }

  // The Toolbox: its resource and admin resource, its machine client on ID's admin API, and Claude Code as its host client. The first enable
  // call that names the host client links it and approves it for the organisation (docs/toolbox/admin).
  const toolboxed = toolboxRows(toolbox, callback)
  for (const [key, fields] of toolboxed.resources) await registrar.resource(key, fields)
  await machine("toolbox-hub", [["", admin, ["platform:read", "platform:write"]]])
  await registrar.client(...toolboxed.host)

  // The admin MCP: its resource, Claude Code as its host client with the platform organisation's access, a group per role, and its machine
  // client on ID's admin API and the Toolbox's admin API (docs/admin/setup).
  await registrar.resource("admin-mcp-resource-v1", { identifier: adminResource, name: "Admin MCP", allowedScopes: ["admin", "answerable-team", "answerable-admin", "answerable-owner", "offline_access"], accessTokenTtl: 900 })
  const adminHost = await registrar.client("claude-code-admin-v1", hostClient("claude-code-admin", "Claude Code (admin MCP)", ["admin"], callback))
  await link("claude-code-admin-link-v1", "claude-code-admin", adminResource, adminHost)
  for (const grant of hostGrants) {
    await capability(`admin-login-${grant}-v1`, "claude-code-admin", null, grant, signIn)
    await capability(`admin-resource-${grant}-v1`, "claude-code-admin", adminResource, grant, ["admin"])
  }
  await entitlement("admin-login-entitlement-v1", { clientId: "claude-code-admin", scopes: signIn })
  await entitlement("admin-resource-entitlement-v1", { clientId: "claude-code-admin", resource: adminResource, scopes: ["admin"] })
  const groups = {} as Record<(typeof roles)[number], string>
  for (const role of roles) {
    await write("POST", `/organizations/${platform}/groups`, `admin-group-${role}-v1`, { slug: `answerable-${role}`, name: `Answerable ${role}` }, { create: true })
    // A replay answers the receipt, not the group, so the group is found by its slug.
    groups[role] = (await findBySlug(call, `/organizations/${platform}/groups`, `answerable-${role}`))!
    await entitlement(`admin-role-${role}-v1`, { groupId: groups[role], resource: adminResource, scopes: [`answerable-${role}`] })
  }
  await machine("admin-mcp", [["-id", admin, ["platform:read", "platform:write"]], ["-toolbox", toolboxAdmin, ["toolbox:admin"]]])

  // The standalone server's machine client, which reads who is calling from ID's admin API, as the Toolbox's does; then each MCP it serves.
  await machine("standalone-hub", [["", admin, ["platform:read"]]])
  const standalone = mcps.filter(mcp => mcp.serve !== "toolbox")
  for (const mcp of standalone) await registerStandalone(registrar, mcp, { mcpOrigin, callback })

  if (staff) await connectStaff(call, platform, staff, log)

  log(`
Registered in ${((performance.now() - started) / 1000).toFixed(1)} s: ${tally.made} created, ${tally.changed} changed, ${tally.found} as declared already; ${standalone.length} standalone MCP${standalone.length === 1 ? "" : "s"}.
Next:
1. Connect Claude Code to the admin MCP, the Toolbox and each standalone MCP:
   claude mcp add --transport http answerable-admin ${adminResource} --client-id claude-code-admin --callback-port ${callbackPort}
   claude mcp add --transport http answerable-toolbox ${toolbox}/mcp --client-id claude-code-toolbox --callback-port ${callbackPort}${standalone.map(({ name }) => `
   claude mcp add --transport http ${name} ${mcpOrigin}/${name}/mcp --client-id claude-code-${name} --callback-port ${callbackPort}`).join("")}
   An organisation signs in to a standalone MCP once staff have run standalone_enable for it in the admin MCP.
2. While nobody is the first owner: sign in once at ${id}/login with your work account, then run the ops Job make-admin with your email,
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
