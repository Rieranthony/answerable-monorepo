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

test("reads ID, the resource, the database and the machine client, defaulting the bind address to 127.0.0.1, the port to 47520 and leaving the freshness window to createAdminMcp", () => {
  expect(readAdminEnvironment({ ...complete, NODE_ENV: "production" })).toEqual({
    auth: { issuer: "http://localhost:47300", resource: "http://localhost:47520/mcp" },
    hostname: "127.0.0.1",
    port: 47520,
    databaseUrl: complete.ADMIN_DATABASE_URL,
    id: { issuer: "http://localhost:47300", adminResource: "http://localhost:47300/api/admin", clientId: "admin-mcp", clientSecret: "secret" },
    toolboxAdminResource: undefined,
    standaloneOrigin: undefined,
    freshSeconds: undefined,
  })
  expect(readAdminEnvironment({ ...complete, ADMIN_PORT: "47521", ADMIN_TOOLBOX_ADMIN_RESOURCE: "http://localhost:47400/admin", ADMIN_STANDALONE_ORIGIN: "https://mcp.example/", ADMIN_FRESH_SECONDS: "600" }))
    .toMatchObject({ port: 47521, toolboxAdminResource: "http://localhost:47400/admin", standaloneOrigin: "https://mcp.example", freshSeconds: 600 })
  expect(readAdminEnvironment({ ...complete, ADMIN_HOST: "0.0.0.0" })).toMatchObject({ hostname: "0.0.0.0" })
  expect(readAdminEnvironment({ ...complete, ADMIN_HOST: "::" })).toMatchObject({ hostname: "::" })
})

test("outside production, everything but the client pair defaults to the local services", () => {
  for (const NODE_ENV of [undefined, "development", "test"])
    expect(readAdminEnvironment({ NODE_ENV, ADMIN_ID_CLIENT_ID: "admin-mcp", ADMIN_ID_CLIENT_SECRET: "secret" })).toEqual({
      auth: { issuer: "http://localhost:47300", resource: "http://localhost:47520/mcp" },
      hostname: "127.0.0.1",
      port: 47520,
      databaseUrl: "postgres://answerable_admin_runtime:answerable@localhost:47432/answerable_admin",
      id: { issuer: "http://localhost:47300", adminResource: "http://localhost:47300/api/admin", clientId: "admin-mcp", clientSecret: "secret" },
      toolboxAdminResource: "http://localhost:47400/admin",
      standaloneOrigin: "http://localhost:47510",
      freshSeconds: undefined,
    })
  expect(() => readAdminEnvironment({})).toThrow("Invalid admin MCP configuration: ADMIN_ID_CLIENT_ID: ")
})

test("production requires every variable without a fallback, and refuses the local database login", () => {
  const production = { ...complete, NODE_ENV: "production" }
  expect(readAdminEnvironment(production)).toMatchObject({ port: 47520, toolboxAdminResource: undefined })
  for (const name of Object.keys(complete))
    expect(() => readAdminEnvironment({ ...production, [name]: undefined })).toThrow(`Invalid admin MCP configuration: ${name}: `)
  expect(() => readAdminEnvironment({ ...production, ADMIN_DATABASE_URL: "postgres://answerable_admin_runtime:answerable@localhost:47432/answerable_admin" }))
    .toThrow("Invalid admin MCP configuration: ADMIN_DATABASE_URL: a development default")
})

test("names the variable that is missing or invalid", () => {
  expect(() => readAdminEnvironment({ ...complete, ADMIN_ID_CLIENT_SECRET: undefined })).toThrow("Invalid admin MCP configuration: ADMIN_ID_CLIENT_SECRET: ")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_PORT: "0" })).toThrow("ADMIN_PORT")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_HOST: "admin.example" })).toThrow("Invalid admin MCP configuration: ADMIN_HOST: ")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_FRESH_SECONDS: "0" })).toThrow("ADMIN_FRESH_SECONDS")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_TOOLBOX_ADMIN_RESOURCE: "not a url" })).toThrow("ADMIN_TOOLBOX_ADMIN_RESOURCE")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_STANDALONE_ORIGIN: "not a url" })).toThrow("ADMIN_STANDALONE_ORIGIN")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_RESOURCE_URL: "http://admin.example/mcp" })).toThrow("Invalid admin MCP configuration: ADMIN_RESOURCE_URL: resource must use HTTPS or loopback HTTP")
  expect(() => readAdminEnvironment({ ...complete, ADMIN_ID_ISSUER: "http://id.example" })).toThrow("Invalid admin MCP configuration: ADMIN_ID_ISSUER: issuer must use HTTPS or loopback HTTP")
})
