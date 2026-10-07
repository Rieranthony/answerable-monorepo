/** What a caller should do after a failure. */
export type Retry = {
  policy: "never" | "after_delay" | "after_fix_input" | "after_state_change" | "after_reprepare" | "after_approval"
  /** Milliseconds to wait before retrying; `after_delay` defaults to 1000. */
  after_ms?: number
}

/** Every standard error code, with its default retry policy. */
export const errorCodes = Object.freeze({
  INVALID_INPUT: "after_fix_input",
  NOT_FOUND: "never",
  PERMISSION_DENIED: "never",
  PRECONDITION_FAILED: "after_state_change",
  RESULT_TOO_LARGE: "after_fix_input",
  INTENT_STALE: "after_reprepare",
  INTENT_EXPIRED: "after_reprepare",
  INTENT_NOT_FOUND: "after_reprepare",
  INTENT_CANCELLED: "after_reprepare",
  INTENT_CONSUMED: "after_reprepare",
  COMMIT_TOKEN_INVALID: "never",
  PRINCIPAL_MISMATCH: "never",
  APPROVAL_REQUIRED: "after_approval",
  APPROVAL_DENIED: "never",
  COMMIT_IN_PROGRESS: "after_delay",
  IDEMPOTENCY_KEY_MISMATCH: "never",
  RATE_LIMITED: "after_delay",
  BUDGET_EXHAUSTED: "after_delay",
  UPSTREAM_REJECTED: "never",
  UPSTREAM_UNAVAILABLE: "after_delay",
  TIMEOUT: "after_delay",
  OPERATION_NOT_FOUND: "never",
  OPERATION_EXPIRED: "never",
  INTERNAL: "after_delay",
} as const satisfies Record<string, Retry["policy"]>)

/** A standard error code. Providers may add `<PROVIDER>_<CODE>` codes with an explicit retry policy. */
export type ErrorCode = keyof typeof errorCodes

export const customCode = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/

/**
 * Throw from a handler for an expected failure; the caller receives its code, message, retry policy and details in the error envelope.
 * A custom `<PROVIDER>_<CODE>` code needs an explicit `retry` and must be listed in the definition's `errors`.
 */
export class ToolError extends Error {
  readonly code: string
  readonly retry: Retry
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode | (string & {}), message: string, options: { retry?: Retry; details?: Record<string, unknown> } = {}) {
    super(message)
    this.name = "ToolError"
    const policy = Object.hasOwn(errorCodes, code) ? errorCodes[code as ErrorCode] : undefined
    if (!policy && !customCode.test(code)) {
      throw new Error(`ToolError code "${code}" must be a standard code or <PROVIDER>_<CODE> in capitals, for example ACME_QUOTA_EXCEEDED`)
    }
    const retry = options.retry ?? (policy ? { policy } : undefined)
    if (!retry) throw new Error(`ToolError code "${code}" is not in the standard table; pass { retry } for a custom code`)
    this.code = code
    this.retry = retry.policy === "after_delay" ? { ...retry, after_ms: retry.after_ms ?? 1000 } : retry
    if (options.details) this.details = options.details
  }
}

/** The code a failure answers with: a `ToolError`'s own, anything else `INTERNAL`. For a server's `wrapCall`, to record or trace what a call answered. */
export const errorCodeOf = (failure: unknown): string => failure instanceof ToolError ? failure.code : "INTERNAL"
