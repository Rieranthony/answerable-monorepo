import { callerOrganisation, type Mount, type Provider } from "@answerable/mcp"
import { assertServingLogin, mcpDatabase } from "@answerable/mcp-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

/** Where an MCP is served: in the Toolbox's hub, alone at `<origin>/<name>/mcp`, or both. */
export type Serve = "toolbox" | "standalone" | "both"

/**
 * An MCP as the Toolbox's generated list declares it: its provider, where it is served, and where its tables live: `shared`, a schema in the
 * shared database, or `own`, a database of its own, whose URL the server reads from `variable`.
 */
export type Declared = Readonly<{ provider: Provider; serve: Serve } & ({ database: "shared" } | { database: "own"; variable: string })>

/**
 * The databases of the MCPs a server serves, from its generated list and its configuration: one pool to the shared database at `shared`, as the
 * server's serving login, and one pool to each `own` MCP's database at `own[variable]`, as that MCP's runtime login. Each MCP with a `database`
 * gets its `db`, made once, through `mcpDatabase`, with the organisation of the call running (`callerOrganisation`). Returns `mount`, each MCP
 * with where it is served, for `createToolbox`; `pools`, by name (`mcps`, and each own MCP's name), for `/health`; `assert()`, `assertServingLogin`
 * on each pool for the MCPs it serves, to await before listening; and `close()`.
 */
export function mcpDatabases(declared: readonly Declared[], { shared, own }: { shared: string; own: Readonly<Record<string, string | undefined>> }) {
  const pool = new Pool({ connectionString: shared })
  const owned = new Map(declared.flatMap(entry => {
    if (entry.database === "shared") return []
    const url = own[entry.variable]
    if (!url) throw new Error(`Set ${entry.variable} to the database of ${entry.provider.id}, as its runtime login`)
    return [[entry.provider.id, new Pool({ connectionString: url })] as const]
  }))
  const mount: (Mount & { readonly serve: Serve })[] = declared.map(({ provider, serve }) => {
    if (!provider.database) return { provider, serve }
    const db = mcpDatabase(owned.get(provider.id) ?? pool, { name: provider.id, schema: provider.database.schema, organisation: callerOrganisation })
    return { provider, serve, db }
  })
  const names = declared.filter(entry => entry.database === "shared").map(entry => entry.provider.id)
  return {
    mount,
    pools: { mcps: pool, ...Object.fromEntries(owned) } as Readonly<Record<string, Pool>>,
    /** Refuse to serve as a login that is more than the one provisioning made, or that lacks USAGE on the schema of an MCP its pool serves. */
    assert: () => Promise.all([
      assertServingLogin(drizzle({ client: pool }), { names }),
      ...[...owned].map(([name, own]) => assertServingLogin(drizzle({ client: own }), { names: [name] })),
    ]).then(() => undefined),
    close: () => Promise.all([pool, ...owned.values()].map(each => each.end())).then(() => undefined),
  }
}
