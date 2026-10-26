// The Toolbox at 200 MCPs. A recorded benchmark, not a gate: `bun bench/scale.ts [runs] [mcps]` from this workspace, on the development Postgres.
// 200 synthetic MCPs unless `mcps` says another number, bench000 on, each with one table limited to the caller's organisation (items) and 5 tools in 2 domains:
// items.list, items.get, items.add and items.remove, and stats.count. On databases of its own, dropped with their roles afterwards, it measures:
// - boot ingest of them all, first and unchanged, on a fresh Toolbox database for each of `runs`;
// - a burst of 1,000 tool calls over every MCP, from 20 organisations at once, through the Toolbox in process and its one pool to the shared MCP
//   database: the time, the most connections that pool held, and the errors;
// - 1,000 tool calls one at a time with each caller's profile cached: the median and the largest.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { defineProvider, withDatabase } from "@answerable/mcp"
import { mcpDatabases } from "@answerable/mcp-platform"
import { testSharedMcps } from "@answerable/mcp-platform/testing"
import { organisationIsolation } from "@answerable/mcp-postgres"
import { mcpPostgresTestConfig } from "@answerable/mcp-postgres/testing"
import { count, eq } from "drizzle-orm"
import { pgSchema, text, uuid } from "drizzle-orm/pg-core"
import { Client } from "pg"
import { z } from "zod"
import { ingest, writeHostClient } from "../src/catalogue"
import { migrate } from "../src/db/migrate"
import { database } from "../src/test/database"
import { createHub } from "../src/test/hub"

const runs = Number(process.argv[2] ?? 3)
const names = Array.from({ length: Number(process.argv[3] ?? 200) }, (_, index) => `bench${String(index).padStart(3, "0")}`)
const prefix = "mcp_tbench"
const sharedName = "answerable_toolbox_test_benchmcps"

// The migration bun mcp db generate would write for the table below.
const migration = (name: string) => {
  const match = `"${name}"."items"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid`
  return `CREATE TABLE "${name}"."items" (
\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
\t"organisation_id" uuid NOT NULL,
\t"title" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "${name}"."items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "${name}"."items" AS PERMISSIVE FOR ALL TO public USING (${match}) WITH CHECK (${match});`
}
const journal = JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1792949253320, tag: "0000_initial", breakpoints: true }] })

// One synthetic MCP, as bun mcp new and add tool would make it: its schema, its tools on its typed db, and its migrations folder.
function benchProvider(name: string, migrations: URL) {
  const items = pgSchema(name).table("items", { id: uuid().primaryKey().defaultRandom(), organisation_id: uuid().notNull(), title: text().notNull() }, table => [organisationIsolation(table.organisation_id)]).enableRLS()
  const schema = { items }
  const { defineTool, defineMutation } = withDatabase({ schema })
  const item = z.object({ id: z.uuid(), title: z.string() })
  const fields = { id: items.id, title: items.title }
  return defineProvider({
    id: name, description: "A synthetic MCP for the Toolbox's scale benchmark: items of the caller's organisation, listed, read, added and removed.", version: "2026-10-26",
    database: { schema, migrations },
    tools: [
      defineTool({
        name: "items.list", description: "List the items of the caller's organisation, up to limit, for the benchmark; it changes nothing.",
        input: z.object({ limit: z.number().int().min(1).max(100).default(20) }), output: z.object({ items: z.array(item) }),
        async execute({ limit }, { db }) { return { items: await db.select(fields).from(items).limit(limit) } },
      }),
      defineTool({
        name: "items.get", description: "Read one item of the caller's organisation by its id, for the benchmark; it changes nothing.",
        input: z.object({ id: z.uuid() }), output: z.object({ item: item.nullable() }),
        async execute({ id }, { db }) { return { item: (await db.select(fields).from(items).where(eq(items.id, id)))[0] ?? null } },
      }),
      defineTool({
        name: "stats.count", description: "Count the items of the caller's organisation, for the benchmark; it changes nothing.",
        input: z.object({}), output: z.object({ items: z.number() }),
        async execute(_input, { db }) { return { items: (await db.select({ n: count() }).from(items))[0]!.n } },
      }),
      defineMutation({
        name: "items.add", description: "Prepare adding an item to the caller's organisation, for the benchmark; commit the intent to add it.",
        input: z.object({ title: z.string().min(1) }), output: item,
        async prepare({ title }) { return { targets: [], preview: { summary: `Add ${title}` }, plan: { title } } },
        async commit({ plan }, { db, organisation }) {
          const [row] = await db.insert(items).values({ organisation_id: organisation.id, title: plan.title }).returning(fields)
          return { results: row!, applied_changes: [], effects_performed: [] }
        },
      }),
      defineMutation({
        name: "items.remove", description: "Prepare removing an item of the caller's organisation, for the benchmark; commit the intent to remove it.",
        input: z.object({ id: z.uuid() }), output: z.object({ removed: z.number() }),
        async prepare({ id }) { return { targets: [], preview: { summary: `Remove ${id}` }, plan: { id } } },
        async commit({ plan }, { db }) { return { results: { removed: (await db.delete(items).where(eq(items.id, plan.id)).returning()).length }, applied_changes: [], effects_performed: [] } },
      }),
    ],
  })
}

const elapsed = (started: number) => performance.now() - started
const ms = (value: number) => Math.round(value * 10) / 10
const folders = await mkdtemp(join(tmpdir(), "toolbox-bench-"))
try {
  const providers = await Promise.all(names.map(async name => {
    await mkdir(join(folders, name, "meta"), { recursive: true })
    await writeFile(join(folders, name, "0000_initial.sql"), migration(name))
    await writeFile(join(folders, name, "meta/_journal.json"), journal)
    return benchProvider(name, pathToFileURL(`${join(folders, name)}/`))
  }))

  for (let run = 1; run <= runs; run++) {
    const scratch = await database.scratch("bench")
    try {
      await migrate(scratch.db)
      let started = performance.now()
      await ingest(scratch.db, providers)
      const first = elapsed(started)
      started = performance.now()
      await ingest(scratch.db, providers)
      console.log(`ingest run ${run}: ${names.length} × 5, first boot ${ms(first)} ms, unchanged boot ${ms(elapsed(started))} ms`)
    } finally {
      await scratch.drop()
    }
  }

  const shared = await testSharedMcps({ name: sharedName, prefix, mcps: providers })
  const toolboxDb = await database.scratch("bench")
  const opened = mcpDatabases(providers.map(provider => ({ provider, serve: "toolbox" as const, database: "shared" as const })), { shared: shared.url, own: {}, prefix })
  try {
    await migrate(toolboxDb.db)
    const pool = opened.pools.mcps!
    let most = 0
    pool.on("acquire", () => { most = Math.max(most, pool.totalCount) })
    const hub = await createHub(toolboxDb.db, opened.mount)
    // A host that asks for every tool by name: a person granted 1,000 tools would get the meta tools under the default projection.
    await writeHostClient(toolboxDb.db, "test-client", { projection: "direct" })
    const people = await Promise.all(Array.from({ length: 20 }, () => hub.member(names)))
    // One item per MCP for each organisation, written past row-level security as the cluster's superuser.
    const superuser = new Client({ connectionString: Object.assign(new URL(mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL), { pathname: `/${sharedName}` }).href })
    await superuser.connect()
    const seeded = new Map<string, string>()
    try {
      for (const name of names) {
        const { rows } = await superuser.query(`insert into ${name}.items (organisation_id, title) select unnest($1::uuid[]), 'seed' returning id, organisation_id`, [people.map(person => person.organizationId)])
        for (const row of rows) seeded.set(`${row.organisation_id} ${name}`, row.id)
      }
    } finally {
      await superuser.end()
    }
    const clients = await Promise.all(people.map(person => person.connect()))
    // Call `index`'s tool: MCP index mod 200, as person index mod 20, cycling through the three reads. Answers whether the call failed.
    async function call(index: number) {
      const name = names[index % names.length]!
      const person = people[index % people.length]!
      const [tool, args] = ([["items_list", {}], ["stats_count", {}], ["items_get", { id: seeded.get(`${person.organizationId} ${name}`) }]] as const)[index % 3]!
      const result = await clients[index % clients.length]!.callTool({ name: `${name}_${tool}`, arguments: args }).catch((error: Error) => ({ isError: true, error }))
      return Boolean(result.isError)
    }
    // Every caller's grants and profile read once, as a running Toolbox would have them cached.
    await Promise.all(clients.map((_, index) => call(index)))
    most = 0
    const started = performance.now()
    const failed = (await Promise.all(Array.from({ length: 1000 }, (_, index) => call(index)))).filter(Boolean).length
    const burst = elapsed(started)
    const latencies: number[] = []
    for (let index = 0; index < 1000; index++) {
      const one = performance.now()
      if (await call(index)) throw new Error(`call ${index} failed`)
      latencies.push(elapsed(one))
    }
    latencies.sort((a, b) => a - b)
    console.log(JSON.stringify({
      burst: { calls: 1000, mcps: names.length, organisations: people.length, ms: ms(burst), errors: failed, poolMax: 10, mostConnections: most },
      sequential: { calls: 1000, medianMs: ms(latencies[latencies.length / 2]!), maxMs: ms(latencies.at(-1)!), p99Ms: ms(latencies[Math.floor(latencies.length * 0.99)]!) },
    }, null, 2))
    await Promise.all(clients.map(client => client.close()))
  } finally {
    await opened.close()
    await toolboxDb.drop()
    await shared.close()
  }
} finally {
  await rm(folders, { recursive: true, force: true })
}
