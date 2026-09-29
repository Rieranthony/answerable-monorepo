import { expect, test } from "bun:test"
import { renderReference } from "../scripts/reference"

const file = Bun.file(new URL("../../../apps/web/content/docs/mcp/reference.mdx", import.meta.url))
const generated = renderReference()

test("reference.mdx is what the documentation comments generate", async () => {
  expect(await file.text(), "apps/web/content/docs/mcp/reference.mdx is out of date; run bun run --filter @answerable/mcp reference").toBe(generated)
})

test("every export has its section, and the functions authors start from have an example", () => {
  const section = (name: string) => generated.split(/^### /m).find(part => part.startsWith(`${name}\n`)) ?? ""
  for (const name of ["defineTool", "defineMutation", "defineProvider", "createMcpServer", "createTestMcp", "assertProviderConformance", "createIdVerifier"]) {
    expect(section(name), name).toContain("**Example**")
  }
  for (const name of ["ToolError", "manifest", "ConformanceFixture", "buildView", "createTestIssuer", "AuthenticationError"]) expect(section(name), name).not.toBe("")
  expect(section("UserPrincipal")).not.toBe("")
})
