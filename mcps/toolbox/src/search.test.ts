import { afterAll, beforeAll, expect, test } from "bun:test"
import { defineProvider, defineTool } from "@answerable/mcp"
import { z } from "zod"
import { ingest } from "./catalogue"
import { migrate } from "./db/migrate"
import { search } from "./search"
import { testDatabase } from "./test/database"

const db = testDatabase()
const id = `s${crypto.randomUUID().slice(0, 8)}`
const tool = (name: string, description: string, fields: { title?: string; input?: z.ZodObject } = {}) => defineTool({
  name, description, title: fields.title, input: fields.input ?? z.object({}), output: z.object({}), async execute() { return {} },
})
// Each word sits in one field: "invoices" in an identity and in another tool's description, "quarterly" in a title, "customer" in an argument name.
const provider = (version: string) => defineProvider({ id, version, tools: [
  tool("invoices.list", "List the organisation's bills, newest first, 20 per page."),
  tool("payments.list", "List the payments made against invoices, oldest first."),
  tool("reports.get", "Read one report by its id, with every figure it holds.", { title: "Quarterly summaries" }),
  tool("tickets.search", "Search support tickets by the words in their subject.", { input: z.object({ customer_ref: z.string() }) }),
] })
const served = provider("2026-09-29")
const everything = served.tools.map(({ identity, version }) => ({ identity, version }))
const find = (query: string, allowed = everything, page = { limit: 10, offset: 0 }) => search(db, query, allowed, page)
beforeAll(async () => {
  await migrate(db)
  await ingest(db, [provider("2026-09-01"), served])
})
afterAll(() => db.close())

test("a word in an identity ranks above the same word in a description", async () => {
  expect(await find("invoices")).toEqual([`${id}/invoices.list`, `${id}/payments.list`])
})

test("titles and descriptions match other forms of a word; argument names match; any word of the query matches", async () => {
  expect(await find("summary")).toEqual([`${id}/reports.get`])
  expect(await find("customer")).toEqual([`${id}/tickets.search`])
  expect(await find("Oldest!")).toEqual([`${id}/payments.list`])
  expect((await find("the quarterly tickets")).toSorted()).toEqual([`${id}/reports.get`, `${id}/tickets.search`])
})

test("only the capabilities allowed, at the version served, in pages of limit from offset", async () => {
  expect(await find("invoices", everything.slice(1))).toEqual([`${id}/payments.list`])
  expect(await find("list", everything, { limit: 1, offset: 0 })).toEqual([`${id}/invoices.list`])
  expect(await find("list", everything, { limit: 1, offset: 1 })).toEqual([`${id}/payments.list`])
  expect(await find("list", everything, { limit: 1, offset: 2 })).toEqual([])
  expect(await find("list", [])).toEqual([])
})

test("a query without a letter or a digit finds nothing", async () => {
  expect(await find("!? --")).toEqual([])
})
