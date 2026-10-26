import { expect, test } from "bun:test"
import { ownMcpDatabase } from "@answerable/mcp-postgres"
import { readStandaloneEnvironment } from "./environment"
import { served } from "./served.generated"

// Each own MCP the generated list names, so that a new MCP needs no edit here: the variable a deployment sets, and its local default.
const own = served.flatMap(entry => entry.database === "own" ? [entry] : [])
const ownSet: Record<string, string> = Object.fromEntries(own.map(entry => [entry.variable, `postgres://${entry.provider.id}:secret@db.example.test:5432/answerable_mcp_${entry.provider.id}`]))
const ownLocal = Object.fromEntries(own.map(entry => {
  const { database, runtime } = ownMcpDatabase(entry.provider.id)
  return [entry.variable, `postgres://${runtime}:answerable@localhost:47432/${database}`]
}))

const complete = {
  STANDALONE_ORIGIN: "https://mcp.example.test",
  STANDALONE_ID_ISSUER: "https://id.example.test",
  STANDALONE_DATABASE_URL: "postgres://runtime:secret@db.example.test:5432/answerable_standalone",
  STANDALONE_MCPS_DATABASE_URL: "postgres://serving:secret@db.example.test:5432/answerable_mcps",
  STANDALONE_ID_CLIENT_ID: "standalone-hub",
  STANDALONE_ID_CLIENT_SECRET: "secret",
  STANDALONE_ID_ADMIN_RESOURCE: "https://id.example.test/api/admin",
  ...ownSet,
}

test("reads the origin, ID, both databases and the machine client, defaulting to 127.0.0.1, 47510 and the role prefix mcp", () => {
  expect(readStandaloneEnvironment({ ...complete, NODE_ENV: "production" })).toEqual({
    origin: complete.STANDALONE_ORIGIN,
    issuer: complete.STANDALONE_ID_ISSUER,
    databaseUrl: complete.STANDALONE_DATABASE_URL,
    mcps: { shared: complete.STANDALONE_MCPS_DATABASE_URL, own: ownSet, prefix: "mcp" },
    hostname: "127.0.0.1",
    port: 47510,
    id: { issuer: complete.STANDALONE_ID_ISSUER, adminResource: complete.STANDALONE_ID_ADMIN_RESOURCE, clientId: "standalone-hub", clientSecret: "secret" },
    otlpEndpoint: undefined,
  })
  expect(readStandaloneEnvironment({ ...complete, STANDALONE_HOST: "0.0.0.0", STANDALONE_PORT: "47511", STANDALONE_MCPS_ROLE_PREFIX: "mcp_test", OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }))
    .toMatchObject({ hostname: "0.0.0.0", port: 47511, mcps: { prefix: "mcp_test" }, otlpEndpoint: "http://localhost:4318" })
})

test("outside production, everything but the client pair defaults to the local services", () => {
  for (const NODE_ENV of [undefined, "development", "test"])
    expect(readStandaloneEnvironment({ NODE_ENV, STANDALONE_ID_CLIENT_ID: "standalone-hub", STANDALONE_ID_CLIENT_SECRET: "secret" })).toMatchObject({
      origin: "http://localhost:47510",
      issuer: "http://localhost:47300",
      databaseUrl: "postgres://answerable_standalone_runtime:answerable@localhost:47432/answerable_standalone",
      mcps: { shared: "postgres://answerable_mcps_standalone:answerable@localhost:47432/answerable_mcps", own: ownLocal, prefix: "mcp" },
      id: { adminResource: "http://localhost:47300/api/admin" },
    })
  expect(() => readStandaloneEnvironment({})).toThrow("Invalid standalone server configuration: STANDALONE_ID_CLIENT_ID: ")
})

test("production requires every variable without a fallback, refuses the local logins, and names what is invalid", () => {
  const production = { ...complete, NODE_ENV: "production" }
  for (const name of Object.keys(complete)) expect(() => readStandaloneEnvironment({ ...production, [name]: undefined })).toThrow(`Invalid standalone server configuration: ${name}: `)
  expect(() => readStandaloneEnvironment({ ...production, STANDALONE_MCPS_DATABASE_URL: "postgres://answerable_mcps_standalone:answerable@localhost:47432/answerable_mcps" }))
    .toThrow("Invalid standalone server configuration: STANDALONE_MCPS_DATABASE_URL: a development default")
  expect(() => readStandaloneEnvironment({ ...complete, STANDALONE_ORIGIN: "http://mcp.example.test" })).toThrow("Invalid standalone server configuration: STANDALONE_ORIGIN: resource must use HTTPS or loopback HTTP")
  expect(() => readStandaloneEnvironment({ ...complete, STANDALONE_MCPS_ROLE_PREFIX: "Mcp" })).toThrow("STANDALONE_MCPS_ROLE_PREFIX")
  expect(() => readStandaloneEnvironment({ ...complete, STANDALONE_PORT: "0" })).toThrow("STANDALONE_PORT")
})
