import { expect, test } from "bun:test"
import { testPrincipal } from "@answerable/mcp/testing"
import { perRequest } from "./per-request"

test("one read per principal: every decision of a request shares it, and the next request's principal reads again", async () => {
  const reads: string[] = []
  const role = perRequest(async principal => (reads.push(principal.userId), "admin"))
  const [first, next] = [testPrincipal(), testPrincipal()]
  expect(await Promise.all([role(first), role(first), role(first)])).toEqual(["admin", "admin", "admin"])
  expect(await role(next)).toBe("admin")
  expect(reads).toEqual([first.userId, next.userId])
})
