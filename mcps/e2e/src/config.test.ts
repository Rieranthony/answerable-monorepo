import { expect, test } from "bun:test"
import { readConfig } from "./config"

const valid = {
  MCP_ID_ISSUER: "http://localhost:47300", MCP_ID_JWKS_URL: "http://localhost:47300/auth/jwks",
  MCP_RESOURCE_URL: "http://localhost:47500/mcp", MCP_RESOURCE_INSTANCE_ID: crypto.randomUUID(),
  MCP_RECORDS_PATH: "/tmp/fixture.sqlite", MCP_ALLOW_LOCAL_HTTP: "true",
}
test("missing required configuration identifies the missing variable", () => {
  expect(() => readConfig({})).toThrow("MCP_ID_ISSUER")
})
test("configuration uses explicit local HTTP opt-in and a valid port", () => {
  expect(readConfig(valid)).toMatchObject({ port: 47500, auth: { allowLocalHttp: true } })
  expect(() => readConfig({ ...valid, MCP_PORT: "abc" })).toThrow("MCP_PORT")
  expect(() => readConfig({ ...valid, MCP_ALLOW_LOCAL_HTTP: "false" })).toThrow()
})
