// Test support: what bun mcp makes for an MCP on the development Postgres, and its removal, so a test leaves nothing of its own behind.
import { Client } from "pg"
import { mcpCliConfig } from "../config"

/** A random MCP name, `t` and six lowercase letters or digits, which no developer's MCP has. */
export const randomName = () => `t${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`

const url = (database: string) => Object.assign(new URL(mcpCliConfig.read(process.env).MCPS_DATABASE_ADMIN_URL), { pathname: `/${database}` }).href

/** Rows of `text` on `database`, as the development superuser. */
export async function query(database: string, text: string, params: unknown[] = []) {
  const client = new Client({ connectionString: url(database) })
  await client.connect()
  try {
    // Without parameters, several statements run as one simple query.
    return (await (params.length ? client.query(text, params) : client.query(text))).rows
  } finally {
    await client.end()
  }
}

/** What exists of MCP `name`: its schemas in the shared databases, its roles and logins, and its own database. */
export async function traces(name: string) {
  const schemas = async (database: string) => (await query(database, "select nspname from pg_namespace where nspname = $1", [name])).map(row => `${database}.${row.nspname}`)
  const roles = await query("postgres", "select rolname from pg_roles where rolname like any($1) order by 1", [[`mcp_${name}%`, `mcp_test_${name}%`, `answerable_mcp_${name}_%`]])
  const databases = await query("postgres", "select datname from pg_database where datname = $1", [`answerable_mcp_${name}`])
  return [...(await schemas("answerable_mcps")), ...(await schemas("answerable_mcps_test")), ...roles.map(row => row.rolname), ...databases.map(row => row.datname)]
}

/** Drop everything bun mcp and the MCP's tests made for `name`, under the lock every role statement takes. */
export async function forget(name: string) {
  for (const database of ["answerable_mcps", "answerable_mcps_test"]) await query(database, `drop schema if exists "${name}" cascade`)
  await query("postgres", `drop database if exists answerable_mcp_${name} with (force)`)
  const roles = [`mcp_${name}`, `mcp_${name}_owner`, `mcp_test_${name}`, `mcp_test_${name}_owner`, `answerable_mcp_${name}_owner`, `answerable_mcp_${name}_runtime`]
  await query("postgres", `begin; select pg_advisory_xact_lock(hashtext('answerable:mcp-runtime-role')); ${roles.map(role => `drop role if exists ${role}`).join("; ")}; commit`)
}
