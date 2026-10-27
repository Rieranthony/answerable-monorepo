// The code every MCP starts with: its definitions bound to its database, its provider, its schema and its conformance test; and the edits
// `bun mcp add tool` makes to the provider and the schema.
import { schemaBinding, tableBinding, toolBinding, toolModule, type Answers, type ToolAnswers } from "./names"

/** The line `bun mcp add tool` inserts above, once among the imports of `src/provider.ts` and once in its `tools` array. */
export const toolsMarker = "// bun mcp: tools"

/** `src/mcp.ts`: `defineTool` and `defineMutation` bound to the MCP's schema, and its database for the provider. */
export const mcpTs = () => `// Written by bun mcp new; never edited. Every tool imports defineTool or defineMutation from here.
import { withDatabase } from "@answerable/mcp"
import * as schema from "./db/schema"

/** This MCP's definitions: every handler's context.db is typed by src/db/schema.ts. */
export const { defineTool, defineMutation } = withDatabase({ schema })

/** This MCP's database, which src/provider.ts declares: its tables, and the migrations bun mcp db generate writes into drizzle/. */
export const database = { schema, migrations: new URL("../drizzle", import.meta.url) }
`

/** `src/provider.ts`: the provider, with no tool yet and the two places `bun mcp add tool` adds one. */
export function providerTs({ name, description, date }: Answers) {
  return `// The ${name} MCP: what it is for, its version and its tools. bun mcp add tool adds a tool above each "bun mcp: tools" line.
import { defineProvider } from "@answerable/mcp"
import { database } from "./mcp"
${toolsMarker}

export const provider = defineProvider({
  id: "${name}",
  description: ${JSON.stringify(description)},
  version: "${date}",
  database,
  tools: [
    ${toolsMarker}
  ],
})
`
}

/** The import a table needs in `src/db/schema.ts`, which `bun mcp add tool` adds when the file has no table yet. */
export const isolationImport = `import { organisationIsolation } from "@answerable/mcp-postgres"\n`

/** A domain's table in `src/db/schema.ts`: the rows a read lists and a mutation adds, each limited to the caller's organisation. */
export const tableTs = (name: string, domain: string) => `
// The ${domain} table: each organisation's rows. The id is a UUID v7, so ids sort by creation.
export const ${tableBinding(domain)} = ${schemaBinding(name)}.table("${domain}", {
  id: pg.uuid().primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  organisation_id: pg.uuid().notNull(),
  title: pg.text().notNull(),
  created_at: pg.timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [organisationIsolation(table.organisation_id)]).enableRLS()
`

/** `src/db/schema.ts`: the MCP's Postgres schema, with no table yet. */
export function schemaTs({ name }: Answers) {
  return `import * as pg from "drizzle-orm/pg-core"

// The tables of the ${name} MCP, in its own Postgres schema, ${name}. After a change here, bun mcp db ${name} generate writes the
// migration; bun mcp add tool adds the table a new domain needs.
//
// Every table has organisation_id and the organisationIsolation policy, with .enableRLS(): Postgres then limits every query to the
// caller's organisation, even one that forgets to filter. A table without them is shared by every organisation: a reviewed exception,
// with a comment above it saying why.
//
//   export const projects = ${schemaBinding(name)}.table("projects", {
//     id: pg.uuid().primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
//     organisation_id: pg.uuid().notNull(),
//     name: pg.text().notNull(),
//   }, table => [organisationIsolation(table.organisation_id)]).enableRLS()
export const ${schemaBinding(name)} = pg.pgSchema("${name}")
`
}

const isolationImported = /^import \{[^}]*\borganisationIsolation\b[^}]*\} from "@answerable\/mcp-postgres"$/m

/**
 * What `bun mcp add tool` makes of MCP `name`'s `src/provider.ts` and `src/db/schema.ts` for `tool`: the provider with the tool's import above the
 * first marker and its entry above the second, and the schema with the tool's domain's table, and the policy's import, when it has no such table.
 * `table` says whether the table was added.
 */
export function withTool(name: string, { provider, schema }: { provider: string; schema: string }, tool: ToolAnswers) {
  const lines = provider.split("\n")
  const [imports, entries] = lines.flatMap((line, index) => (line.trim() === toolsMarker ? [index] : []))
  lines.splice(entries!, 0, `    ${toolBinding(tool.name)},`)
  lines.splice(imports!, 0, `import { ${toolBinding(tool.name)} } from "./tools/${toolModule(tool.name)}"`)
  const domain = tool.name.split(".")[0]!
  const table = !schema.includes(`.table("${domain}"`)
  return {
    provider: lines.join("\n"),
    schema: table ? `${isolationImported.test(schema) ? "" : isolationImport}${schema}${tableTs(name, domain)}` : schema,
    table,
  }
}

/** `src/provider.test.ts`: the conformance kit over every tool, each called with its example, and the manifest. */
export const providerTest = () => `import { assertProviderConformance } from "@answerable/mcp-postgres/testing"
import { provider } from "./provider"

// One test per check of the Answerable MCP standard, for every tool, each called with its example; and manifest.json, the contract.
assertProviderConformance(provider, { manifest: new URL("../manifest.json", import.meta.url) })
`
