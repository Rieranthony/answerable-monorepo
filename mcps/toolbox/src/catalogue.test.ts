import { afterAll, beforeAll, expect, test } from "bun:test"
import { defineMutation, defineProvider, defineTool } from "@answerable/mcp"
import { z } from "zod"
import { ingest, readCatalogue, writeCatalogue } from "./catalogue"
import { migrate } from "./db/migrate"
import { testDatabase } from "./test/database"

const db = testDatabase()
beforeAll(() => migrate(db))
afterAll(() => db.close())

const providerId = () => `c${crypto.randomUUID().slice(0, 8)}`
function provider(id: string, { version = "2026-09-29", title = "Search tickets", limit = 100 } = {}) {
  const search = defineTool({
    name: "tickets.search", title, description: "Search the organisation's tickets by words in their subject, newest first.",
    input: z.object({ query: z.string(), limit: z.number().int().max(limit).default(20) }), output: z.object({ ids: z.array(z.string()) }),
    async execute() { return { ids: [] } },
  })
  const close = defineMutation({
    name: "tickets.close", risk: "high", description: "Prepare closing a ticket. Changes nothing: returns an intent to commit.",
    input: z.object({ id: z.string() }), output: z.object({ closed: z.boolean() }),
    async prepare({ id }) { return { targets: [], preview: { summary: `Close ${id}` } } },
    async commit() { return { results: { closed: true }, applied_changes: [], effects_performed: [] } },
  })
  return defineProvider({ id, version, tools: [search, close] })
}
const rows = (id: string) => db`select identity, version, kind, risk, title, input -> 'required' as required from capabilities where provider_id = ${id} order by identity, version`

test("ingest stores a provider's manifest and each capability, without the commit tools; a mutation's class is not stored, since its risk gives it", async () => {
  const id = providerId()
  await ingest(db, [provider(id)])
  const [stored] = await db`select version, status, manifest -> 'id' as manifest_id from providers where id = ${id}`
  expect(stored).toEqual({ version: "2026-09-29", status: "active", manifest_id: id })
  expect(await rows(id)).toEqual([
    { identity: `${id}/tickets.close`, version: "2026-09-29", kind: "mutate", risk: "high", title: null, required: ["id"] },
    { identity: `${id}/tickets.search`, version: "2026-09-29", kind: "read", risk: null, title: "Search tickets", required: ["query"] },
  ])
  const columns = await db`select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'capabilities' order by ordinal_position`
  expect(columns.map((row: { column_name: string }) => row.column_name)).toEqual(["provider_id", "identity", "version", "kind", "risk", "title", "description", "input", "output", "search", "status"])
})

test("ingesting again changes nothing, and a new title or description updates in place", async () => {
  const id = providerId()
  await ingest(db, [provider(id)])
  const [first] = await db`select registered_at from providers where id = ${id}`
  await ingest(db, [provider(id)])
  expect<unknown>(await db`select registered_at from providers where id = ${id}`).toEqual([first])
  await ingest(db, [provider(id, { title: "Find tickets" })])
  expect((await rows(id)).map((row: { title: string | null }) => row.title)).toEqual([null, "Find tickets"])
})

test("a changed contract under the same version refuses the boot, naming the capability and what changed; a new version stands beside the old", async () => {
  const id = providerId()
  await ingest(db, [provider(id)])
  await expect(ingest(db, [provider(id, { limit: 50 })])).rejects.toThrow(
    `Capability ${id}/tickets.search version 2026-09-29 changed its input without a new version; give the tool a new version (YYYY-MM-DD) in its definition or its provider`,
  )
  expect((await rows(id)).map((row: { version: string }) => row.version)).toEqual(["2026-09-29", "2026-09-29"])
  await ingest(db, [provider(id, { limit: 50, version: "2026-10-01" })])
  expect((await rows(id)).map((row: { identity: string; version: string }) => `${row.identity}@${row.version}`)).toEqual([
    `${id}/tickets.close@2026-09-29`, `${id}/tickets.close@2026-10-01`, `${id}/tickets.search@2026-09-29`, `${id}/tickets.search@2026-10-01`,
  ])
  expect<unknown>(await db`select version from providers where id = ${id}`).toEqual([{ version: "2026-10-01" }])
})

test("the search vector covers the identity, title, description and argument names", async () => {
  const id = providerId()
  await ingest(db, [provider(id)])
  const find = async (words: string) => (await db`select identity from capabilities where provider_id = ${id} and search @@ plainto_tsquery('simple', ${words}) order by identity`)
    .map((row: { identity: string }) => row.identity)
  expect(await find("tickets")).toEqual([`${id}/tickets.close`, `${id}/tickets.search`])
  expect(await find("query")).toEqual([`${id}/tickets.search`])
  expect(await find("close")).toEqual([`${id}/tickets.close`])
})

test("an organisation's catalogue is read by provider, with default overrides, and rewritten in place", async () => {
  const id = providerId()
  await ingest(db, [provider(id)])
  const organisation = crypto.randomUUID()
  expect(await readCatalogue(db, organisation)).toEqual(new Map())
  await writeCatalogue(db, organisation, id, { enabled: true })
  expect(await readCatalogue(db, organisation)).toEqual(new Map([[id, { enabled: true, overrides: { disabled: [], policy_class: {} } }]]))
  const overrides = { disabled: [`${id}/tickets.search`], policy_class: { [`${id}/tickets.close`]: "controlled" as const } }
  await writeCatalogue(db, organisation, id, { enabled: false, overrides })
  expect(await readCatalogue(db, organisation)).toEqual(new Map([[id, { enabled: false, overrides }]]))
  await expect(writeCatalogue(db, organisation, id, { enabled: true, overrides: { disabled: [], policy_class: { x: "nobody" as "human" } } })).rejects.toThrow()
  await expect(writeCatalogue(db, organisation, providerId(), { enabled: true })).rejects.toThrow()
})
