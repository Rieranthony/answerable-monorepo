import { IdError, type IdAdmin } from "@answerable/id-admin"
import { defineMutation, ToolError } from "@answerable/mcp"
import { z } from "zod"
import { commitWith, errors, invalid, named, organizationId, precondition, scopes, type Writes } from "./writes"

const failure = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

/**
 * The Toolbox's platform-tier admin API, which the admin MCP calls to enable the Toolbox for an organisation, with a `toolbox:admin` token
 * that ID issues to the admin MCP's own machine client for the Toolbox's admin resource. `resource` is that resource, `<toolbox origin>/admin`
 * (`ADMIN_TOOLBOX_ADMIN_RESOURCE`); the API lives under it at `/v1`.
 */
export function createToolboxAdmin({ id, resource, fetch = globalThis.fetch }: {
  id: IdAdmin
  resource: string
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}) {
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const url = `${resource}/v1${path}`
    let response: Response
    try {
      response = await id.withToken(resource, "toolbox:admin", token => fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      }))
    } catch (error) {
      console.error("[admin] the Toolbox failed", error)
      // ID refusing the token is a configuration to fix; no answer from either is a moment to wait.
      if (error instanceof IdError && error.status !== 0 && error.status < 500) {
        throw new ToolError("UPSTREAM_REJECTED", error.message, { details: { upstream: { status: error.status, code: error.code ?? null } } })
      }
      throw new ToolError("UPSTREAM_UNAVAILABLE", `The Toolbox at ${resource} did not answer; try again shortly`)
    }
    const json = await response.json().catch(() => undefined)
    if (response.ok) return json
    const said = failure.safeParse(json)
    const code = said.success ? said.data.error.code : null
    const message = `The Toolbox answered ${method} ${url} with ${response.status}${said.success ? ` ${code}: ${said.data.error.message}` : ""}`
    console.error("[admin] the Toolbox failed", message)
    if (response.status >= 500) throw new ToolError("UPSTREAM_UNAVAILABLE", message, { details: { upstream: { status: response.status, code } } })
    throw new ToolError("UPSTREAM_REJECTED", message, { details: { upstream: { status: response.status, code } } })
  }
  return {
    /** The providers mounted in the Toolbox, by id. */
    async providers() {
      return z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await call("GET", "/providers")).items.map(provider => provider.id)
    },
    /** The providers enabled for an organisation in the Toolbox's catalogue. */
    async enabled(organizationId: string) {
      const { items } = z.object({ items: z.array(z.object({ provider_id: z.string(), enabled: z.boolean() })) }).parse(await call("GET", `/organisations/${organizationId}/catalogue`))
      return items.filter(item => item.enabled).map(item => item.provider_id).sort()
    },
    /** The enable operation: what it made (`created`) and what it found (`existing`). Repeating it makes only what is missing. */
    async enable(organizationId: string, body: { hostClientIds: string[]; providers: string[] }) {
      return z.object({ created: z.array(z.string()), existing: z.array(z.string()) }).parse(await call("POST", `/organisations/${organizationId}/enable`, body))
    },
  }
}
/** The Toolbox's admin API, as the admin MCP calls it. */
export type ToolboxAdmin = ReturnType<typeof createToolboxAdmin>

/**
 * `toolbox.enable`: the Toolbox's enable operation for an organisation, the providers and the host clients named. Without the Toolbox's admin
 * resource configured it stays listed and answers `PRECONDITION_FAILED` saying what to set.
 */
export function toolboxWrites(writes: Writes, toolbox: ToolboxAdmin | undefined) {
  const { calls, role, organisation } = writes
  const enable = role("admin", defineMutation({
    name: "toolbox.enable", risk: "normal", scopes, errors, effects: ["permission_change", "external_call"],
    description: `Prepare enabling the Toolbox for an organisation: the named providers in its catalogue, and for each named host client what Answerable ID needs so that its people can sign in to the Toolbox from it. ${commitWith} What each person may use still needs access_grant of grant strings. Safe to repeat.`,
    input: z.object({
      organizationId,
      hostClientIds: z.array(z.string().min(1).max(200)).min(1).max(20).describe("The OAuth clients people use the Toolbox from, such as claude-code-toolbox"),
      providers: z.array(z.string().min(1).max(12)).min(1).max(50).describe("The Toolbox providers to enable, such as e2e; the Toolbox lists them"),
    }),
    output: z.object({ created: z.array(z.string()).describe("What the Toolbox made"), existing: z.array(z.string()).describe("What it found already in place") }),
    async prepare(input, context) {
      if (!toolbox) {
        throw precondition("The admin MCP does not know the Toolbox: set ADMIN_TOOLBOX_ADMIN_RESOURCE to the Toolbox's admin resource, such as http://localhost:47400/admin, and restart it", {
          variable: "ADMIN_TOOLBOX_ADMIN_RESOURCE",
        })
      }
      const { organisation: row, target: version } = await organisation(input.organizationId, context)
      const [hostClientIds, providers] = [[...new Set(input.hostClientIds)].sort(), [...new Set(input.providers)].sort()]
      const mounted = await toolbox.providers()
      const unknown = providers.filter(provider => !mounted.includes(provider))
      if (unknown.length) throw invalid("providers", `The Toolbox has no provider ${unknown.join(", ")}; it has ${mounted.join(", ")}`)
      for (const clientId of hostClientIds) {
        if (await calls.read(`/clients/${encodeURIComponent(clientId)}`, context) === undefined) throw invalid("hostClientIds", `Answerable ID has no client ${clientId}; register it first`)
      }
      const before = await toolbox.enabled(row.id)
      return {
        targets: [version],
        preview: {
          summary: `Enable the Toolbox for organisation ${named(row)}: ${providers.join(", ")}, from ${hostClientIds.join(", ")}`,
          changes: [{ path: `toolbox.catalogue[${row.id}]`, from: before, to: [...new Set([...before, ...providers])].sort() }],
          effects: ["permission_change" as const, "external_call" as const],
          warnings: [
            `For each host client, the Toolbox makes in Answerable ID what is missing of: the client's link to the Toolbox, and the organisation's login and toolbox capabilities and entitlements for everyone in it. The receipt lists what it made and what it found.`,
            "Not atomic: if the Toolbox fails part-way, what it made stays; preparing and committing the same request again finishes it, skipping what exists.",
          ],
        },
        plan: { organizationId: row.id, hostClientIds, providers },
      }
    },
    async commit({ plan: { organizationId: id, hostClientIds, providers }, preview }) {
      const done = await toolbox!.enable(id, { hostClientIds, providers })
      return { results: done, applied_changes: preview.changes, effects_performed: preview.effects }
    },
  }))
  return [enable]
}
