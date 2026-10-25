import { expect, test } from "bun:test"
import { defineConfig } from "@answerable/config"
import { ownDatabases } from "./configuration"
import { pltfix } from "./test/fixtures/pltfix-provider"

test("an own MCP's database URL is a secret field of the server's configuration, from its variable, with the local database by default", () => {
  const own = ownDatabases([{ provider: pltfix, database: "own", variable: "TOOLBOX_MCP_PLTFIX_DATABASE_URL" }, { provider: { ...pltfix, id: "other" }, database: "shared" }])
  expect(Object.keys(own.fields)).toEqual(["TOOLBOX_MCP_PLTFIX_DATABASE_URL"])
  const config = defineConfig("Fixture", own.fields)
  expect(own.urls(config.read({ NODE_ENV: "test" }))).toEqual({ TOOLBOX_MCP_PLTFIX_DATABASE_URL: "postgres://answerable_mcp_pltfix_runtime:answerable@localhost:47432/answerable_mcp_pltfix" })
  expect(() => config.read({ NODE_ENV: "production" })).toThrow("Invalid Fixture configuration: TOOLBOX_MCP_PLTFIX_DATABASE_URL: ")
  expect(config.fields.find(field => field.name === "TOOLBOX_MCP_PLTFIX_DATABASE_URL")).toMatchObject({ secret: true, source: "cluster", doc: "The database of the pltfix MCP, its own, as its runtime login" })
  expect(ownDatabases([]).fields).toEqual({})
})
