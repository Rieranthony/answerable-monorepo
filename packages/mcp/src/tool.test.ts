import { expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, defineView } from "./index"
import { wireDescription, wireName } from "./tool"

const description = "List the records of your organisation, oldest first, twenty per page."
const fields = {
  name: "records.list",
  description,
  input: z.object({ limit: z.number().int().max(100).default(20), cursor: z.string().optional() }),
  output: z.object({ items: z.array(z.string()), next_cursor: z.string().nullable(), has_more: z.boolean() }),
  async execute() { return { items: [], next_cursor: null, has_more: false } },
}

test("five fields make a frozen read tool with a closed input and the default timeout", () => {
  const tool = defineTool(fields)
  expect(Object.isFrozen(tool)).toBe(true)
  expect(tool).toMatchObject({ name: "records.list", description, timeoutMs: 25_000 })
  expect(tool.output).toBe(fields.output)
  expect(tool.input.safeParse({ extra: true }).success).toBe(false)
  expect(tool.input.parse({})).toEqual({ limit: 20 })
  expect(fields.input.safeParse({ extra: true }).success).toBe(true)
})

test("optional fields are kept and frozen", () => {
  const view = defineView({ name: "records", html: "<title>Records</title>" })
  const tool = defineTool({
    ...fields, title: "Records", version: "2026-09-29", scopes: ["e2e:identity"], view, timeoutMs: 55_000,
    deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "records.search" },
  })
  expect(tool).toMatchObject({ title: "Records", version: "2026-09-29", scopes: ["e2e:identity"], view, timeoutMs: 55_000 })
  expect(Object.isFrozen(tool.scopes)).toBe(true)
  expect(Object.isFrozen(tool.deprecated)).toBe(true)
})

test("names are <domain>.<operation>, each part a lowercase letter then up to 15 letters or digits", () => {
  const rule = "must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list"
  for (const name of ["Records.list", "records.li-st", "records_list", "recordslist", "a.b.c", "1records.list", "records.", ".list", "abcdefghijklmnopq.list", "records.abcdefghijklmnopq"]) {
    expect(() => defineTool({ ...fields, name })).toThrow(`Tool name "${name}" ${rule}`)
  }
  for (const name of ["a.b", "abcdefghijklmnop.abcdefghijklmnop", "e2e.v2"]) expect(defineTool({ ...fields, name }).name).toBe(name)
})

test("descriptions are 40 to 1,000 characters", () => {
  for (const length of [39, 1001]) {
    expect(() => defineTool({ ...fields, description: "x".repeat(length) })).toThrow(`Tool records.list: the description is ${length} characters; write 40 to 1,000 saying what it does, when to use it and its limits`)
  }
  for (const length of [40, 1000]) expect(defineTool({ ...fields, description: "x".repeat(length) }).description).toHaveLength(length)
})

test("timeouts are whole milliseconds up to 55,000", () => {
  for (const timeoutMs of [55_001, 0, -1, 1.5]) {
    expect(() => defineTool({ ...fields, timeoutMs })).toThrow(`Tool records.list: timeoutMs ${timeoutMs} must be a whole number of milliseconds from 1 to 55,000`)
  }
  expect(defineTool({ ...fields, timeoutMs: 1 }).timeoutMs).toBe(1)
})

test("versions and deprecation dates are YYYY-MM-DD dates", () => {
  expect(() => defineTool({ ...fields, version: "2026-9-29" })).toThrow('Tool records.list: version "2026-9-29" must be a date, YYYY-MM-DD')
  for (const deprecated of [{ since: "2026-02-30", sunset: "2027-09-29" }, { since: "2026-09-29", sunset: "next year" }]) {
    expect(() => defineTool({ ...fields, deprecated })).toThrow("Tool records.list: deprecated.since and deprecated.sunset must be dates, YYYY-MM-DD")
  }
})

test("scopes, when given, are non-empty tokens", () => {
  for (const scopes of [[], [""], ["has space"]]) {
    expect(() => defineTool({ ...fields, scopes })).toThrow("Tool records.list: scopes must be non-empty and contain no spaces; omit them for the default <provider>:read")
  }
})

test("the wire name swaps the dot, and a deprecated description ends with the deprecation sentence", () => {
  expect(wireName("records.list")).toBe("records_list")
  expect(wireDescription(defineTool(fields))).toBe(description)
  expect(wireDescription(defineTool({ ...fields, deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "records.search" } })))
    .toBe(`${description} Deprecated since 2026-09-29; removed on 2027-09-29; use records.search instead.`)
  expect(wireDescription(defineTool({ ...fields, deprecated: { since: "2026-09-29", sunset: "2027-09-29" } })))
    .toBe(`${description} Deprecated since 2026-09-29; removed on 2027-09-29.`)
})
