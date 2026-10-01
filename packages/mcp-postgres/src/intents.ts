import type { SQL } from "bun"
import type { Intent, IntentStatus, IntentStore } from "@answerable/mcp"

/** An `IntentStore` in Postgres, with `expire`, which `withEvidence` uses to record each expiry once. */
export type PostgresIntentStore = IntentStore & {
  /** Mark the intent `expired` if it is `prepared` or `awaiting_approval` and `expires_at` has passed. True when this call expired it. */
  expire(intentId: string): Promise<boolean>
}

type Row = Record<"intent_id" | "organisation_id" | "user_id" | "membership_id" | "client_id" | "capability_identity" | "capability_version" | "policy_class" | "commit_token_hash" | "status", string>
  & Record<"input" | "targets" | "preview" | "approval", string> & Record<"plan" | "receipt", string | null> & Record<"created_at" | "expires_at", Date>

// JSON goes in as text and comes out as text, so that every JSON value, null included, survives the round trip.
const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))
const expirable = (status: IntentStatus) => status === "prepared" || status === "awaiting_approval"

function intentOf(row: Row): Intent {
  return {
    intent_id: row.intent_id, organisation_id: row.organisation_id,
    principal: { user_id: row.user_id, membership_id: row.membership_id, client_id: row.client_id },
    capability_identity: row.capability_identity, capability_version: row.capability_version,
    input: JSON.parse(row.input), targets: JSON.parse(row.targets), preview: JSON.parse(row.preview),
    ...(row.plan === null ? {} : { plan: JSON.parse(row.plan) }),
    policy_class: row.policy_class as Intent["policy_class"], approval: JSON.parse(row.approval), commit_token_hash: row.commit_token_hash,
    status: row.status as IntentStatus, created_at: row.created_at.toISOString(), expires_at: row.expires_at.toISOString(),
    ...(row.receipt === null ? {} : { receipt: JSON.parse(row.receipt) }),
  }
}

/**
 * Keep intents in the `intents` table. Every status change is one `UPDATE … WHERE intent_id = … AND status = …`, so two commits can never both
 * claim an intent. `get` and `transition` first mark an intent `expired` once `expires_at` has passed, judged by the database's clock, or by
 * `now` when a test injects one; `now` also stamps new intents and receipts.
 */
export function createPostgresIntentStore(db: SQL, options: { now?: () => number } = {}): PostgresIntentStore {
  const { now } = options
  async function expire(intentId: string) {
    const expired = await db`update intents set status = 'expired'
      where intent_id = ${intentId} and status in ('prepared', 'awaiting_approval') and expires_at <= coalesce(${now ? new Date(now()) : null}::timestamptz, now())
      returning 1`
    return expired.length === 1
  }
  return {
    now: now ?? Date.now,
    expire,
    async insert(intent) {
      const { principal } = intent
      await db`insert into intents (intent_id, organisation_id, user_id, membership_id, client_id, capability_identity, capability_version, input, targets,
          preview, plan, policy_class, approval, commit_token_hash, status, created_at, expires_at, receipt)
        values (${intent.intent_id}, ${intent.organisation_id}, ${principal.user_id}, ${principal.membership_id}, ${principal.client_id},
          ${intent.capability_identity}, ${intent.capability_version}, ${json(intent.input)}::text::jsonb, ${json(intent.targets)}::text::jsonb,
          ${json(intent.preview)}::text::jsonb, ${json(intent.plan)}::text::jsonb, ${intent.policy_class}, ${json(intent.approval)}::text::jsonb,
          ${intent.commit_token_hash}, ${intent.status}, ${intent.created_at}::timestamptz, ${intent.expires_at}::timestamptz, ${json(intent.receipt)}::text::jsonb)`
    },
    async get(intentId) {
      await expire(intentId)
      const [row] = await db`select intent_id::text, organisation_id::text, user_id, membership_id, client_id, capability_identity, capability_version,
          input::text, targets::text, preview::text, plan::text, policy_class, approval::text, commit_token_hash, status, created_at, expires_at, receipt::text
        from intents where intent_id = ${intentId}`
      return row && intentOf(row)
    },
    async transition(intentId, from, to, receipt) {
      if (expirable(from)) await expire(intentId)
      const moved = await db`update intents set status = ${to}, receipt = coalesce(${json(receipt)}::text::jsonb, receipt)
        where intent_id = ${intentId} and status = ${from} returning 1`
      return moved.length === 1
    },
  }
}
