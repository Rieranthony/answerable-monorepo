import { existsSync } from "node:fs"
import { join } from "node:path"
import { migrateMcps, ownMcpDatabase, type DeclaredMcp, type Grant, type McpMigration } from "@answerable/mcp-postgres"
import { Client } from "pg"

type Options = {
  /** The repository the MCPs are in, `/app` in the image: each MCP's migrations are `mcps/<name>/drizzle`. */
  root: string
  /** The chart's list (charts/answerable/mcps.json): each MCP's name, and where its tables live. */
  mcps: readonly Pick<DeclaredMcp, "name" | "database">[]
  /** The shared database as the migrator login, which takes each shared MCP's owner role. */
  shared: string
  /** An own MCP's database as its owner login. */
  own: (name: string) => string
  /** The prefix of the shared MCPs' roles: `mcp`. */
  prefix: string
  log: (line: string) => void
}

/**
 * Migrate every MCP of `mcps`, in the list's order, with `@answerable/mcp-postgres`'s `migrateMcps`: a shared MCP through the migrator login
 * at `shared`, as its owner role `<prefix>_<name>_owner`; an own MCP as its database's owner login at `own(name)`, granting its runtime login.
 * The grants are those `mcps/<name>/src/db/grants.ts` exports as `grants`, else every table read and written. An MCP with no migration yet is
 * skipped: provisioning has made its schema. Stops at the first failure, which names the MCP. One connection for the shared MCPs and one for
 * each own MCP in turn, each closed when done, so a migration that waits on a lock gives up rather than stall the MCP's servers.
 */
export async function migrateDeclared({ root, mcps, shared, own, prefix, log }: Options): Promise<void> {
  const list: McpMigration[] = []
  for (const { name, database } of mcps) {
    const dir = join(root, "mcps", name)
    if (!existsSync(join(dir, "mcp.json"))) throw new Error(`mcps/${name} is not in this image: the chart's list and the image come from different commits`)
    const folder = join(dir, "drizzle")
    if (!existsSync(join(folder, "meta/_journal.json"))) {
      log(`${name}: no migration yet`)
      continue
    }
    const grantsFile = join(dir, "src/db/grants.ts")
    const grants = existsSync(grantsFile) ? ((await import(grantsFile)) as { grants?: readonly Grant[] }).grants : undefined
    list.push(database === "shared" ? { name, folder, grants, mode: "shared", prefix } : { name, folder, grants, mode: "own", runtime: ownMcpDatabase(name).runtime })
  }
  const open = async (url: string) => {
    const client = new Client({ connectionString: url, lock_timeout: 5_000, statement_timeout: 300_000 })
    await client.connect()
    return client
  }
  let migrator: Client | undefined
  let current: Client | undefined
  try {
    await migrateMcps(list, async mcp => {
      await current?.end()
      current = undefined
      const url = mcp.mode === "shared" ? shared : own(mcp.name)
      const as = mcp.mode === "shared" ? `${prefix}_${mcp.name}_owner` : decodeURIComponent(new URL(url).username)
      log(`${mcp.name}: migrating in ${new URL(url).pathname.slice(1)} as ${as}${mcp.grants ? ", with src/db/grants.ts" : ""}`)
      if (mcp.mode === "shared") return (migrator ??= await open(shared))
      return (current = await open(url))
    })
  } finally {
    await Promise.all([migrator?.end(), current?.end()])
  }
}
