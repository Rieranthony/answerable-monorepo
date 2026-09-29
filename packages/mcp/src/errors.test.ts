import { expect, test } from "bun:test"
import { errorCodes, ToolError, type ErrorCode } from "./index"

const defaults: Record<ErrorCode, string> = {
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
}

test("every code in the standard's table gets its default retry policy", () => {
  expect(errorCodes as Record<string, string>).toEqual(defaults)
  expect(Object.isFrozen(errorCodes)).toBe(true)
  for (const [code, policy] of Object.entries(defaults)) {
    const error = new ToolError(code, "Message")
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: "ToolError", code, message: "Message", retry: { policy } })
    expect(error.details).toBeUndefined()
  }
})

test("after_delay fills after_ms, and an explicit retry or details are kept", () => {
  expect(new ToolError("RATE_LIMITED", "Slow down").retry).toEqual({ policy: "after_delay", after_ms: 1000 })
  expect(new ToolError("RATE_LIMITED", "Slow down", { retry: { policy: "after_delay", after_ms: 30_000 } }).retry).toEqual({ policy: "after_delay", after_ms: 30_000 })
  expect(new ToolError("NOT_FOUND", "Gone", { retry: { policy: "after_state_change" } }).retry).toEqual({ policy: "after_state_change" })
  expect(new ToolError("NOT_FOUND", "Gone").retry).toEqual({ policy: "never" })
  expect(new ToolError("PRECONDITION_FAILED", "Locked", { details: { preconditions: ["unlocked"] } }).details).toEqual({ preconditions: ["unlocked"] })
})

test("a custom <PROVIDER>_<CODE> needs an explicit retry and a capitalised shape", () => {
  expect(new ToolError("ACME_QUOTA_EXCEEDED", "Quota", { retry: { policy: "after_delay" } })).toMatchObject({ code: "ACME_QUOTA_EXCEEDED", retry: { policy: "after_delay", after_ms: 1000 } })
  expect(new ToolError("E2E_LOCKED2", "Locked", { retry: { policy: "never" } }).retry).toEqual({ policy: "never" })
  expect(() => new ToolError("ACME_QUOTA_EXCEEDED", "Quota")).toThrow('ToolError code "ACME_QUOTA_EXCEEDED" is not in the standard table; pass { retry } for a custom code')
  for (const code of ["record_not_found", "NOTFOUND", "Acme_QUOTA", "_ACME", "ACME_", "2ACME_X", "ACME-QUOTA", "toString"]) {
    expect(() => new ToolError(code, "Bad", { retry: { policy: "never" } })).toThrow(`ToolError code "${code}" must be a standard code or <PROVIDER>_<CODE> in capitals, for example ACME_QUOTA_EXCEEDED`)
  }
})
