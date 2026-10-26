import { callerOrganisation, type Mount, type Provider } from "@answerable/mcp"
import { assertOwnLogin, assertServingLogin, mcpDatabase } from "@answerable/mcp-postgres"
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
 * gets its `db`, made once, through `mcpDatabase`, with the organisation of the call running (`callerOrganisation`): in mode `shared` each borrow
 * takes its runtime role `<prefix>_<name>` (`prefix` is `mcp` unless given). Returns `mount`, each MCP with where it is served, for `createToolbox`; `pools`,
 * by name (`mcps`, and each own MCP's name), for `/health`; `assert()`, the serving login's assertion and each own MCP's runtime login's, to
 * await before listening; and `close()`.
 */
export function mcpDatabases(declared: readonly Declared[], { shared, own, prefix = "mcp" }: { shared: string; own: Readonly<Record<string, string | undefined>>; prefix?: string }) {
  const pool = new Pool({ connectionString: shared })
  const owned = new Map(declared.flatMap(entry => {
    if (entry.database === "shared") return []
    const url = own[entry.variable]
    if (!url) throw new Error(`Set ${entry.variable} to the database of ${entry.provider.id}, as its runtime login`)
    return [[entry.provider.id, new Pool({ connectionString: url })] as const]
  }))
  const mount: (Mount & { readonly serve: Serve })[] = declared.map(({ provider, serve, database }) => {
    if (!provider.database) return { provider, serve }
    const db = mcpDatabase(owned.get(provider.id) ?? pool, { name: provider.id, prefix, schema: provider.database.schema, mode: database, organisation: callerOrganisation })
    return { provider, serve, db }
  })
  const names = declared.filter(entry => entry.database === "shared").map(entry => entry.provider.id)
  return {
    mount,
    pools: { mcps: pool, ...Object.fromEntries(owned) } as Readonly<Record<string, Pool>>,
    /** Refuse to serve as a shared login that holds more than the runtime roles of the shared MCPs, or misses one, or as an own MCP's login that is more than its runtime login. */
    assert: () => Promise.all([
      assertServingLogin(drizzle({ client: pool }), { prefix, names }),
      ...[...owned].map(([name, own]) => assertOwnLogin(drizzle({ client: own }), { name })),
    ]).then(() => undefined),
    close: () => Promise.all([pool, ...owned.values()].map(each => each.end())).then(() => undefined),
  }
}
