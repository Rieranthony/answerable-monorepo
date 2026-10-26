// Provisioning of MCP schemas. It imports values from nothing outside this package, never from @answerable/mcp, so that the ops image,
// which copies only this package (infra/ops/Dockerfile), can run it.
import type { Client, Pool } from "pg"
import { assertMcpName, identifier, quote, roleLock } from "./names"

/** A statement on one administrative connection: `text` with `$1`… bound to `params`, returning its rows, as `infra/ops`'s `pgSql` gives it. */
export type Sql = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/** The `Sql` of a connected pg client, or of a pool. */
export const sqlOf = (client: Pick<Client, "query"> | Pick<Pool, "query">): Sql => async (text, params) => (await client.query(text, params)).rows

/** The shared database's two logins: `answerable_mcps_migrator`, which owns it and migrates, and `answerable_mcps_toolbox`, which serves every MCP, when deployed. */
export type McpLogins = { migrator: string; toolbox: string }

/**
 * Make, or bring back in line, every MCP of `mcps` in the connected shared database, as a login that holds the migrator's privileges and may
 * `SET ROLE` to it: a superuser, or a managed database's administrator that is a member of it, as the bootstrap's is. In one transaction, under
 * the lock statements on a database's privileges take:
 * - the database, which `logins.migrator` must own: no privilege for `PUBLIC`, `CONNECT` for the two logins, no `TEMPORARY` for the serving one;
 * - for each MCP, schema `<name>`, owned by the migrator, and `USAGE` on it for the serving login, which serves every MCP. The migration grants
 *   it the tables.
 *
 * Every name is checked before any SQL runs. Running it twice changes nothing; it never drops anything and makes no role.
 */
export async function provisionMcps(sql: Sql, { mcps, logins }: { mcps: readonly { name: string }[]; logins: McpLogins }): Promise<void> {
  for (const { name } of mcps) assertMcpName(name)
  const duplicate = mcps.find((mcp, index) => mcps.findIndex(other => other.name === mcp.name) !== index)
  if (duplicate) throw new Error(`MCP ${duplicate.name} is listed twice`)
  for (const login of Object.values(logins)) if (!identifier.test(login)) throw new Error(`Invalid login name "${login}"`)
  const [migrator, toolbox] = [logins.migrator, logins.toolbox].map(quote)

  await sql("begin")
  try {
    await sql(`select pg_advisory_xact_lock(${roleLock})`)
    const [database] = await sql("select datname as name, pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()")
    if (database!.owner !== logins.migrator) throw new Error(`Database ${database!.name} is owned by ${database!.owner}; the migrator login, ${logins.migrator}, must own it`)
    const name = quote(database!.name as string)
    await sql(`revoke all on database ${name} from public`)
    await sql(`grant connect on database ${name} to ${migrator}, ${toolbox}`)
    await sql(`revoke temporary on database ${name} from ${toolbox}`)
    for (const mcp of mcps) {
      await sql(`create schema if not exists ${quote(mcp.name)} authorization ${migrator}`)
      await sql(`grant usage on schema ${quote(mcp.name)} to ${toolbox}`)
    }
    await sql("commit")
  } catch (error) {
    await sql("rollback")
    throw error
  }
}

/**
 * Make, or bring back in line, an MCP's schema in its own database, `answerable_mcp_<name>`, as that database's owner login, `owner`: schema
 * `<name>`, owned by `owner`, and `USAGE` on it for its runtime login, `runtime`. The database and both logins exist before it runs. Nothing
 * else: an owner login may not alter another role, so no search path is set, and `mcpDatabase` sets one on every borrow anyway.
 */
export async function provisionOwnMcp(sql: Sql, { name, owner, runtime }: { name: string; owner: string; runtime: string }): Promise<void> {
  assertMcpName(name)
  for (const login of [owner, runtime]) if (!identifier.test(login)) throw new Error(`Invalid login name "${login}"`)
  await sql(`create schema if not exists ${quote(name)} authorization ${quote(owner)}`)
  await sql(`grant usage on schema ${quote(name)} to ${quote(runtime)}`)
}
