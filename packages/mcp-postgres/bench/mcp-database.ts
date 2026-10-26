// The shared MCP database at 200 MCPs. A recorded benchmark, not a gate: `bun bench/mcp-database.ts` from this package, on the development Postgres
// (MCPS_TEST_DATABASE_URL names its superuser). In a database of its own, answerable_mcps_bench, owned by the migrator login as answerable_mcps is,
// it provisions 200 MCPs, mpgb000 to mpgb199, each with one table limited to the caller's organisation, under the role prefix mcp_bench, then
// measures provisioning, the first migration and one with nothing pending, the database's size, what a borrow through mcpDatabase costs, and a
// burst of 1,000 queries over the 200 on one pool of 10. It drops the database, the roles and the login it made afterwards.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Client, Pool } from "pg"
import { ensureLocalMcpDatabases } from "../src/local"
import { mcpDatabase } from "../src/mcp-database"
import { migrateMcps, type McpMigration } from "../src/migrate-mcp"
import { roleLock, sharedMcps } from "../src/names"
import { provisionMcps, sqlOf } from "../src/provision"
import { mcpPostgresTestConfig } from "../src/testing"

const database = "answerable_mcps_bench"
const prefix = "mcp_bench"
const url = new URL(mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL)
const at = (pathname: string, username = url.username, password = url.password) => Object.assign(new URL(url), { pathname, username, password }).href
const names = Array.from({ length: 200 }, (_, index) => `mpgb${String(index).padStart(3, "0")}`)
const login = `mcp_bench_login_${crypto.randomUUID().replaceAll("-", "")}`
const organisation = crypto.randomUUID()
const fixture = new URL("../src/test/fixtures/mpgfixb/", import.meta.url)
const time = async (work: () => Promise<unknown>) => {
  const start = performance.now()
  await work()
  return performance.now() - start
}
// Mean milliseconds per run of `work`, sequentially, after 100 runs of warm-up.
async function perRun(work: () => Promise<unknown>, runs = 2000) {
  for (let run = 0; run < 100; run++) await work()
  return (await time(async () => { for (let run = 0; run < runs; run++) await work() })) / runs
}

await ensureLocalMcpDatabases(at("/postgres"))
const cluster = new Client({ connectionString: at("/postgres") })
await cluster.connect()
await cluster.query(`drop database if exists ${database} with (force)`)
await cluster.query(`create database ${database} owner ${sharedMcps.logins.migrator}`)
await cluster.query(`create role ${login} login password 'bench' noinherit`)
const admin = new Client({ connectionString: at(`/${database}`) })
const pool = new Pool({ connectionString: at(`/${database}`, login, "bench"), max: 10 })
const folders = await mkdtemp(join(tmpdir(), "mcp-postgres-bench-"))
try {
  await admin.connect()
  const provisioned = await time(() => provisionMcps(sqlOf(admin), { mcps: names.map(name => ({ name })), prefix, logins: { ...sharedMcps.logins, toolbox: login } }))
  const [initial, journal] = await Promise.all([readFile(new URL("0000_initial.sql", fixture), "utf8"), readFile(new URL("meta/_journal.json", fixture), "utf8")])
  const list: McpMigration[] = await Promise.all(names.map(async name => {
    const folder = join(folders, name)
    await mkdir(join(folder, "meta"), { recursive: true })
    await writeFile(join(folder, "0000_initial.sql"), initial.replaceAll("mpgfixb", name))
    await writeFile(join(folder, "meta/_journal.json"), journal)
    return { name, folder, mode: "shared", prefix }
  }))
  const migrator = new Client({ connectionString: at(`/${database}`, sharedMcps.logins.migrator, "answerable") })
  await migrator.connect()
  const migrated = await time(() => migrateMcps(list, () => migrator))
  const unchanged = await time(() => migrateMcps(list, () => migrator))
  await migrator.end()
  const size = Number((await admin.query("select pg_database_size(current_database()) as bytes")).rows[0].bytes)

  const db = mcpDatabase(pool, { name: names[0]!, prefix, schema: {}, mode: "shared", organisation: () => organisation })
  const query = sql`select 1`
  const sequential = {
    plain: await perRun(() => pool.query("select 1")),
    mcpDatabase: await perRun(() => db.execute(query)),
    plainTransaction: await perRun(async () => {
      const client = await pool.connect()
      try {
        await client.query("begin")
        for (let index = 0; index < 10; index++) await client.query("select 1")
        await client.query("commit")
      } finally {
        client.release()
      }
    }),
    mcpDatabaseTransaction: await perRun(() => db.transaction(async tx => { for (let index = 0; index < 10; index++) await tx.execute(query) })),
  }

  const dbs = names.map(name => mcpDatabase(pool, { name, prefix, schema: {}, mode: "shared", organisation: () => organisation }))
  let most = 0
  pool.on("acquire", () => { most = Math.max(most, pool.totalCount) })
  let results: PromiseSettledResult<unknown>[] = []
  const burst = await time(async () => { results = await Promise.allSettled(Array.from({ length: 1000 }, (_, index) => dbs[index % 200]!.execute(sql`select count(*) from secrets`))) })
  const { rows: [connections] } = await admin.query("select count(*)::int as open from pg_stat_activity where usename = $1", [login])
  const round = (value: number) => Math.round(value * 1000) / 1000
  console.log(JSON.stringify({
    postgres: (await admin.query("show server_version")).rows[0].server_version,
    max_connections: Number((await admin.query("show max_connections")).rows[0].max_connections),
    provision200Ms: round(provisioned), migrate200Ms: round(migrated), migrate200UnchangedMs: round(unchanged), databaseMiB: round(size / 1048576),
    sequentialMsPerRun: Object.fromEntries(Object.entries(sequential).map(([name, ms]) => [name, round(ms)])),
    burst: { queries: 1000, mcps: 200, ms: round(burst), errors: results.filter(result => result.status === "rejected").length, poolMax: 10, mostConnections: most, openAfter: connections.open },
  }, null, 2))
} finally {
  await pool.end()
  await admin.end()
  await cluster.query(`drop database ${database} with (force)`)
  await cluster.query(`begin; select pg_advisory_xact_lock(${roleLock}); drop role ${login}; ${names.map(name => `drop role if exists ${prefix}_${name}_owner; drop role if exists ${prefix}_${name}`).join("; ")}; commit`)
  await cluster.end()
  await rm(folders, { recursive: true, force: true })
}
