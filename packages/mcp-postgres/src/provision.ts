// Provisioning of MCP schemas and roles. It imports values from nothing outside this package, never from @answerable/mcp, so that the
// ops image, which copies only this package (infra/ops/Dockerfile), can run it.
import type { Client, Pool } from "pg"
import { assertMcpName, identifier, mcpRoles, quote, roleLock } from "./names"

/** A statement on one administrative connection: `text` with `$1`… bound to `params`, returning its rows, as `infra/ops`'s `pgSql` gives it. */
export type Sql = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/** The `Sql` of a connected pg client, or of a pool. */
export const sqlOf = (client: Pick<Client, "query"> | Pick<Pool, "query">): Sql => async (text, params) => (await client.query(text, params)).rows

/** The serving logins that may take an MCP's runtime role: `toolbox`, `standalone`, or both. */
export type ServedBy = "toolbox" | "standalone"

/** The shared database's three logins: `answerable_mcps_migrator`, `answerable_mcps_toolbox` and `answerable_mcps_standalone` when deployed. */
export type McpLogins = { migrator: string; toolbox: string; standalone: string }

// What a role of an MCP must never be. A CREATEROLE login may clear the rest, but only a superuser can clear these.
const unfixable = [["rolsuper", "SUPERUSER"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const

/**
 * Make, or bring back in line, every MCP of `mcps` in the connected shared database, as an administrative login with `CREATEROLE` that holds
 * the database owner's privileges (a member of `logins.migrator`, which must own it), not necessarily a superuser. In one transaction, under
 * the lock every role statement takes:
 * - the database: no privilege for `PUBLIC`, `CONNECT` for the three logins, no `TEMPORARY` for the two serving ones;
 * - for each MCP, its owner role `<prefix>_<name>_owner` and runtime role `<prefix>_<name>`, both `NOLOGIN NOINHERIT`; schema `<name>`,
 *   owned by the owner role; `USAGE` on it for the runtime role; the owner role for the migrator and for the administrative login itself, and
 *   the runtime role for each login in `servedBy`, granted `WITH INHERIT FALSE, SET TRUE`; and the runtime role revoked from a serving login
 *   not in `servedBy`. So the administrative login inherits no MCP's owner role.
 *
 * `prefix` is `mcp` unless given (tests use `mcp_test`). Every name is checked before any SQL runs. Running it twice changes nothing, and it
 * never drops anything.
 */
export async function provisionMcps(sql: Sql, { mcps, prefix = "mcp", logins }: { mcps: readonly { name: string; servedBy: readonly ServedBy[] }[]; prefix?: string; logins: McpLogins }): Promise<void> {
  const planned = mcps.map(mcp => {
    const unknown = mcp.servedBy.find(server => server !== "toolbox" && server !== "standalone")
    if (unknown) throw new Error(`MCP ${mcp.name} is served by "${unknown}"; servedBy lists toolbox and standalone`)
    return { name: mcp.name, servedBy: mcp.servedBy, ...mcpRoles(prefix, mcp.name) }
  })
  const duplicate = planned.find((mcp, index) => planned.findIndex(other => other.name === mcp.name) !== index)
  if (duplicate) throw new Error(`MCP ${duplicate.name} is listed twice`)
  for (const login of Object.values(logins)) if (!identifier.test(login)) throw new Error(`Invalid login name "${login}"`)
  const [migrator, toolbox, standalone] = [logins.migrator, logins.toolbox, logins.standalone].map(quote)

  await sql("begin")
  try {
    await sql(`select pg_advisory_xact_lock(${roleLock})`)
    const [database] = await sql("select datname as name, pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()")
    if (database!.owner !== logins.migrator) throw new Error(`Database ${database!.name} is owned by ${database!.owner}; the migrator login, ${logins.migrator}, must own it`)
    const name = quote(database!.name as string)
    await sql(`revoke all on database ${name} from public`)
    await sql(`grant connect on database ${name} to ${migrator}, ${toolbox}, ${standalone}`)
    await sql(`revoke temporary on database ${name} from ${toolbox}, ${standalone}`)
    for (const mcp of planned) {
      await role(sql, mcp.owner)
      await role(sql, mcp.runtime)
      // Postgres 16 and later let a CREATEROLE login give a schema to a role only once it may SET ROLE to it. SET is all that check needs:
      // without INHERIT this login holds none of the owner's privileges, so it grants USAGE as the owner.
      await sql(`grant ${quote(mcp.owner)} to current_user with inherit false, set true`)
      await sql(`create schema if not exists ${quote(mcp.name)} authorization ${quote(mcp.owner)}`)
      await sql(`set local role ${quote(mcp.owner)}`)
      await sql(`grant usage on schema ${quote(mcp.name)} to ${quote(mcp.runtime)}`)
      await sql("reset role")
      await sql(`grant ${quote(mcp.owner)} to ${migrator} with inherit false, set true`)
      for (const server of ["toolbox", "standalone"] as const) {
        if (mcp.servedBy.includes(server)) {
          await sql(`grant ${quote(mcp.runtime)} to ${quote(logins[server])} with inherit false, set true`)
          continue
        }
        const grants = await sql(`select pg_get_userbyid(grantor) as grantor from pg_auth_members where roleid = to_regrole($1) and member = to_regrole($2)`, [mcp.runtime, logins[server]])
        for (const { grantor } of grants) await sql(`revoke ${quote(mcp.runtime)} from ${quote(logins[server])} granted by ${quote(grantor as string)}`)
      }
    }
    await sql("commit")
  } catch (error) {
    await sql("rollback")
    throw error
  }
}

// What an MCP's role must not be, as pg_roles names it and as alter role clears it. A CREATEROLE login may clear only an attribute it holds
// itself, so only the wrong ones are altered; those only a superuser could clear are refused.
const cleared = [["rolcanlogin", "nologin"], ["rolinherit", "noinherit"], ["rolcreatedb", "nocreatedb"], ["rolcreaterole", "nocreaterole"]] as const

// Create `name`, `NOLOGIN NOINHERIT`, or clear what the role that exists has wrong.
async function role(sql: Sql, name: string) {
  const [existing] = await sql("select rolcanlogin, rolinherit, rolcreatedb, rolcreaterole, rolsuper, rolreplication, rolbypassrls from pg_roles where rolname = $1", [name])
  if (!existing) return void (await sql(`create role ${quote(name)} nologin noinherit`))
  for (const [column, attribute] of unfixable) if (existing[column]) throw new Error(`The role ${name} has ${attribute}: make it an ordinary role, then provision again`)
  const wrong = cleared.filter(([column]) => existing[column]).map(([, clause]) => clause)
  if (wrong.length) await sql(`alter role ${quote(name)} ${wrong.join(" ")}`)
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
