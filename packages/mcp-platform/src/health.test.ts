import { expect, test } from "bun:test"
import { mcpPostgresTestConfig } from "@answerable/mcp-postgres/testing"
import { Pool } from "pg"
import { health } from "./health"

test("health checks every database by name and lists the providers: 200 when all answer, 503 naming the one that does not", async () => {
  const up = new Pool({ connectionString: mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL, max: 1 })
  const down = new Pool({ connectionString: "postgres://nobody:nothing@127.0.0.1:1/none", max: 1, connectionTimeoutMillis: 1_000 })
  try {
    const ok = await health({ toolbox: up, mcps: up }, ["e2e", "example"])()
    expect([ok.status, await ok.json()]).toEqual([200, { status: "ok", databases: { toolbox: "ok", mcps: "ok" }, providers: ["e2e", "example"] }])
    const unavailable = await health({ toolbox: up, mcps: down }, ["e2e"])()
    expect([unavailable.status, await unavailable.json()]).toEqual([503, { status: "unavailable", databases: { toolbox: "ok", mcps: "unavailable" }, providers: ["e2e"] }])
  } finally {
    await Promise.all([up.end(), down.end()])
  }
})
