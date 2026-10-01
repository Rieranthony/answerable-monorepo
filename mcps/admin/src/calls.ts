import { found, IdError, type IdAdmin } from "@answerable/id-admin"
import { ToolError, type ToolContext } from "@answerable/mcp"

const query = (params: Record<string, unknown>) => new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])))
const join = (path: string, params: Record<string, unknown>) => `${path}${path.includes("?") ? "&" : "?"}${query(params)}`

// ID's failure as the error a model acts on: no answer or a 5xx is UPSTREAM_UNAVAILABLE; any other refusal is UPSTREAM_REJECTED with ID's status and code.
function upstream(error: unknown): never {
  if (!(error instanceof IdError)) throw error
  console.error("[admin] Answerable ID failed", error)
  if (error.status === 0 || error.status >= 500) throw new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID did not answer; try again shortly")
  throw new ToolError("UPSTREAM_REJECTED", error.message, { details: { upstream: { status: error.status, code: error.code ?? null } } })
}

/** What a write to ID sends besides its path: the body, a precondition and the idempotency key the intent's plan carries. */
export type Write = { body?: unknown; ifMatch?: string; ifNoneMatch?: "*"; key: string }

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
   * A write with the plan's idempotency key and the call's execution id. When ID does not answer, it is sent once more with the same key, which
   * ID replays if the first one was applied. ID refusing a stale `If-Match` answers `INTENT_STALE`. Returns the `Operation-Id` ID sends with
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
      if (error instanceof IdError && (error.status === 0 || error.status >= 500)) {
        console.error("[admin] Answerable ID failed", error)
        throw new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID failed the write twice, or did not answer it; it may or may not have applied it. Read it back before preparing again")
      }
      return upstream(error)
    }
  }
  return { read, need, list, all, version, versioned, write }
}
/** ID's admin API as the tools call it. */
export type Calls = ReturnType<typeof createCalls>
