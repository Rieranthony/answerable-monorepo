import { expect, test } from "bun:test"
import { ToolError, type UserPrincipal } from "@answerable/mcp"
import { createRecordStore } from "./records"

function principal(): UserPrincipal {
  return { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(), clientId: "test", scopes: [], expiresAt: 1, organizationAuthorizationVersion: 1 }
}
const firstPage = { limit: 20 }

test("records stay within the caller's organisation", () => {
  const records = createRecordStore()
  const alice = principal()
  const bob = principal()
  const created = records.create(alice, "First")
  expect(created).toMatchObject({ organizationId: alice.organizationId, creatorId: alice.userId, title: "First", version: 1 })
  expect(records.list(alice, firstPage)).toEqual({ items: [created], next_cursor: null, has_more: false })
  expect(records.list(bob, firstPage)).toEqual({ items: [], next_cursor: null, has_more: false })
  expect(() => records.remove(bob, created.id)).toThrow(new ToolError("NOT_FOUND", "No accessible record exists"))
  expect(records.list(alice, firstPage).items).toEqual([created])
  expect(records.remove(alice, created.id)).toEqual({ deleted: true, id: created.id })
  expect(records.list(alice, firstPage).items).toEqual([])
  expect(() => records.remove(alice, created.id)).toThrow("No accessible record exists")
})

test("pages run oldest first and follow next_cursor to the end", () => {
  const records = createRecordStore()
  const user = principal()
  const created = Array.from({ length: 25 }, (_, index) => records.create(user, `Record ${index}`))
  const first = records.list(user, firstPage)
  expect(first).toEqual({ items: created.slice(0, 20), next_cursor: expect.any(String), has_more: true })
  expect(records.list(user, { limit: 20, cursor: first.next_cursor! })).toEqual({ items: created.slice(20), next_cursor: null, has_more: false })
  expect(records.list(user, { limit: 25 })).toEqual({ items: created, next_cursor: null, has_more: false })
  const byTens = records.list(user, { limit: 10 })
  expect(records.list(user, { limit: 10, cursor: byTens.next_cursor! })).toMatchObject({ items: created.slice(10, 20), has_more: true })
})

test("a cursor this organisation's list did not issue answers INVALID_INPUT", () => {
  const records = createRecordStore()
  const alice = principal()
  const bob = principal()
  for (const title of ["One", "Two"]) records.create(alice, title)
  const cursor = records.list(alice, { limit: 1 }).next_cursor!
  for (const [caller, value] of [[alice, "unknown"], [bob, cursor]] as const) {
    let failure: unknown
    try { records.list(caller, { limit: 20, cursor: value }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ToolError)
    expect(failure).toMatchObject({
      code: "INVALID_INPUT", message: "cursor: Unknown cursor; list again without one",
      retry: { policy: "after_fix_input" }, details: { field_violations: [{ field: "cursor", message: "Unknown cursor; list again without one" }] },
    })
  }
})

test("get reads one record, touch moves its version, and both stay within the organisation", () => {
  const records = createRecordStore()
  const alice = principal()
  const created = records.create(alice, "First")
  expect(records.get(alice, created.id)).toEqual(created)
  expect(records.touch(alice, created.id)).toEqual({ ...created, version: 2 })
  expect(records.get(alice, created.id)).toEqual({ ...created, version: 2 })
  expect(records.list(alice, firstPage).items).toEqual([{ ...created, version: 2 }])
  expect(created.version).toBe(1)
  for (const call of [() => records.get(principal(), created.id), () => records.touch(principal(), created.id), () => records.get(alice, crypto.randomUUID())]) {
    expect(call).toThrow(new ToolError("NOT_FOUND", "No accessible record exists"))
  }
})
