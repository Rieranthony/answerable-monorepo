import type { Change, PolicyClass, Preview, Target } from "./mutation"

/** Where an intent is: `prepared` or `awaiting_approval` until a commit claims it (`committing`), then `committed`, `failed` or `stale`; `expired` once `expires_at` passes unclaimed. */
export type IntentStatus = "prepared" | "awaiting_approval" | "committing" | "committed" | "failed" | "expired" | "stale"
type Principal = { user_id: string; membership_id: string; client_id: string }

/** The immutable record of a committed intent. A repeat of the commit returns it with `idempotent_replay: true`. */
export type Receipt = {
  receipt_id: string
  intent_id: string
  status: "committed"
  /** Checked against the mutation's `output`. */
  results: Record<string, unknown>
  applied_changes: Change[]
  effects_performed: string[]
  committed_at: string
  committed_by: Principal
  idempotent_replay: boolean
}

/** A prepared mutation as a store keeps it: bound to one principal, one capability version and the target versions `prepare` saw. */
export type Intent = {
  /** UUIDv7. */
  intent_id: string
  organisation_id: string
  principal: Principal
  capability_identity: string
  capability_version: string
  /** The caller's arguments without `validate_only`; commit runs `prepare` on them again. */
  input: Record<string, unknown>
  targets: Target[]
  preview: Preview
  /** The author's own data for `commit`. */
  plan?: unknown
  policy_class: PolicyClass
  /** SHA-256 hex of the commit token; the token itself is never stored. */
  commit_token_hash: string
  status: IntentStatus
  created_at: string
  expires_at: string
  /** Stored by the commit that ends `committed`. */
  receipt?: Receipt
}

/** Where a server keeps intents. Every write is a compare-and-set on the status, so concurrent commits cannot both claim an intent. */
export type IntentStore = {
  /** Milliseconds since the epoch. The store's clock decides every expiry. */
  now(): number
  insert(intent: Intent): Promise<void>
  /** The intent, marked `expired` first if it was `prepared` or `awaiting_approval` and `expires_at` has passed. */
  get(intentId: string): Promise<Intent | undefined>
  /** Move an intent from `from` to `to`, applying expiry first; with `receipt`, store it too. False when the intent is not in `from`. */
  transition(intentId: string, from: IntentStatus, to: IntentStatus, receipt?: Receipt): Promise<boolean>
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
// How long a committed intent keeps its receipt for a repeated commit, and how often an insert sweeps the store, in milliseconds.
const replayMs = 86_400_000
const sweepMs = 60_000

// Whether an intent can leave the store at `at`: one that can no longer be committed, or a committed one whose receipt no longer replays.
function removable(intent: Intent, at: number) {
  switch (intent.status) {
    case "committing": return false
    case "committed": return Date.parse(intent.receipt!.committed_at) + replayMs <= at
    case "prepared": case "awaiting_approval": return Date.parse(intent.expires_at) <= at
    default: return true
  }
}

/**
 * An `IntentStore` in memory: one per server by default, lost when the process stops. It keeps JSON copies, as a database would.
 * An insert, at most once a minute by the store's clock, removes the intents that can no longer be committed (expired, failed and stale ones)
 * and committed ones a day after their commit, so a repeated commit replays its receipt for a day; after that, or once an intent is removed,
 * a commit answers `INTENT_NOT_FOUND`. A test moves the clock instead of waiting for an intent to expire.
 *
 * @example
 * ```ts
 * let clock = Date.now()
 * const intents = createMemoryIntentStore({ now: () => clock })
 * const server = createMcpServer({ provider, auth, intents })
 * clock += 10 * 60_000 // every agent-class intent prepared so far has expired
 * ```
 */
export function createMemoryIntentStore(options: { now?: () => number } = {}): IntentStore {
  const { now = Date.now } = options
  const intents = new Map<string, Intent>()
  let swept = -Infinity
  function current(intentId: string) {
    const intent = intents.get(intentId)
    if ((intent?.status === "prepared" || intent?.status === "awaiting_approval") && Date.parse(intent.expires_at) <= now()) intent.status = "expired"
    return intent
  }
  return {
    now,
    async insert(intent) {
      const at = now()
      if (at - swept >= sweepMs) {
        swept = at
        for (const [intentId, stored] of intents) if (removable(stored, at)) intents.delete(intentId)
      }
      intents.set(intent.intent_id, copy(intent))
    },
    async get(intentId) {
      const intent = current(intentId)
      return intent && copy(intent)
    },
    async transition(intentId, from, to, receipt) {
      const intent = current(intentId)
      if (intent?.status !== from) return false
      intent.status = to
      if (receipt) intent.receipt = copy(receipt)
      return true
    },
  }
}
