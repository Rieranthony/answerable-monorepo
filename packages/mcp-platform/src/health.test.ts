import { expect, test } from "bun:test"
import { mcpPostgresTestConfig } from "@answerable/mcp-postgres/testing"
import { Pool } from "pg"
import { health } from "./health"

const url = mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL
const answer = async (response: Response) => [response.status, await response.json()]

test("health is ready while the server's own database answers, and reports each MCP database without failing on it", async () => {
  const up = new Pool({ connectionString: url, max: 1 })
  const down = new Pool({ connectionString: "postgres://nobody:nothing@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 1_000 })
  try {
    expect(await answer(await health({ toolbox: up }, ["e2e", "example"], { mcps: up })())).toEqual([200, { status: "ok", databases: { toolbox: "ok", mcps: "ok" }, providers: ["e2e", "example"] }])
    expect(await answer(await health({ toolbox: up }, ["e2e"], { mcps: down })())).toEqual([200, { status: "ok", databases: { toolbox: "ok", mcps: "unavailable" }, providers: ["e2e"] }])
    expect(await answer(await health({ toolbox: down }, ["e2e"], { mcps: up })())).toEqual([503, { status: "unavailable", databases: { toolbox: "unavailable", mcps: "ok" }, providers: ["e2e"] }])
  } finally {
    await Promise.all([up.end(), down.end()])
  }
})

test("a saturated MCP pool leaves health ready within Kubernetes' one-second probe, reported as unavailable", async () => {
  const own = new Pool({ connectionString: url, max: 1 })
  const saturated = new Pool({ connectionString: url, max: 1 })
  // The pool's one connection is held by a slow query, so a check of it would queue behind it.
  const held = saturated.query("select pg_sleep(2)")
  try {
    const started = performance.now()
    expect(await answer(await health({ toolbox: own }, [], { mcps: saturated })())).toEqual([200, { status: "ok", databases: { toolbox: "ok", mcps: "unavailable" }, providers: [] }])
    expect(performance.now() - started).toBeLessThan(1_000)
  } finally {
    await held
    await Promise.all([own.end(), saturated.end()])
  }
})
