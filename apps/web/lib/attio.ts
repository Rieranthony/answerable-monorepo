// Thin client for the Attio REST API (https://docs.attio.com/rest-api).
//
// Kept pure on purpose: no environment access, and both `fetch` and `sleep`
// are injectable, so it runs under `bun test` without touching the network.
// Deliberately no `import "server-only"`: Next resolves that import itself,
// but Bun cannot in tests. The only importer is lib/waitlist.ts, which is
// reached solely from the "use server" module app/actions.ts.

const BASE_URL = "https://api.attio.com/v2"
const DEFAULT_TIMEOUT_MS = 10_000
const RETRY_FALLBACK_MS = 500
const RETRY_CAP_MS = 2_000
const ERROR_MESSAGE_LIMIT = 500

export type AttioConfig = {
  apiKey: string
  /** List UUID or api_slug. When absent, people are upserted but not listed. */
  listId?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type AttioDeps = {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

export type AttioErrorKind =
  | "invalid_input" // 400/422: Attio rejected a value (e.g. an email domain)
  | "auth" // 401/403: bad key or missing scopes
  | "not_found" // 404: wrong list slug or UUID
  | "multiple_matches" // MULTIPLE_MATCH_RESULTS: duplicates already in Attio
  | "rate_limited" // 429 after the retry
  | "server" // 5xx after the retry
  | "timeout"
  | "network"
  | "unexpected"

export class AttioError extends Error {
  readonly kind: AttioErrorKind
  readonly status?: number
  readonly code?: string

  constructor(
    kind: AttioErrorKind,
    message: string,
    options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined)
    this.name = "AttioError"
    this.kind = kind
    this.status = options.status
    this.code = options.code
  }
}

/** Mirrors apps/id/src/env.ts's parseEnvironment(source) shape, without zod. */
export function parseAttioConfig(
  source: Record<string, string | undefined>,
): AttioConfig | undefined {
  const apiKey = source.ATTIO_API_KEY?.trim()
  if (!apiKey) return undefined
  const listId = source.ATTIO_WAITLIST_LIST?.trim()
  return listId ? { apiKey, listId } : { apiKey }
}

export type AddToWaitlistResult =
  | { recordId: string; listed: true }
  | { recordId: string; listed: false; listError?: AttioError }

type ResolvedDeps = Required<AttioDeps>

export function createAttioClient(config: AttioConfig, deps: AttioDeps = {}) {
  const resolved: ResolvedDeps = {
    fetch: deps.fetch ?? globalThis.fetch,
    sleep: deps.sleep ?? defaultSleep,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }

  /** Creates or updates the person matched by email; returns the record id. */
  async function upsertPerson(email: string): Promise<string> {
    const data = await request<{ id: { record_id: string } }>(
      config,
      resolved,
      "PUT",
      "/objects/people/records?matching_attribute=email_addresses",
      { data: { values: { email_addresses: [{ email_address: email }] } } },
    )
    return data.id.record_id
  }

  /** Adds the person to the list, or leaves the existing entry untouched. */
  async function upsertListEntry(
    listId: string,
    recordId: string,
  ): Promise<void> {
    await request(
      config,
      resolved,
      "PUT",
      `/lists/${encodeURIComponent(listId)}/entries`,
      {
        data: {
          parent_record_id: recordId,
          parent_object: "people",
          entry_values: {},
        },
      },
    )
  }

  // Throws only when the person upsert fails. A list failure is reported in
  // the result: the signup is already in Attio, so the caller should not make
  // the visitor retry (a retry would hit the same misconfiguration).
  async function addToWaitlist({
    email,
  }: {
    email: string
  }): Promise<AddToWaitlistResult> {
    const recordId = await upsertPerson(email)
    if (!config.listId) return { recordId, listed: false }
    try {
      await upsertListEntry(config.listId, recordId)
      return { recordId, listed: true }
    } catch (error) {
      if (error instanceof AttioError) {
        return { recordId, listed: false, listError: error }
      }
      throw error
    }
  }

  return { upsertPerson, upsertListEntry, addToWaitlist }
}

async function request<T>(
  config: AttioConfig,
  deps: ResolvedDeps,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<T> {
  let response: Response
  try {
    response = await deps.fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
  } catch (cause) {
    // The visitor has already waited the full timeout; don't double it.
    if (isTimeout(cause)) {
      throw new AttioError("timeout", "Attio request timed out", { cause })
    }
    if (attempt === 0) {
      await deps.sleep(RETRY_FALLBACK_MS)
      return request(config, deps, method, path, body, attempt + 1)
    }
    throw new AttioError("network", "Attio request failed", { cause })
  }

  if (response.ok) {
    const json = (await response.json().catch(() => undefined)) as
      { data?: T } | undefined
    if (!json || json.data === undefined) {
      throw new AttioError(
        "unexpected",
        `Attio returned ${response.status} without a data envelope`,
        { status: response.status },
      )
    }
    return json.data
  }

  // Both calls are upserts, so one retry on a transient failure is safe.
  const retryable = response.status === 429 || response.status >= 500
  if (retryable && attempt === 0) {
    await deps.sleep(retryDelay(response.headers.get("retry-after")))
    return request(config, deps, method, path, body, attempt + 1)
  }
  throw await toAttioError(response)
}

/** Attio sends Retry-After as seconds or as an HTTP date; cap either form. */
function retryDelay(retryAfter: string | null): number {
  if (!retryAfter) return RETRY_FALLBACK_MS
  const seconds = Number(retryAfter)
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(retryAfter) - Date.now()
  if (!Number.isFinite(ms)) return RETRY_FALLBACK_MS
  return Math.min(Math.max(ms, 0), RETRY_CAP_MS)
}

async function toAttioError(response: Response): Promise<AttioError> {
  const text = await response.text().catch(() => "")
  let parsed: { code?: unknown; message?: unknown } = {}
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object") parsed = value
  } catch {
    // Not JSON; the raw text becomes the message.
  }
  const status = response.status
  const code = typeof parsed.code === "string" ? parsed.code : undefined
  const detail = typeof parsed.message === "string" ? parsed.message : text
  const message =
    detail.slice(0, ERROR_MESSAGE_LIMIT) || `Attio responded ${status}`
  return new AttioError(classify(status, code), message, { status, code })
}

function classify(status: number, code?: string): AttioErrorKind {
  if (code === "MULTIPLE_MATCH_RESULTS") return "multiple_matches"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not_found"
  if (status === 400 || status === 422) return "invalid_input"
  if (status === 429) return "rate_limited"
  if (status >= 500) return "server"
  return "unexpected"
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === "TimeoutError" || name === "AbortError"
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
