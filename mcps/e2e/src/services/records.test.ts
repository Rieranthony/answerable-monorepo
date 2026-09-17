import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRecordStore } from "./records"

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "answerable-mcp-records-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "records.sqlite")
  const store = createRecordStore(path)
  cleanups.push(() => store.close())
  const actor = { organizationId: crypto.randomUUID(), userId: crypto.randomUUID(), resourceInstanceId: crypto.randomUUID() }
  return { store, path, actor }
}

test("tenant-owned records cannot be read or deleted by another tenant", () => {
  const { store, actor } = fixture()
  const record = store.create(actor, { title: "Example", operationKey: crypto.randomUUID() })
  expect(store.list(actor)).toEqual([record])
  expect(store.get(actor, record.id)).toEqual(record)
  const outsider = { ...actor, organizationId: crypto.randomUUID() }
  expect(store.list(outsider)).toEqual([])
  expect(() => store.get(outsider, record.id)).toThrow("record_not_found")
  expect(() => store.remove(outsider, { recordId: record.id, operationKey: crypto.randomUUID() })).toThrow("record_not_found")
  expect(store.get(actor, record.id)).toEqual(record)
})

test("a lost create response can be replayed after reopening storage without another effect", () => {
  const { store, path, actor } = fixture()
  const input = { title: "Once", operationKey: crypto.randomUUID() }
  const first = store.create(actor, input)
  store.close()
  const reopened = createRecordStore(path)
  cleanups.push(() => reopened.close())
  expect(reopened.create(actor, input)).toEqual(first)
  expect(reopened.list(actor)).toHaveLength(1)
  expect(() => reopened.create(actor, { ...input, title: "Different" })).toThrow("operation_key_reused")
})

test("receipts are scoped to subject and resource, and delete can be replayed", () => {
  const { store, actor } = fixture()
  const input = { title: "Scoped", operationKey: crypto.randomUUID() }
  const a = store.create(actor, input)
  const b = store.create({ ...actor, userId: crypto.randomUUID() }, input)
  const c = store.create({ ...actor, resourceInstanceId: crypto.randomUUID() }, input)
  expect(new Set([a.id, b.id, c.id]).size).toBe(3)
  const deletion = { recordId: a.id, operationKey: crypto.randomUUID() }
  expect(store.remove(actor, deletion)).toEqual({ deleted: true, id: a.id })
  expect(store.remove(actor, deletion)).toEqual({ deleted: true, id: a.id })
  expect(() => store.get(actor, a.id)).toThrow("record_not_found")
})

test("invalid writes leave no records or receipts", () => {
  const { store, actor } = fixture()
  const key = crypto.randomUUID()
  expect(() => store.create(actor, { title: "", operationKey: key })).toThrow()
  expect(store.list(actor)).toEqual([])
  expect(store.create(actor, { title: "Valid", operationKey: key }).title).toBe("Valid")
})
