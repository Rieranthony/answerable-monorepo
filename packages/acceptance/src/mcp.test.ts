import { expect, test } from "bun:test"
import { createMcpServer, defineProvider, defineTool, type McpServerHandle } from "@answerable/mcp"
import { createTestMcp } from "@answerable/mcp/testing"
import type { Client, OAuthClientProvider, Tool } from "@modelcontextprotocol/client"
import { z } from "zod"
import { cleanup } from "./cleanup"
import { connect, refusal, serve, tool } from "./mcp"

const envelope = { error: { code: "NOT_FOUND", message: "No accessible record exists", retry: { policy: "never" as const }, request_id: "r1" } }
const failing = { isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }] }
const client = (result: object) => ({ callTool: async () => result }) as unknown as Client

test("tool returns the structured content", async () => {
  expect(await tool(client({ structuredContent: { items: [] } }), "records_list")).toEqual({ items: [] })
})

test("a failed tool call throws with the error envelope's code and message", async () => {
  await expect(tool(client(failing), "records_show", { id: "x" })).rejects.toThrow("records_show answered NOT_FOUND: No accessible record exists")
})

test("refusal returns the envelope's error", async () => {
  expect(await refusal(client(failing), "records_show")).toEqual(envelope.error)
})

test("refusal fails when the call succeeds", async () => {
  await expect(refusal(client({ content: [], structuredContent: {} }), "records_list")).rejects.toThrow("records_list: the call succeeded where an error was expected")
})

test("connect with onToolsChanged listens for tools/list_changed and passes the tools listed again", async () => {
  const probe = defineTool({ name: "probe.read", description: "A probe tool that returns nothing and changes nothing.", input: z.object({}), output: z.object({}), async execute() { return {} } })
  let server!: McpServerHandle
  const listener = serve(0, request => server.fetch(request))
  const resource = `http://127.0.0.1:${listener.port}/mcp`
  const mcp = await createTestMcp(auth => (server = createMcpServer({ provider: defineProvider({ id: "probe", version: "2026-09-29", tools: [probe] }), auth: { ...auth, resource } })))
  const token = await mcp.issuer.sign({ resource, scopes: ["probe:read"] })
  const provider = { tokens: () => ({ access_token: token, token_type: "Bearer" }), clientInformation: () => ({ client_id: "probe" }) } as unknown as OAuthClientProvider
  try {
    const listed = new Promise<Tool[]>((resolve, reject) => void connect(resource, provider, "2026-07-28", (error, tools) => (error ? reject(error) : resolve(tools!))).then(() => server.toolsChanged()))
    expect((await listed).map(item => item.name)).toEqual(["probe_read"])
  } finally {
    await mcp.close()
    await cleanup()
  }
})
