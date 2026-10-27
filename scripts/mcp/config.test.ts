import { expect, test } from "bun:test"
import { idConfig } from "../../apps/id/src/config"
import { mcpCliConfig } from "./config"

test("the root secret bun mcp setup uses while ID's root is unlocked is the one ID starts with locally, and a secret", () => {
  expect(mcpCliConfig.read({}).ROOT_ADMIN_SECRET).toBe(idConfig.read({}).ROOT_ADMIN_SECRET as string)
  expect(mcpCliConfig.read({ NODE_ENV: "test" }).ROOT_ADMIN_SECRET).toBe(idConfig.read({ NODE_ENV: "test" }).ROOT_ADMIN_SECRET as string)
  expect(mcpCliConfig.fields.find(field => field.name === "ROOT_ADMIN_SECRET")!.secret).toBe(true)
})

test("the machine client has no default, the organisation is the platform's, and an organisation that is not a slug is refused naming the variable", () => {
  expect(mcpCliConfig.read({})).toMatchObject({ MCP_DEV_ID_CLIENT_ID: undefined, MCP_DEV_ID_CLIENT_SECRET: undefined, MCP_DEV_ORGANISATION: "answerable" })
  expect(() => mcpCliConfig.read({ MCP_DEV_ORGANISATION: "Not A Slug" })).toThrow("MCP_DEV_ORGANISATION")
})
