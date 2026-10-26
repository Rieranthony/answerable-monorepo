import { expect, test } from "bun:test"
import { ownMcpDatabase } from "@answerable/mcp-postgres"
import { readToolboxEnvironment } from "./environment"
import { mounted } from "./mounted.generated"

// Each own MCP the generated list names, so that a new MCP needs no edit here: the variable a deployment sets, and its local default.
const own = mounted.flatMap(entry => entry.database === "own" ? [entry] : [])
const ownSet: Record<string, string> = Object.fromEntries(own.map(entry => [entry.variable, `postgres://${entry.provider.id}:secret@localhost:47432/answerable_mcp_${entry.provider.id}`]))
const ownLocal = Object.fromEntries(own.map(entry => {
  const { database, runtime } = ownMcpDatabase(entry.provider.id)
  return [entry.variable, `postgres://${runtime}:answerable@localhost:47432/${database}`]
}))

const complete = {
  TOOLBOX_DATABASE_URL: "postgres://answerable:answerable@localhost:47432/answerable_toolbox",
  TOOLBOX_MCPS_DATABASE_URL: "postgres://toolbox:secret@localhost:47432/answerable_mcps",
  TOOLBOX_ID_ISSUER: "http://localhost:47300",
  TOOLBOX_RESOURCE_URL: "http://localhost:47400/mcp",
  TOOLBOX_ID_CLIENT_ID: "toolbox-hub",
  TOOLBOX_ID_CLIENT_SECRET: "secret",
  TOOLBOX_ID_ADMIN_RESOURCE: "http://localhost:47300/api/admin",
  ...ownSet,
}

test("reads the databases, ID, the resource, the bind address, the port and the machine client, defaulting to 127.0.0.1, 47400 and the role prefix mcp", () => {
  expect(readToolboxEnvironment(complete)).toEqual({
    databaseUrl: complete.TOOLBOX_DATABASE_URL,
    mcps: { shared: complete.TOOLBOX_MCPS_DATABASE_URL, own: ownSet, prefix: "mcp" },
    auth: { issuer: "http://localhost:47300", resource: "http://localhost:47400/mcp" },
    hostname: "127.0.0.1",
    port: 47400,
    id: { issuer: "http://localhost:47300", adminResource: "http://localhost:47300/api/admin", clientId: "toolbox-hub", clientSecret: "secret" },
    otlpEndpoint: undefined,
  })
  expect(readToolboxEnvironment({ ...complete, TOOLBOX_PORT: "47401", OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toMatchObject({ port: 47401, otlpEndpoint: "http://localhost:4318" })
  expect(readToolboxEnvironment({ ...complete, TOOLBOX_HOST: "0.0.0.0" })).toMatchObject({ hostname: "0.0.0.0" })
  expect(readToolboxEnvironment({ ...complete, TOOLBOX_HOST: "::" })).toMatchObject({ hostname: "::" })
  expect(readToolboxEnvironment({ ...complete, TOOLBOX_MCPS_ROLE_PREFIX: "mcp_tbx" }).mcps.prefix).toBe("mcp_tbx")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_MCPS_ROLE_PREFIX: "MCP" })).toThrow("Invalid Toolbox configuration: TOOLBOX_MCPS_ROLE_PREFIX: ")
})

test("outside production, everything but the client pair defaults to the local services", () => {
  for (const NODE_ENV of [undefined, "development", "test"])
    expect(readToolboxEnvironment({ NODE_ENV, TOOLBOX_ID_CLIENT_ID: "toolbox-hub", TOOLBOX_ID_CLIENT_SECRET: "secret" })).toEqual({
      databaseUrl: "postgres://answerable_toolbox_runtime:answerable@localhost:47432/answerable_toolbox",
      mcps: { shared: "postgres://answerable_mcps_toolbox:answerable@localhost:47432/answerable_mcps", own: ownLocal, prefix: "mcp" },
      auth: { issuer: "http://localhost:47300", resource: "http://localhost:47400/mcp" },
      hostname: "127.0.0.1",
      port: 47400,
      id: { issuer: "http://localhost:47300", adminResource: "http://localhost:47300/api/admin", clientId: "toolbox-hub", clientSecret: "secret" },
      otlpEndpoint: undefined,
    })
  expect(() => readToolboxEnvironment({})).toThrow("Invalid Toolbox configuration: TOOLBOX_ID_CLIENT_ID: ")
})

test("production requires every variable without a fallback, and refuses the local database login", () => {
  const production = { ...complete, NODE_ENV: "production" }
  expect(readToolboxEnvironment(production).port).toBe(47400)
  for (const name of Object.keys(complete))
    expect(() => readToolboxEnvironment({ ...production, [name]: undefined })).toThrow(`Invalid Toolbox configuration: ${name}: `)
  expect(() => readToolboxEnvironment({ ...production, TOOLBOX_DATABASE_URL: "postgres://answerable_toolbox_runtime:answerable@localhost:47432/answerable_toolbox" }))
    .toThrow("Invalid Toolbox configuration: TOOLBOX_DATABASE_URL: a development default")
})

test("names the variable that is missing or invalid", () => {
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_ID_CLIENT_SECRET: undefined })).toThrow("Invalid Toolbox configuration: TOOLBOX_ID_CLIENT_SECRET: ")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_PORT: "0" })).toThrow("TOOLBOX_PORT")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_HOST: "toolbox.example" })).toThrow("Invalid Toolbox configuration: TOOLBOX_HOST: ")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_RESOURCE_URL: "http://toolbox.example/mcp" })).toThrow("Invalid Toolbox configuration: TOOLBOX_RESOURCE_URL: resource must use HTTPS or loopback HTTP")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_ID_ISSUER: "http://id.example" })).toThrow("Invalid Toolbox configuration: TOOLBOX_ID_ISSUER: issuer must use HTTPS or loopback HTTP")
})
