import type { SQL } from "bun"
import { manifest, type Provider } from "@answerable/mcp"
import { z } from "zod"

/** What an organisation changes about a provider it may use; a field left out is empty, and an unknown field is refused. */
export const overridesSchema = z.object({
  /** Identities the organisation may not use even when granted. */
  disabled: z.array(z.string()).default([]),
  /** The policy class of a mutation in this organisation, by identity, in place of the one its risk gives. */
  policy_class: z.record(z.string(), z.enum(["agent", "controlled", "human"])).default({}),
}).strict()
/** What an organisation changes about a provider it may use. */
export type Overrides = z.output<typeof overridesSchema>
/** Whether an organisation may use a provider, and its overrides. */
export type CatalogueEntry = { enabled: boolean; overrides: Overrides }
/** An organisation's catalogue, by provider id. A provider without an entry is not enabled. */
export type Catalogue = ReadonlyMap<string, CatalogueEntry>

/**
 * Store each provider's id and every capability of its manifest at its version. A capability already stored at the same version with another
 * kind, risk, input or output refuses the whole ingest, naming it: a contract change needs a new version. Titles and descriptions update in place.
 * A capability the provider never had before stays off for every organisation that has the provider enabled: its identity joins their `overrides.disabled`.
 */
export async function ingest(db: SQL, providers: readonly Provider[]) {
  await db.begin(async tx => {
    for (const provider of providers) {
      const contract = manifest(provider)
      await tx`insert into providers (id) values (${provider.id}) on conflict (id) do nothing`
      const known = new Set((await tx`select identity from capabilities where provider_id = ${provider.id}`).map((row: { identity: string }) => row.identity))
      for (const tool of contract.tools) {
        if (tool.kind === "commit") continue
        const risk = tool.kind === "mutate" ? tool.risk : null
        const [stored] = await tx`select kind <> ${tool.kind} as kind, risk is distinct from ${risk} as risk, input <> ${tool.input} as input, output <> ${tool.output} as output
          from capabilities where identity = ${tool.identity} and version = ${tool.version}`
        const changed = Object.entries(stored ?? {}).filter(([, differs]) => differs).map(([field]) => field)
        if (changed.length) {
          throw new Error(`Capability ${tool.identity} version ${tool.version} changed its ${changed.join(" and ")} without a new version; give the tool a new version (YYYY-MM-DD) in its definition or its provider`)
        }
        await tx`insert into capabilities (provider_id, identity, version, kind, risk, title, description, input, output)
          values (${provider.id}, ${tool.identity}, ${tool.version}, ${tool.kind}, ${risk}, ${tool.title ?? null}, ${tool.description}, ${tool.input}, ${tool.output})
          on conflict (identity, version) do update set title = excluded.title, description = excluded.description`
      }
      const added = contract.tools.filter(tool => tool.kind !== "commit" && !known.has(tool.identity)).map(tool => tool.identity)
      if (added.length) {
        await tx`update organisation_catalogue set updated_at = now(), overrides = jsonb_set(overrides, '{disabled}', (
            select coalesce(jsonb_agg(identity order by identity), '[]') from (select distinct jsonb_array_elements_text(overrides -> 'disabled' || ${added}::jsonb) as identity) as merged))
          where provider_id = ${provider.id} and enabled`
      }
    }
  })
}

/** An organisation's catalogue, by provider id in order. */
export async function readCatalogue(db: SQL, organisationId: string): Promise<Catalogue> {
  const rows = await db`select provider_id, enabled, overrides from organisation_catalogue where organisation_id = ${organisationId} order by provider_id collate "C"`
  return new Map(rows.map((row: { provider_id: string; enabled: boolean; overrides: unknown }) => [row.provider_id, { enabled: row.enabled, overrides: overridesSchema.parse(row.overrides) }]))
}

/** Enable or disable a provider for an organisation and set its overrides, and return the entry. The provider must have been ingested. */
export async function writeCatalogue(db: SQL, organisationId: string, providerId: string, entry: { enabled: boolean; overrides?: Partial<Overrides> }): Promise<CatalogueEntry> {
  const overrides = overridesSchema.parse(entry.overrides ?? {})
  await db`insert into organisation_catalogue (organisation_id, provider_id, enabled, overrides) values (${organisationId}, ${providerId}, ${entry.enabled}, ${overrides})
    on conflict (organisation_id, provider_id) do update set enabled = excluded.enabled, overrides = excluded.overrides, updated_at = now()`
  return { enabled: entry.enabled, overrides }
}

/** A host client's settings as they are written: a field left out takes its default, and an unknown field is refused. */
export const hostClientSettings = z.object({
  projection: z.enum(["direct", "meta", "auto"]).default("auto"),
  // VS Code caps a request at 128 tools.
  direct_limit: z.number().int().min(1).max(128).default(40),
}).strict()
/** How the Toolbox serves a host client's callers: `direct`, `meta`, or `auto`, direct while their granted tools number at most `direct_limit`. */
export type HostClient = z.output<typeof hostClientSettings>

/** A host client's settings; without a row, the defaults: `auto` with a direct limit of 40. */
export async function readHostClient(db: SQL, clientId: string): Promise<HostClient> {
  const [row] = await db`select projection, direct_limit from host_clients where client_id = ${clientId}`
  return row ?? hostClientSettings.parse({})
}

/** Set a host client's settings and return its row. */
export async function writeHostClient(db: SQL, clientId: string, settings: z.input<typeof hostClientSettings>) {
  const { projection, direct_limit } = hostClientSettings.parse(settings)
  await db`insert into host_clients (client_id, projection, direct_limit) values (${clientId}, ${projection}, ${direct_limit})
    on conflict (client_id) do update set projection = excluded.projection, direct_limit = excluded.direct_limit`
  return { client_id: clientId, projection, direct_limit }
}

/** Every host client's row, by client id. */
export async function listHostClients(db: SQL): Promise<(HostClient & { client_id: string })[]> {
  return [...await db`select client_id, projection, direct_limit from host_clients order by client_id collate "C"`]
}

/** Remove a host client's row; false when there was none. */
export async function removeHostClient(db: SQL, clientId: string) {
  return (await db`delete from host_clients where client_id = ${clientId} returning client_id`).length > 0
}
