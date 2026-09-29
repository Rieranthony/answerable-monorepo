import type { SQL } from "bun"
import type { Provider } from "@answerable/mcp"
import { z } from "zod"
import { readCatalogue, writeCatalogue } from "./catalogue"
import { allowedScopes } from "./grants"
import { createIdAdmin, IdError, type IdConfig } from "./id"
import { createIdClient, type Row } from "./id-client"
import { parse, Problem } from "./problem"

const request = z.object({ hostClientIds: z.array(z.string().min(1)).min(1), providers: z.array(z.string().min(1)).min(1) }).strict()
// What ID needs to issue a person's token for a host client: the login, and `toolbox` for the Toolbox, each for both grant kinds.
const grantKinds = ["authorization_code", "refresh_token"] as const
// Something to do, in order; `run` is absent when it already exists.
type Step = { what: string; run?: () => Promise<unknown> }

/** A row ID holds counts when it is active and carries what is needed; any other row of the same target stops the operation, naming it. */
function exists(row: Row | undefined, needed: readonly string[], label: string, clientId: string) {
  if (!row) return false
  const lacking = needed.filter(scope => !row.scopes.includes(scope))
  if (row.status === "active" && !lacking.length) return true
  const fix = [row.status === "active" ? "" : "make it active", lacking.length ? `give it at least ${needed.join(" ")}` : ""].filter(Boolean).join(" and ")
  throw new Problem(409, "id_row_conflict", `Answerable ID already holds the ${label} of ${clientId} (${row.id}) with status ${row.status} and scopes ${row.scopes.join(" ")}; ${fix} in ID, then repeat the call`)
}

/**
 * The enable operation: everything Answerable ID and the catalogue need for an organisation to use the named providers from the named host clients.
 * It reads what ID holds first, stops on a row that does not fit, then creates what is missing in order: the Toolbox resource's allowed scopes, then for each
 * host client its link and the organisation's login and `toolbox` capabilities and entitlements, then the catalogue rows. Repeating it changes nothing.
 */
export function createEnable({ db, providers, id, resource }: { db: SQL; providers: readonly Provider[]; id: IdConfig; resource: string }) {
  const ids = createIdClient(createIdAdmin(id), resource)
  const mounted = new Map(providers.map(provider => [provider.id, provider]))
  async function plan(organisationId: string, hostClientIds: string[], named: Provider[]) {
    const held = await ids.resource()
    if (!held) throw new Problem(409, "resource_not_registered", `Answerable ID does not know the resource ${resource}; register it first, as the Toolbox administration page shows`)
    const capabilities = await ids.capabilities(organisationId)
    if (!capabilities) throw new Problem(404, "organisation_not_found", `Answerable ID does not know the organisation ${organisationId}`)
    const current = new Set(held.allowedScopes)
    const added = allowedScopes(named).filter(scope => !current.has(scope))
    const steps: Step[] = [{ what: `allowed scopes of ${resource}`, run: added.length ? () => ids.allowScopes([...current, ...added].sort(), held.etag) : undefined }]
    const targets = [{ name: "login", target: null, scopes: ["openid", "offline_access"] }, { name: "toolbox", target: resource, scopes: ["toolbox"] }]
    for (const clientId of hostClientIds) {
      const entitlements = await ids.entitlements(organisationId, clientId)
      steps.push({
        what: `link ${clientId}`,
        run: held.clients.includes(clientId) ? undefined : async () => {
          if (!await ids.link(clientId)) throw new Problem(422, "unknown_host_client", `Answerable ID has no client ${clientId}; register it first`)
        },
      })
      for (const { name, target, scopes } of targets) {
        for (const grantKind of grantKinds) {
          const row = capabilities.find(row => row.clientId === clientId && row.resource === target && row.grantKind === grantKind)
          steps.push({ what: `capability ${clientId} ${name} ${grantKind}`, run: exists(row, scopes, `${name} ${grantKind} capability`, clientId) ? undefined : () => ids.createCapability(organisationId, { clientId, resource: target, grantKind, scopes }) })
        }
      }
      for (const { name, target, scopes } of targets) {
        const row = entitlements.find(row => row.resource === target && !row.memberId && !row.groupId)
        steps.push({ what: `entitlement ${clientId} ${name}`, run: exists(row, scopes, `${name} entitlement`, clientId) ? undefined : () => ids.createEntitlement(organisationId, { clientId, ...(target === null ? {} : { resource: target }), scopes }) })
      }
    }
    const catalogue = await readCatalogue(db, organisationId)
    for (const { id: providerId } of named) {
      const entry = catalogue.get(providerId)
      steps.push({ what: `catalogue ${providerId}`, run: entry?.enabled ? undefined : () => writeCatalogue(db, organisationId, providerId, { enabled: true, overrides: entry?.overrides }) })
    }
    return steps
  }
  return async function enable(organisationId: string, body: unknown) {
    const asked = parse(request, body)
    const missing = [...new Set(asked.providers)].filter(name => !mounted.has(name))
    if (missing.length) throw new Problem(422, "unknown_provider", `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not mounted in this Toolbox; mounted: ${[...mounted.keys()].sort().join(", ")}`)
    try {
      const steps = await plan(organisationId, [...new Set(asked.hostClientIds)], [...new Set(asked.providers)].map(name => mounted.get(name)!))
      const done: { created: string[]; existing: string[] } = { created: [], existing: [] }
      for (const { what, run } of steps) {
        if (run) await run()
        done[run ? "created" : "existing"].push(what)
      }
      return { organisation_id: organisationId, ...done }
    } catch (error) {
      if (error instanceof IdError) throw new Problem(502, "id_failed", `${error.message}. Nothing is rolled back: repeat the call, which skips what already exists`)
      throw error
    }
  }
}
