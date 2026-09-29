import { expect, test } from "bun:test"
import { z } from "zod"
import { defineMutation, defineTool } from "./index"

const description = "Delete one of your organisation's records. Prepare it, then commit the intent it returns."
const fields = {
  name: "records.delete",
  description,
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  async prepare({ id }: { id: string }) { return { targets: [], preview: { summary: `Delete ${id}` }, plan: { id } } },
  async commit() { return { results: { deleted: true }, applied_changes: [], effects_performed: [] } },
}

test("prepare and commit make a frozen mutation: kind mutate, normal risk, no effects, a closed input and the default timeout", () => {
  const mutation = defineMutation(fields)
  expect(Object.isFrozen(mutation)).toBe(true)
  expect(mutation).toMatchObject({ kind: "mutate", name: "records.delete", description, risk: "normal", effects: [], timeoutMs: 25_000 })
  expect(mutation.output).toBe(fields.output)
  expect(mutation.expiresInMs).toBeUndefined()
  expect(Object.isFrozen(mutation.effects)).toBe(true)
  expect(mutation.input.safeParse({ id: "r1", extra: true }).success).toBe(false)
  expect(fields.input.safeParse({ id: "r1", extra: true }).success).toBe(true)
  const read = defineTool({ ...fields, name: "records.list", async execute() { return { deleted: false } } })
  expect(read.kind).toBe("read")
  expect(defineMutation({ ...fields, kind: "read" } as never).kind).toBe("mutate")
})

test("optional fields are kept and frozen", () => {
  const mutation = defineMutation({
    ...fields, title: "Delete record", version: "2026-09-29", scopes: ["records:delete"], timeoutMs: 1000,
    risk: "high", effects: ["cascade_delete", "notification"], expiresInMs: 60_000,
    deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "records.remove" },
  })
  expect(mutation).toMatchObject({
    title: "Delete record", version: "2026-09-29", scopes: ["records:delete"], timeoutMs: 1000,
    risk: "high", effects: ["cascade_delete", "notification"], expiresInMs: 60_000,
  })
  for (const value of [mutation.scopes, mutation.effects, mutation.deprecated]) expect(Object.isFrozen(value)).toBe(true)
})

test("risk is low, normal or high", () => {
  for (const risk of ["low", "normal", "high"] as const) expect(defineMutation({ ...fields, risk }).risk).toBe(risk)
  for (const risk of ["medium", "", "HIGH"]) {
    expect(() => defineMutation({ ...fields, risk } as never)).toThrow(`Mutation records.delete: risk "${risk}" must be low, normal or high`)
  }
})

test("effects come from the vocabulary", () => {
  const vocabulary = ["notification", "external_call", "money_movement", "cascade_delete", "permission_change", "publication"] as const
  expect(defineMutation({ ...fields, effects: vocabulary }).effects).toEqual([...vocabulary])
  expect(() => defineMutation({ ...fields, effects: ["notification", "email"] } as never))
    .toThrow('Mutation records.delete: effect "email" is not in the vocabulary: notification, external_call, money_movement, cascade_delete, permission_change, publication')
})

test("expiresInMs may shorten the expiry its risk gives, never lengthen it", () => {
  const limits = { low: 600_000, normal: 1_800_000, high: 86_400_000 } as const
  for (const [risk, limit] of Object.entries(limits) as [keyof typeof limits, number][]) {
    expect(defineMutation({ ...fields, risk, expiresInMs: limit }).expiresInMs).toBe(limit)
    expect(defineMutation({ ...fields, risk, expiresInMs: 1 }).expiresInMs).toBe(1)
    for (const expiresInMs of [limit + 1, 0, -1, 1.5]) {
      expect(() => defineMutation({ ...fields, risk, expiresInMs }))
        .toThrow(`Mutation records.delete: expiresInMs ${expiresInMs} must be a whole number of milliseconds from 1 to ${limit.toLocaleString("en-GB")}, the expiry of ${risk} risk; a mutation may shorten its expiry, not lengthen it`)
    }
  }
})

test("the tool rules apply, naming the mutation", () => {
  expect(() => defineMutation({ ...fields, name: "records_delete" })).toThrow('Mutation name "records_delete" must be <domain>.<operation>')
  expect(() => defineMutation({ ...fields, description: "Too short" })).toThrow("Mutation records.delete: the description is 9 characters")
  expect(() => defineMutation({ ...fields, timeoutMs: 55_001 })).toThrow("Mutation records.delete: timeoutMs 55001 must be a whole number")
  expect(() => defineMutation({ ...fields, version: "2026-9-29" })).toThrow('Mutation records.delete: version "2026-9-29" must be a date, YYYY-MM-DD')
  expect(() => defineMutation({ ...fields, deprecated: { since: "soon", sunset: "2027-09-29" } })).toThrow("Mutation records.delete: deprecated.since and deprecated.sunset must be dates")
  expect(() => defineMutation({ ...fields, scopes: [] })).toThrow("Mutation records.delete: scopes must be non-empty and contain no spaces; omit them for the default <provider>:write")
})
