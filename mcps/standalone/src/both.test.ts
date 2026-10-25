// e2e is served both ways: its records live in Postgres, in schema e2e, so the Toolbox and the standalone server, each with pools of its own,
// read and write the same rows, organisation by organisation, and a restarted server finds them.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createTestIssuer } from "@answerable/auth/testing"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { createMemoryTracer, mcpDatabases } from "@answerable/mcp-platform"
import { provider as e2e } from "@answerable/mcp-e2e/provider"
import { migrate } from "@answerable/mcp-toolbox/migrate"
import { createToolbox } from "@answerable/mcp-toolbox/toolbox"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { sql } from "drizzle-orm"
import { database, serving } from "./test/database"
import { databases, prefix } from "./test/mcps"
import { startStandalone, type Who } from "./test/standalone"

const toolboxResource = "https://toolbox.test/mcp"
const issuer = await createTestIssuer()
const id = createFakeId()
const login = await serving()
// The Toolbox's own database, beside this suite's: a scratch one, migrated as the Toolbox migrates its own.
const hub = await database.scratch("toolbox")
let toolbox: Awaited<ReturnType<typeof createToolbox>>
const toolboxMcps = mcpDatabases([{ provider: e2e, database: "shared" }], { shared: databases.url, own: {}, prefix })
beforeAll(async () => {
  await migrate(hub.db)
  toolbox = await createToolbox({ mount: toolboxMcps.mount, auth: { issuer: issuer.issuer, resource: toolboxResource, fetch: issuer.fetch }, db: hub.db, id: createIdAdmin(id.config), spans: createMemoryTracer().tracer })
})
const clients: Client[] = []
afterAll(async () => {
  await Promise.all(clients.map(client => client.close()))
  await toolboxMcps.close()
  await hub.drop()
  await login.drop()
})

// A person in the Toolbox, granted e2e in an organisation that enabled it: the same person the standalone server signs in.
async function inToolbox(who: Who) {
  await hub.db.execute(sql`insert into organisation_catalogue (organisation_id, provider_id, enabled) values (${who.organizationId}, 'e2e', true) on conflict do nothing`)
  id.grant(who.organizationId, who.membershipId, [{ kind: "resource", id: toolboxResource, scopes: ["toolbox", "e2e"] }])
  const token = await issuer.sign({ resource: toolboxResource, scopes: ["toolbox"], organizationId: who.organizationId, userId: who.userId, claims: { membership_id: who.membershipId } })
  const client = new Client({ name: "toolbox-test", version: "0.1.0" })
  clients.push(client)
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    request.headers.set("Host", "toolbox.test")
    return toolbox.fetch(request)
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(toolboxResource), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch }))
  return client
}
const titles = async (client: Client, name: string) => ((await client.callTool({ name, arguments: {} })).structuredContent as { items: { title: string }[] }).items.map(item => item.title)
async function create(client: Client, prepare: string, commit: string, title: string) {
  const { intent_id, commit_token } = (await client.callTool({ name: prepare, arguments: { title } })).structuredContent as { intent_id: string; commit_token: string }
  expect((await client.callTool({ name: commit, arguments: { intent_id, commit_token } })).structuredContent).toMatchObject({ status: "committed" })
}
const scopes = ["e2e:identity", "e2e:read", "e2e:write"]

test("a record made at e2e's path is listed in the Toolbox, one made in the Toolbox at e2e's path, and another organisation sees neither", async () => {
  const standalone = await startStandalone(login.db, { issuer, id })
  try {
    const { client: alone, ...ada } = await standalone.connect("e2e", scopes)
    const inHub = await inToolbox(ada)
    await create(alone, "records_create", "e2e_commit", "Made alone")
    expect(await titles(inHub, "e2e_records_list")).toEqual(["Made alone"])
    await create(inHub, "e2e_records_create", "toolbox_commit", "Made in the Toolbox")
    expect(await titles(alone, "records_list")).toEqual(["Made alone", "Made in the Toolbox"])
    const { client: stranger, ...grace } = await standalone.connect("e2e", scopes)
    expect([await titles(stranger, "records_list"), await titles(await inToolbox(grace), "e2e_records_list")]).toEqual([[], []])
  } finally {
    await standalone.close()
  }
})

test("the records survive a restart: a standalone server started again on fresh pools lists what the first one wrote", async () => {
  const first = await startStandalone(login.db, { issuer, id })
  const { client, ...ada } = await first.connect("e2e", scopes)
  await create(client, "records_create", "e2e_commit", "Before the restart")
  await first.close()
  const again = await startStandalone(login.db, { issuer, id })
  try {
    expect(await titles((await again.connect("e2e", scopes, ada)).client, "records_list")).toEqual(["Before the restart"])
  } finally {
    await again.close()
  }
})
