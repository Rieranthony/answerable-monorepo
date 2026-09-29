import { expect, test } from "bun:test"
import { readToolboxEnvironment } from "./environment"

const complete = {
  TOOLBOX_DATABASE_URL: "postgres://answerable:answerable@localhost:47432/answerable_toolbox",
  TOOLBOX_ID_ISSUER: "http://localhost:47300",
  TOOLBOX_RESOURCE_URL: "http://localhost:47400/mcp",
  TOOLBOX_ID_CLIENT_ID: "toolbox-hub",
  TOOLBOX_ID_CLIENT_SECRET: "secret",
  TOOLBOX_ID_ADMIN_RESOURCE: "http://localhost:47300/api/admin",
}

test("reads the database, ID, the resource, the port and the machine client, defaulting the port to 47400", () => {
  expect(readToolboxEnvironment(complete)).toEqual({
    databaseUrl: complete.TOOLBOX_DATABASE_URL,
    auth: { issuer: "http://localhost:47300", resource: "http://localhost:47400/mcp" },
    port: 47400,
    id: { issuer: "http://localhost:47300", adminResource: "http://localhost:47300/api/admin", clientId: "toolbox-hub", clientSecret: "secret" },
    otlpEndpoint: undefined,
  })
  expect(readToolboxEnvironment({ ...complete, TOOLBOX_PORT: "47401", OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toMatchObject({ port: 47401, otlpEndpoint: "http://localhost:4318" })
})

test("names the variable that is missing or invalid", () => {
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_ID_CLIENT_SECRET: undefined })).toThrow("Invalid Toolbox configuration: TOOLBOX_ID_CLIENT_SECRET: ")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_PORT: "0" })).toThrow("TOOLBOX_PORT")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_RESOURCE_URL: "http://toolbox.example/mcp" })).toThrow("Invalid Toolbox configuration: TOOLBOX_RESOURCE_URL: resource must use HTTPS or loopback HTTP")
  expect(() => readToolboxEnvironment({ ...complete, TOOLBOX_ID_ISSUER: "http://id.example" })).toThrow("Invalid Toolbox configuration: TOOLBOX_ID_ISSUER: issuer must use HTTPS or loopback HTTP")
})
