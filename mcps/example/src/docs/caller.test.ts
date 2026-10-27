import { expect, test } from "bun:test"
import { defineProvider } from "@answerable/mcp"
import { createTestMcp } from "@answerable/mcp/testing"
import { notesWhoami } from "./caller"

const provider = defineProvider({ id: "example", description: "Tells you who you are to the notes server, for the docs on the caller.", version: "2026-09-30", tools: [notesWhoami] })

//#region person
test("a test is the test person of the test organisation, unless connect says who", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const anyone = await mcp.connect()
    expect((await anyone.callTool({ name: "notes_whoami", arguments: {} })).structuredContent).toEqual({ name: "Test Person", organisation: "Test Organisation", groups: [] })
    const ada = await mcp.connect({ person: { name: "Ada Lovelace", groups: [{ id: crypto.randomUUID(), slug: "engineers", name: "Engineers" }] }, organisation: { name: "Acme" } })
    expect((await ada.callTool({ name: "notes_whoami", arguments: {} })).structuredContent).toEqual({ name: "Ada Lovelace", organisation: "Acme", groups: ["engineers"] })
  } finally {
    await mcp.close()
  }
})
//#endregion
