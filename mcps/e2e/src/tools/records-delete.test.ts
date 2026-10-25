import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import { errorOf } from "@answerable/mcp/testing"
import { eq, sql } from "drizzle-orm"
import { records } from "../db/schema"
import { provider } from "../provider"

type Intent = { intent_id: string; commit_token: string; commit_tool: string; targets: { version: { kind: string; value: string } }[]; preview: { summary: string } }

test("records_delete binds the record's version: a change since prepare is stale, another organisation's record is not found, and a commit deletes it", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
    const add = (organisationId: string, title: string) => mcp.asOrganisation(organisationId, async () => (await mcp.db.insert(records).values({ organisation_id: organisationId, creator_id: crypto.randomUUID(), title }).returning())[0]!)
    const [record, other] = [await add(mine, "Doomed"), await add(theirs, "Theirs")]
    const client = await mcp.connect({ organizationId: mine })
    expect(errorOf(await client.callTool({ name: "records_delete", arguments: { id: other.id } }))).toMatchObject({ code: "NOT_FOUND", message: "No accessible record exists" })
    const prepare = async () => (await client.callTool({ name: "records_delete", arguments: { id: record.id } })).structuredContent as Intent
    const commit = (intent: Intent) => client.callTool({ name: intent.commit_tool, arguments: { intent_id: intent.intent_id, commit_token: intent.commit_token, preview_summary: intent.preview.summary } })
    const stale = await prepare()
    expect(stale).toMatchObject({ commit_tool: "e2e_commit_confirmed", targets: [{ version: { kind: "serial", value: "1" } }], preview: { summary: "Delete record “Doomed”" } })
    await mcp.asOrganisation(mine, () => mcp.db.update(records).set({ version: sql`${records.version} + 1` }).where(eq(records.id, record.id)))
    expect(errorOf(await commit(stale)).code).toBe("INTENT_STALE")
    expect((await commit(await prepare())).structuredContent).toMatchObject({ status: "committed", results: { deleted: true, id: record.id } })
    expect(await mcp.asOrganisation(mine, () => mcp.db.select().from(records))).toEqual([])
    expect(await mcp.asOrganisation(theirs, () => mcp.db.select({ title: records.title }).from(records))).toEqual([{ title: "Theirs" }])
  } finally {
    await mcp.close()
  }
})
