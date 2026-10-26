// The MCPs as the deployment serves them, on the acceptance's own PostgreSQL: the shared MCP database, answerable_mcps_acceptance, with its two
// logins, and every MCP the Toolbox serves provisioned and migrated in it, as the bootstrap and the migration Job do.
import { migrateMcp, provisionMcps, sharedMcps, sqlOf } from "@answerable/mcp-postgres"
import { mounted } from "@answerable/mcp-toolbox/mounted"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { onCleanup } from "./cleanup"
import { step } from "./step"

const postgres = "postgres://answerable:answerable@127.0.0.1:47532"
type Logins = { toolbox: string }
let made: Promise<Logins> | undefined

async function connected<T>(url: string, work: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

async function make(): Promise<Logins> {
  step("Creating answerable_mcps_acceptance, its migrator and serving logins, and every MCP's schema and roles, migrated")
  const { logins } = sharedMcps
  const passwords = Object.fromEntries(Object.keys(logins).map(login => [login, crypto.randomUUID().replaceAll("-", "")]))
  const login = (name: string) => logins[name as keyof typeof logins]
  await connected(`${postgres}/answerable_id_test`, async client => {
    // CREATE ROLE takes no parameters; the names are fixed and the passwords generated here.
    for (const [name, password] of Object.entries(passwords)) await client.query(`create role ${login(name)} login password '${password}' noinherit`)
    await client.query(`create database answerable_mcps_acceptance owner ${login("migrator")}`)
  })
  await connected(`${postgres}/answerable_mcps_acceptance`, client => provisionMcps(sqlOf(client), { mcps: mounted.map(({ provider }) => ({ name: provider.id })), logins }))
  const as = (name: string) => `postgres://${login(name)}:${passwords[name]}@127.0.0.1:47532/answerable_mcps_acceptance`
  for (const { provider } of mounted) {
    await connected(as("migrator"), client => migrateMcp({ client, name: provider.id, folder: fileURLToPath(provider.database!.migrations), mode: "shared" }))
  }
  return { toolbox: as("toolbox") }
}

/** The shared MCP database on the PostgreSQL `startId` started, made once per start: the Toolbox's serving login's URL, for `mcpDatabases`. */
export function mcpsDatabase() {
  if (!made) {
    made = make()
    onCleanup(() => { made = undefined })
  }
  return made
}
