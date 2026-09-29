import type { PolicyClass, Preview, Target } from "./mutation"

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
  applied_changes: { path: string; from: unknown; to: unknown }[]
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
  approval: { required: boolean; status: "not_required" | "pending" }
  /** SHA-256 hex of the commit token; the token itself is never stored. */
  commit_token_hash: string
  status: IntentStatus
  created_at: string
  expires_at: string
  committed_at?: string
  receipt?: Receipt
}

/** Where a server keeps intents. Every write is a compare-and-set on the status, so concurrent commits cannot both claim an intent. */
export type IntentStore = {
  /** Milliseconds since the epoch. The store's clock decides every expiry. */
  now(): number
  insert(intent: Intent): Promise<void>
  /** The intent, marked `expired` first if it was `prepared` or `awaiting_approval` and `expires_at` has passed. */
  get(intentId: string): Promise<Intent | undefined>
  /** Move an intent from `from` to `to`, applying expiry first; with `receipt`, store it and its `committed_at`. False when the intent is not in `from`. */
  transition(intentId: string, from: IntentStatus, to: IntentStatus, receipt?: Receipt): Promise<boolean>
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

/** An `IntentStore` in memory: one per server by default, lost when the process stops. It keeps JSON copies, as a database would; `now` sets its clock. */
export function createMemoryIntentStore({ now = Date.now }: { now?: () => number } = {}): IntentStore {
  const intents = new Map<string, Intent>()
  function current(intentId: string) {
    const intent = intents.get(intentId)
    if ((intent?.status === "prepared" || intent?.status === "awaiting_approval") && Date.parse(intent.expires_at) <= now()) intent.status = "expired"
    return intent
  }
  return {
    now,
    async insert(intent) { intents.set(intent.intent_id, copy(intent)) },
    async get(intentId) {
      const intent = current(intentId)
      return intent && copy(intent)
    },
    async transition(intentId, from, to, receipt) {
      const intent = current(intentId)
      if (intent?.status !== from) return false
      intent.status = to
      if (receipt) Object.assign(intent, { committed_at: receipt.committed_at, receipt: copy(receipt) })
      return true
    },
  }
}
