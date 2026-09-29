// The Toolbox in process, over the test database and a fake ID, and members of fresh organisations to call it.
import type { SQL } from "bun"
import type { Provider } from "@answerable/mcp"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { createTestMcp } from "@answerable/mcp/testing"
import { writeCatalogue } from "../catalogue"
import { createMemoryTracer } from "../spans"
import { createToolbox } from "../toolbox"
import { createFakeId } from "./fake-id"

export const resource = "https://mcp.test/mcp"
export const view = "<!doctype html><title>Records</title>"
export const e2e = () => createE2eProvider({ records: createRecordStore(), viewHtml: view })

export async function createHub(db: SQL, providers: Provider[] = [e2e()]) {
  const id = createFakeId()
  const { tracer, spans } = createMemoryTracer()
  let toolbox!: Awaited<ReturnType<typeof createToolbox>>
  const mcp = await createTestMcp(async auth => (toolbox = await createToolbox({ providers, auth, db, id: id.config, spans: tracer })))
  async function member(grants: string[], { enable = providers.map(provider => provider.id), scopes = ["toolbox"] }: { enable?: string[]; scopes?: string[] } = {}) {
    const organizationId = crypto.randomUUID()
    const membershipId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    id.grant(organizationId, membershipId, [{ kind: "resource", id: resource, scopes: [...grants, "toolbox"] }, { kind: "client_resource", id: "test-client", resource, scopes: ["toolbox", "offline_access"] }])
    for (const provider of enable) await writeCatalogue(db, organizationId, provider, { enabled: true })
    const connect = (protocol?: "2025" | "2026-07-28", clientId?: string) => mcp.connect({ organizationId, membershipId, userId, scopes, protocol, clientId })
    return { organizationId, membershipId, userId, connect }
  }
  return { id, spans, mcp, member, toolbox: () => toolbox }
}
export type Hub = Awaited<ReturnType<typeof createHub>>
export type Client = Awaited<ReturnType<Hub["mcp"]["connect"]>>
export const names = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name)
