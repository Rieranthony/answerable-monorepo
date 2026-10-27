import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import * as schema from "../db/schema"
import { provider } from "../provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string; preview: { summary: string } }

test("notes_add prepares a row, and the commit tool its intent names adds it to the caller's organisation only", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
    const client = await mcp.connect({ organizationId: mine, organisation: { name: "Acme" } })
    const intent = (await client.callTool({ name: "notes_add", arguments: { title: "First" } })).structuredContent as Intent
    expect(intent.preview.summary).toBe("Add “First” to the notes of Acme")
    const { intent_id, commit_token, preview } = intent
    const committed = await client.callTool({ name: intent.commit_tool, arguments: { intent_id, commit_token, preview_summary: preview.summary } })
    expect(committed.structuredContent).toMatchObject({ status: "committed", results: { title: "First" } })
    expect(await mcp.asOrganisation(mine, () => mcp.db.select({ title: schema.notes.title }).from(schema.notes))).toEqual([{ title: "First" }])
    expect(await mcp.asOrganisation(theirs, () => mcp.db.select().from(schema.notes))).toEqual([])
  } finally {
    await mcp.close()
  }
})
