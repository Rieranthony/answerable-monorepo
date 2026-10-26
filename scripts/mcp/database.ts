// An MCP's database on this machine: its migrations, written by drizzle-kit without the schema line, and its local development schema,
// provisioned and migrated as the deployment does it (@answerable/mcp-postgres).
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { migrateMcp, ownMcpDatabase, provisionMcps, provisionOwnMcp, sharedMcps, sqlOf, withoutSchemaCreation } from "@answerable/mcp-postgres"
import { is } from "drizzle-orm"
import { getTableConfig, PgTable } from "drizzle-orm/pg-core"
import { Client } from "pg"
import { readSettings } from "./environment"
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
 * Provision and migrate the local development schemas of `mcps`, in this process, as the deployment does. The shared ones on one administrator
 * connection, their schemas in `answerable_mcps` provisioned at once, then on one migrator connection, granting the Toolbox's serving login every
 * table read and written. Each own one in turn: its database `answerable_mcp_<name>` and its two logins, migrated as its owner login, granting
 * its runtime login the same. The logins have the development password. The admin URL is the root `.env`'s, wherever it runs (`readSettings`).
 * A line for each MCP, in order, of what it did.
 */
export async function migrateLocal(root: string, mcps: readonly Declaration[]): Promise<string[]> {
  const admin = new URL((await readSettings(root)).settings.MCPS_DATABASE_ADMIN_URL)
  // `admin`'s server and database as `login`, with the development password.
  const as = (login: string, pathname = admin.pathname) => Object.assign(new URL(admin), { username: login, password: "answerable", pathname })
  const folder = (name: string) => join(root, "mcps", name, "drizzle")
  const migrations = (name: string) => existsSync(join(folder(name), "meta/_journal.json"))
  const done = (name: string, database: string) => `schema ${name} in ${database}: ${migrations(name) ? "migrated" : "provisioned; no migration yet"}`
  const shared = mcps.filter(mcp => mcp.database === "shared")
  if (shared.length) {
    const { migrator, toolbox } = sharedMcps.logins
    await connected(admin, client => provisionMcps(sqlOf(client), { mcps: shared, logins: sharedMcps.logins }))
    // Each migration error names its MCP: `Refusing to migrate acme: …`, `acme: 0001_notes.sql failed: …`.
    const pending = shared.filter(mcp => migrations(mcp.name))
    if (pending.length) await connected(as(migrator), async client => { for (const { name } of pending) await migrateMcp({ client, name, folder: folder(name), serving: toolbox }) })
  }
  for (const { name } of mcps.filter(mcp => mcp.database === "own")) {
    const { database: own, owner, runtime } = ownMcpDatabase(name)
    await connected(Object.assign(new URL(admin), { pathname: "/postgres" }), async client => {
      for (const login of [owner, runtime]) {
        if (!(await client.query("select 1 from pg_roles where rolname = $1", [login])).rowCount) await client.query(`create role ${login} login password 'answerable' noinherit`)
      }
      if (!(await client.query("select 1 from pg_database where datname = $1", [own])).rowCount) await client.query(`create database ${own} owner ${owner}`)
      await client.query(`revoke all on database ${own} from public; grant connect on database ${own} to ${owner}, ${runtime}`)
    })
    await connected(as(owner, `/${own}`), async client => {
      await provisionOwnMcp(sqlOf(client), { name, owner, runtime })
      if (migrations(name)) await migrateMcp({ client, name, folder: folder(name), serving: runtime })
    })
  }
  return mcps.map(({ name, database }) => done(name, database === "shared" ? admin.pathname.slice(1) : ownMcpDatabase(name).database))
}
