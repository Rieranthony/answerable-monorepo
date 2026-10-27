// What Answerable ID needs so that an organisation's people can sign in to a standalone MCP through a host client, as the rows to make. The admin MCP's
// standalone_enable previews and commits them; bun mcp dev makes them on a developer's machine: one plan, so that the two never differ.

/** A capability or an entitlement of ID, as far as the plan reads it. */
export type Row = { id: string; clientId: string | null; resource: string | null; grantKind?: string; memberId?: string | null; groupId?: string | null; scopes: string[]; status: string }

/** One row to make, in order: a host client's link to the resource (`PUT`), or a capability or an entitlement (`POST` with its `body`). */
type Step = { what: string; method: "PUT" | "POST"; path: string; body?: Record<string, unknown> }

/** A row ID holds for a target that does not fit: not active, or lacking scopes. The message says what to do to it; `details` say which row. */
export class RowConflict extends Error {
  constructor(message: string, readonly details: { id: string; status: string; scopes: string[] }) {
    super(message)
    this.name = "RowConflict"
  }
}

// What ID needs to sign a person in through a host client: the login and the MCP's resource, each for both grant kinds.
const grantKinds = ["authorization_code", "refresh_token"] as const
/** The scopes of the login every host client needs. */
const signIn = ["openid", "offline_access"]

/** A row ID holds counts when it is active and carries what is needed; any other row of the same target stops the plan, naming it. */
function held(row: Row | undefined, needed: readonly string[], label: string) {
  if (!row) return false
  const lacking = needed.filter(scope => !row.scopes.includes(scope))
  if (row.status === "active" && !lacking.length) return true
  const fix = [row.status === "active" ? "" : "enable it", lacking.length ? `give it at least ${needed.join(" ")}` : ""].filter(Boolean).join(" and ")
  throw new RowConflict(`Answerable ID already holds the ${label} (${row.id}) with status ${row.status} and scopes ${row.scopes.join(" ")}; ${fix}`, { id: row.id, status: row.status, scopes: row.scopes })
}

/**
 * The rows still to make, in order, for organisation `organizationId` to sign in to standalone MCP `mcp`, whose resource is `resource` and whose
 * scopes are `mcpScopes` (those of its resource but `offline_access`), through each of `hostClientIds`. `linked` are the clients its resource is
 * linked to, `capabilities` the organisation's, and `entitlements(clientId)` reads the organisation's entitlements through one client. For each
 * client: its link; the login and MCP capabilities for both grant kinds; the organisation-wide login entitlement, and with `everyone` the
 * organisation-wide entitlement of the MCP's scopes, which ID counts towards a person's token only through the client it names. A row that exists
 * is not made again; one that exists but does not fit throws {@link RowConflict}. Nothing is read or written here: an empty list means nothing is left.
 */
export async function enablementSteps({ organizationId, mcp, resource, mcpScopes, linked, hostClientIds, everyone, capabilities, entitlements }: {
  organizationId: string
  mcp: string
  resource: string
  mcpScopes: readonly string[]
  linked: readonly string[]
  hostClientIds: readonly string[]
  everyone: boolean
  capabilities: readonly Row[]
  entitlements: (clientId: string) => Promise<readonly Row[]>
}) {
  const steps: Step[] = []
  for (const clientId of hostClientIds) {
    if (!linked.includes(clientId)) steps.push({ what: `link ${clientId}`, method: "PUT", path: `/clients/${encodeURIComponent(clientId)}/resources/${encodeURIComponent(resource)}` })
    for (const [name, reach, needed] of [["login", null, signIn], [mcp, resource, mcpScopes]] as const) {
      for (const grantKind of grantKinds) {
        const found = capabilities.find(item => item.clientId === clientId && item.resource === reach && item.grantKind === grantKind)
        if (!held(found, needed, `${name} ${grantKind} capability of ${clientId}`)) {
          steps.push({ what: `capability ${clientId} ${name} ${grantKind}`, method: "POST", path: `/organizations/${organizationId}/capabilities`, body: { clientId, resource: reach, grantKind, scopes: needed } })
        }
      }
    }
    const through = await entitlements(clientId)
    for (const [name, reach, needed] of [["login", null, signIn], ...(everyone ? [[mcp, resource, mcpScopes] as const] : [])] as const) {
      const found = through.find(item => item.resource === reach && !item.memberId && !item.groupId)
      if (!held(found, needed, `${name} entitlement of ${clientId}`)) {
        steps.push({ what: `entitlement ${clientId} ${name}`, method: "POST", path: `/organizations/${organizationId}/entitlements`, body: { clientId, ...(reach ? { resource: reach } : {}), scopes: needed } })
      }
    }
  }
  return steps
}
