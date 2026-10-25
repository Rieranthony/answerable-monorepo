// Boot ingest at 200 providers of 5 tools each (3 reads, 2 mutations), on a scratch database beside the Toolbox's test database: the first boot,
// then an unchanged one, each run on a fresh database. Not a gate: bun bench/ingest.ts [runs], and the times go in the evidence report.
import { defineMutation, defineProvider, defineTool } from "@answerable/mcp"
import { z } from "zod"
import { ingest } from "../src/catalogue"
import { migrate } from "../src/db/migrate"
import { database } from "../src/test/database"

const runs = Number(process.argv[2] ?? 3)
const providers = Array.from({ length: 200 }, (_, index) => defineProvider({
  id: `bench${index}`, description: "A benchmark provider: three reads and two mutations over its records, none of which runs.", version: "2026-10-25",
  tools: [
    ...["records.list", "records.get", "records.search"].map(name => defineTool({
      name, description: `Read ${name} of the benchmark provider; it changes nothing and returns nothing.`,
      input: z.object({ id: z.string().optional(), limit: z.number().int().max(100).default(20) }), output: z.object({ items: z.array(z.string()) }), async execute() { return { items: [] } },
    })),
    ...["records.create", "records.delete"].map(name => defineMutation({
      name, description: `Prepare ${name} for the benchmark provider; commit the intent to apply it.`, input: z.object({ title: z.string() }), output: z.object({ id: z.string() }),
      async prepare() { return { targets: [], preview: { summary: name } } }, async commit() { return { results: { id: "x" }, applied_changes: [], effects_performed: [] } },
    })),
  ],
}))
const seconds = (started: number) => ((performance.now() - started) / 1000).toFixed(2)
for (let run = 1; run <= runs; run++) {
  const scratch = await database.scratch("bench")
  try {
    await migrate(scratch.db)
    let started = performance.now()
    await ingest(scratch.db, providers)
    const first = seconds(started)
    started = performance.now()
    await ingest(scratch.db, providers)
    console.log(`run ${run}: 200 × 5, first boot ${first} s, unchanged boot ${seconds(started)} s`)
  } finally {
    await scratch.drop()
  }
}
