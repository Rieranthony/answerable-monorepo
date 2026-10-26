// What bun mcp dev does for the developer's organisation, in the local ID and the local Toolbox, so that they can sign in to the MCP and call every
// tool of it. Both are local conveniences: in staging and production staff enable an MCP for an organisation and grant it (toolbox_enable,
// standalone_enable and access_grant in the admin MCP).
import { enablementSteps, RowConflict, type Row } from "@answerable/mcp-admin/enablement"
import type { Call } from "../../infra/ops/src/admin-api"
import type { Registrar } from "../../infra/ops/src/registrar"
import { local, type Stack } from "./local"
import type { Fetch } from "./io"
import { all, createRegistrar, machineToken } from "./local-id"

// Widen the scopes of a capability or an entitlement ID holds at `path` to carry `needed` as well, with If-Match under `<key>-r<revision>`.
async function widen(registrar: Registrar, path: string, key: string, needed: readonly string[]) {
  const held = (await registrar.read(path))!
  await registrar.update(path, key, held, { scopes: [...new Set([...(held.body.scopes as string[]), ...needed])].sort() })
}

/**
 * Give organisation `organization` access to standalone MCP `name`, whose resource and `claude-code-<name>` client are registered: the rows
 * `standalone_enable` makes with `everyone: true`, from the same plan. A capability or an entitlement of the MCP's resource that lacks a scope the MCP
 * gained since is widened first; a row that is not active stops it, naming the row and the command to run again. Safe to repeat. What it did, in words.
 */
export async function giveStandaloneAccess(call: Call, organization: string, name: string, stack: Stack = local) {
  const registrar = createRegistrar(call)
  const resource = `${stack.standalone}/${name}/mcp`
  const hostClientId = `claude-code-${name}`
  const registered = (await registrar.read(`/resources/${encodeURIComponent(resource)}`))!.body
  const mcpScopes = (registered.allowedScopes as string[]).filter(scope => scope !== "offline_access")
  const capabilities = await all<Row>(call, `/organizations/${organization}/capabilities`)
  const entitlements = await all<Row>(call, `/organizations/${organization}/entitlements?clientId=${encodeURIComponent(hostClientId)}`)
  const lacking = (row: Row) => row.clientId === hostClientId && row.resource === resource && row.status === "active" && mcpScopes.some(scope => !row.scopes.includes(scope))
  for (const [kind, rows] of [["capabilities", capabilities], ["entitlements", entitlements]] as const) {
    for (const row of rows.filter(lacking)) {
      await widen(registrar, `/organizations/${organization}/${kind}/${row.id}`, `${name}-${row.id}`, mcpScopes)
      row.scopes = [...new Set([...row.scopes, ...mcpScopes])].sort()
    }
  }
  const steps = await enablementSteps({
    organizationId: organization, mcp: name, resource, mcpScopes, linked: registered.clients as string[], hostClientIds: [hostClientId], everyone: true,
    capabilities, entitlements: async () => entitlements,
  }).catch((error: unknown) => { throw error instanceof RowConflict ? new Error(`${error.message}, then run bun mcp dev ${name} again`) : error })
  for (const step of steps) await registrar.write(step.method, step.path, crypto.randomUUID(), step.body, { create: true })
  const { made, changed } = registrar.tally
  return made || changed ? `${made} made, ${changed} widened` : "already in place"
}

/**
 * Enable provider `name` for organisation `organization` in the local Toolbox, with mcp-dev's `toolbox:admin` token, and grant its grant string, `name`,
 * to everyone in the organisation: widening the organisation's entitlement on the Toolbox's resource, which ID keeps one of, or making it. Safe to repeat.
 * What it did, in words.
 */
export async function enableInToolbox(io: { fetch: Fetch }, call: Call, mcpDev: { clientId: string; clientSecret: string }, organization: string, name: string, stack: Stack = local) {
  const token = await machineToken(io.fetch, mcpDev, stack.toolboxAdminResource, "toolbox:admin", stack)
  if (!token) throw new Error("ID refused mcp-dev a token for the Toolbox's admin API, which needs toolbox:admin: run bun mcp setup again")
  const response = await io.fetch(`${stack.toolbox}/admin/v1/organisations/${organization}/enable`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ hostClientIds: ["claude-code-toolbox"], providers: [name] }), signal: AbortSignal.timeout(30_000),
  })
  const enabled = (await response.json()) as { created?: string[]; error?: { code: string; message: string } }
  if (!response.ok) throw new Error(`the Toolbox answered ${response.status} ${enabled.error?.code}: ${enabled.error?.message}`)
  const registrar = createRegistrar(call)
  const path = `/organizations/${organization}/entitlements`
  const held = (await all<Row & { clientId: string | null }>(call, `${path}?resource=${encodeURIComponent(stack.toolboxResource)}`)).find(row => !row.clientId && !row.memberId && !row.groupId)
  if (held && held.status !== "active") throw new Error(`Answerable ID holds the organisation's entitlement on the Toolbox (${held.id}) with status ${held.status}; enable it with access_enable in the admin MCP, then run bun mcp dev ${name} again`)
  if (held) await widen(registrar, `${path}/${held.id}`, `${name}-toolbox`, [name])
  else await registrar.write("POST", path, crypto.randomUUID(), { resource: stack.toolboxResource, scopes: [name] }, { create: true })
  return `${enabled.created?.length ?? 0} rows made in ID and the catalogue; ${registrar.tally.made + registrar.tally.changed ? `${name} granted to the organisation` : `${name} was granted already`}`
}
