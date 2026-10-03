import { expect, test } from "bun:test"
import { ToolError } from "@answerable/mcp"
import { testPrincipal as principal } from "@answerable/mcp/testing"
import { createRecordStore } from "./records"

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
