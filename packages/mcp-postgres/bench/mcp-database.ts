// What a borrow through mcpDatabase costs, and a burst over 200 MCPs on one pool. A recorded benchmark, not a gate: run it by hand with
// `bun bench/mcp-database.ts` from this package, against the development Postgres or a throwaway one named by MCPS_TEST_DATABASE_URL.
// It provisions 200 MCPs, mpgb000 to mpgb199, in answerable_mcps_test with the mcp_test prefix, and drops everything it made afterwards.
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Client, Pool } from "pg"
import { ensureLocalMcpDatabases } from "../src/local"
import { mcpDatabase } from "../src/mcp-database"
import { migrateMcps, type McpMigration } from "../src/migrate-mcp"
import { roleLock } from "../src/names"
import { provisionMcps } from "../src/provision"
import { mcpPostgresTestConfig } from "../src/testing"

const url = new URL(mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL)
const at = (pathname: string, username = url.username, password = url.password) => Object.assign(new URL(url), { pathname, username, password }).href
const names = Array.from({ length: 200 }, (_, index) => `mpgb${String(index).padStart(3, "0")}`)
const login = `mcp_test_login_${crypto.randomUUID().replaceAll("-", "")}`
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

const admin = new Client({ connectionString: url.href })
const folders = await mkdtemp(join(tmpdir(), "mcp-postgres-bench-"))
await ensureLocalMcpDatabases(at("/postgres"))
await admin.connect()
const pool = new Pool({ connectionString: at(url.pathname, login, "bench"), max: 10 })
try {
  await admin.query(`create role ${login} login password 'bench' noinherit`)
  const provisioned = await time(() => provisionMcps(async (text, params) => (await admin.query(text, params)).rows, {
    mcps: names.map(name => ({ name, servedBy: ["toolbox"] })), prefix: "mcp_test", logins: { migrator: "answerable_mcps_migrator", toolbox: login, standalone: "answerable_mcps_standalone" },
  }))
  const [initial, journal] = await Promise.all([readFile(new URL("0000_initial.sql", fixture), "utf8"), readFile(new URL("meta/_journal.json", fixture), "utf8")])
  const list: McpMigration[] = await Promise.all(names.map(async name => {
    const folder = join(folders, name)
    await mkdir(join(folder, "meta"), { recursive: true })
    await writeFile(join(folder, "0000_initial.sql"), initial.replaceAll("mpgfixb", name))
    await writeFile(join(folder, "meta/_journal.json"), journal)
    return { name, folder, mode: "shared", prefix: "mcp_test" }
  }))
  const migrator = new Client({ connectionString: at(url.pathname, "answerable_mcps_migrator", "answerable") })
  await migrator.connect()
  const migrated = await time(() => migrateMcps(list, () => migrator))
  const unchanged = await time(() => migrateMcps(list, () => migrator))
  await migrator.end()

  const db = mcpDatabase(pool, { name: names[0]!, prefix: "mcp_test", schema: {}, mode: "shared", organisation: () => organisation })
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

  const dbs = names.map(name => mcpDatabase(pool, { name, prefix: "mcp_test", schema: {}, mode: "shared", organisation: () => organisation }))
  let most = 0
  pool.on("acquire", () => { most = Math.max(most, pool.totalCount) })
  const burst = await time(() => Promise.all(Array.from({ length: 1000 }, (_, index) => dbs[index % 200]!.execute(sql`select count(*) from secrets`))))
  const { rows: [connections] } = await admin.query("select count(*)::int as open from pg_stat_activity where usename = $1", [login])
  const round = (ms: number) => Math.round(ms * 1000) / 1000
  console.log(JSON.stringify({
    postgres: (await admin.query("show server_version")).rows[0].server_version,
    max_connections: Number((await admin.query("show max_connections")).rows[0].max_connections),
    provision200Ms: round(provisioned), migrate200Ms: round(migrated), migrate200UnchangedMs: round(unchanged),
    sequentialMsPerRun: Object.fromEntries(Object.entries(sequential).map(([name, ms]) => [name, round(ms)])),
    burst: { queries: 1000, mcps: 200, ms: round(burst), poolMax: 10, mostConnections: most, openAfter: connections.open },
  }, null, 2))
} finally {
  await pool.end()
  await admin.query(`begin; select pg_advisory_xact_lock(${roleLock}); ${names.map(name => `drop schema if exists ${name} cascade; drop role if exists mcp_test_${name}_owner; drop role if exists mcp_test_${name}`).join("; ")};
    drop owned by ${login}; drop role ${login}; commit`)
  await admin.end()
  await rm(folders, { recursive: true, force: true })
}
