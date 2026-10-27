import { expect, test } from "bun:test"
import { createTestMcp } from "@answerable/mcp-postgres/testing"
import * as schema from "../db/schema"
import { provider } from "../provider"

type Page = { items: { title: string }[]; next_cursor: string | null; has_more: boolean }

test("notes_list lists the caller's organisation's rows only, newest first, a page at a time", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [mine, theirs] = [crypto.randomUUID(), crypto.randomUUID()]
    for (const title of ["First", "Second", "Third"]) await mcp.asOrganisation(mine, () => mcp.db.insert(schema.notes).values({ organisation_id: mine, title }))
    await mcp.asOrganisation(theirs, () => mcp.db.insert(schema.notes).values({ organisation_id: theirs, title: "Theirs" }))
    const client = await mcp.connect({ organizationId: mine })
    const first = (await client.callTool({ name: "notes_list", arguments: { limit: 2 } })).structuredContent as Page
    expect(first.items.map(item => item.title)).toEqual(["Third", "Second"])
    expect(first.has_more).toBe(true)
    const second = await client.callTool({ name: "notes_list", arguments: { limit: 2, cursor: first.next_cursor } })
    expect(second.structuredContent).toMatchObject({ items: [{ title: "First" }], next_cursor: null, has_more: false })
    const other = await mcp.connect({ organizationId: theirs })
    expect((await other.callTool({ name: "notes_list", arguments: {} })).structuredContent).toMatchObject({ items: [{ title: "Theirs" }] })
  } finally {
    await mcp.close()
  }
})
