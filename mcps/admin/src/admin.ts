import { createIdProfiles, type IdAdmin } from "@answerable/id-admin"
import { createMcpServer, type IdVerifierConfig } from "@answerable/mcp"
import { createCalls, health } from "@answerable/mcp-platform"
import type { Database } from "@answerable/mcp-postgres"
import { reauthenticationRequired } from "./fresh"
import { createAdminProvider } from "./provider"
import { createRoles } from "./roles"
import { createToolboxAdmin } from "./toolbox"

/** What `createAdminMcp` takes: the ID issuer and resource to trust, the database, ID's admin API as the machine client, and the platform organisation's id. */
export type AdminMcpConfig = {
  auth: IdVerifierConfig
  db: Database
  /** ID's admin API as the admin MCP's machine client: `createIdAdmin(config)`. */
  id: IdAdmin
  /** The platform organisation's id, from `readPlatform(id)`. */
  platform: string
  /** How recent a directory sign-in a critical operation needs, in seconds: `ADMIN_FRESH_SECONDS`, 1,800 by default. */
  freshSeconds?: number
  /** The Toolbox's admin resource (`ADMIN_TOOLBOX_ADMIN_RESOURCE`) and, for tests, the HTTP client that reaches it; unset, `toolbox_enable` is refused. */
  toolbox?: { resource: string; fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }
  /** The standalone server's origin (`ADMIN_STANDALONE_ORIGIN`); unset, `standalone_enable` is refused. */
  standaloneOrigin?: string
}

/**
 * The admin MCP: the provider served to members of the platform organisation alone, each tool only to a role at or above its minimum, the role
 * read from ID once per request, and who is calling read from ID through a 60-second cache, which the audit-log poller drops on a change. Every
 * mutation is controlled class: the host shows the preview and commits with its summary. Intents live in Postgres. Every call that runs, every
 * refusal of a tool, a refusal because ID did not answer with the role included, and every intent transition is evidence on the platform
 * organisation's chain (`@answerable/mcp-platform`); a commit's names the intent it applied and the service that intent's capability calls.
 * `GET /health` answers from the database.
 */
export function createAdminMcp({ auth, db, id, platform, freshSeconds = 1800, toolbox, standaloneOrigin }: AdminMcpConfig) {
  const authority = createRoles({ id, platform, resource: auth.resource })
  const { provider, minimum } = createAdminProvider({
    id, authority, platform, resource: auth.resource, issuer: auth.issuer, freshSeconds, toolbox: toolbox && createToolboxAdmin({ id, ...toolbox }), standaloneOrigin,
  })
  const profiles = createIdProfiles(id)
  const calls = createCalls({
    db, salt: auth.resource, organisation: () => platform,
    // A critical operation refused for a stale sign-in is a denial, with the times that decided it.
    denials: { [reauthenticationRequired]: "stale_authentication" },
    upstream: identity => (identity === "admin/toolbox.enable" ? "toolbox" : "id"),
  })
  const server = createMcpServer({
    provider, auth, profiles,
    intents: calls.intents,
    policyClass: () => "controlled",
    allow: calls.allow((principal, tool) => authority.refusal(principal, tool.scopes, minimum(tool))),
    wrapCall: calls.wrapCall,
  })
  const healthy = health({ admin: db.$client }, [provider.id])
  return {
    async fetch(request: Request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") return healthy()
      return server.fetch(request)
    },
    /** Who each caller is, cached, for `startAuditPoller` to invalidate. */
    profiles,
  }
}
