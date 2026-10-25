import { expect, test } from "bun:test"
import { readMcpEnvironment } from "./index"

const env = { MCP_ID_ISSUER: "http://localhost:47300", MCP_RESOURCE_URL: "http://127.0.0.1:47500/mcp" }
const client = { MCP_ID_CLIENT_ID: "e2e-mcp", MCP_ID_CLIENT_SECRET: "e2e-secret" }
test("parses only issuer, resource and port, with loopback HTTP allowed", () => {
  expect(readMcpEnvironment({ ...env, MCP_RECORDS_PATH: "ignored" })).toEqual({ auth: { issuer: env.MCP_ID_ISSUER, resource: env.MCP_RESOURCE_URL }, port: 47500, id: undefined })
  expect(readMcpEnvironment({ ...env, MCP_PORT: "65535" }).port).toBe(65535)
})
test("outside production, the issuer and the resource default to the local ID and the e2e server", () => {
  for (const NODE_ENV of [undefined, "development", "test"])
    expect(readMcpEnvironment({ NODE_ENV })).toEqual({ auth: { issuer: "http://localhost:47300", resource: "http://localhost:47500/mcp" }, port: 47500, id: undefined })
})
test("a machine client gives the id createIdAdmin takes, with the local admin resource outside production", () => {
  expect(readMcpEnvironment({ ...env, ...client }).id).toEqual({ issuer: env.MCP_ID_ISSUER, adminResource: "http://localhost:47300/api/admin", clientId: "e2e-mcp", clientSecret: "e2e-secret" })
  const production = { ...env, ...client, NODE_ENV: "production", MCP_ID_ADMIN_RESOURCE: "https://id.test/api/admin" }
  expect(readMcpEnvironment(production).id).toMatchObject({ adminResource: "https://id.test/api/admin" })
})
test("reports missing and invalid variable names", () => {
  expect(() => readMcpEnvironment({ NODE_ENV: "production" })).toThrow("Invalid MCP configuration: MCP_ID_ISSUER:")
  expect(() => readMcpEnvironment({ NODE_ENV: "production" })).toThrow("MCP_RESOURCE_URL")
  for (const value of ["0", "65536", "abc", "1.5", ""]) expect(() => readMcpEnvironment({ ...env, MCP_PORT: value })).toThrow("MCP_PORT")
  expect(() => readMcpEnvironment({ ...env, MCP_ID_ISSUER: "http://evil.test" })).toThrow("Invalid MCP configuration: MCP_ID_ISSUER:")
  expect(() => readMcpEnvironment({ ...env, MCP_RESOURCE_URL: "https://mcp.test#fragment" })).toThrow("Invalid MCP configuration: MCP_RESOURCE_URL:")
  expect(() => readMcpEnvironment({ ...env, MCP_ID_CLIENT_ID: "e2e-mcp" })).toThrow("Invalid MCP configuration: MCP_ID_CLIENT_SECRET: set it with MCP_ID_CLIENT_ID")
  expect(() => readMcpEnvironment({ ...env, ...client, NODE_ENV: "production" })).toThrow("Invalid MCP configuration: MCP_ID_ADMIN_RESOURCE: set it with MCP_ID_CLIENT_ID")
})
