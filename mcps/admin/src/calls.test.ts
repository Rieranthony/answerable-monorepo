import { expect, spyOn, test } from "bun:test"
import { createIdAdmin, IdError, type IdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
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

test("a write ID fails twice answers UPSTREAM_UNAVAILABLE saying the outcome is unknown; a stale If-Match INTENT_STALE; any other refusal UPSTREAM_REJECTED, never resent", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const twice = writing([new IdError(503, "database_busy", "busy"), new IdError(0, undefined, "no answer")])
    expect(await write(twice.calls)).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE", message: "Answerable ID failed the write twice, did not answer it, or is still applying it; it may or may not have applied it. Read it back before preparing again", retry: { policy: "after_delay", after_ms: 1000 },
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

test("ID asking to be asked again answers UPSTREAM_UNAVAILABLE after its Retry-After: 503 database_busy, sent once more with the same key, and 409 operation_in_progress for a write whose key is still running", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  const create = (calls: ReturnType<typeof createCalls>) => calls.write("POST", "/organizations", { body: { slug: "acme", name: "Acme" }, key: "intent-key" }, context).catch((error: unknown) => error)
  try {
    // Every write answers 503 database_busy with Retry-After: 2.
    const busy = createFakeId({ clientId: "admin-mcp" })
    const answering = (input: string | URL | Request, init?: RequestInit) => {
      busy.failWrite(1)
      return busy.config.fetch(input, init).then(response => (response.headers.has("Retry-After") ? (response.headers.set("Retry-After", "2"), response) : response))
    }
    expect(await create(createCalls(createIdAdmin({ ...busy.config, fetch: answering })))).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retry: { policy: "after_delay", after_ms: 2000 } })
    expect(busy.received.filter(({ request }) => request === "POST /api/admin/v1/organizations").map(({ idempotencyKey }) => idempotencyKey)).toEqual(["intent-key", "intent-key"])
    // Two writes with one key at once: ID runs the first and answers the second 409 operation_in_progress, which carries no Retry-After.
    const running = createFakeId({ clientId: "admin-mcp", operationInProgress: true })
    running.slow(50)
    const calls = createCalls(createIdAdmin(running.config))
    const [first, second] = await Promise.all([create(calls), create(calls)])
    expect(first).toEqual({ operationId: expect.any(String), id: expect.any(String) })
    expect(second).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("or is still applying it"), retry: { policy: "after_delay", after_ms: 1000 } })
    expect(running.received.filter(({ request }) => request === "POST /api/admin/v1/organizations")).toHaveLength(2)
  } finally { log.mockRestore() }
})

test("a read without the ETag a target binds, or a write's answer without its Operation-Id, throws naming what is missing instead of passing on null", async () => {
  const applied = writing([{ body: { id: "row" }, etag: null, operationId: null, replayed: false }])
  expect(await write(applied.calls)).toEqual(new Error("Answerable ID applied POST /organizations but answered without an Operation-Id, which the receipt needs"))
  const reading = createCalls({ read: async () => ({ body: { id: "row" }, etag: null }) } as unknown as IdAdmin)
  expect(await reading.version("/organizations/org", context).catch((error: unknown) => error)).toEqual(new Error("Answerable ID answered GET /organizations/org without an ETag, which the target's version needs"))
})
