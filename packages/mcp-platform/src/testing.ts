// Databases for the tests of a server that serves MCPs, on the development Postgres, each a suite's own, as the deployment makes them. bun run
// mcp:test runs suites concurrently, so a suite names databases no other suite uses (the Toolbox's answerable_toolbox_test_mcps and
// answerable_toolbox_test_<name>, this package's answerable_mcp_platform_test and the two beside it), and every login's name is generated:
// logins are cluster-wide.
import { fileURLToPath } from "node:url"
import type { Provider } from "@answerable/mcp"
import { migrateMcp, provisionMcps, provisionOwnMcp, sharedMcps, sqlOf } from "@answerable/mcp-postgres"
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
const folderOf = (provider: Provider) => fileURLToPath(provider.database!.migrations)
function assertDisposable(name: string) {
  if (!/^answerable_[a-z0-9_]*_test(_[a-z0-9_]+)?$/.test(name)) throw new Error(`Refusing to make ${name}: a suite's database is answerable_<suite>_test, or that and a suffix`)
}

/**
 * A shared MCP database of a suite's own, `name` (`answerable_<suite>_test…`), made as the deployment makes `answerable_mcps`: owned by the
 * migrator login, each provider of `mcps` provisioned for a fresh serving login, as the Toolbox's, then migrated from its `database` as the
 * migrator, with the development password. `url` is the serving login's. `close()` drops the database and the login, so suites run at once.
 */
export async function testSharedMcps({ name, mcps }: { name: string; mcps: readonly Provider[] }) {
  assertDisposable(name)
  const serving = login(name)
  await statements(`drop database if exists ${name} with (force)`, `create database ${name} owner ${sharedMcps.logins.migrator}`, `create role ${serving.role} login password '${serving.password}' noinherit`)
  await asSuperuser(name, client => provisionMcps(sqlOf(client), { mcps: mcps.map(({ id }) => ({ name: id })), logins: { migrator: sharedMcps.logins.migrator, toolbox: serving.role } }))
  const client = new Client({ connectionString: Object.assign(cluster(name), { username: sharedMcps.logins.migrator, password: "answerable" }).href })
  await client.connect()
  try {
    for (const provider of mcps) await migrateMcp({ client, name: provider.id, folder: folderOf(provider), serving: serving.role })
  } finally {
    await client.end()
  }
  return {
    url: serving.url,
    close: () => statements(`drop database ${name} with (force)`, `drop role ${serving.role}`),
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
    await migrateMcp({ client, name: provider.id, folder: folderOf(provider), serving: runtime.role })
  } finally {
    await client.end()
  }
  return {
    url: runtime.url,
    close: () => statements(`drop database ${name} with (force)`, `drop role ${owner.role}, ${runtime.role}`),
  }
}
