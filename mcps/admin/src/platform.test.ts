import { expect, test } from "bun:test"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { readPlatform } from "./platform"

test("the platform organisation is the machine client's own organisation, which ID marks as the platform", async () => {
  const id = createFakeId({ clientId: "admin-mcp" })
  expect(await readPlatform(createIdAdmin(id.config))).toBe(id.organizationId)
  expect(id.requests).toContain("GET /api/admin/v1/me")
})

test("a machine client of another organisation is refused, saying what to fix", async () => {
  const id = createFakeId({ clientId: "admin-mcp", platform: false })
  await expect(readPlatform(createIdAdmin(id.config))).rejects.toThrow(
    `The machine client admin-mcp belongs to organisation ${id.organizationId}, which is not the platform organisation; register ADMIN_ID_CLIENT_ID in the platform organisation`,
  )
})
