// An MCP's migrations, its grants and the schema line drizzle-kit writes. Values come from node, pg and drizzle-orm only, never from
// @answerable/mcp, so that the ops image, which copies only this package (infra/ops/Dockerfile), can run it.
import { readFileSync } from "node:fs"
import { readMigrationFiles } from "drizzle-orm/migrator"
import type { Client } from "pg"
import { assertMcpName, identifier, mcpRoles, quote } from "./names"
import type { Grant } from "./runtime-role"

/** An MCP to migrate: shared, as its owner role through the migrator login; or own, as its own database's owner login, granting `runtime`. */
export type McpMigration = {
  name: string
  /** The MCP's drizzle folder. */
  folder: string
  /** What the runtime role may do, table by table, replacing the default: every table but the journal, read and written. */
  grants?: readonly Grant[]
} & ({ mode: "shared"; prefix?: string } | { mode: "own"; runtime: string })

/** drizzle's journal table, kept in drizzle's format in the MCP's own schema, where its owner role may create it. */
const journal = "__drizzle_migrations"
// drizzle-kit writes this after each statement, and drizzle's readMigrationFiles splits a file on it without the newline.
const breakpoint = "--> statement-breakpoint"
const privileges = new Set(["select", "insert", "update", "delete"])
// What only the platform does to an MCP's database: create its schema, grant, and take a role.
const forbidden = /\b(?:create\s+schema|alter\s+default\s+privileges|grant|revoke|set\s+(?:session\s+|local\s+)?role|reset\s+role|set\s+(?:session\s+|local\s+)?session\s+authorization)\b/gi
const tokens = /"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*|\S/gi

// The text with comments and string literals blanked, and quoted identifiers too unless `keep`, with every newline kept so an index keeps its line.
const blank = (text: string, keep: boolean) =>
  text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, match => (keep && match.startsWith('"') ? match : match.replace(/[^\n]/g, " ")))
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length

/**
 * Where a migration does what only the platform may: creates a schema, grants or revokes, takes a role, or qualifies a name with any schema
 * but `name`'s (`schemas` are those to refuse). Each problem names the line.
 */
function problems(text: string, name: string, schemas: ReadonlySet<string>) {
  const found = [...blank(text, false).matchAll(forbidden)].map(match => ({ line: lineOf(text, match.index), what: match[0].replace(/\s+/g, " ").toUpperCase() }))
  const words = [...blank(text, true).matchAll(tokens)]
  words.forEach((word, index) => {
    if (words[index + 1]?.[0] !== "." || word[0] === ".") return
    const qualifier = word[0].startsWith('"') ? word[0].slice(1, -1).replaceAll('""', '"') : word[0].toLowerCase()
    if (qualifier !== name && schemas.has(qualifier)) found.push({ line: lineOf(text, word.index), what: `schema ${qualifier}` })
  })
  return found.sort((a, b) => a.line - b.line).map(({ line, what }) => `line ${line}: ${what}`)
}

/**
 * Apply the MCP's pending migrations into schema `name`, with drizzle's journal in `<name>.__drizzle_migrations`, then its grants, in one
 * transaction. In mode `shared` the client is the migrator login, which takes the owner role `<prefix>_<name>_owner` for the transaction
 * (`prefix` is `mcp` unless given); in mode `own` it is the MCP's database's owner login. The owner role has no `CREATE` on the database, so
 * drizzle's migrator, which always creates its journal's schema, cannot run here; this loop keeps drizzle's journal format instead.
 *
 * Refused before anything runs, naming the file: an applied file whose text or journal time changed or that disappeared; and a pending file
 * that creates a schema, grants or revokes, takes a role, or names another schema, with the line. Then the grants: the runtime role gets
 * `select, insert, update, delete` on every table but the journal, or exactly `grants`, and usage on the sequences but the journal's;
 * every other privilege on the schema and its objects, `PUBLIC`'s included, is revoked. Running it again with nothing pending changes nothing.
 * `client` is one connection, not a pool: a drizzle transaction on a pool would borrow another.
 */
export async function migrateMcp({ client, name, folder, grants, ...mode }: McpMigration & { client: Client }): Promise<void> {
  assertMcpName(name)
  const roles = mode.mode === "shared" ? mcpRoles(mode.prefix ?? "mcp", name) : { owner: undefined, runtime: mode.runtime }
  if (!identifier.test(roles.runtime)) throw new Error(`Invalid runtime role name "${roles.runtime}"`)
  for (const grant of grants ?? []) {
    if (!identifier.test(grant.table) || grant.table === journal) throw new Error(`A grant names "${grant.table}", which is not a table the runtime role may be granted`)
    const unknown = grant.privileges.find(privilege => !privileges.has(privilege))
    if (unknown) throw new Error(`Invalid privilege "${unknown}" on ${grant.table}`)
  }
  const files = readMigrationFiles({ migrationsFolder: folder })
  const tags = (JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] }).entries.map(entry => `${entry.tag}.sql`)
  const schema = quote(name)
  const rows = async <T>(text: string, values?: unknown[]) => (await client.query(text, values)).rows as T[]

  await client.query("begin")
  try {
    if (roles.owner) await client.query(`set local role ${quote(roles.owner)}`)
    const [{ exists }] = await rows<{ exists: boolean }>("select to_regclass($1) is not null as exists", [`${schema}.${journal}`])
    const receipts = exists ? await rows<{ hash: string; created_at: string }>(`select hash, created_at::text from ${schema}.${journal} order by id`) : []
    for (const [index, receipt] of receipts.entries()) {
      const file = files[index]
      if (file?.hash === receipt.hash && String(file.folderMillis) === receipt.created_at) continue
      throw new Error(`Refusing to migrate ${name}: ${tags[index] ?? `the file applied as migration ${index + 1}`} is not the migration this database applied. Restore the applied file, or recreate a disposable database.`)
    }
    const pending = files.slice(receipts.length).map((file, index) => ({ ...file, tag: tags[receipts.length + index]! }))
    const schemas = new Set(["public", "drizzle", ...(await rows<{ nspname: string }>("select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'")).map(row => row.nspname)])
    const refused = pending.flatMap(file => problems(file.sql.join(breakpoint), name, schemas).map(problem => `${file.tag} ${problem}`))
    if (refused.length) throw new Error(`Refusing to migrate ${name}: ${refused.join("; ")}. A migration creates no schema, grants nothing, takes no role and names no schema but ${name}`)

    await client.query(`create table if not exists ${schema}.${journal} (id serial primary key, hash text not null, created_at bigint)`)
    for (const file of pending) {
      for (const statement of file.sql) {
        await client.query(statement).catch((error: Error) => { throw new Error(`${name}: ${file.tag} failed: ${error.message}`, { cause: error }) })
      }
      await client.query(`insert into ${schema}.${journal} (hash, created_at) values ($1, $2)`, [file.hash, file.folderMillis])
    }
    await grant(client, name, roles.runtime, grants)
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

// As the schema's owner: revoke everything every grantee holds on the schema and its objects, PUBLIC and the runtime role always, then grant.
async function grant(client: Client, name: string, runtime: string, grants: readonly Grant[] | undefined) {
  const schema = quote(name)
  const { rows: others } = await client.query<{ grantee: string }>(`select distinct acl.grantee::regrole::text as grantee
    from (select nspacl as acl, nspowner as owner from pg_namespace where nspname = $1
      union all select c.relacl, c.relowner from pg_class c where c.relnamespace = $1::regnamespace
      union all select p.proacl, p.proowner from pg_proc p where p.pronamespace = $1::regnamespace) as object, aclexplode(object.acl) as acl
    where acl.grantee not in (0, object.owner)`, [name])
  const grantees = [...new Set(["public", quote(runtime), ...others.map(row => row.grantee)])].join(", ")
  const tables = grants
    ? grants.filter(grant => grant.privileges.length).map(grant => `grant ${grant.privileges.join(", ")} on ${schema}.${quote(grant.table)} to ${quote(runtime)}`)
    : [`grant select, insert, update, delete on all tables in schema ${schema} to ${quote(runtime)}`, `revoke all on ${schema}.${journal} from ${quote(runtime)}`]
  await client.query([
    `revoke all on schema ${schema} from ${grantees}`,
    `revoke all on all tables in schema ${schema} from ${grantees}`,
    `revoke all on all sequences in schema ${schema} from ${grantees}`,
    `revoke all on all routines in schema ${schema} from ${grantees}`,
    `grant usage on schema ${schema} to ${quote(runtime)}`,
    ...tables,
    `grant usage on all sequences in schema ${schema} to ${quote(runtime)}`,
    `revoke all on sequence ${schema}.${quote(`${journal}_id_seq`)} from ${quote(runtime)}`,
  ].join(";\n"))
}

/** Migrate each MCP in turn with the connection `connection` gives it, stopping at the first failure, which names the MCP. */
export async function migrateMcps(list: readonly McpMigration[], connection: (mcp: McpMigration) => Client | Promise<Client>): Promise<void> {
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
 * provisioning creates the schema, and its owner role may not. Any other `CREATE SCHEMA` is refused, naming the line. Never run it on an
 * applied migration: the file's hash is its receipt.
 */
export function withoutSchemaCreation(text: string, name: string): string {
  assertMcpName(name)
  const kept = text.split(`${breakpoint}\n`).filter(statement => statement.trim() !== `CREATE SCHEMA ${quote(name)};`).join(`${breakpoint}\n`)
  const other = [...blank(kept, false).matchAll(/\bcreate\s+schema\b/gi)].map(match => `line ${lineOf(kept, match.index)}`)
  if (other.length) throw new Error(`Refusing a migration that creates a schema other than by drizzle-kit's own line for ${name}: ${other.join(", ")}`)
  return kept
}
