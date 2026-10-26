import { defineMutation, ToolError } from "@answerable/mcp"
import { z } from "zod"
import { commitWith, errors, invalid, named, noPrecondition, organizationId, precondition, scopes, target, type Writes } from "./writes"

// A capability or an entitlement of ID, as far as standalone_enable reads it.
type Row = { id: string; clientId: string | null; resource: string | null; grantKind?: string; memberId?: string | null; groupId?: string | null; scopes: string[]; status: string }
type Resource = { name: string; allowedScopes: string[] | null; clients: string[] }
/** One row to make, in order: a host client's link to the resource (`PUT`), or a capability or an entitlement (`POST` with its `body`). */
type Step = { what: string; method: "PUT" | "POST"; path: string; body?: Record<string, unknown> }

// What ID needs to sign a person in through a host client: the login and the MCP's resource, each for both grant kinds.
const grantKinds = ["authorization_code", "refresh_token"] as const
const signIn = ["openid", "offline_access"]
// bun mcp's rule for an MCP's name.
const mcpName = z.string().regex(/^[a-z][a-z0-9]{0,11}$/, "A lowercase letter, then up to 11 lowercase letters or digits")

/** A row ID holds counts when it is active and carries what is needed; any other row of the same target stops the preparation, naming it. */
function held(row: Row | undefined, needed: readonly string[], label: string) {
  if (!row) return false
  const lacking = needed.filter(scope => !row.scopes.includes(scope))
  if (row.status === "active" && !lacking.length) return true
  const fix = [row.status === "active" ? "" : "enable it", lacking.length ? `give it at least ${needed.join(" ")}` : ""].filter(Boolean).join(" and ")
  throw precondition(`Answerable ID already holds the ${label} (${row.id}) with status ${row.status} and scopes ${row.scopes.join(" ")}; ${fix}, then prepare again`, { id: row.id, status: row.status, scopes: row.scopes })
}

/** ID's refusal of a create because the row exists: someone made it after the preparation read. */
const existed = (error: unknown) => error instanceof ToolError && (error.details?.upstream as { status?: number; code?: string } | undefined)?.code === "conflict"

/**
 * `standalone.enable`: what Answerable ID needs for an organisation's people to sign in to a standalone MCP, the resource `<origin>/<name>/mcp` that
 * the deploy's register Job registered. Without the standalone server's origin configured it stays listed and answers `PRECONDITION_FAILED`
 * saying what to set.
 */
export function standaloneWrites(writes: Writes, origin: string | undefined) {
  const { calls, role, organisation } = writes
  const enable = role("admin", defineMutation({
    name: "standalone.enable", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare giving an organisation access to a standalone MCP, which the standalone server serves at its own URL: for each host client (claude-code-<name> unless named) its link to the MCP, the organisation's sign-in and MCP capabilities for both grant kinds, and the sign-in entitlement for everyone in it. ${commitWith} People then need the MCP's scopes through that host client: access_grant them with clientId set to it, to the organisation, a group or a person, or pass everyone: true to grant them to the whole organisation in the same intent. Undo it with access_revoke. Safe to repeat.`,
    input: z.object({
      organizationId,
      mcp: mcpName.describe("The standalone MCP's name, as bun mcp list shows it, such as acme"),
      hostClientIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional().describe("The OAuth clients people use the MCP from; omit it for claude-code-<name>, which the deploy registers"),
      everyone: z.boolean().optional().describe("Also grant the MCP's scopes to everyone in the organisation, through each host client; omit it to grant them with access_grant"),
    }),
    output: z.object({ created: z.array(z.string()).describe("What the commit made in Answerable ID"), existing: z.array(z.string()).describe("What it found already in place") }),
    async prepare({ organizationId: id, mcp, hostClientIds: asked = [`claude-code-${mcp}`], everyone = false }, context) {
      if (!origin) {
        throw precondition("The admin MCP does not know the standalone server: set ADMIN_STANDALONE_ORIGIN to its origin, such as http://localhost:47510, and restart it", {
          variable: "ADMIN_STANDALONE_ORIGIN",
        })
      }
      const { organisation: row, target: version } = await organisation(id, context)
      const resource = `${origin}/${mcp}/mcp`
      const registered = await calls.versioned<Resource>(`/resources/${encodeURIComponent(resource)}`, context,
        `Answerable ID has no resource ${resource}: ship ${mcp} with serve standalone or both, and the deploy's register Job registers it`)
      const mcpScopes = (registered.body.allowedScopes ?? []).filter(scope => scope !== "offline_access")
      const hostClientIds = [...new Set(asked)].sort()
      for (const clientId of hostClientIds) {
        if (await calls.read(`/clients/${encodeURIComponent(clientId)}`, context) === undefined) throw invalid("hostClientIds", `Answerable ID has no client ${clientId}; register it first`)
      }
      const capabilities = await calls.all<Row>(`/organizations/${id}/capabilities`, context)
      const steps: Step[] = []
      for (const clientId of hostClientIds) {
        if (!registered.body.clients.includes(clientId)) steps.push({ what: `link ${clientId}`, method: "PUT", path: `/clients/${encodeURIComponent(clientId)}/resources/${encodeURIComponent(resource)}` })
        for (const [name, reach, needed] of [["login", null, signIn], [mcp, resource, mcpScopes]] as const) {
          for (const grantKind of grantKinds) {
            const found = capabilities.find(item => item.clientId === clientId && item.resource === reach && item.grantKind === grantKind)
            if (!held(found, needed, `${name} ${grantKind} capability of ${clientId}`)) {
              steps.push({ what: `capability ${clientId} ${name} ${grantKind}`, method: "POST", path: `/organizations/${id}/capabilities`, body: { clientId, resource: reach, grantKind, scopes: needed } })
            }
          }
        }
        // ID counts an entitlement towards a person's token only through its client: the sign-in's, and with everyone the MCP's scopes.
        const entitlements = await calls.all<Row>(`/organizations/${id}/entitlements?clientId=${encodeURIComponent(clientId)}`, context)
        for (const [name, reach, needed] of [["login", null, signIn], ...(everyone ? [[mcp, resource, mcpScopes] as const] : [])] as const) {
          const found = entitlements.find(item => item.resource === reach && !item.memberId && !item.groupId)
          if (!held(found, needed, `${name} entitlement of ${clientId}`)) {
            steps.push({ what: `entitlement ${clientId} ${name}`, method: "POST", path: `/organizations/${id}/entitlements`, body: { clientId, ...(reach ? { resource: reach } : {}), scopes: needed } })
          }
        }
      }
      const reach = `${hostClientIds.join(", ")}${everyone ? `, with ${mcpScopes.join(" ")} for everyone in it` : ""}`
      if (!steps.length) throw precondition(`Organisation ${named(row)} can already sign in to ${mcp} from ${reach}; nothing to enable`, { organizationId: id, resource })
      return {
        targets: [version, target("resource", resource, registered.body.name, registered.etag)],
        preview: {
          summary: `Enable ${mcp} for organisation ${named(row)} from ${reach}`,
          changes: steps.map(step => ({ path: step.what, from: null, to: step.body ?? { linked: resource } })),
          effects: ["permission_change" as const],
          warnings: [
            everyone ? `Everyone in the organisation may use every tool of ${mcp} through ${hostClientIds.join(", ")} once this commits; access_revoke disables those entitlements.`
              : `Nobody may use ${mcp}'s tools yet: grant ${mcpScopes.join(" ")} on ${resource} with access_grant, clientId ${hostClientIds.join(" or ")}, or prepare again with everyone: true.`,
            "Not atomic: if Answerable ID fails part-way, what was made stays; preparing and committing again finishes it, skipping what exists.",
            noPrecondition("creating a capability or an entitlement"),
          ],
        },
        plan: { steps },
      }
    },
    // Each step under the intent's key and its place: a retried commit replays. A capability or entitlement someone made meanwhile is found, not
    // made twice; a link made meanwhile moved the resource's revision, so the commit's prepare already found the intent stale.
    async commit({ intent_id, plan: { steps }, preview }, context) {
      const done = { created: [] as string[], existing: [] as string[] }
      for (const [index, { what, method, path, body }] of steps.entries()) {
        const made = await calls.write(method, path, { body, key: `${intent_id}.${index}` }, context).then(() => true, (error: unknown) => {
          if (existed(error)) return false
          throw error
        })
        done[made ? "created" : "existing"].push(what)
      }
      return { results: done, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))
  return [enable]
}
