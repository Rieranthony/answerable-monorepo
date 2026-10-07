import type { SQL } from "bun"
import type { IdAdmin } from "@answerable/id-admin"
import { createMcpServer, errorCodeOf, type ToolError, type IdVerifierConfig, type UserPrincipal } from "@answerable/mcp"
import { createEvidence, createPostgresIntentStore, withEvidence, type EvidenceEvent } from "@answerable/mcp-postgres"
import { reauthenticationRequired } from "./fresh"
import { createAdminProvider } from "./provider"
import { createRoles } from "./roles"
import { createToolboxAdmin } from "./toolbox"

/** What `createAdminMcp` takes: the ID issuer and resource to trust, the database, ID's admin API as the machine client, and the platform organisation's id. */
export type AdminMcpConfig = {
  auth: IdVerifierConfig
  db: SQL
  /** ID's admin API as the admin MCP's machine client: `createIdAdmin(config)`. */
  id: IdAdmin
  /** The platform organisation's id, from `readPlatform(id)`. */
  platform: string
  /** How recent a directory sign-in a critical operation needs, in seconds: `ADMIN_FRESH_SECONDS`, 1,800 by default. */
  freshSeconds?: number
  /** The Toolbox's admin resource (`ADMIN_TOOLBOX_ADMIN_RESOURCE`) and, for tests, the HTTP client that reaches it; unset, `toolbox_enable` is refused. */
  toolbox?: { resource: string; fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }
}

/**
 * The admin MCP: the provider served to members of the platform organisation alone, each tool only to a role at or above its minimum, the role
 * read from ID once per request. Every mutation is controlled class: the host shows the preview and commits with its summary. Intents live in
 * Postgres. Every call that runs, every refusal of a tool and every intent transition is evidence on the platform organisation's chain; a call
 * refused because ID did not answer is not, since the SDK answers it before `wrapCall`. `GET /health` answers from the database.
 */
export function createAdminMcp({ auth, db, id, platform, freshSeconds = 1800, toolbox }: AdminMcpConfig) {
  const authority = createRoles({ id, platform, resource: auth.resource })
  const { provider, minimum } = createAdminProvider({
    id, authority, platform, resource: auth.resource, issuer: auth.issuer, freshSeconds, toolbox: toolbox && createToolboxAdmin({ id, ...toolbox }),
  })
  const evidence = createEvidence(db)
  const record = (principal: UserPrincipal, tool: { identity: string; version: string }, fields: Omit<EvidenceEvent, "organisation_id" | "actor_type" | "actor_id">) => evidence.record({
    organisation_id: platform, actor_type: "user", actor_id: principal.userId, client_id: principal.clientId,
    capability_identity: tool.identity, capability_version: tool.version, ...fields,
  })
  const server = createMcpServer({
    provider, auth,
    intents: withEvidence(createPostgresIntentStore(db), evidence),
    policyClass: () => "controlled",
    async allow(principal, tool, called) {
      const refused = await authority.refusal(principal, tool.scopes, minimum(tool))
      if (refused && called) await record(principal, tool, { kind: "capability.denied", outcome: "denied", ...refused })
      return !refused
    },
    async wrapCall(call, run) {
      const settled = await run().then(data => ({ data }), (failure: unknown) => ({ failure }))
      const code = "failure" in settled ? errorCodeOf(settled.failure) : undefined
      const ran = { execution_id: call.executionId, request_id: String(call.requestId), upstream: call.tool.identity === "admin/toolbox.enable" ? "toolbox" : "id" }
      await record(call.principal, call.tool, code === reauthenticationRequired
        // A critical operation refused for a stale sign-in is a denial, with the times that decided it.
        ? { kind: "capability.denied", outcome: "denied", reason: "stale_authentication", data: (settled as { failure: ToolError }).failure.details, ...ran }
        : { kind: "capability.completed", ...ran, ...(code ? { outcome: "failure", error_code: code } : { outcome: "success" }) })
      if ("failure" in settled) throw settled.failure
      return settled.data
    },
  })
  return {
    async fetch(request: Request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") {
        try {
          await db`select 1`
          return Response.json({ status: "ok" })
        } catch {
          return Response.json({ status: "unavailable" }, { status: 503 })
        }
      }
      return server.fetch(request)
    },
  }
}
