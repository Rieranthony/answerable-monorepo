// The Toolbox as the Toolbox journeys and the host lane register and start it, so that what the lane offers by hand is what the journeys prove.
import { createIdAdmin, type IdConfig } from "@answerable/id-admin"
import { createMemoryTracer, mcpDatabases, startAuditPoller } from "@answerable/mcp-platform"
import { assertRuntimeRole, configureRuntimeRole } from "@answerable/mcp-postgres"
import { toolboxAdminResource } from "@answerable/mcp-toolbox/admin"
import { migrate, runtimeGrants } from "@answerable/mcp-toolbox/migrate"
import { mounted } from "@answerable/mcp-toolbox/mounted"
import { createToolbox } from "@answerable/mcp-toolbox/toolbox"
import { z } from "zod"
import { registerClient, registerMachine, registerResource } from "./admin"
import { onCleanup } from "./cleanup"
import { createDatabase, type Id } from "./id"
import { mcpsDatabase } from "./mcps"
import { step } from "./step"

/** The Toolbox's URL, which is the audience of its tokens; it is served on port 47604. */
export const toolboxResource = "http://127.0.0.1:47604/mcp"
const toolboxAdmin = toolboxAdminResource(toolboxResource)

/** A public client a person signs in from, such as Claude Code: its id and the redirect URI it was registered with. */
export type HostClient = { clientId: string; redirectUri: string }

/**
 * Register the Toolbox in a started ID and start it mounting every MCP of its generated list. Registered in ID: the Toolbox's resource (60-second
 * tokens, allowing only `toolbox` and `offline_access` until an enable call widens it) and its admin resource, each of `hosts` as a public host
 * client, and in the platform organisation the Toolbox's machine client `toolbox-hub` and a staff client `toolbox-staff` with `toolbox:admin`. The
 * Toolbox gets the database `database` on the acceptance's PostgreSQL, migrated as the owner, and serves as its runtime login, as `db:migrate` and
 * the entry point do; the mounted MCPs' tables are in the shared MCP database (`mcpsDatabase`), reached as its serving login, which is checked
 * first; and the audit-log poller drops its grants and profiles. `fetch` is the HTTP client of its machine client. No organisation is enabled yet.
 * The caller serves `toolbox.fetch` on port 47604.
 */
export async function startToolboxStack(id: Id, { hosts, database, fetch }: { hosts: readonly HostClient[]; database: string; fetch?: IdConfig["fetch"] }) {
  const { admin, manifest } = id
  step("Registering the Toolbox, its admin resource and its host clients")
  await registerResource(admin, { identifier: toolboxResource, scopes: ["toolbox"], accessTokenTtl: 60 })
  await registerResource(admin, { identifier: toolboxAdmin, scopes: ["toolbox:admin"], accessTokenTtl: 300 })
  for (const host of hosts) await registerClient(admin, { ...host, scopes: ["toolbox"] })

  step("Registering the Toolbox's machine client and a staff client in the platform organisation")
  const organisations = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", "/organizations?q=answerable"))
  const platform = organisations.items.find(organisation => organisation.slug === "answerable")!
  const hub = await registerMachine(admin, platform.id, "toolbox-hub", { [manifest.adminResource]: ["platform:read", "platform:write"] })
  const staff = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...await registerMachine(admin, platform.id, "toolbox-staff", { [toolboxAdmin]: ["toolbox:admin"] }) })
  // ID makes its signing key when it signs its first token, and two first tokens at once make two keys: a verifier that read the keys between them
  // refuses the second's token for 30 seconds. The Toolbox's poller and the first enable call would ask together, so the staff client's token comes
  // first, kept for the admin calls; nothing is sent with it yet.
  await staff.withToken(toolboxAdmin, "toolbox:admin", async () => new Response())

  step(`Creating and migrating ${database}, and starting the Toolbox mounting ${mounted.map(({ provider }) => provider.id).join(" and ")} as its runtime logins`)
  const { owner, runtime, role } = await createDatabase(database)
  await migrate(owner)
  await configureRuntimeRole(owner, role, runtimeGrants)
  await assertRuntimeRole(runtime)
  const mcps = mcpDatabases(mounted, { shared: (await mcpsDatabase()).toolbox, own: {} })
  onCleanup(() => mcps.close())
  await mcps.assert()
  const { tracer, spans } = createMemoryTracer()
  const machine = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...hub, fetch })
  const toolbox = await createToolbox({ mount: mcps.mount, pools: mcps.pools, auth: { issuer: manifest.idOrigin, resource: toolboxResource }, db: runtime, id: machine, spans: tracer })
  const poller = startAuditPoller({ id: machine, caches: [toolbox.grants, toolbox.profiles] })
  onCleanup(() => poller.stop())

  return {
    toolbox,
    /** The providers the Toolbox mounts: those of its generated list. */
    providers: mounted.map(({ provider }) => provider),
    /** The Toolbox's database as its owner, to read the catalogue, intents and evidence the Toolbox wrote as its runtime login. */
    db: owner,
    /** The Toolbox's spans, in memory. */
    spans,
    /** The Toolbox's admin API as the staff client: the status and the JSON body. */
    async adminApi(method: string, path: string, body?: unknown) {
      const response = await staff.withToken(toolboxAdmin, "toolbox:admin", token => globalThis.fetch(`${new URL(toolboxResource).origin}/admin/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }))
      const text = await response.text()
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
    },
  }
}
