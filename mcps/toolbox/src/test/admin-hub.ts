import type { SQL } from "bun"
import { createTestIssuer } from "@answerable/auth/testing"
import { defineMutation, defineProvider, defineTool, type Provider } from "@answerable/mcp"
import { z } from "zod"
import { createMemoryTracer } from "../spans"
import { createToolbox } from "../toolbox"
import { createFakeId } from "./fake-id"

export const resource = "https://toolbox.test/mcp"
export const adminResource = "https://toolbox.test/admin"

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

/** A Toolbox with its admin API over a fake ID, and `call` to use it as staff: a machine token for the admin resource with `toolbox:admin`, unless told otherwise. */
export async function adminHub(db: SQL, providers: readonly Provider[], { secret, pageSize }: { secret?: string; pageSize?: number } = {}) {
  const issuer = await createTestIssuer()
  const id = createFakeId({ pageSize })
  const hub = await createToolbox({
    providers, auth: { issuer: issuer.issuer, resource, fetch: issuer.fetch }, db, spans: createMemoryTracer().tracer,
    id: secret ? { ...id.config, clientSecret: secret } : id.config,
  })
  // What ID puts in a client_credentials token: the client is the subject, with no membership or grant.
  const token = (audience = adminResource, scopes = ["toolbox:admin"]) => issuer.sign({
    resource: audience, scopes,
    claims: { subject_type: "client", sub: "staff", client_id: "staff", client_instance: crypto.randomUUID(), authorization_version: 1, membership_id: undefined, grant_id: undefined },
  })
  async function call(method: string, path: string, { body, authorization }: { body?: unknown; authorization?: string | null } = {}) {
    const bearer = authorization === undefined ? `Bearer ${await token()}` : authorization
    const response = await hub.fetch(new Request(`https://toolbox.test/admin/v1${path}`, {
      method,
      headers: { ...(bearer ? { Authorization: bearer } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }))
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers }
  }
  return { id, issuer, token, call }
}
