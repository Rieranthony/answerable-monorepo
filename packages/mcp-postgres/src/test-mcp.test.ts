import { afterAll, expect, test } from "bun:test"
import { checkProviderId, createMcpServer, defineProvider } from "@answerable/mcp"
import { eq } from "drizzle-orm"
import { Pool } from "pg"
import { assertMcpName } from "./names"
import { projects } from "./test/fixtures/mpgfixa"
import { provider } from "./test/fixtures/mpgfixa-provider"
import { forget, mcpsUrl } from "./test/mcps"
import { assertProviderConformance, createTestMcp } from "./testing"

const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
afterAll(async () => {
  // The helpers never drop an MCP's roles; this suite's fixture is its own to remove.
  await forget(admin, "mpgfixa")
  await admin.end()
})

//#region conformance
assertProviderConformance(provider, {
  manifest: new URL("test/fixtures/mpgfixa-manifest.json", import.meta.url),
  // A rename needs a project to rename, made as the caller's organisation; moving its target renames it outside the MCP.
  examples: {
    "projects.rename": async ({ organizationId }, { db, asOrganisation }) => {
      const [project] = await asOrganisation(organizationId, () => db.insert(projects).values({ organisation_id: organizationId, name: "Tower" }).returning())
      return { id: project!.id, name: "Spire" }
    },
  },
  moveTarget: ({ resource_id }, { organizationId }, { db, asOrganisation }) => asOrganisation(organizationId, () => db.update(projects).set({ name: "Moved" }).where(eq(projects.id, resource_id))),
})
//#endregion

type Intent = { intent_id: string; commit_token: string; commit_tool: string }

//#region isolation
test("a provider with a database gets a working typed db, and each organisation connected sees only its own rows", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const [acme, other] = [await mcp.connect({ organizationId: crypto.randomUUID() }), await mcp.connect({ organizationId: crypto.randomUUID() })]
    for (const [client, name] of [[acme, "Tower"], [acme, "Bridge"], [other, "Harbour"]] as const) {
      const { intent_id, commit_token, commit_tool } = (await client.callTool({ name: "projects_add", arguments: { name } })).structuredContent as Intent
      expect((await client.callTool({ name: commit_tool, arguments: { intent_id, commit_token } })).structuredContent).toMatchObject({ status: "committed", results: { id: expect.any(String) } })
    }
    expect((await acme.callTool({ name: "projects_list", arguments: {} })).structuredContent).toEqual({ names: ["Bridge", "Tower"] })
    expect((await other.callTool({ name: "projects_list", arguments: {} })).structuredContent).toEqual({ names: ["Harbour"] })
  } finally {
    await mcp.close()
  }
})
//#endregion

test("a test seeds and reads rows as an organisation through the provider's db, and builds its own server with the provider and db", async () => {
  const [acme, other] = [crypto.randomUUID(), crypto.randomUUID()]
  const mcp = await createTestMcp(provider, { server: serving => createMcpServer({ ...serving, policyClass: () => "agent" }) })
  try {
    await mcp.asOrganisation(acme, () => mcp.db.insert(projects).values({ organisation_id: acme, name: "Seeded" }))
    const client = await mcp.connect({ organizationId: acme })
    expect((await client.callTool({ name: "projects_list", arguments: {} })).structuredContent).toEqual({ names: ["Seeded"] })
    const { commit_tool } = (await client.callTool({ name: "projects_add", arguments: { name: "Agent" } })).structuredContent as Intent
    expect(commit_tool).toBe("mpgfixa_commit")
    expect(await mcp.asOrganisation(other, () => mcp.db.select().from(projects))).toEqual([])
  } finally {
    await mcp.close()
  }
})

test("the wrappers refuse a provider without a database, pointing at the SDK's", async () => {
  const plain = defineProvider({ id: "mpgplain", description: "A fixture provider with no database, which the wrappers refuse.", version: "2026-10-25", tools: [] })
  await expect(createTestMcp(plain)).rejects.toThrow("Provider mpgplain has no database; import createTestMcp and assertProviderConformance from @answerable/mcp/testing")
})

test("the MCP name rule agrees with the SDK's provider id rule, for valid and invalid names, with the same message", () => {
  for (const name of ["acme", "a", "e2e", "abcdefghijkl", "Acme", "acme-co", "acme_co", "1acme", "", "abcdefghijklm", "ac me"]) {
    const refusal = checkProviderId(name)
    if (refusal === undefined) expect(() => assertMcpName(name), name).not.toThrow()
    else expect(() => assertMcpName(name), name).toThrow(`MCP name ${refusal}`)
  }
  // Only the database refuses the schemas Postgres and drizzle own.
  for (const name of ["public", "drizzle"]) {
    expect(checkProviderId(name)).toBeUndefined()
    expect(() => assertMcpName(name)).toThrow(`MCP name ${name} is reserved`)
  }
})
