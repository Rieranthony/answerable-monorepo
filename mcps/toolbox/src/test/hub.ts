// The Toolbox in process, over the test database and a fake ID: members of fresh organisations to call its MCP endpoint, and staff to call its admin API.
import type { SQL } from "bun"
import { defineMutation, defineProvider, defineTool, type Provider } from "@answerable/mcp"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { createTestMcp } from "@answerable/mcp/testing"
import { z } from "zod"
import { writeCatalogue } from "../catalogue"
import { createIdAdmin } from "../id"
import { createMemoryTracer } from "../spans"
import { createToolbox } from "../toolbox"
import { createFakeId } from "./fake-id"

export const resource = "https://mcp.test/mcp"
export const adminResource = "https://mcp.test/admin"
export const view = "<!doctype html><title>Records</title>"
export const e2e = () => createE2eProvider({ records: createRecordStore(), viewHtml: view })

/** A provider with a read (`records.list`, titled) and a mutation (`records.create`), and `extra` more reads, for the admin API's tests. */
export function records(id: string, { version = "2026-09-29", extra = [] as string[] } = {}) {
  const read = (name: string, title?: string) => defineTool({
    name, title, description: `Read ${name} for the tests of the Toolbox's admin API; it changes nothing and returns nothing.`,
    input: z.object({}), output: z.object({}), async execute() { return {} },
  })
  const create = defineMutation({
    name: "records.create", risk: "low", description: "Prepare creating a record for the tests of the Toolbox's admin API; it changes nothing.",
    input: z.object({}), output: z.object({}),
    async prepare() { return { targets: [], preview: { summary: "Create a record" } } },
    async commit() { return { results: {}, applied_changes: [], effects_performed: [] } },
  })
  return defineProvider({ id, version, tools: [read("records.list", "List records"), create, ...extra.map(name => read(name))] })
}
/** A provider id no other test uses. */
export const providerId = () => `a${crypto.randomUUID().slice(0, 8)}`

export async function createHub(db: SQL, providers: readonly Provider[] = [e2e()], { secret, pageSize }: { secret?: string; pageSize?: number } = {}) {
  const id = createFakeId({ pageSize })
  const { tracer, spans } = createMemoryTracer()
  let toolbox!: Awaited<ReturnType<typeof createToolbox>>
  const mcp = await createTestMcp(async auth => (toolbox = await createToolbox({
    providers, auth, db, id: createIdAdmin(secret ? { ...id.config, clientSecret: secret } : id.config), spans: tracer,
  })))
  async function member(grants: string[], { enable = providers.map(provider => provider.id), scopes = ["toolbox"] }: { enable?: string[]; scopes?: string[] } = {}) {
    const organizationId = crypto.randomUUID()
    const membershipId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    id.grant(organizationId, membershipId, [{ kind: "resource", id: resource, scopes: [...grants, "toolbox"] }, { kind: "client_resource", id: "test-client", resource, scopes: ["toolbox", "offline_access"] }])
    for (const provider of enable) await writeCatalogue(db, organizationId, provider, { enabled: true })
    const connect = (protocol?: "2025" | "2026-07-28", clientId?: string) => mcp.connect({ organizationId, membershipId, userId, scopes, protocol, clientId })
    return { organizationId, membershipId, userId, connect }
  }
  // What ID puts in a client_credentials token: the client is the subject, with no membership or grant.
  const token = (audience = adminResource, scopes = ["toolbox:admin"]) => mcp.issuer.sign({
    resource: audience, scopes,
    claims: { subject_type: "client", sub: "staff", client_id: "staff", client_instance: crypto.randomUUID(), authorization_version: 1, membership_id: undefined, grant_id: undefined },
  })
  /** Call the admin API as staff, with a machine token for the admin resource carrying `toolbox:admin` unless `authorization` says otherwise. */
  async function admin(method: string, path: string, { body, authorization }: { body?: unknown; authorization?: string | null } = {}) {
    const bearer = authorization === undefined ? `Bearer ${await token()}` : authorization
    const response = await mcp.fetch(`https://mcp.test/admin/v1${path}`, {
      method,
      headers: { ...(bearer ? { Authorization: bearer } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers }
  }
  return { id, spans, mcp, member, token, admin, toolbox: () => toolbox }
}
export type Hub = Awaited<ReturnType<typeof createHub>>
export type Client = Awaited<ReturnType<Hub["mcp"]["connect"]>>
export const names = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name)
