import { expect, test } from "bun:test"
import type { Config } from "@answerable/config"
import { idConfig } from "../../apps/id/src/config"
import { mcpCliConfig } from "./config"

const rootSecret = (config: Pick<Config<Record<string, never>>, "fields">) => config.fields.find(field => field.name === "ROOT_ADMIN_SECRET")

test("the root secret bun mcp setup uses while ID's root is unlocked defaults to the one ID starts with locally, as its own definition says", () => {
  expect(rootSecret(mcpCliConfig)).toMatchObject({ secret: true, defaults: rootSecret(idConfig)!.defaults })
  expect(mcpCliConfig.read({}).ROOT_ADMIN_SECRET).toBe(idConfig.read({}).ROOT_ADMIN_SECRET as string)
})

test("the machine client has no default, the organisation is the platform's, and an organisation that is not a slug is refused naming the variable", () => {
  expect(mcpCliConfig.read({})).toMatchObject({ MCP_DEV_ID_CLIENT_ID: undefined, MCP_DEV_ID_CLIENT_SECRET: undefined, MCP_DEV_ORGANISATION: "answerable" })
  expect(() => mcpCliConfig.read({ MCP_DEV_ORGANISATION: "Not A Slug" })).toThrow("MCP_DEV_ORGANISATION")
})
