import { and, eq, inArray, lte, or, sql } from "drizzle-orm"
import type { Intent, IntentStatus, IntentStore } from "@answerable/mcp"
import type { Executor } from "./connect"
import type { createEvidence, EvidenceEvent } from "./evidence"
import { intents } from "./schema"

// JSON goes in as text and comes out as text, so that every JSON value, null included, survives the round trip.
const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))
const asJson = (value: unknown) => sql`${json(value)}::text::jsonb`
const asText = (column: unknown) => sql<string>`${column}::text`
const expirable = (status: IntentStatus) => status === "prepared" || status === "awaiting_approval"
// How often an insert sweeps the table, in milliseconds, as the memory store does.
const sweepMs = 60_000
const columns = {
  intent_id: asText(intents.intent_id), organisation_id: asText(intents.organisation_id), user_id: intents.user_id, membership_id: intents.membership_id,
  client_id: intents.client_id, capability_identity: intents.capability_identity, capability_version: intents.capability_version,
  input: asText(intents.input), targets: asText(intents.targets), preview: asText(intents.preview), plan: sql<string | null>`${intents.plan}::text`,
  policy_class: intents.policy_class, commit_token_hash: intents.commit_token_hash, status: intents.status, created_at: intents.created_at,
  expires_at: intents.expires_at, receipt: sql<string | null>`${intents.receipt}::text`,
}
type Row = Record<"intent_id" | "organisation_id" | "user_id" | "membership_id" | "client_id" | "capability_identity" | "capability_version" | "commit_token_hash", string>
  & Record<"input" | "targets" | "preview", string> & Record<"plan" | "receipt", string | null> & Record<"created_at" | "expires_at", Date>
  & { policy_class: Intent["policy_class"]; status: IntentStatus }

function intentOf(row: Row | undefined): Intent | undefined {
  return row && {
    intent_id: row.intent_id, organisation_id: row.organisation_id,
    principal: { user_id: row.user_id, membership_id: row.membership_id, client_id: row.client_id },
    capability_identity: row.capability_identity, capability_version: row.capability_version,
    input: JSON.parse(row.input), targets: JSON.parse(row.targets), preview: JSON.parse(row.preview),
    ...(row.plan === null ? {} : { plan: JSON.parse(row.plan) }),
    policy_class: row.policy_class, commit_token_hash: row.commit_token_hash,
    status: row.status, created_at: row.created_at.toISOString(), expires_at: row.expires_at.toISOString(),
    ...(row.receipt === null ? {} : { receipt: JSON.parse(row.receipt) }),
  }
}

/**
 * Keep intents in the `intents` table and record every step of an intent as `evidence`, so that the SDK never deals with evidence. Every status
 * change is one `UPDATE … WHERE intent_id = … AND status = …`, so two commits can never both claim an intent. `get` and `transition` first mark an
 * intent `expired` once `expires_at` has passed, at most once per call, and record the expiry that one step made.
 *
 * The evidence: `intent.prepared` on insert, with the preview as an erasable payload, and `intent.approval_requested` when the intent waits for a
 * human; `intent.committed` and `receipt.issued` when a commit ends `committed`; `intent.stale` when it ends `stale`; `intent.expired` once, when a
 * read or a claim expires the intent. A failed commit is its call's own `capability.completed` failure. A transition the store refuses records nothing.
 *
 * Like the memory store, an insert, at most once a minute, deletes the intents that can no longer be committed (expired, failed and stale ones, and
 * unclaimed ones past `expires_at`) and committed ones a day after their commit. Expiry and the sweep follow the database's clock, or `now` when a
 * test injects one; `now` also stamps new intents and receipts, and spaces the sweeps.
 */
export function createPostgresIntentStore(db: Executor, evidence: ReturnType<typeof createEvidence>, options: { now?: () => number } = {}): IntentStore {
  const { now } = options
  const clock = now ?? Date.now
  // The moment the call reads: the injected clock's, else the database's.
  const at = () => sql`coalesce(${now ? new Date(now()) : null}::timestamptz, now())`
  let swept = -Infinity
  const record = (intent: Intent, kind: EvidenceEvent["kind"], fields: Partial<EvidenceEvent> = {}) => evidence.record({
    organisation_id: intent.organisation_id, kind, actor_type: "user", actor_id: intent.principal.user_id, client_id: intent.principal.client_id,
    capability_identity: intent.capability_identity, capability_version: intent.capability_version, intent_id: intent.intent_id, outcome: "success", ...fields,
  })
  // Mark the intent expired if it is open and past expires_at, and record that: the intent when this step expired it, else undefined.
  async function expire(intentId: string) {
    const [row] = await db.update(intents).set({ status: "expired" })
      .where(and(eq(intents.intent_id, intentId), inArray(intents.status, ["prepared", "awaiting_approval"]), lte(intents.expires_at, at())))
      .returning(columns)
    const expired = intentOf(row)
    if (expired) await record(expired, "intent.expired")
    return expired
  }
  return {
    now: clock,
    async insert(intent) {
      if (clock() - swept >= sweepMs) {
        swept = clock()
        await db.delete(intents).where(or(
          inArray(intents.status, ["expired", "failed", "stale"]),
          and(inArray(intents.status, ["prepared", "awaiting_approval"]), lte(intents.expires_at, at())),
          and(eq(intents.status, "committed"), sql`(${intents.receipt} ->> 'committed_at')::timestamptz <= ${at()} - interval '1 day'`),
        ))
      }
      const { principal } = intent
      await db.insert(intents).values({
        intent_id: intent.intent_id, organisation_id: intent.organisation_id, user_id: principal.user_id, membership_id: principal.membership_id,
        client_id: principal.client_id, capability_identity: intent.capability_identity, capability_version: intent.capability_version,
        input: asJson(intent.input), targets: asJson(intent.targets), preview: asJson(intent.preview), plan: asJson(intent.plan),
        policy_class: intent.policy_class, commit_token_hash: intent.commit_token_hash, status: intent.status,
        created_at: new Date(intent.created_at), expires_at: new Date(intent.expires_at), receipt: asJson(intent.receipt),
      })
      await record(intent, "intent.prepared", { data: { policy_class: intent.policy_class }, payload: intent.preview })
      if (intent.status === "awaiting_approval") await record(intent, "intent.approval_requested")
    },
    async get(intentId) {
      const expired = await expire(intentId)
      if (expired) return expired
      const [row] = await db.select(columns).from(intents).where(eq(intents.intent_id, intentId))
      return intentOf(row)
    },
    async transition(intentId, from, to, receipt) {
      if (expirable(from)) await expire(intentId)
      const [row] = await db.update(intents).set({ status: to, receipt: sql`coalesce(${asJson(receipt)}, ${intents.receipt})` })
        .where(and(eq(intents.intent_id, intentId), eq(intents.status, from))).returning(columns)
      const moved = intentOf(row)
      if (!moved) return false
      if (to === "stale") await record(moved, "intent.stale")
      if (to === "committed") {
        await record(moved, "intent.committed", { receipt_id: receipt!.receipt_id })
        await record(moved, "receipt.issued", { receipt_id: receipt!.receipt_id })
      }
      return true
    },
  }
}
