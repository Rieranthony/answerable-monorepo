import { expect, test } from "bun:test"
import type { UserPrincipal } from "@answerable/auth"
import { ToolError } from "@answerable/mcp-base"
import { createRecordStore } from "./records"

function principal(): UserPrincipal {
  return { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(), clientId: "test", scopes: [], expiresAt: 1 }
}
test("records stay within the caller's organisation", () => {
  const records = createRecordStore()
  const alice = principal()
  const bob = principal()
  const created = records.create(alice, "First")
  expect(created).toMatchObject({ organizationId: alice.organizationId, creatorId: alice.userId, title: "First" })
  expect(records.list(alice)).toEqual([created])
  expect(records.list(bob)).toEqual([])
  expect(() => records.remove(bob, created.id)).toThrow(new ToolError("record_not_found", "No accessible record exists"))
  expect(records.list(alice)).toEqual([created])
  expect(records.remove(alice, created.id)).toEqual({ deleted: true, id: created.id })
  expect(records.list(alice)).toEqual([])
  expect(() => records.remove(alice, created.id)).toThrow("No accessible record exists")
  expect(() => records.remove(alice, crypto.randomUUID())).toThrow("No accessible record exists")
})
test("lists at most 100 records, oldest first", () => {
  const records = createRecordStore()
  const user = principal()
  const created = Array.from({ length: 105 }, (_, index) => records.create(user, `Record ${index}`))
  expect(records.list(user)).toEqual(created.slice(0, 100))
  records.remove(user, created[0]!.id)
  expect(records.list(user)).toEqual(created.slice(1, 101))
})
