import { defineMutation, ToolError } from "@answerable/mcp"
import { z } from "zod"
import { enablementSteps, RowConflict, type Row } from "./enablement"
import { commitWith, errors, named, noPrecondition, organizationId, precondition, scopes, target, type Writes } from "./writes"

type Resource = { name: string; allowedScopes: string[] | null; clients: string[] }

// bun mcp's rule for an MCP's name.
const mcpName = z.string().regex(/^[a-z][a-z0-9]{0,11}$/, "A lowercase letter, then up to 11 lowercase letters or digits")

/** ID's refusal of a create because the row exists: someone made it after the preparation read. */
const existed = (error: unknown) => error instanceof ToolError && (error.details?.upstream as { status?: number; code?: string } | undefined)?.code === "conflict"

/**
 * `standalone.enable`: what Answerable ID needs for an organisation's people to sign in to a standalone MCP through Claude Code's client for it,
 * `claude-code-<name>`: the resource `<origin>/<name>/mcp` and the client that the deploy's register Job registered.
 */
export function standaloneWrites(writes: Writes, origin: string) {
  const { calls, role, organisation } = writes
  const enable = role("admin", defineMutation({
    name: "standalone.enable", risk: "normal", scopes, errors, effects: ["permission_change"],
    description: `Prepare giving an organisation access to a standalone MCP, which the Toolbox serves at its own URL: for its host client, claude-code-<name>, its link to the MCP, the organisation's sign-in and MCP capabilities for both grant kinds, and the sign-in entitlement for everyone in it. ${commitWith} People then need the MCP's scopes through that host client: access_grant them with clientId set to it, to the organisation, a group or a person, or pass everyone: true to grant them to the whole organisation in the same intent. Undo it with access_revoke. Safe to repeat.`,
    input: z.object({
      organizationId,
      mcp: mcpName.describe("The standalone MCP's name, as bun mcp list shows it, such as acme"),
      everyone: z.boolean().optional().describe("Also grant the MCP's scopes to everyone in the organisation, through its host client; omit it to grant them with access_grant"),
    }),
    output: z.object({ created: z.array(z.string()).describe("What the commit made in Answerable ID"), existing: z.array(z.string()).describe("What it found already in place") }),
    async prepare({ organizationId: id, mcp, everyone = false }, context) {
      const { organisation: row, target: version } = await organisation(id, context)
      const resource = `${origin}/${mcp}/mcp`
      const registered = await calls.versioned<Resource>(`/resources/${encodeURIComponent(resource)}`, context,
        `Answerable ID has no resource ${resource}: ship ${mcp} with serve standalone or both, and the deploy's register Job registers it`)
      const mcpScopes = (registered.body.allowedScopes ?? []).filter(scope => scope !== "offline_access")
      const client = `claude-code-${mcp}`
      await calls.need(`/clients/${client}`, context, `Answerable ID has no client ${client}: ship ${mcp} with serve standalone or both, and the deploy's register Job registers it`)
      const steps = await enablementSteps({
        organizationId: id, mcp, resource, mcpScopes, linked: registered.body.clients, hostClientIds: [client], everyone,
        capabilities: await calls.all<Row>(`/organizations/${id}/capabilities`, context),
        entitlements: clientId => calls.all<Row>(`/organizations/${id}/entitlements?clientId=${encodeURIComponent(clientId)}`, context),
      }).catch((error: unknown) => { throw error instanceof RowConflict ? precondition(`${error.message}, then prepare again`, error.details) : error })
      const reach = `${client}${everyone ? `, with ${mcpScopes.join(" ")} for everyone in it` : ""}`
      if (!steps.length) throw precondition(`Organisation ${named(row)} can already sign in to ${mcp} from ${reach}; nothing to enable`, { organizationId: id, resource })
      return {
        targets: [version, target("resource", resource, registered.body.name, registered.etag)],
        preview: {
          summary: `Enable ${mcp} for organisation ${named(row)} from ${reach}`,
          changes: steps.map(step => ({ path: step.what, from: null, to: step.body ?? { linked: resource } })),
          effects: ["permission_change" as const],
          warnings: [
            everyone ? `Everyone in the organisation may use every tool of ${mcp} through ${client} once this commits; access_revoke disables those entitlements.`
              : `Nobody may use ${mcp}'s tools yet: grant ${mcpScopes.join(" ")} on ${resource} with access_grant, clientId ${client}, or prepare again with everyone: true.`,
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
