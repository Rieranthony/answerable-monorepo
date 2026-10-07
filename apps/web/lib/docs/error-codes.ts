// The meaning of every standard error code of @answerable/mcp. The codes and their retry policies come from the SDK's
// `errorCodes`; this record is typed by the SDK's own `ErrorCode`, so a code added to the SDK fails the web typecheck
// until it is described here. Inline Markdown only: code spans and links to docs pages.
import { errorCodes, type ErrorCode } from "../../../../packages/mcp/src/errors"

type Meaning = { meaning: string; action: string }

const errorMeanings: Record<ErrorCode, Meaning> = {
  INVALID_INPUT: {
    meaning: "The input failed the schema or a business rule",
    action: "Fix the fields in `details.field_violations`",
  },
  NOT_FOUND: {
    meaning:
      "A named resource does not exist for this caller; another organisation's resource is not found either. The Toolbox's meta tools answer it for a capability you may not use, as for one that does not exist",
    action:
      "Check the identifier, for example with a list tool or `toolbox_search`",
  },
  PERMISSION_DENIED: {
    meaning:
      "The caller may not perform the operation; a commit answers it too when the caller can no longer use the mutation (its token lacks the scopes, or a hub's grants no longer cover it)",
    action: "Ask for access, then prepare again",
  },
  PRECONDITION_FAILED: {
    meaning:
      "The current state does not allow the operation; `details.preconditions` says what",
    action: "Change that state first",
  },
  RESULT_TOO_LARGE: {
    meaning:
      "A read's result exceeded 100 KiB of JSON; `details.bytes` is its size and `details.limit` the limit, 102,400 bytes",
    action: "Narrow the request with `limit`, `cursor` or filters",
  },
  INTENT_STALE: {
    meaning:
      "A target's version moved, or a target disappeared or appeared, since prepare; `details.targets` says which",
    action: "Prepare again and show the new preview",
  },
  INTENT_EXPIRED: {
    meaning: "The intent passed `expires_at` before it was committed",
    action: "Prepare again",
  },
  INTENT_NOT_FOUND: {
    meaning:
      "No intent has that id, or it is for a capability version this server does not serve",
    action: "Prepare again",
  },
  INTENT_CANCELLED: {
    meaning: "The intent was cancelled",
    action: "Not yet: intents cannot be cancelled",
  },
  INTENT_CONSUMED: {
    meaning: "The intent was committed once and that commit failed",
    action: "Prepare again",
  },
  COMMIT_TOKEN_INVALID: {
    meaning: "The commit token does not match the intent",
    action: "Pass the `commit_token` the prepare tool returned for this intent",
  },
  PRINCIPAL_MISMATCH: {
    meaning: "Another person, membership or client prepared the intent",
    action: "Prepare your own intent",
  },
  APPROVAL_REQUIRED: {
    meaning:
      "The intent's class needs the other commit tool, the person's confirmed summary, or a human approval",
    action: "See [approval](/docs/mcp/errors#approval)",
  },
  APPROVAL_DENIED: {
    meaning: "A person refused the approval",
    action: "Not yet: approvals do not exist",
  },
  COMMIT_IN_PROGRESS: {
    meaning: "Another commit of this intent is running",
    action: "Call again; a finished commit answers with its receipt",
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    meaning: "The same idempotency key came with different input",
    action: "Not yet: prepare takes no idempotency key",
  },
  RATE_LIMITED: {
    meaning: "A rate limit refused the call",
    action:
      "Wait `after_ms`. Not yet: the SDK enforces no limits; a handler may throw it",
  },
  BUDGET_EXHAUSTED: {
    meaning: "A budget refused the call",
    action:
      "Wait `after_ms`. Not yet: the SDK enforces no budgets; a handler may throw it",
  },
  UPSTREAM_REJECTED: {
    meaning: "The source refused; `details.upstream` carries its code",
    action:
      "Read `details.upstream`. A handler that calls a source throws it; no Answerable provider does yet",
  },
  UPSTREAM_UNAVAILABLE: {
    meaning: "The source did not answer",
    action:
      "Call again later. The Toolbox answers it when Answerable ID does not say what you may use; a handler that calls a source throws it",
  },
  TIMEOUT: {
    meaning: "The tool ran past its `timeoutMs`",
    action:
      "Call again; a commit may still finish, so call the commit tool again for its receipt",
  },
  OPERATION_NOT_FOUND: {
    meaning: "The operation handle is unknown",
    action: "Not yet: operations do not exist",
  },
  OPERATION_EXPIRED: {
    meaning: "The operation handle is gone",
    action: "Not yet: operations do not exist",
  },
  INTERNAL: {
    meaning:
      "An unexpected failure, or a handler that threw a [custom code](/docs/mcp/errors#custom-codes) its definition does not declare",
    action:
      "Call again once; if it persists, the operator reads the server log for the `request_id`, which names an undeclared code",
  },
}

/** Every standard code in the SDK's order, with its default retry policy and its meaning. */
export const errorRows = (Object.keys(errorCodes) as ErrorCode[]).map(
  (code) => ({ code, retry: errorCodes[code], ...errorMeanings[code] }),
)
