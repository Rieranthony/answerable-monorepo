// The MCPs as the deployment serves them, on the acceptance's own PostgreSQL: the shared MCP database, answerable_mcps_acceptance, with its three
// logins, and every MCP the Toolbox mounts or the standalone server serves provisioned and migrated in it, as the bootstrap and the migration Job do.
import { migrateMcp, provisionMcps, sharedMcps, sqlOf, type ServedBy } from "@answerable/mcp-postgres"
import { mounted } from "@answerable/mcp-toolbox/mounted"
import { served } from "@answerable/mcp-standalone/served"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { onCleanup } from "./cleanup"
import { step } from "./step"

const postgres = "postgres://answerable:answerable@127.0.0.1:47532"
type Logins = { toolbox: string; standalone: string }
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
  const mcps = new Map<string, { provider: (typeof mounted)[number]["provider"]; servedBy: ServedBy[] }>()
  for (const [list, server] of [[mounted, "toolbox"], [served, "standalone"]] as const) {
    for (const { provider } of list) mcps.set(provider.id, { provider, servedBy: [...mcps.get(provider.id)?.servedBy ?? [], server] })
  }
  await connected(`${postgres}/answerable_mcps_acceptance`, client => provisionMcps(sqlOf(client), {
    mcps: [...mcps.values()].map(({ provider, servedBy }) => ({ name: provider.id, servedBy })), logins,
  }))
  const as = (name: string) => `postgres://${login(name)}:${passwords[name]}@127.0.0.1:47532/answerable_mcps_acceptance`
  for (const { provider } of mcps.values()) {
    await connected(as("migrator"), client => migrateMcp({ client, name: provider.id, folder: fileURLToPath(provider.database!.migrations), mode: "shared" }))
  }
  return { toolbox: as("toolbox"), standalone: as("standalone") }
}

/**
 * The shared MCP database on the PostgreSQL `startId` started, made once per start: each serving login's URL, the Toolbox's and the standalone
 * server's, for `mcpDatabases`.
 */
export function mcpsDatabase() {
  if (!made) {
    made = make()
    onCleanup(() => { made = undefined })
  }
  return made
}
