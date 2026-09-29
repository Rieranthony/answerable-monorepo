import { bounded } from "./call"
import { commitToolName } from "./commit-tools"
import type { ToolContext } from "./definitions"
import { ToolError } from "./errors"
import type { Intent, IntentStore, Receipt } from "./intents"
import { outcome, preparePlan, type Mutation, type Target } from "./mutation"
import { hashToken } from "./prepare"
import type { Served } from "./provider"

const approvalRequired = (intent: Intent, commit_tool: string, message: string) =>
  new ToolError("APPROVAL_REQUIRED", message, { details: { approval: { class: intent.policy_class, commit_tool } } })

/** The receipt of an intent that is no longer `prepared`, or the error that says why it cannot be committed. */
function settled(intent: Intent, id: string): Receipt {
  const { intent_id } = intent
  switch (intent.status) {
    case "committed": return { ...intent.receipt!, idempotent_replay: true }
    case "committing": throw new ToolError("COMMIT_IN_PROGRESS", `Intent ${intent_id} is being committed; call again shortly for its receipt`)
    case "expired": throw new ToolError("INTENT_EXPIRED", `Intent ${intent_id} expired at ${intent.expires_at}; prepare it again`)
    case "stale": throw new ToolError("INTENT_STALE", `Intent ${intent_id} is stale; prepare it again`)
    case "failed": throw new ToolError("INTENT_CONSUMED", `Intent ${intent_id} was used and its commit failed; prepare it again`)
    default: // awaiting_approval
      throw approvalRequired(intent, commitToolName(id, "human"), `Intent ${intent_id} is human class and needs a person's approval, which this server cannot record yet`)
  }
}

/** The targets whose version moved, disappeared or appeared since prepare. */
function moved(expected: Target[], current: Target[]) {
  const key = (target: Target) => JSON.stringify([target.resource_type, target.resource_id])
  const before = new Map(expected.map(target => [key(target), target]))
  const after = new Map(current.map(target => [key(target), target]))
  return [...new Set([...before.keys(), ...after.keys()])].flatMap(name => {
    const [was, now] = [before.get(name), after.get(name)]
    if (was && now && was.version.kind === now.version.kind && was.version.value === now.version.value) return []
    const { resource_id, label } = (was ?? now)!
    return [{ resource_id, label, expected: was?.version.value ?? null, current: now?.version.value ?? null }]
  })
}

/** Claimed intents run here: `prepare` again to compare the targets, then `commit`; the intent ends `committed`, `stale` or `failed`. */
function apply(intent: Intent, mutation: Served<Mutation>, context: ToolContext, store: IntentStore): Promise<Receipt> {
  const { intent_id } = intent
  return bounded(mutation, context, async context => {
    try {
      const plan = await preparePlan(mutation, await mutation.input.parseAsync(intent.input), context)
      const changed = moved(intent.targets, plan.targets)
      if (changed.length) {
        await store.transition(intent_id, "committing", "stale")
        const labels = changed.map(({ label }) => `“${label}”`).join(", ")
        const targets = changed.map(({ resource_id, expected, current }) => ({ resource_id, expected, current }))
        throw new ToolError("INTENT_STALE", `Intent ${intent_id} is stale: ${labels} changed since it was prepared; prepare it again`, { details: { targets } })
      }
      const done = await mutation.commit({ targets: intent.targets, preview: intent.preview, plan: intent.plan }, context)
      const receipt: Receipt = {
        receipt_id: Bun.randomUUIDv7(), intent_id, status: "committed",
        results: await mutation.output.parseAsync(done.results), ...outcome.parse(done),
        committed_at: new Date(store.now()).toISOString(), committed_by: intent.principal, idempotent_replay: false,
      }
      await store.transition(intent_id, "committing", "committed", receipt)
      return receipt
    } catch (error) {
      // A stale intent has already left committing, so this marks only a failure.
      await store.transition(intent_id, "committing", "failed")
      throw error
    }
  })
}

type CommitRequest = {
  /** The start of the server's commit tool names: the provider id when served alone. */
  id: string
  /** The commit tool called. */
  tool: string
  input: { intent_id: string; commit_token: string; preview_summary?: string }
  context: ToolContext
  store: IntentStore
  mutations: readonly Served<Mutation>[]
  /** Whether the caller may still use a mutation. */
  permitted(mutation: Served<Mutation>): boolean
}

/** Commit an intent: check it can be committed by this caller through this tool, claim it, then apply it. */
export async function commitIntent(request: CommitRequest): Promise<Receipt> {
  const { id, tool, input, context, store, mutations, permitted } = request
  const { principal } = context
  const intent = await store.get(input.intent_id)
  if (!intent) throw new ToolError("INTENT_NOT_FOUND", `No intent ${input.intent_id} exists; prepare the mutation again`)
  const { intent_id, principal: owner } = intent
  if (owner.user_id !== principal.userId || owner.membership_id !== principal.membershipId || owner.client_id !== principal.clientId) {
    throw new ToolError("PRINCIPAL_MISMATCH", `Intent ${intent_id} belongs to another person, membership or client; prepare your own`)
  }
  if (intent.status !== "prepared") return settled(intent, id)
  const mutation = mutations.find(({ identity, version }) => identity === intent.capability_identity && version === intent.capability_version)
  if (!mutation) {
    throw new ToolError("INTENT_NOT_FOUND", `Intent ${intent_id} is for ${intent.capability_identity} version ${intent.capability_version}, which this server does not serve; prepare it again`)
  }
  if (!permitted(mutation)) throw new ToolError("PERMISSION_DENIED", `Your access no longer covers ${mutation.identity}`)
  if (hashToken(input.commit_token) !== intent.commit_token_hash) throw new ToolError("COMMIT_TOKEN_INVALID", `The commit token does not match intent ${intent_id}`)
  const needed = commitToolName(id, intent.policy_class)
  if (tool !== needed) {
    throw approvalRequired(intent, needed, intent.policy_class === "agent"
      ? `Intent ${intent_id} is agent class; commit it with ${needed}`
      : `Intent ${intent_id} is controlled class: show the person its preview, then commit it with ${needed} and its summary as preview_summary`)
  }
  if (intent.policy_class === "controlled" && input.preview_summary !== intent.preview.summary) {
    throw approvalRequired(intent, needed, `preview_summary differs from the summary of intent ${intent_id}; show the person the preview and pass its summary word for word`)
  }
  // Losing the claim to a concurrent commit means the status moved on: read it again.
  if (!(await store.transition(intent_id, "prepared", "committing"))) return commitIntent(request)
  return apply(intent, mutation, context, store)
}
