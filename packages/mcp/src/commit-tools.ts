import { z } from "zod"
import type { Receipt } from "./intents"
import { change, type PolicyClass } from "./mutation"

const intent = {
  intent_id: z.uuid().describe("intent_id from the prepare tool's result"),
  commit_token: z.string().describe("commit_token from the prepare tool's result; it works once"),
}

/** What both commit tools return. */
export const receipt = z.object({
  receipt_id: z.uuid(),
  intent_id: z.uuid(),
  status: z.literal("committed"),
  results: z.record(z.string(), z.unknown()),
  applied_changes: z.array(change),
  effects_performed: z.array(z.string()),
  committed_at: z.iso.datetime(),
  committed_by: z.object({ user_id: z.string(), membership_id: z.string(), client_id: z.string() }),
  idempotent_replay: z.boolean(),
}) satisfies z.ZodType<Receipt>

/** The commit tool an intent of this class names, on a server whose commit tools start with `id`. */
export const commitToolName = (id: string, policyClass: PolicyClass) => policyClass === "agent" ? `${id}_commit` : `${id}_commit_confirmed`

/** The two commit tools of a server whose commit tools start with `id` (the provider id when served alone). */
export function commitTools(id: string) {
  const agent = commitToolName(id, "agent")
  const confirmed = commitToolName(id, "controlled")
  return [
    {
      name: agent,
      identity: `${id}/commit`,
      description: `Commit an agent-class intent that a prepare tool returned: pass its intent_id and commit_token. Returns the receipt; calling again returns the same receipt with idempotent_replay true. An intent whose commit_tool is ${confirmed} answers APPROVAL_REQUIRED here.`,
      input: z.object(intent).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      meta: { "com.answerable/capability": { identity: `${id}/commit`, kind: "commit" } },
    },
    {
      name: confirmed,
      identity: `${id}/commit_confirmed`,
      description: `Commit a controlled-class intent once the person has seen its preview and confirmed it: pass its intent_id, commit_token and preview_summary, which must equal the intent's preview.summary word for word. Returns the receipt; calling again returns the same receipt with idempotent_replay true. A human-class intent needs a person's approval and answers APPROVAL_REQUIRED; commit an agent-class intent with ${agent}.`,
      input: z.object({ ...intent, preview_summary: z.string().describe("The intent's preview.summary, word for word as the person saw it") }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      meta: { "com.answerable/capability": { identity: `${id}/commit_confirmed`, kind: "commit" }, "anthropic/requiresUserInteraction": true },
    },
  ]
}
