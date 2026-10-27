import { expect, test } from "bun:test"
import { createMcpServer, createMemoryIntentStore, riskClass } from "@answerable/mcp"
import { errorOf } from "@answerable/mcp/testing"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import { provider } from "./provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string; policy_class: string; preview: { summary: string } }

//#region expiry
test("an intent committed after it expires answers INTENT_EXPIRED", async () => {
  let clock = Date.now()
  const intents = createMemoryIntentStore({ now: () => clock })
  const mcp = await createTestMcp(provider, { server: serving => createMcpServer({ ...serving, intents }) })
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { title: "Later" } })
    const { intent_id, commit_token, commit_tool, preview } = prepared.structuredContent as Intent
    clock += 30 * 60_000 // a normal-risk (controlled-class) intent lasts 30 minutes
    const committed = await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token, preview_summary: preview.summary } })
    expect(errorOf(committed).code).toBe("INTENT_EXPIRED")
  } finally {
    await mcp.close()
  }
})
//#endregion

//#region policy-class
test("with policyClass, an organisation's agent commits normal-risk mutations on its own", async () => {
  const policyClass = ({ risk }: { risk: "low" | "normal" | "high" }) => (risk === "normal" ? "agent" : riskClass[risk])
  const mcp = await createTestMcp(provider, { server: serving => createMcpServer({ ...serving, policyClass }) })
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { title: "Trusted" } })
    expect(prepared.structuredContent).toMatchObject({ policy_class: "agent", commit_tool: "example_commit" })
  } finally {
    await mcp.close()
  }
})
//#endregion

//#region confirmed
test("a controlled intent commits only with its preview's summary, word for word", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const client = await mcp.connect()
    const prepared = await client.callTool({ name: "notes_add", arguments: { title: "Confirmed" } })
    const { intent_id, commit_token, commit_tool } = prepared.structuredContent as Intent
    const wrong = await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token, preview_summary: "Add a note" } })
    expect(errorOf(wrong).code).toBe("APPROVAL_REQUIRED")
    const right = await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token, preview_summary: "Add “Confirmed” to the notes of Test Organisation" } })
    expect(right.structuredContent).toMatchObject({ status: "committed", results: { title: "Confirmed" } })
  } finally {
    await mcp.close()
  }
})
//#endregion
