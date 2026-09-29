import { expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/client"
import { refusal, tool } from "./mcp"

const envelope = { error: { code: "NOT_FOUND", message: "No accessible record exists", retry: { policy: "never" }, request_id: "r1" } }
const failing = { isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }] }
const client = (result: object) => ({ callTool: async () => result }) as unknown as Client

test("tool returns the structured content", async () => {
  expect(await tool(client({ structuredContent: { items: [] } }), "records_list")).toEqual({ items: [] })
})

test("a failed tool call throws with the error envelope's text", async () => {
  await expect(tool(client(failing), "records_show", { id: "x" })).rejects.toThrow(`records_show: ${JSON.stringify(envelope)}`)
})

test("refusal returns the envelope's code, message and details", async () => {
  expect(await refusal(client(failing), "records_show")).toEqual({ code: "NOT_FOUND", message: "No accessible record exists" })
})

test("refusal fails when the call succeeds", async () => {
  await expect(refusal(client({ structuredContent: {} }), "records_list")).rejects.toThrow("records_list must refuse")
})
