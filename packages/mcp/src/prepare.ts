import type { UserPrincipal } from "@answerable/auth"
import { z } from "zod"
import type { IntentStore } from "./intents"
import { classExpiry, preview, target, type Mutation, type Plan, type PolicyClass } from "./mutation"
import type { Served } from "./provider"

/** The intent as the caller sees it, which every prepare tool returns. */
export const intentView = z.object({
  intent_id: z.uuid().nullable(),
  capability: z.string(),
  version: z.string(),
  policy_class: z.enum(["agent", "controlled", "human"]),
  commit_tool: z.string(),
  commit_token: z.string().nullable(),
  expires_at: z.iso.datetime(),
  targets: z.array(target),
  preview,
  approval: z.object({ required: z.boolean(), status: z.enum(["not_required", "pending"]) }),
})

export const hashToken = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex")

/** Record a prepared plan as an intent and return it with a single-use commit token; with `validateOnly`, record nothing and return no id or token. */
export async function recordIntent({ mutation, input, plan, policyClass, commitTool, principal, store, validateOnly }: {
  mutation: Served<Mutation>
  input: Record<string, unknown>
  plan: Plan
  policyClass: PolicyClass
  commitTool: string
  principal: UserPrincipal
  store: IntentStore
  validateOnly: boolean
}) {
  const now = store.now()
  const expires_at = new Date(now + Math.min(mutation.expiresInMs ?? Infinity, classExpiry[policyClass])).toISOString()
  const human = policyClass === "human"
  const approval = human ? { required: true, status: "pending" as const } : { required: false, status: "not_required" as const }
  const intent_id = validateOnly ? null : Bun.randomUUIDv7()
  const commit_token = validateOnly ? null : `act_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`
  if (intent_id && commit_token) {
    await store.insert({
      intent_id, organisation_id: principal.organizationId,
      principal: { user_id: principal.userId, membership_id: principal.membershipId, client_id: principal.clientId },
      capability_identity: mutation.identity, capability_version: mutation.version, input,
      targets: plan.targets, preview: plan.preview, plan: plan.plan, policy_class: policyClass, approval,
      commit_token_hash: hashToken(commit_token), status: human ? "awaiting_approval" : "prepared",
      created_at: new Date(now).toISOString(), expires_at,
    })
  }
  return {
    intent_id, capability: mutation.identity, version: mutation.version, policy_class: policyClass, commit_tool: commitTool, commit_token,
    expires_at, targets: plan.targets, preview: plan.preview, approval,
  }
}
