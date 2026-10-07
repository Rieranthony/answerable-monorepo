import { found, IdError, type IdAdmin } from "@answerable/id-admin"
import { ToolError, type ToolContext } from "@answerable/mcp"

const query = (params: Record<string, unknown>) => new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])))
const join = (path: string, params: Record<string, unknown>) => `${path}${path.includes("?") ? "&" : "?"}${query(params)}`

// ID asking to be asked again later: no answer, a 5xx such as 503 database_busy, or 409 operation_in_progress, a write with the same key still running.
const later = ({ status, code }: IdError) => status === 0 || status >= 500 || code === "operation_in_progress"
// After ID's Retry-After when it sends one, else the SDK's default delay.
const delay = (error: IdError) => ({ retry: { policy: "after_delay" as const, after_ms: error.retryAfterMs } })

// ID's failure as the error a model acts on: asked to come back later, UPSTREAM_UNAVAILABLE; any other refusal is UPSTREAM_REJECTED with ID's status and code.
function upstream(error: unknown): never {
  if (!(error instanceof IdError)) throw error
  console.error("[admin] Answerable ID failed", error)
  if (later(error)) throw new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID did not answer; try again shortly", delay(error))
  throw new ToolError("UPSTREAM_REJECTED", error.message, { details: { upstream: { status: error.status, code: error.code ?? null } } })
}

/** What a write to ID sends besides its path: the body, a precondition and the idempotency key, the intent's id (`<intent id>.<step>` for one of several writes). */
type Write = { body?: unknown; ifMatch?: string; ifNoneMatch?: "*"; key: string }

/**
 * ID's admin API as the tools call it: every call carries the call's execution id as `x-request-id`, and every failure answers the error a model
 * acts on. Reads answer ID's 404 as undefined, or with `NOT_FOUND` saying what is missing.
 */
export function createCalls(id: IdAdmin) {
  async function read<T>(path: string, { executionId }: ToolContext): Promise<T | undefined> {
    return await found(id.get(path, { requestId: executionId })).catch(upstream) as T | undefined
  }
  async function need<T>(path: string, context: ToolContext, missing = `Answerable ID answered 404 for ${path}`) {
    const answer = await read<T>(path, context)
    if (answer === undefined) throw new ToolError("NOT_FOUND", missing)
    return answer
  }
  // One page of an ID list, in the pagination every list answers.
  async function list<Item>(path: string, params: Record<string, unknown>, context: ToolContext, missing?: string) {
    const { items, nextCursor } = await need<{ items: Item[]; nextCursor: string | null }>(join(path, params), context, missing)
    return { items, next_cursor: nextCursor, has_more: nextCursor !== null }
  }
  // Every item of an ID list, page by page.
  async function all<Item>(path: string, context: ToolContext, missing?: string) {
    const items: Item[] = []
    let cursor: string | undefined
    do {
      const page = await list<Item>(path, { limit: 200, cursor }, context, missing)
      items.push(...page.items)
      cursor = page.next_cursor ?? undefined
    } while (cursor)
    return items
  }
  // A read with ID's ETag, the version a target binds; ID's 404 is undefined.
  async function version<T>(path: string, { executionId }: ToolContext) {
    return await found(id.read(path, { requestId: executionId })).catch(upstream) as { body: T; etag: string } | undefined
  }
  async function versioned<T>(path: string, context: ToolContext, missing: string) {
    const answer = await version<T>(path, context)
    if (!answer) throw new ToolError("NOT_FOUND", missing)
    return answer
  }
  /**
   * A write with the intent's idempotency key and the call's execution id. When ID does not answer, or answers with a 5xx, it is sent once more with
   * the same key, which ID replays if the first one was applied; when it still fails, or ID answers that a write with the key is still running,
   * `UPSTREAM_UNAVAILABLE` says the outcome is unknown. ID refusing a stale `If-Match` answers `INTENT_STALE`. Returns the `Operation-Id` ID sends with
   * every command (`apps/id/src/http/admin/command.ts`) and the id of the row it made or changed, which a replayed answer carries in its
   * receipt; a `204` has none.
   */
  async function write(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, { body, ifMatch, ifNoneMatch, key }: Write, { executionId }: ToolContext) {
    const send = () => id.manage(method, path, { body, ifMatch, ifNoneMatch, idempotencyKey: key, requestId: executionId })
    try {
      const answer = await send().catch(error => {
        if (error instanceof IdError && (error.status === 0 || error.status >= 500)) return send()
        throw error
      })
      const row = answer.body as { id?: string; resultReference?: { id: string } } | null
      return { operationId: answer.operationId as string, id: (answer.replayed ? row?.resultReference?.id : row?.id) as string }
    } catch (error) {
      if (error instanceof IdError && error.status === 412) {
        throw new ToolError("INTENT_STALE", `Answerable ID refused the write because ${path} changed after the commit checked it; prepare it again`, {
          details: { upstream: { status: 412, code: error.code ?? null } },
        })
      }
      if (error instanceof IdError && later(error)) {
        console.error("[admin] Answerable ID failed", error)
        throw new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID failed the write twice, did not answer it, or is still applying it; it may or may not have applied it. Read it back before preparing again", delay(error))
      }
      return upstream(error)
    }
  }
  return { read, need, list, all, version, versioned, write }
}
/** ID's admin API as the tools call it. */
export type Calls = ReturnType<typeof createCalls>
