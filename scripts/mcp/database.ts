// An MCP's database on this machine: its migrations, written by drizzle-kit without the schema line, and its local development schema,
// provisioned and migrated as the deployment does it (@answerable/mcp-postgres).
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { ensureLocalMcpDatabases, migrateMcp, ownMcpDatabase, provisionMcps, provisionOwnMcp, servedBy, sharedMcps, sqlOf, withoutSchemaCreation, type Grant } from "@answerable/mcp-postgres"
import { is } from "drizzle-orm"
import { getTableConfig, PgTable } from "drizzle-orm/pg-core"
import { Client } from "pg"
import { mcpCliConfig } from "./config"
import { Refusal, tail, type Exec } from "./io"
import { schemaBinding } from "./templates"
import type { Declaration } from "./workspace"

const drizzleKit = join(dirname(Bun.resolveSync("drizzle-kit", import.meta.dir)), "bin.cjs")
const sqlFiles = (folder: string) => (existsSync(folder) ? readdirSync(folder).filter(file => file.endsWith(".sql")) : [])

/** Refuse a table that `src/db/schema.ts` defines outside `pgSchema("<name>")`: drizzle-kit would put it in `public`, which no MCP may touch. */
export async function assertTablesInSchema(root: string, name: string): Promise<void> {
  // A fresh import each time, so a schema changed since this process last read it is read again.
  const module: Record<string, unknown> = await import(`${join(root, "mcps", name, "src/db/schema.ts")}?read=${crypto.randomUUID()}`)
  const outside = Object.entries(module).filter(([, value]) => is(value, PgTable) && getTableConfig(value).schema !== name).map(([binding]) => binding)
  if (outside.length) {
    throw new Refusal("table-outside-schema", `mcps/${name}/src/db/schema.ts defines ${outside.join(", ")} outside pgSchema("${name}"); define every table with ${schemaBinding(name)}.table(…)`, `bun mcp db ${name} generate`)
  }
}

/**
 * Write the migration for the change to `src/db/schema.ts`, with drizzle-kit, named `migration` when given, then remove drizzle-kit's
 * `CREATE SCHEMA` line from each file it has just written: provisioning makes the schema. The files written, none when nothing changed.
 */
export async function generateMigration(exec: Exec, root: string, name: string, migration?: string): Promise<string[]> {
  const dir = join(root, "mcps", name)
  const folder = join(dir, "drizzle")
  const before = new Set(sqlFiles(folder))
  const command = [process.execPath, drizzleKit, "generate", "--dialect", "postgresql", "--schema", "src/db/schema.ts", "--out", "drizzle"]
  const { code, output } = await exec(migration ? [...command, "--name", migration] : command, { cwd: dir })
  if (code) throw new Error(`drizzle-kit generate answered ${code}:\n${tail(output)}`)
  const written = sqlFiles(folder).filter(file => !before.has(file))
  for (const file of written) await Bun.write(join(folder, file), withoutSchemaCreation(await Bun.file(join(folder, file)).text(), name))
  return written.map(file => `drizzle/${file}`)
}

// A Postgres that does not answer, named, with how to start it.
const unreachable = (url: URL) => (error: Error & { code?: string }) => {
  throw error.code === "ECONNREFUSED" ? new Error(`the development Postgres does not answer on ${url.host}; start it with bun run env:up from the main checkout`, { cause: error }) : error
}

// Work on one connection to `url`, closed afterwards.
async function connected(url: URL, work: (client: Client) => Promise<unknown>) {
  const client = new Client({ connectionString: url.href })
  await client.connect().catch(unreachable(url))
  try {
    await work(client)
  } finally {
    await client.end()
  }
}

/**
 * Provision and migrate the MCP's local development schema, as the deployment does: the local databases first when missing, then, shared, its
 * schema and roles in `answerable_mcps`, or, own, its database `answerable_mcp_<name>` and its two logins, with the development password.
 * The grants are those `src/db/grants.ts` exports as `grants`, else every table read and written. What it did, in words.
 */
export async function migrateLocal(root: string, { name, serve, database }: Declaration): Promise<string> {
  const admin = new URL(mcpCliConfig.read(process.env).MCPS_DATABASE_ADMIN_URL)
  const cluster = new URL(admin)
  cluster.pathname = "/postgres"
  await ensureLocalMcpDatabases(cluster.href).catch(unreachable(cluster))
  const dir = join(root, "mcps", name)
  const folder = join(dir, "drizzle")
  const migrations = existsSync(join(folder, "meta/_journal.json"))
  const grantsFile = join(dir, "src/db/grants.ts")
  const grants = existsSync(grantsFile) ? ((await import(grantsFile)) as { grants?: readonly Grant[] }).grants : undefined
  const done = `${migrations ? "migrated" : "provisioned; no migration yet"}${grants ? ", with src/db/grants.ts" : ""}`
  if (database === "shared") {
    await connected(admin, async client => {
      await provisionMcps(sqlOf(client), { mcps: [{ name, servedBy: servedBy[serve] }], logins: sharedMcps.logins })
      if (migrations) await migrateMcp({ client, name, folder, mode: "shared", grants })
    })
    return `schema ${name} in ${admin.pathname.slice(1)}: ${done}`
  }
  const { database: own, owner, runtime } = ownMcpDatabase(name)
  await connected(cluster, async client => {
    for (const login of [owner, runtime]) {
      if (!(await client.query("select 1 from pg_roles where rolname = $1", [login])).rowCount) await client.query(`create role ${login} login password 'answerable' noinherit`)
    }
    if (!(await client.query("select 1 from pg_database where datname = $1", [own])).rowCount) await client.query(`create database ${own} owner ${owner}`)
    await client.query(`revoke all on database ${own} from public; grant connect on database ${own} to ${owner}, ${runtime}`)
  })
  const asOwner = new URL(cluster)
  Object.assign(asOwner, { username: owner, password: "answerable", pathname: `/${own}` })
  await connected(asOwner, async client => {
    await provisionOwnMcp(sqlOf(client), { name, owner, runtime })
    if (migrations) await migrateMcp({ client, name, folder, mode: "own", runtime, grants })
  })
  return `schema ${name} in ${own}: ${done}`
}
