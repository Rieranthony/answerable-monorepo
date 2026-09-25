import { expect, test } from "bun:test"
import { readMcpEnvironment } from "./index"

const env = { MCP_ID_ISSUER: "http://localhost:47300", MCP_RESOURCE_URL: "http://127.0.0.1:47500/mcp" }
test("parses only issuer, resource and port, with loopback HTTP allowed", () => {
  expect(readMcpEnvironment({ ...env, MCP_RECORDS_PATH: "ignored" })).toEqual({ auth: { issuer: env.MCP_ID_ISSUER, resource: env.MCP_RESOURCE_URL }, port: 47500 })
  expect(readMcpEnvironment({ ...env, MCP_PORT: "65535" }).port).toBe(65535)
})
test("reports missing and invalid variable names", () => {
  expect(() => readMcpEnvironment({})).toThrow("Invalid MCP configuration: MCP_ID_ISSUER:")
  expect(() => readMcpEnvironment({})).toThrow("MCP_RESOURCE_URL")
  for (const value of ["0", "65536", "abc", "1.5", ""]) expect(() => readMcpEnvironment({ ...env, MCP_PORT: value })).toThrow("MCP_PORT")
  expect(() => readMcpEnvironment({ ...env, MCP_ID_ISSUER: "http://evil.test" })).toThrow("Invalid MCP configuration: MCP_ID_ISSUER:")
  expect(() => readMcpEnvironment({ ...env, MCP_RESOURCE_URL: "https://mcp.test#fragment" })).toThrow("Invalid MCP configuration: MCP_RESOURCE_URL:")
})
