import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { createMcpServer, defineProvider, defineTool, type Mount } from "@answerable/mcp"
import { createTestMcp } from "@answerable/mcp/testing"
import { connectionCutter } from "@answerable/mcp-postgres/testing"
import { z } from "zod"
import { mcpDatabases, type Declared } from "./databases"
import { pltfix } from "./test/fixtures/pltfix-provider"
import { testOwnMcp, testSharedMcps } from "./testing"

let shared: Awaited<ReturnType<typeof testSharedMcps>>
let empty: Awaited<ReturnType<typeof testSharedMcps>>
let own: Awaited<ReturnType<typeof testOwnMcp>>
beforeAll(async () => {
  ;[shared, empty, own] = await Promise.all([
    testSharedMcps({ name: "answerable_mcp_platform_test", mcps: [pltfix] }),
    testSharedMcps({ name: "answerable_mcp_platform_test_empty", mcps: [] }),
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
async function opened(declared: Declared[], sharedUrl: string) {
  const mcps = mcpDatabases(declared, { shared: sharedUrl, own: { PLTFIX_DATABASE_URL: own.url } })
  try {
    await mcps.assert()
    return { counts: await counts(mcps.mount[0]!), pools: Object.keys(mcps.pools) }
  } finally {
    await mcps.close()
  }
}

test("a shared MCP's db borrows from the one pool to the shared database, as the serving login, limited to the caller's organisation", async () => {
  const { counts: [first, second], pools } = await opened([{ provider: pltfix, serve: "toolbox", database: "shared" }], shared.url)
  expect([first!.notes, second!.notes]).toEqual([1, 0])
  expect([first!.role, second!.role]).toEqual([new URL(shared.url).username, new URL(shared.url).username])
  expect(pools).toEqual(["mcps"])
})

test("an own MCP's db borrows from a pool of its own, as its own runtime login, with the same isolation", async () => {
  const { counts: [first, second], pools } = await opened([{ provider: pltfix, serve: "toolbox", database: "own", variable: "PLTFIX_DATABASE_URL" }], empty.url)
  expect([first!.notes, second!.notes]).toEqual([1, 0])
  expect(first!.role).toBe(new URL(own.url).username)
  expect(pools).toEqual(["mcps", "pltfix"])
})

test("a provider without a database is mounted with no db; an own MCP without its URL is refused; a login without USAGE on an MCP's schema, shared or own, does not serve", async () => {
  const plain = defineProvider({
    id: "plain", description: "A fixture MCP with no database, which its server mounts with no db.", version: "2026-10-25",
    tools: [defineTool({ name: "plain.ping", description: "Answer nothing; a fixture MCP with no database, mounted with no db.", input: z.object({}), output: z.object({}), async execute() { return {} } })],
  })
  const without = mcpDatabases([{ provider: plain, serve: "standalone", database: "shared" }], { shared: empty.url, own: {} })
  expect(without.mount).toEqual([{ provider: plain, serve: "standalone" }])
  await without.close()
  expect(() => mcpDatabases([{ provider: pltfix, serve: "toolbox", database: "own", variable: "PLTFIX_DATABASE_URL" }], { shared: empty.url, own: {} })).toThrow("Set PLTFIX_DATABASE_URL to the database of pltfix, as its runtime login")
  const missing = mcpDatabases([{ provider: pltfix, serve: "toolbox", database: "shared" }], { shared: empty.url, own: {} })
  try {
    await expect(missing.assert()).rejects.toThrow("may not serve MCPs: lacks USAGE on schema pltfix")
  } finally {
    await missing.close()
  }
  // The empty shared database's serving login, named as the own MCP's: its database has no schema pltfix.
  const elsewhere = mcpDatabases([{ provider: pltfix, serve: "toolbox", database: "own", variable: "PLTFIX_DATABASE_URL" }], { shared: shared.url, own: { PLTFIX_DATABASE_URL: empty.url } })
  try {
    await expect(elsewhere.assert()).rejects.toThrow("may not serve MCPs: lacks USAGE on schema pltfix")
  } finally {
    await elsewhere.close()
  }
})

test("each pool outlives a connection lost with no word from the server, idle or in a transaction, and serves the next query", async () => {
  const [sharedCutter, ownCutter] = await Promise.all([connectionCutter(shared.url), connectionCutter(own.url)])
  const mcps = mcpDatabases([{ provider: pltfix, serve: "toolbox", database: "own", variable: "PLTFIX_DATABASE_URL" }], { shared: sharedCutter.url, own: { PLTFIX_DATABASE_URL: ownCutter.url } })
  const log = spyOn(console, "error").mockImplementation(() => {})
  const until = async (holds: () => boolean) => {
    for (let wait = 0; wait < 500 && !holds(); wait++) await Bun.sleep(10)
    expect(holds()).toBe(true)
  }
  try {
    for (const [pool, cutter] of [[mcps.pools.mcps!, sharedCutter], [mcps.pools.pltfix!, ownCutter]] as const) {
      log.mockClear()
      await pool.query("select 1")
      expect(pool.idleCount).toBe(1)
      cutter.cut()
      await until(() => pool.idleCount === 0)
      expect((await pool.query("select 1 as served")).rows).toEqual([{ served: 1 }])
      const held = await pool.connect()
      await held.query("begin")
      cutter.cut()
      await until(() => log.mock.calls.length === 2)
      await expect(held.query("select 1")).rejects.toThrow()
      held.release()
      expect((await pool.query("select 1 as served")).rows).toEqual([{ served: 1 }])
      expect(log.mock.calls).toEqual(Array(2).fill(["[mcp-platform] database connection lost", { name: "Error" }]))
    }
  } finally {
    log.mockRestore()
    await mcps.close()
    sharedCutter.close()
    ownCutter.close()
  }
})
