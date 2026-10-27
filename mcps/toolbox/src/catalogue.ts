import { eq, sql } from "drizzle-orm"
import { manifest, type Provider } from "@answerable/mcp"
import type { Executor } from "@answerable/mcp-postgres"
import { z } from "zod"
import { capabilities, hostClients, organisationCatalogue, providers as providerRows, type Overrides } from "./db/schema"

/** What an organisation changes about a provider it may use; a field left out is empty, and an unknown field is refused. */
export const overridesSchema = z.object({
  /** Identities the organisation may not use even when granted. */
  disabled: z.array(z.string()).default([]),
  /** The policy class of a mutation in this organisation, by identity, in place of the one its risk gives. */
  policy_class: z.record(z.string(), z.enum(["agent", "controlled", "human"])).default({}),
}).strict()
/** Whether an organisation may use a provider, and its overrides. */
type CatalogueEntry = { enabled: boolean; overrides: Overrides }
/** An organisation's catalogue, by provider id. A provider without an entry is not enabled. */
export type Catalogue = ReadonlyMap<string, CatalogueEntry>

/**
 * Store each provider's id and every capability of its manifest at its version, in one transaction, with one read and one write per provider.
 * A capability already stored at the same version with another kind, risk, input or output refuses the whole ingest, naming it: a contract change
 * needs a new version. Titles and descriptions update in place. A capability the provider never had before stays off for every organisation that
 * has the provider enabled: its identity joins their `overrides.disabled`.
 */
export async function ingest(db: Executor, providers: readonly Provider[]) {
  await db.transaction(async tx => {
    for (const provider of providers) {
      const tools = manifest(provider).tools.flatMap(tool => tool.kind === "commit" ? [] : [{
        identity: tool.identity, version: tool.version, kind: tool.kind, risk: tool.kind === "mutate" ? tool.risk : null,
        title: tool.title ?? null, description: tool.description, input: tool.input, output: tool.output,
      }])
      const json = JSON.stringify(tools)
      // Every capability the provider has stored, at any version, and for one this manifest has at the same version, what differs.
      const { rows: stored } = await tx.execute<{ identity: string; version: string; kind: boolean | null; risk: boolean | null; input: boolean | null; output: boolean | null }>(sql`
        select c.identity, c.version, c.kind <> t.kind as kind, c.risk is distinct from t.risk and t.identity is not null as risk, c.input <> t.input as input, c.output <> t.output as output
        from ${capabilities} c left join jsonb_to_recordset(${json}::jsonb) as t(identity text, version text, kind text, risk text, input jsonb, output jsonb)
          on t.identity = c.identity and t.version = c.version
        where c.provider_id = ${provider.id}`)
      for (const tool of tools) {
        const found = stored.find(row => row.identity === tool.identity && row.version === tool.version)
        const changed = (["kind", "risk", "input", "output"] as const).filter(field => found?.[field])
        if (changed.length) {
          throw new Error(`Capability ${tool.identity} version ${tool.version} changed its ${changed.join(" and ")} without a new version; give the tool a new version (YYYY-MM-DD) in its definition or its provider`)
        }
      }
      const known = new Set(stored.map(row => row.identity))
      const added = [...new Set(tools.map(tool => tool.identity).filter(identity => !known.has(identity)))].sort()
      // The provider's row, its capabilities and, when it gained one, the catalogue entries that have it enabled, in one statement.
      await tx.execute(sql`
        with provider as (insert into ${providerRows} (id) values (${provider.id}) on conflict do nothing),
        stored as (
          insert into ${capabilities} (provider_id, identity, version, kind, risk, title, description, input, output)
          select ${provider.id}, t.identity, t.version, t.kind, t.risk, t.title, t.description, t.input, t.output
          from jsonb_to_recordset(${json}::jsonb) as t(identity text, version text, kind text, risk text, title text, description text, input jsonb, output jsonb)
          on conflict (identity, version) do update set title = excluded.title, description = excluded.description
        )
        update ${organisationCatalogue} set updated_at = now(), overrides = jsonb_set(${organisationCatalogue.overrides}, '{disabled}', (
          select coalesce(jsonb_agg(identity order by identity), '[]') from (select distinct jsonb_array_elements_text(${organisationCatalogue.overrides} -> 'disabled' || ${JSON.stringify(added)}::jsonb) as identity) as merged))
        where ${organisationCatalogue.provider_id} = ${provider.id} and ${organisationCatalogue.enabled} and ${added.length > 0}`)
    }
  })
}

/** An organisation's catalogue, by provider id in order. */
export async function readCatalogue(db: Executor, organisationId: string): Promise<Catalogue> {
  const rows = await db.select({ provider_id: organisationCatalogue.provider_id, enabled: organisationCatalogue.enabled, overrides: organisationCatalogue.overrides })
    .from(organisationCatalogue).where(eq(organisationCatalogue.organisation_id, organisationId)).orderBy(sql`${organisationCatalogue.provider_id} collate "C"`)
  return new Map(rows.map(row => [row.provider_id, { enabled: row.enabled, overrides: overridesSchema.parse(row.overrides) }]))
}

/** Enable or disable a provider for an organisation and set its overrides, and return the entry. The provider must have been ingested. */
export async function writeCatalogue(db: Executor, organisationId: string, providerId: string, entry: { enabled: boolean; overrides?: Partial<Overrides> }): Promise<CatalogueEntry> {
  const overrides = overridesSchema.parse(entry.overrides ?? {})
  await db.insert(organisationCatalogue).values({ organisation_id: organisationId, provider_id: providerId, enabled: entry.enabled, overrides })
    .onConflictDoUpdate({ target: [organisationCatalogue.organisation_id, organisationCatalogue.provider_id], set: { enabled: sql`excluded.enabled`, overrides: sql`excluded.overrides`, updated_at: sql`now()` } })
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

const settings = { projection: hostClients.projection, direct_limit: hostClients.direct_limit }

/** A host client's settings; without a row, the defaults: `auto` with a direct limit of 40. */
export async function readHostClient(db: Executor, clientId: string): Promise<HostClient> {
  const [row] = await db.select(settings).from(hostClients).where(eq(hostClients.client_id, clientId))
  return row ?? hostClientSettings.parse({})
}

/** Set a host client's settings and return its row. */
export async function writeHostClient(db: Executor, clientId: string, settings: z.input<typeof hostClientSettings>) {
  const { projection, direct_limit } = hostClientSettings.parse(settings)
  await db.insert(hostClients).values({ client_id: clientId, projection, direct_limit })
    .onConflictDoUpdate({ target: hostClients.client_id, set: { projection: sql`excluded.projection`, direct_limit: sql`excluded.direct_limit` } })
  return { client_id: clientId, projection, direct_limit }
}

/** Every host client's row, by client id. */
export function listHostClients(db: Executor): Promise<(HostClient & { client_id: string })[]> {
  return db.select({ client_id: hostClients.client_id, ...settings }).from(hostClients).orderBy(sql`${hostClients.client_id} collate "C"`)
}

/** Remove a host client's row; false when there was none. */
export async function removeHostClient(db: Executor, clientId: string) {
  return (await db.delete(hostClients).where(eq(hostClients.client_id, clientId)).returning({ client_id: hostClients.client_id })).length > 0
}
