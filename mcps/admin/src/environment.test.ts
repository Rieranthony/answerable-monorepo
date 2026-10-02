import { expect, test } from "bun:test"
import { readAdminEnvironment } from "./environment"

const complete = {
  ADMIN_ID_ISSUER: "http://localhost:47300",
  ADMIN_RESOURCE_URL: "http://localhost:47520/mcp",
  ADMIN_DATABASE_URL: "postgres://answerable:answerable@localhost:47432/answerable_admin",
  ADMIN_ID_CLIENT_ID: "admin-mcp",
  ADMIN_ID_CLIENT_SECRET: "secret",
  ADMIN_ID_ADMIN_RESOURCE: "http://localhost:47300/api/admin",
}

test("reads ID, the resource, the database and the machine client, defaulting the port to 47520 and leaving the freshness window to createAdminMcp", () => {
  expect(readAdminEnvironment(complete)).toEqual({
    auth: { issuer: "http://localhost:47300", resource: "http://localhost:47520/mcp" },
    port: 47520,
    databaseUrl: complete.ADMIN_DATABASE_URL,
    id: { issuer: "http://localhost:47300", adminResource: "http://localhost:47300/api/admin", clientId: "admin-mcp", clientSecret: "secret" },
    toolboxAdminResource: undefined,
    freshSeconds: undefined,
  })
  expect(readAdminEnvironment({ ...complete, ADMIN_PORT: "47521", ADMIN_TOOLBOX_ADMIN_RESOURCE: "http://localhost:47400/admin", ADMIN_FRESH_SECONDS: "600" }))
    .toMatchObject({ port: 47521, toolboxAdminResource: "http://localhost:47400/admin", freshSeconds: 600 })
})

test("names the variable that is missing or invalid", () => {
  for (const name of Object.keys(complete)) {
    expect(() => readAdminEnvironment({ ...complete, [name]: undefined })).toThrow(`Invalid admin MCP configuration: ${name}: `)
  }
  expect(() => readAdminEnvironment({ ...complete, ADMIN_PORT: "0" })).toThrow("ADMIN_PORT")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_FRESH_SECONDS: "0" })).toThrow("ADMIN_FRESH_SECONDS")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_TOOLBOX_ADMIN_RESOURCE: "not a url" })).toThrow("ADMIN_TOOLBOX_ADMIN_RESOURCE")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_RESOURCE_URL: "http://admin.example/mcp" })).toThrow("Invalid admin MCP configuration: ADMIN_RESOURCE_URL: resource must use HTTPS or loopback HTTP")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_ID_ISSUER: "http://id.example" })).toThrow("Invalid admin MCP configuration: ADMIN_ID_ISSUER: issuer must use HTTPS or loopback HTTP")
})
