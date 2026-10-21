import { sql } from "drizzle-orm"
import { boolean, check, customType, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"

// The Toolbox's database: the tables every server with a database has, then its own. One drizzle journal covers them all (drizzle.config.ts).
export { evidenceEvents, evidencePayloads, intents } from "@answerable/mcp-postgres/schema"

/** What an organisation changes about a provider it may use, as the `organisation_catalogue` row stores it. */
export type Overrides = { disabled: string[]; policy_class: Record<string, "agent" | "controlled" | "human"> }

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" })
// Every constraint is named as Postgres named it when the Toolbox's SQL file created these tables before drizzle, so that a database that file
// built is a fresh drizzle one and its adoption (migrate.ts) is bookkeeping, not DDL.

/** The providers mounted at some boot; the manifest in process is the source of truth, so a row only anchors the foreign keys below. */
export const providers = pgTable("providers", {
  id: text().primaryKey(),
})

/** The capabilities the Toolbox serves, as their providers' manifests describe them, each at its version. */
export const capabilities = pgTable("capabilities", {
  provider_id: text().notNull(),
  identity: text().notNull(),
  version: text().notNull(),
  kind: text({ enum: ["read", "mutate"] }).notNull(),
  risk: text({ enum: ["low", "normal", "high"] }),
  title: text(),
  description: text().notNull(),
  input: jsonb().$type<Record<string, unknown>>().notNull(),
  output: jsonb().$type<Record<string, unknown>>().notNull(),
  /** Identity first, then title, then description, then the names of the input's arguments. Not indexed: the table is small enough to scan. */
  search: tsvector().generatedAlwaysAs(sql.raw(`setweight(to_tsvector('simple', translate(identity, '/.', '  ')), 'A')
    || setweight(to_tsvector('english', coalesce(title, '')), 'B')
    || setweight(to_tsvector('english', description), 'C')
    || setweight(jsonb_to_tsvector('simple', jsonb_path_query_array(input, '$.properties.keyvalue().key'), '["string"]'), 'D')`)),
}, table => [
  primaryKey({ name: "capabilities_pkey", columns: [table.identity, table.version] }),
  foreignKey({ name: "capabilities_provider_id_fkey", columns: [table.provider_id], foreignColumns: [providers.id] }),
  check("capabilities_kind_check", sql`${table.kind} in ('read', 'mutate')`),
  check("capabilities_risk_check", sql`${table.risk} in ('low', 'normal', 'high')`),
  check("capabilities_check", sql`(${table.kind} = 'mutate') = (${table.risk} is not null)`),
])

/** Which providers each organisation may use, and what it changes about them. */
export const organisationCatalogue = pgTable("organisation_catalogue", {
  organisation_id: uuid().notNull(),
  provider_id: text().notNull(),
  enabled: boolean().notNull().default(false),
  overrides: jsonb().$type<Overrides>().notNull().default({ disabled: [], policy_class: {} }),
  updated_at: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, table => [
  primaryKey({ name: "organisation_catalogue_pkey", columns: [table.organisation_id, table.provider_id] }),
  foreignKey({ name: "organisation_catalogue_provider_id_fkey", columns: [table.provider_id], foreignColumns: [providers.id] }),
])

/** How the Toolbox serves each host: the OAuth client of the token names the row, and a client without one gets the defaults. */
export const hostClients = pgTable("host_clients", {
  client_id: text().primaryKey(),
  projection: text({ enum: ["direct", "meta", "auto"] }).notNull().default("auto"),
  direct_limit: integer().notNull().default(40),
}, table => [
  check("host_clients_projection_check", sql`${table.projection} in ('direct', 'meta', 'auto')`),
  check("host_clients_direct_limit_check", sql`${table.direct_limit} > 0`),
])
