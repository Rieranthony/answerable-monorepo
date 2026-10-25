import { expect, test } from "bun:test"
import { assertProviderConformance, createTestMcp } from "@answerable/mcp-postgres/testing"
import { eq, sql } from "drizzle-orm"
import { records } from "./db/schema"
import { provider } from "./provider"

//#region conformance
// One test per check of the Answerable MCP standard, for every tool, each called with its example; and manifest.json, the contract. A delete
// needs a record to delete, made as the caller's organisation; moving its target bumps the record's version, as another writer would.
assertProviderConformance(provider, {
  manifest: new URL("../manifest.json", import.meta.url),
  examples: {
    "records.delete": async ({ organizationId, userId }, { db, asOrganisation }) => {
      const [record] = await asOrganisation(organizationId, () => db.insert(records).values({ organisation_id: organizationId, creator_id: userId, title: "Doomed" }).returning())
      return { id: record!.id }
    },
  },
  moveTarget: ({ resource_id }, { organizationId }, { db, asOrganisation }) =>
    asOrganisation(organizationId, () => db.update(records).set({ version: sql`${records.version} + 1` }).where(eq(records.id, resource_id))),
})
//#endregion

test("an entitled caller sees three read tools, two mutations and the commit tools, and their verified identity", async () => {
  const mcp = await createTestMcp(provider)
  try {
    const organizationId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const client = await mcp.connect({ organizationId, userId })
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(["identity_get", "records_list", "records_show", "records_create", "records_delete", "e2e_commit", "e2e_commit_confirmed"])
    const version = "2026-09-29"
    expect(tools.map(tool => tool._meta?.["com.answerable/capability"])).toEqual([
      ...["identity.get", "records.list", "records.show"].map(name => ({ identity: `e2e/${name}`, version, kind: "read" })),
      { identity: "e2e/records.create", version, kind: "mutate", risk: "low", policy_class: "agent" },
      { identity: "e2e/records.delete", version, kind: "mutate", risk: "normal", policy_class: "controlled" },
      { identity: "e2e/commit", kind: "commit" },
      { identity: "e2e/commit_confirmed", kind: "commit" },
    ])
    const identity = await client.callTool({ name: "identity_get", arguments: {} })
    expect(identity.structuredContent).toEqual({ userId, organizationId, scopes: ["e2e:identity", "e2e:read", "e2e:write"] })
    expect(identity.content).toEqual([{ type: "text", text: JSON.stringify(identity.structuredContent) }])
  } finally {
    await mcp.close()
  }
})
