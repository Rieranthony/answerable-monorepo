// An MCP's migrations, its grants and the schema line drizzle-kit writes. Values come from node, pg and drizzle-orm only, never from
// @answerable/mcp, so that the ops image, which copies only this package (infra/ops/Dockerfile), can run it.
import { readFileSync } from "node:fs"
import { DrizzleQueryError } from "drizzle-orm"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { drizzle } from "drizzle-orm/node-postgres"
import type { Client } from "pg"
import { migrate } from "./migrate"
import { assertMcpName, identifier, quote } from "./names"
import { privileges, type Grant } from "./runtime-role"

/** An MCP to migrate, as the owner of its schema: the migrator login in the shared database, or the owner login of an own MCP's database. */
export type McpMigration = {
  name: string
  /** The MCP's drizzle folder. */
  folder: string
  /** The login that serves the MCP and is granted its tables: the shared database's serving login, or an own MCP's runtime login. */
  serving: string
  /** What the serving login may do, table by table, replacing the default: every table but the journal, read and written. */
  grants?: readonly Grant[]
}

/** drizzle's journal table, in the MCP's own schema. */
const journal = "__drizzle_migrations"
// drizzle-kit writes this after each statement, and drizzle's readMigrationFiles splits a file on it without the newline.
const breakpoint = "--> statement-breakpoint"

// The text with comments, string literals and quoted identifiers blanked, with every newline kept so an index keeps its line.
const blank = (text: string) => text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, match => match.replace(/[^\n]/g, " "))
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length

/**
 * Apply the MCP's pending migrations into schema `name` with drizzle's migrator, its journal in `<name>.__drizzle_migrations`, as the schema's
 * owner on `client`: the migrator login in the shared database, an own MCP's owner login in its database. An applied file whose text or journal
 * time changed, or that disappeared, refuses the run before anything is applied, naming the file; a statement that fails names the MCP and its
 * file, and nothing pending is applied. Then the grants, in one transaction: `serving` gets `USAGE` on the schema, `select, insert, update,
 * delete` on every table but the journal, or exactly `grants`, and `USAGE` on the sequences but the journal's; every other privilege on the schema
 * and its objects, `PUBLIC`'s included, is revoked. Running it again with nothing pending changes nothing. `client` is one connection, not a
 * pool: a drizzle transaction on a pool would borrow another.
 */
export async function migrateMcp({ client, name, folder, serving, grants }: McpMigration & { client: Client }): Promise<void> {
  assertMcpName(name)
  if (!identifier.test(serving)) throw new Error(`Invalid serving login name "${serving}"`)
  for (const grant of grants ?? []) {
    if (!identifier.test(grant.table) || grant.table === journal) throw new Error(`A grant names "${grant.table}", which is not a table the serving login may be granted`)
    const unknown = grant.privileges.find(privilege => !privileges.has(privilege))
    if (unknown) throw new Error(`Invalid privilege "${unknown}" on ${grant.table}`)
  }
  try {
    await migrate(drizzle({ client }), { folder, schema: name })
  } catch (error) {
    if (!(error instanceof DrizzleQueryError)) throw error
    // drizzle runs each statement of a file as it is, so the latest file that holds the failed one is the pending file it came from.
    const files = readMigrationFiles({ migrationsFolder: folder })
    const tags = (JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] }).entries.map(entry => entry.tag)
    const index = files.findLastIndex(file => file.sql.includes(error.query))
    throw new Error(`${name}: ${index < 0 ? "" : `${tags[index]}.sql failed: `}${(error.cause as Error).message}`, { cause: error })
  }
  await grant(client, name, serving, grants)
}

// As the schema's owner, in one statement and so one transaction: revoke everything every grantee holds on the schema and its objects, PUBLIC and
// the serving login always, then grant.
async function grant(client: Client, name: string, serving: string, grants: readonly Grant[] | undefined) {
  const schema = quote(name)
  const login = quote(serving)
  const { rows: others } = await client.query<{ grantee: string }>(`select distinct acl.grantee::regrole::text as grantee
    from (select nspacl as acl, nspowner as owner from pg_namespace where nspname = $1
      union all select c.relacl, c.relowner from pg_class c where c.relnamespace = $1::regnamespace
      union all select p.proacl, p.proowner from pg_proc p where p.pronamespace = $1::regnamespace) as object, aclexplode(object.acl) as acl
    where acl.grantee not in (0, object.owner)`, [name])
  const grantees = [...new Set(["public", login, ...others.map(row => row.grantee)])].join(", ")
  const tables = grants
    ? grants.filter(grant => grant.privileges.length).map(grant => `grant ${grant.privileges.join(", ")} on ${schema}.${quote(grant.table)} to ${login}`)
    : [`grant select, insert, update, delete on all tables in schema ${schema} to ${login}`, `revoke all on ${schema}.${journal} from ${login}`]
  await client.query([
    `revoke all on schema ${schema} from ${grantees}`,
    `revoke all on all tables in schema ${schema} from ${grantees}`,
    `revoke all on all sequences in schema ${schema} from ${grantees}`,
    `revoke all on all routines in schema ${schema} from ${grantees}`,
    `grant usage on schema ${schema} to ${login}`,
    ...tables,
    `grant usage on all sequences in schema ${schema} to ${login}`,
    `revoke all on sequence ${schema}.${quote(`${journal}_id_seq`)} from ${login}`,
  ].join(";\n"))
}

/** Migrate each MCP in turn with the connection `connection` gives it, stopping at the first failure, which names the MCP. */
export async function migrateMcps<Migration extends McpMigration>(list: readonly Migration[], connection: (mcp: Migration) => Client | Promise<Client>): Promise<void> {
  for (const mcp of list) {
    try {
      await migrateMcp({ ...mcp, client: await connection(mcp) })
    } catch (error) {
      throw new Error(`Migrating MCP ${mcp.name} failed: ${(error as Error).message}`, { cause: error })
    }
  }
}

/**
 * The migration file drizzle-kit has just generated without its `CREATE SCHEMA "<name>";` statement and that statement's breakpoint:
 * provisioning creates the schema. Any other `CREATE SCHEMA` is refused, naming the line. Never run it on an applied migration: the file's hash
 * is its receipt.
 */
export function withoutSchemaCreation(text: string, name: string): string {
  assertMcpName(name)
  const kept = text.split(`${breakpoint}\n`).filter(statement => statement.trim() !== `CREATE SCHEMA ${quote(name)};`).join(`${breakpoint}\n`)
  const other = [...blank(kept).matchAll(/\bcreate\s+schema\b/gi)].map(match => `line ${lineOf(kept, match.index)}`)
  if (other.length) throw new Error(`Refusing a migration that creates a schema other than by drizzle-kit's own line for ${name}: ${other.join(", ")}`)
  return kept
}
