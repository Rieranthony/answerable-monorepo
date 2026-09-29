import { afterEach, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { defineMutation, defineProvider, defineTool, ToolError } from "./index"
import { createTestMcp, errorOf, type TestMcp } from "./testing"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const declared = new ToolError("ACME_LOCKED", "The record is locked", { retry: { policy: "after_state_change" } })
const undeclared = new ToolError("ACME_OTHER", "Another failure", { retry: { policy: "never" } })
const throwing = { NOT_FOUND: new ToolError("NOT_FOUND", "Gone"), declared, undeclared }
const how = z.object({ how: z.enum(["NOT_FOUND", "declared", "undeclared"]) })

const list = defineTool({
  name: "records.list", description: "Throws the error it is asked to, for the declared-errors tests.", errors: ["ACME_LOCKED"],
  input: how, output: z.object({}),
  async execute({ how }) { throw throwing[how] },
})
const remove = defineMutation({
  name: "records.delete", description: "Prepare a delete that throws the error it is asked to, for the declared-errors tests.", errors: ["ACME_LOCKED"], risk: "low",
  input: z.object({ at: z.enum(["prepare", "commit"]), how: how.shape.how }), output: z.object({}),
  async prepare({ at, how }) {
    if (at === "prepare") throw throwing[how]
    return { targets: [], preview: { summary: "Delete" }, plan: { how } }
  },
  async commit({ plan }) { throw throwing[plan.how] },
})

async function connect() {
  const mcp: TestMcp = await createTestMcp(defineProvider({ id: "acme", version: "2026-09-29", tools: [list, remove] }))
  cleanups.push(() => mcp.close())
  return mcp.connect()
}
const envelope = async (client: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) => errorOf(await client.callTool({ name, arguments: args }))

test("a read tool's declared custom code and any standard code reach the caller; an undeclared custom code answers INTERNAL and is logged", async () => {
  const client = await connect()
  expect(await envelope(client, "records_list", { how: "declared" })).toMatchObject({ code: "ACME_LOCKED", retry: { policy: "after_state_change" } })
  expect(await envelope(client, "records_list", { how: "NOT_FOUND" })).toMatchObject({ code: "NOT_FOUND" })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(await envelope(client, "records_list", { how: "undeclared" })).toMatchObject({ code: "INTERNAL", message: "The tool could not complete" })
    expect(log.mock.calls[0]![0]).toBe("[mcp] tool records.list failed")
    expect(log.mock.calls[0]![2]).toMatchObject({ message: "records.list threw ACME_OTHER, which its definition does not declare; add it to errors" })
  } finally { log.mockRestore() }
})

test("a mutation's declared codes reach the caller from prepare and from commit, and an undeclared code from either answers INTERNAL", async () => {
  const client = await connect()
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(await envelope(client, "records_delete", { at: "prepare", how: "declared" })).toMatchObject({ code: "ACME_LOCKED" })
    expect(await envelope(client, "records_delete", { at: "prepare", how: "undeclared" })).toMatchObject({ code: "INTERNAL" })
    expect(log.mock.calls.at(-1)![2]).toMatchObject({ message: "records.delete threw ACME_OTHER, which its definition does not declare; add it to errors" })
    for (const [how, code] of [["declared", "ACME_LOCKED"], ["undeclared", "INTERNAL"]] as const) {
      const intent = (await client.callTool({ name: "records_delete", arguments: { at: "commit", how } })).structuredContent as { intent_id: string; commit_token: string }
      const commit = { intent_id: intent.intent_id, commit_token: intent.commit_token }
      expect(await envelope(client, "acme_commit", commit)).toMatchObject({ code })
      expect(await envelope(client, "acme_commit", commit)).toMatchObject({ code: "INTENT_CONSUMED" })
    }
    expect(log.mock.calls.at(-1)![2]).toMatchObject({ message: "records.delete threw ACME_OTHER, which its definition does not declare; add it to errors" })
  } finally { log.mockRestore() }
})
