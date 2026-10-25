// Databases for the tests of a server that serves MCPs, on the development Postgres, each a suite's own, as the deployment makes them.
import { fileURLToPath } from "node:url"
import type { Provider } from "@answerable/mcp"
import { ensureLocalMcpDatabases, migrateMcp, provisionMcps, provisionOwnMcp } from "@answerable/mcp-postgres"
import { mcpPostgresTestConfig } from "@answerable/mcp-postgres/testing"
import { Client } from "pg"

// The development cluster, as its superuser, at database `name`.
function cluster(name: string) {
  const url = new URL(mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL)
  url.pathname = `/${name}`
  return url
}
async function asSuperuser(name: string, work: (client: Client) => Promise<unknown>) {
  const client = new Client({ connectionString: cluster(name).href })
  await client.connect()
  try {
    await work(client)
  } finally {
    await client.end()
  }
}
// Statements one at a time, as the superuser: a database is created or dropped outside any transaction, which one string of several would open.
const statements = (...each: string[]) => asSuperuser("postgres", async client => { for (const statement of each) await client.query(statement) })
// A login with a generated name and password, and its URL to database `name`.
function login(name: string) {
  const role = `mcp_test_login_${crypto.randomUUID().replaceAll("-", "")}`
  const password = crypto.randomUUID().replaceAll("-", "")
  const url = cluster(name)
  Object.assign(url, { username: role, password })
  return { role, password, url: url.href }
}
const sqlOf = (client: Client) => async (text: string, params?: unknown[]) => (await client.query(text, params)).rows
const folderOf = (provider: Provider) => fileURLToPath(provider.database!.migrations)
function assertDisposable(name: string) {
  if (!/^answerable_[a-z0-9_]*_test(_[a-z0-9_]+)?$/.test(name)) throw new Error(`Refusing to make ${name}: a suite's database is answerable_<suite>_test, or that and a suffix`)
}

/**
 * A shared MCP database of a suite's own, `name` (`answerable_<suite>_test…`), made as the deployment makes `answerable_mcps`: owned by the
 * migrator login, each provider of `mcps` provisioned with `prefix`, a role prefix of the suite's own, and migrated from its `database`, and a
 * fresh serving login that may take their runtime roles, as the Toolbox's or the standalone server's. `url` is the serving login's. `close()`
 * drops the database, the login and the roles `prefix` made, so suites with different prefixes run at once.
 */
export async function testSharedMcps({ name, prefix, mcps }: { name: string; prefix: string; mcps: readonly Provider[] }) {
  assertDisposable(name)
  await ensureLocalMcpDatabases(cluster("postgres").href)
  const serving = login(name)
  await statements(`drop database if exists ${name} with (force)`, `create database ${name} owner answerable_mcps_migrator`, `create role ${serving.role} login password '${serving.password}' noinherit`)
  await asSuperuser(name, async client => {
    await provisionMcps(sqlOf(client), { mcps: mcps.map(({ id }) => ({ name: id, servedBy: ["toolbox", "standalone"] })), prefix, logins: { migrator: "answerable_mcps_migrator", toolbox: serving.role, standalone: serving.role } })
    for (const provider of mcps) await migrateMcp({ client, name: provider.id, folder: folderOf(provider), mode: "shared", prefix })
  })
  return {
    url: serving.url,
    async close() {
      const roles = mcps.flatMap(({ id }) => [`${prefix}_${id}`, `${prefix}_${id}_owner`])
      await statements(`drop database ${name} with (force)`, `drop role ${[serving.role, ...roles].join(", ")}`)
    },
  }
}

/**
 * An own MCP's database of a suite's own, `name`: owned by a fresh owner login and reachable by it and a fresh runtime login alone, with
 * `provider`'s schema provisioned and migrated as the deployment does in mode `own`. `url` is the runtime login's; `close()` drops the database
 * and both logins.
 */
export async function testOwnMcp({ name, provider }: { name: string; provider: Provider }) {
  assertDisposable(name)
  const [owner, runtime] = [login(name), login(name)]
  await statements(
    `drop database if exists ${name} with (force)`,
    ...[owner, runtime].map(each => `create role ${each.role} login password '${each.password}' noinherit`),
    `create database ${name} owner ${owner.role}`,
    `revoke all on database ${name} from public`,
    `grant connect on database ${name} to ${owner.role}, ${runtime.role}`,
  )
  const client = new Client({ connectionString: owner.url })
  await client.connect()
  try {
    await provisionOwnMcp(sqlOf(client), { name: provider.id, owner: owner.role, runtime: runtime.role })
    await migrateMcp({ client, name: provider.id, folder: folderOf(provider), mode: "own", runtime: runtime.role })
  } finally {
    await client.end()
  }
  return {
    url: runtime.url,
    close: () => statements(`drop database ${name} with (force)`, `drop role ${owner.role}, ${runtime.role}`),
  }
}
