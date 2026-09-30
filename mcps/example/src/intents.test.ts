import { expect, test } from "bun:test"
import { createMcpServer, createMemoryIntentStore, riskClass } from "@answerable/mcp"
import { createTestMcp, errorOf } from "@answerable/mcp/testing"
import { provider } from "./provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string; policy_class: string }

//#region expiry
test("an intent committed after it expires answers INTENT_EXPIRED", async () => {
  let clock = Date.now()
  const intents = createMemoryIntentStore({ now: () => clock })
  const mcp = await createTestMcp(auth => createMcpServer({ provider, auth, intents }))
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { text: "Later" } })
    const { intent_id, commit_token, commit_tool } = prepared.structuredContent as Intent
    clock += 10 * 60_000 // a low-risk (agent-class) intent lasts 10 minutes
    const committed = await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token } })
    expect(errorOf(committed).code).toBe("INTENT_EXPIRED")
  } finally {
    await mcp.close()
  }
})
//#endregion

//#region policy-class
test("with policyClass, people confirm even low-risk mutations", async () => {
  const policyClass = ({ risk }: { risk: "low" | "normal" | "high" }) => (risk === "low" ? "controlled" : riskClass[risk])
  const mcp = await createTestMcp(auth => createMcpServer({ provider, auth, policyClass }))
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { text: "Checked" } })
    expect(prepared.structuredContent).toMatchObject({ policy_class: "controlled", commit_tool: "example_commit_confirmed" })
  } finally {
    await mcp.close()
  }
})
//#endregion

//#region confirmed
test("a controlled intent commits only with its preview's summary, word for word", async () => {
  const mcp = await createTestMcp(auth => createMcpServer({ provider, auth, policyClass: () => "controlled" }))
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { text: "Confirmed" } })
    const { intent_id, commit_token, commit_tool } = prepared.structuredContent as Intent
    const wrong = await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token, preview_summary: "Add a note" } })
    expect(errorOf(wrong).code).toBe("APPROVAL_REQUIRED")
    const right = await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token, preview_summary: "Add the note “Confirmed”" } })
    expect(right.structuredContent).toMatchObject({ status: "committed", results: { text: "Confirmed" } })
  } finally {
    await mcp.close()
  }
})
//#endregion
