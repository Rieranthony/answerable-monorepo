import { expect, spyOn, test } from "bun:test"
import { IdError, type IdAdmin } from "@answerable/id-admin"
import { ToolError } from "@answerable/mcp"
import { testPrincipal } from "@answerable/mcp/testing"
import { createCalls } from "./calls"

const context = Object.freeze({ principal: testPrincipal(), executionId: "exec-1", signal: new AbortController().signal })
// ID's admin API answering each write with the next of `answers`: an answer, or an error to throw.
function writing(answers: (Awaited<ReturnType<IdAdmin["manage"]>> | Error)[]) {
  const sent: unknown[] = []
  const id = {
    async manage(...call: unknown[]) {
      sent.push(call)
      const next = answers.shift()!
      if (next instanceof Error) throw next
      return next
    },
  } as unknown as IdAdmin
  return { calls: createCalls(id), sent }
}
const write = (calls: ReturnType<typeof createCalls>) => calls.write("POST", "/organizations", { body: { slug: "acme" }, key: "intent-key" }, context).catch((error: unknown) => error)

test("a write ID does not answer is sent once more with the same key and execution id; a replayed answer names the row from ID's receipt", async () => {
  const replayed = { body: { operationId: "op-1", outcome: "applied", statusCode: 201, resultReference: { type: "organization", id: "org-1" } }, etag: null, operationId: "op-1", replayed: true }
  const { calls, sent } = writing([new IdError(0, undefined, "Answerable ID did not answer POST"), replayed])
  expect(await write(calls)).toEqual({ operationId: "op-1", id: "org-1" })
  expect(sent).toEqual([
    ["POST", "/organizations", { body: { slug: "acme" }, idempotencyKey: "intent-key", requestId: "exec-1", ifMatch: undefined, ifNoneMatch: undefined }],
    ["POST", "/organizations", { body: { slug: "acme" }, idempotencyKey: "intent-key", requestId: "exec-1", ifMatch: undefined, ifNoneMatch: undefined }],
  ])
})

test("a write ID fails twice answers UPSTREAM_UNAVAILABLE saying the outcome is unknown; a stale If-Match INTENT_STALE; any other refusal UPSTREAM_REJECTED, never resent", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const twice = writing([new IdError(503, "database_busy", "busy"), new IdError(0, undefined, "no answer")])
    expect(await write(twice.calls)).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE", message: "Answerable ID failed the write twice, or did not answer it; it may or may not have applied it. Read it back before preparing again", retry: { policy: "after_delay" },
    })
    expect(twice.sent).toHaveLength(2)
    const stale = writing([new IdError(412, "revision_mismatch", "changed")])
    const answer = await write(stale.calls) as ToolError
    expect(answer).toMatchObject({ code: "INTENT_STALE", message: "Answerable ID refused the write because /organizations changed after the commit checked it; prepare it again", details: { upstream: { status: 412, code: "revision_mismatch" } } })
    const conflict = writing([new IdError(409, "conflict", "Answerable ID answered POST /api/admin/v1/organizations with 409 conflict: Conflict")])
    expect(await write(conflict.calls)).toMatchObject({ code: "UPSTREAM_REJECTED", message: "Answerable ID answered POST /api/admin/v1/organizations with 409 conflict: Conflict", details: { upstream: { status: 409, code: "conflict" } } })
    expect(conflict.sent).toHaveLength(1)
    const unexpected = writing([new Error("bug")])
    expect(await write(unexpected.calls)).toEqual(new Error("bug"))
  } finally { log.mockRestore() }
})
