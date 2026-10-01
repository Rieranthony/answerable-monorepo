import type { Intent, IntentStore } from "@answerable/mcp"
import type { createEvidence, EvidenceEvent } from "./evidence"
import type { PostgresIntentStore } from "./intents"

/**
 * An intent store that records every transition of an intent as evidence, so that the SDK never deals with evidence: `intent.prepared` on insert,
 * with the preview as an erasable payload, and `intent.approval_requested` when the intent waits for a human; `intent.committed` and
 * `receipt.issued` when a commit ends `committed`; `intent.stale` when it ends `stale`; `intent.expired` once, when a read or a claim finds the
 * intent expired. A failed commit is its call's own `capability.completed` failure. A transition the store refuses records nothing.
 */
export function withEvidence(store: PostgresIntentStore, evidence: ReturnType<typeof createEvidence>): IntentStore {
  const record = (intent: Intent, kind: EvidenceEvent["kind"], fields: Partial<EvidenceEvent> = {}) => evidence.record({
    organisation_id: intent.organisation_id, kind, actor_type: "user", actor_id: intent.principal.user_id, client_id: intent.principal.client_id,
    capability_identity: intent.capability_identity, capability_version: intent.capability_version, intent_id: intent.intent_id, outcome: "success", ...fields,
  })
  async function expire(intentId: string) {
    if (await store.expire(intentId)) await record((await store.get(intentId))!, "intent.expired")
  }
  return {
    now: store.now,
    async insert(intent) {
      await store.insert(intent)
      await record(intent, "intent.prepared", { data: { policy_class: intent.policy_class }, payload: intent.preview })
      if (intent.status === "awaiting_approval") await record(intent, "intent.approval_requested")
    },
    async get(intentId) {
      await expire(intentId)
      return store.get(intentId)
    },
    async transition(intentId, from, to, receipt) {
      if (from === "prepared" || from === "awaiting_approval") await expire(intentId)
      if (!(await store.transition(intentId, from, to, receipt))) return false
      if (to === "stale") await record((await store.get(intentId))!, "intent.stale")
      if (to === "committed") {
        const intent = (await store.get(intentId))!
        await record(intent, "intent.committed", { receipt_id: receipt!.receipt_id })
        await record(intent, "receipt.issued", { receipt_id: receipt!.receipt_id })
      }
      return true
    },
  }
}
