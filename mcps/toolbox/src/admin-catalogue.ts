import type { SQL } from "bun"
import { manifest, type Provider } from "@answerable/mcp"
import { z } from "zod"
import { readCatalogue, writeCatalogue } from "./catalogue"
import { parse, Problem } from "./problem"

const entry = z.object({
  enabled: z.boolean(),
  overrides: z.object({ disabled: z.array(z.string()).optional(), policy_class: z.record(z.string(), z.enum(["agent", "controlled", "human"])).optional() }).strict().optional(),
}).strict()
const host = z.object({
  projection: z.enum(["direct", "meta", "auto"]).default("auto"),
  // VS Code caps a request at 128 tools.
  direct_limit: z.number().int().min(1).max(128).default(40),
}).strict()

/** What staff read and write about the providers, the organisations' catalogues and the host clients. */
export function createCatalogueAdmin(db: SQL, providers: readonly Provider[]) {
  // Each mounted provider as its manifest says: its reads and mutations, without the commit tools.
  const offered = new Map(providers.toSorted((a, b) => (a.id < b.id ? -1 : 1)).map(provider => [provider.id, {
    id: provider.id,
    version: provider.version,
    capabilities: manifest(provider).tools.flatMap(tool => tool.kind === "commit" ? [] : [{
      identity: tool.identity, version: tool.version, kind: tool.kind, risk: tool.kind === "mutate" ? tool.risk : null, title: tool.title ?? null,
    }]),
  }]))
  return {
    providers: () => ({ items: [...offered.values()] }),
    async catalogue(organisationId: string) {
      const rows = [...await readCatalogue(db, organisationId)].map(([provider_id, entry]) => ({ provider_id, ...entry }))
      return { items: rows.sort((a, b) => (a.provider_id < b.provider_id ? -1 : 1)) }
    },
    /** Replace an organisation's entry for a provider: `enabled`, and overrides that name capabilities the provider has, a policy class only for its mutations. */
    async putCatalogue(organisationId: string, providerId: string, body: unknown) {
      const provider = offered.get(providerId)
      if (!provider) throw new Problem(404, "provider_not_found", `${providerId} is not mounted in this Toolbox; GET /admin/v1/providers lists what is`)
      const { enabled, overrides } = parse(entry, body)
      const kinds = new Map(provider.capabilities.map(capability => [capability.identity, capability.kind]))
      const unknown = [...(overrides?.disabled ?? []), ...Object.keys(overrides?.policy_class ?? {})].filter(identity => !kinds.has(identity))
      if (unknown.length) throw new Problem(422, "unknown_capability", `${providerId} has no capability ${unknown.join(", ")}; GET /admin/v1/providers lists them`)
      const read = Object.keys(overrides?.policy_class ?? {}).find(identity => kinds.get(identity) === "read")
      if (read) throw new Problem(422, "not_a_mutation", `${read} is a read; a policy class applies to mutations`)
      await writeCatalogue(db, organisationId, providerId, { enabled, overrides })
      return { provider_id: providerId, ...(await readCatalogue(db, organisationId)).get(providerId)! }
    },
    async hostClients() {
      return { items: [...await db`select client_id, projection, direct_limit from host_clients order by client_id collate "C"`] }
    },
    async putHostClient(clientId: string, body: unknown) {
      const { projection, direct_limit } = parse(host, body)
      const [row] = await db`insert into host_clients (client_id, projection, direct_limit) values (${clientId}, ${projection}, ${direct_limit})
        on conflict (client_id) do update set projection = excluded.projection, direct_limit = excluded.direct_limit returning client_id, projection, direct_limit`
      return { ...row }
    },
    async removeHostClient(clientId: string) {
      if (!(await db`delete from host_clients where client_id = ${clientId} returning client_id`).length) throw new Problem(404, "host_client_not_found", `There is no host client ${clientId}`)
    },
  }
}
