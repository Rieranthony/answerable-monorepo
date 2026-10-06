import type { Intent, IntentStore } from "@answerable/mcp"
import type { createEvidence, EvidenceEvent } from "./evidence"
import type { PostgresIntentStore } from "./intents"

/**
 * An intent store that records every transition of an intent as evidence, so that the SDK never deals with evidence: `intent.prepared` on insert,
 * with the preview as an erasable payload, and `intent.approval_requested` when the intent waits for a human; `intent.committed` and
 * `receipt.issued` when a commit ends `committed`; `intent.stale` when it ends `stale`; `intent.expired` once, when a read or a claim expires the
 * intent. Each call expires the intent at most once, and records the expiry from what that one step did. A failed commit is its call's own
 * `capability.completed` failure. A transition the store refuses records nothing.
 */
export function withEvidence(store: PostgresIntentStore, evidence: ReturnType<typeof createEvidence>): IntentStore {
  const record = (intent: Intent, kind: EvidenceEvent["kind"], fields: Partial<EvidenceEvent> = {}) => evidence.record({
    organisation_id: intent.organisation_id, kind, actor_type: "user", actor_id: intent.principal.user_id, client_id: intent.principal.client_id,
    capability_identity: intent.capability_identity, capability_version: intent.capability_version, intent_id: intent.intent_id, outcome: "success", ...fields,
  })
  async function expire(intentId: string) {
    const expired = await store.expire(intentId)
    if (expired) await record(expired, "intent.expired")
    return expired
  }
  return {
    now: store.now,
    async insert(intent) {
      await store.insert(intent)
      await record(intent, "intent.prepared", { data: { policy_class: intent.policy_class }, payload: intent.preview })
      if (intent.status === "awaiting_approval") await record(intent, "intent.approval_requested")
    },
    async get(intentId) {
      return (await expire(intentId)) ?? store.read(intentId)
    },
    async transition(intentId, from, to, receipt) {
      if (from === "prepared" || from === "awaiting_approval") await expire(intentId)
      const moved = await store.move(intentId, from, to, receipt)
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
