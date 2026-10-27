// The Toolbox as the journeys and the host lane register and start it, so that what the lane offers by hand is what the journeys prove: its hub, and
// each MCP it serves alone at its path.
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
 * The Toolbox's process as its entry point builds it, for a journey that serves it at one origin or more: its machine client `toolbox-hub` in the
 * platform organisation of a started ID (`platform:read platform:write`, the HTTP client `fetch`), its database `database` on the acceptance's
 * PostgreSQL (migrated as the owner, served as the runtime login, as `db:migrate` and the entry point do), and the shared MCP database's serving
 * login, checked. `start(origin)` builds a Toolbox on fresh pools whose hub is `<origin>/mcp` and whose MCPs served alone, `standalone` or `both` in
 * its generated list, are `<origin>/<name>/mcp`, with its audit-log poller dropping its grants and profiles; the caller serves its `fetch`, and
 * `close()` stops it, as a process stopping does. Registers nothing else in ID: each resource and client is the journey's to register.
 */
export async function prepareToolbox(id: Id, { database, fetch }: { database: string; fetch?: IdConfig["fetch"] }) {
  const { admin, manifest } = id
  step("Registering the Toolbox's machine client in the platform organisation")
  const organisations = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", "/organizations?q=answerable"))
  const platform = organisations.items.find(organisation => organisation.slug === "answerable")!
  const hub = await registerMachine(admin, platform.id, "toolbox-hub", { [manifest.adminResource]: ["platform:read", "platform:write"] })
  const machine = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...hub, fetch })

  step(`Creating and migrating ${database}, to serve ${mounted.map(({ provider }) => provider.id).join(" and ")} as the Toolbox's runtime logins`)
  const { owner, runtime, role } = await createDatabase(database)
  await migrate(owner)
  await configureRuntimeRole(owner, role, runtimeGrants)
  await assertRuntimeRole(runtime)
  const shared = (await mcpsDatabase()).toolbox
  const checked = mcpDatabases(mounted, { shared, own: {} })
  try {
    await checked.assert()
  } finally {
    await checked.close()
  }
  const { tracer, spans } = createMemoryTracer()
  async function start(origin: string) {
    const mcps = mcpDatabases(mounted, { shared, own: {} })
    const toolbox = await createToolbox({ mount: mcps.mount, pools: mcps.pools, auth: { issuer: manifest.idOrigin, resource: `${origin}/mcp` }, origin, db: runtime, id: machine, spans: tracer })
    const poller = startAuditPoller({ id: machine, caches: [toolbox.grants, toolbox.profiles] })
    let closed: Promise<void> | undefined
    const close = () => (closed ??= (poller.stop(), mcps.close()))
    onCleanup(close)
    return { toolbox, fetch: toolbox.fetch, close }
  }
  return {
    start,
    /** The platform organisation's id. */
    platform: platform.id,
    /** The Toolbox's database as its owner, to read the catalogue, intents and evidence it wrote as its runtime login. */
    db: owner,
    /** The spans of every Toolbox `start` made, in memory. */
    spans,
  }
}

/**
 * Register the Toolbox in a started ID and start it serving every MCP of its generated list. Registered in ID: the Toolbox's resource (60-second
 * tokens, allowing only `toolbox` and `offline_access` until an enable call widens it) and its admin resource, each of `hosts` as a public host
 * client, and in the platform organisation the Toolbox's machine client `toolbox-hub` and a staff client `toolbox-staff` with `toolbox:admin`. The
 * Toolbox is `prepareToolbox`'s, at `toolboxResource`'s origin: its hub there, and each MCP served alone at its path. `fetch` is the HTTP client of
 * its machine client. No organisation is enabled yet. The caller serves `toolbox.fetch` on port 47604; `stop()` stops it, and `start()` makes
 * another Toolbox there on fresh pools, for a restart.
 */
export async function startToolboxStack(id: Id, { hosts, database, fetch }: { hosts: readonly HostClient[]; database: string; fetch?: IdConfig["fetch"] }) {
  const { admin, manifest } = id
  step("Registering the Toolbox, its admin resource and its host clients")
  await registerResource(admin, { identifier: toolboxResource, scopes: ["toolbox"], accessTokenTtl: 60 })
  await registerResource(admin, { identifier: toolboxAdmin, scopes: ["toolbox:admin"], accessTokenTtl: 300 })
  for (const host of hosts) await registerClient(admin, { ...host, scopes: ["toolbox"] })
  const prepared = await prepareToolbox(id, { database, fetch })

  step("Registering a staff client in the platform organisation")
  const staff = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...await registerMachine(admin, prepared.platform, "toolbox-staff", { [toolboxAdmin]: ["toolbox:admin"] }) })
  // ID makes its signing key when it signs its first token, and two first tokens at once make two keys: a verifier that read the keys between them
  // refuses the second's token for 30 seconds. The Toolbox's poller and the first enable call would ask together, so the staff client's token comes
  // first, kept for the admin calls; nothing is sent with it yet.
  await staff.withToken(toolboxAdmin, "toolbox:admin", async () => new Response())

  step(`Starting the Toolbox serving ${mounted.map(({ provider }) => provider.id).join(" and ")}`)
  const origin = new URL(toolboxResource).origin
  const first = await prepared.start(origin)

  return {
    toolbox: first.toolbox,
    /** Stop the Toolbox, as its process stopping does. */
    stop: first.close,
    /** Another Toolbox at the same origin, on fresh pools, as a restarted process: its `fetch`, and `close()`. */
    start: () => prepared.start(origin),
    /** The providers the Toolbox mounts in its hub: those of its generated list served `toolbox` or `both`. */
    providers: mounted.filter(({ serve }) => serve !== "standalone").map(({ provider }) => provider),
    /** The Toolbox's database as its owner, to read the catalogue, intents and evidence the Toolbox wrote as its runtime login. */
    db: prepared.db,
    /** The Toolbox's spans, in memory. */
    spans: prepared.spans,
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
