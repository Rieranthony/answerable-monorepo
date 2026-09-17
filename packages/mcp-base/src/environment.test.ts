import { expect, test } from "bun:test"
import { readMcpEnvironment } from "./index"

test("shared environment parsing reports variable names and requires explicit local HTTP", () => {
  expect(() => readMcpEnvironment({})).toThrow("MCP_ID_ISSUER")
  const env = {
    MCP_ID_ISSUER: "http://localhost:47300", MCP_ID_JWKS_URL: "http://localhost:47300/auth/jwks",
    MCP_RESOURCE_URL: "http://localhost:47500/mcp", MCP_RESOURCE_INSTANCE_ID: crypto.randomUUID(),
    MCP_ALLOW_LOCAL_HTTP: "true",
  }
  expect(readMcpEnvironment(env)).toMatchObject({ port: 47500, auth: { allowLocalHttp: true } })
  expect(() => readMcpEnvironment({ ...env, MCP_PORT: "abc" })).toThrow("MCP_PORT")
  expect(() => readMcpEnvironment({ ...env, MCP_ALLOW_LOCAL_HTTP: "false" })).toThrow()
})
