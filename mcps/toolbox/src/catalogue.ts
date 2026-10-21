import { and, eq, sql } from "drizzle-orm"
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
 * Store each provider's id and every capability of its manifest at its version. A capability already stored at the same version with another
 * kind, risk, input or output refuses the whole ingest, naming it: a contract change needs a new version. Titles and descriptions update in place.
 * A capability the provider never had before stays off for every organisation that has the provider enabled: its identity joins their `overrides.disabled`.
 */
export async function ingest(db: Executor, providers: readonly Provider[]) {
  await db.transaction(async tx => {
    for (const provider of providers) {
      const contract = manifest(provider)
      await tx.insert(providerRows).values({ id: provider.id }).onConflictDoNothing()
      const known = new Set((await tx.select({ identity: capabilities.identity }).from(capabilities).where(eq(capabilities.provider_id, provider.id))).map(row => row.identity))
      for (const tool of contract.tools) {
        if (tool.kind === "commit") continue
        const risk = tool.kind === "mutate" ? tool.risk : null
        const [stored] = await tx.select({
          kind: sql<boolean>`${capabilities.kind} <> ${tool.kind}`, risk: sql<boolean>`${capabilities.risk} is distinct from ${risk}`,
          input: sql<boolean>`${capabilities.input} <> ${JSON.stringify(tool.input)}::jsonb`, output: sql<boolean>`${capabilities.output} <> ${JSON.stringify(tool.output)}::jsonb`,
        }).from(capabilities).where(and(eq(capabilities.identity, tool.identity), eq(capabilities.version, tool.version)))
        const changed = Object.entries(stored ?? {}).filter(([, differs]) => differs).map(([field]) => field)
        if (changed.length) {
          throw new Error(`Capability ${tool.identity} version ${tool.version} changed its ${changed.join(" and ")} without a new version; give the tool a new version (YYYY-MM-DD) in its definition or its provider`)
        }
        await tx.insert(capabilities)
          .values({ provider_id: provider.id, identity: tool.identity, version: tool.version, kind: tool.kind, risk, title: tool.title ?? null, description: tool.description, input: tool.input, output: tool.output })
          .onConflictDoUpdate({ target: [capabilities.identity, capabilities.version], set: { title: sql`excluded.title`, description: sql`excluded.description` } })
      }
      const added = contract.tools.filter(tool => tool.kind !== "commit" && !known.has(tool.identity)).map(tool => tool.identity)
      if (added.length) {
        await tx.update(organisationCatalogue).set({
          updated_at: sql`now()`,
          overrides: sql`jsonb_set(${organisationCatalogue.overrides}, '{disabled}', (
            select coalesce(jsonb_agg(identity order by identity), '[]') from (select distinct jsonb_array_elements_text(${organisationCatalogue.overrides} -> 'disabled' || ${JSON.stringify(added)}::jsonb) as identity) as merged))`,
        }).where(and(eq(organisationCatalogue.provider_id, provider.id), eq(organisationCatalogue.enabled, true)))
      }
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
