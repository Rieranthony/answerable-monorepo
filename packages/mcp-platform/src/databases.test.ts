import { afterAll, beforeAll, expect, test } from "bun:test"
import { createMcpServer, defineProvider, defineTool, type Mount } from "@answerable/mcp"
import { createTestMcp } from "@answerable/mcp/testing"
import { z } from "zod"
import { mcpDatabases, type Declared } from "./databases"
import { pltfix } from "./test/fixtures/pltfix-provider"
import { testOwnMcp, testSharedMcps } from "./testing"

let shared: Awaited<ReturnType<typeof testSharedMcps>>
let empty: Awaited<ReturnType<typeof testSharedMcps>>
let own: Awaited<ReturnType<typeof testOwnMcp>>
beforeAll(async () => {
  ;[shared, empty, own] = await Promise.all([
    testSharedMcps({ name: "answerable_mcp_platform_test", prefix: "mcp_plt", mcps: [pltfix] }),
    testSharedMcps({ name: "answerable_mcp_platform_test_empty", prefix: "mcp_plte", mcps: [] }),
    testOwnMcp({ name: "answerable_mcp_platform_test_own", provider: pltfix }),
  ])
})
afterAll(() => Promise.all([shared.close(), empty.close(), own.close()]))

// The mounted pltfix, served alone: a note added by a first organisation, then what each of two organisations counts.
async function counts(mount: Mount) {
  const mcp = await createTestMcp(serving => createMcpServer({ ...serving, ...mount }))
  try {
    const [first, second] = [await mcp.connect({ organizationId: crypto.randomUUID() }), await mcp.connect({ organizationId: crypto.randomUUID() })]
    const { intent_id, commit_token } = (await first.callTool({ name: "notes_add", arguments: { title: "First" } })).structuredContent as { intent_id: string; commit_token: string }
    await first.callTool({ name: "pltfix_commit", arguments: { intent_id, commit_token } })
    return [(await first.callTool({ name: "notes_count", arguments: {} })).structuredContent, (await second.callTool({ name: "notes_count", arguments: {} })).structuredContent] as { notes: number; role: string }[]
  } finally {
    await mcp.close()
  }
}
async function opened(declared: Declared[], sharedUrl: string, prefix: string) {
  const mcps = mcpDatabases(declared, { shared: sharedUrl, own: { PLTFIX_DATABASE_URL: own.url }, prefix })
  try {
    await mcps.assert()
    return { counts: await counts(mcps.mount[0]!), pools: Object.keys(mcps.pools) }
  } finally {
    await mcps.close()
  }
}

test("a shared MCP's db borrows from the one pool to the shared database, as its runtime role, limited to the caller's organisation", async () => {
  const { counts: [first, second], pools } = await opened([{ provider: pltfix, database: "shared" }], shared.url, "mcp_plt")
  expect([first, second]).toEqual([{ notes: 1, role: "mcp_plt_pltfix" }, { notes: 0, role: "mcp_plt_pltfix" }])
  expect(pools).toEqual(["mcps"])
})

test("an own MCP's db borrows from a pool of its own, as its own runtime login, with the same isolation", async () => {
  const { counts: [first, second], pools } = await opened([{ provider: pltfix, database: "own", variable: "PLTFIX_DATABASE_URL" }], empty.url, "mcp_plte")
  expect([first!.notes, second!.notes]).toEqual([1, 0])
  expect(first!.role).toStartWith("mcp_test_login_")
  expect(pools).toEqual(["mcps", "pltfix"])
})

test("a provider without a database is mounted with no db; an own MCP without its URL is refused; a serving login missing a role does not serve", async () => {
  const plain = defineProvider({
    id: "plain", description: "A fixture MCP with no database, which its server mounts with no db.", version: "2026-10-25",
    tools: [defineTool({ name: "plain.ping", description: "Answer nothing; a fixture MCP with no database, mounted with no db.", input: z.object({}), output: z.object({}), async execute() { return {} } })],
  })
  const without = mcpDatabases([{ provider: plain, database: "shared" }], { shared: empty.url, own: {} })
  expect(without.mount).toEqual([{ provider: plain }])
  await without.close()
  expect(() => mcpDatabases([{ provider: pltfix, database: "own", variable: "PLTFIX_DATABASE_URL" }], { shared: empty.url, own: {} })).toThrow("Set PLTFIX_DATABASE_URL to the database of pltfix, as its runtime login")
  const missing = mcpDatabases([{ provider: pltfix, database: "shared" }], { shared: empty.url, own: {}, prefix: "mcp_plt" })
  try {
    await expect(missing.assert()).rejects.toThrow("is not a member of mcp_plt_pltfix")
  } finally {
    await missing.close()
  }
})
