// The admin MCP and the Toolbox as the setup page of the admin MCP's docs registers them in ID, and the two servers started against it.
// The admin journeys and the admin lane both start from here, so what the page shows is what both run.
import { SQL } from "bun"
import { createIdAdmin, type IdConfig } from "@answerable/id-admin"
import { createAdminMcp } from "@answerable/mcp-admin/admin"
import { readPlatform } from "@answerable/mcp-admin/platform"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { migrate, migrations } from "@answerable/mcp-postgres"
import { toolboxAdminResource } from "@answerable/mcp-toolbox/admin"
import { migrate as migrateToolbox } from "@answerable/mcp-toolbox/migrate"
import { startGrantsPoller } from "@answerable/mcp-toolbox/poller"
import { createMemoryTracer } from "@answerable/mcp-toolbox/spans"
import { createToolbox } from "@answerable/mcp-toolbox/toolbox"
import { z } from "zod"
import { grantOrganisation, linkClient, registerClient, registerMachine, registerResource } from "./admin"
import { onCleanup } from "./cleanup"
import type { Id } from "./id"
import { step } from "./step"

/** The admin MCP's URL, which is the audience of its tokens; it is served on port 47606. */
export const adminResource = "http://127.0.0.1:47606/mcp"
/** The Toolbox's URL, which is the audience of its tokens; it is served on port 47604. */
export const toolboxResource = "http://127.0.0.1:47604/mcp"
const toolboxAdmin = toolboxAdminResource(toolboxResource)
// Each staff role is the grant string `answerable-<role>`, held through a group of the platform organisation.
const staffRoles = ["team", "admin", "owner"] as const

/** A public client a person signs in from, such as Claude Code: its id and the redirect URI it was registered with. */
export type HostClient = { clientId: string; redirectUri: string }

const postgres = "postgres://answerable:answerable@127.0.0.1:47532"
async function createDatabase(name: string) {
  const server = new SQL({ url: `${postgres}/answerable_id_test`, max: 1 })
  await server.unsafe(`create database ${name}`)
  await server.close()
  const db = new SQL({ url: `${postgres}/${name}`, max: 4 })
  onCleanup(() => db.close())
  return db
}

/**
 * Register the admin MCP and the Toolbox in a started ID, in the order the setup page shows them, and start both servers' machinery: the
 * admin MCP and the Toolbox each get a database on the acceptance's PostgreSQL (`answerable_admin_acceptance`, `answerable_toolbox_acceptance`),
 * and the Toolbox gets its grants poller. The caller serves the two handlers on ports 47606 and 47604.
 *
 * Registered in ID: the Toolbox's resource and its admin resource, `toolboxHost` as its host client and the Toolbox's machine client; the admin MCP's
 * resource (900-second tokens, allowing `admin` and the three role strings), `adminHost` as its host client, the platform organisation's capabilities and
 * entitlement for it, a group per role holding that role's string, and the admin MCP's machine client with ID's admin resource and the Toolbox's admin resource as audiences.
 * Nobody is staff yet: `groups` gives each role's group id for the caller to fill.
 */
export async function startAdminStack(id: Id, { adminHost, toolboxHost, fetch }: { adminHost: HostClient; toolboxHost: HostClient; fetch?: IdConfig["fetch"] }) {
  const { admin, manifest } = id
  const platform = manifest.platform!.organizationId
  const grants = staffRoles.map(role => `answerable-${role}`)

  step("Registering the Toolbox, its admin resource, its host client and its machine client")
  await registerResource(admin, { identifier: toolboxResource, scopes: ["toolbox"], accessTokenTtl: 900 })
  await registerResource(admin, { identifier: toolboxAdmin, scopes: ["toolbox:admin"], accessTokenTtl: 300 })
  await registerClient(admin, { ...toolboxHost, scopes: ["toolbox"] })
  const hub = await registerMachine(admin, platform, "toolbox-hub", { [manifest.adminResource]: ["platform:read", "platform:write"] })

  step("Registering the admin MCP, its host client, its three role groups and its machine client")
  await registerResource(admin, { identifier: adminResource, scopes: ["admin", ...grants], accessTokenTtl: 900 })
  await registerClient(admin, { ...adminHost, scopes: ["admin"] })
  await linkClient(admin, adminHost.clientId, adminResource)
  await grantOrganisation(admin, platform, { clientId: adminHost.clientId, resource: adminResource, scopes: ["admin"] })
  const groups = {} as Record<(typeof staffRoles)[number], string>
  for (const role of staffRoles) {
    const group = z.object({ id: z.uuid() }).parse(await admin("POST", `/organizations/${platform}/groups`, { slug: `answerable-${role}`, name: `Answerable ${role}` }))
    await admin("POST", `/organizations/${platform}/entitlements`, { groupId: group.id, resource: adminResource, scopes: [`answerable-${role}`] })
    groups[role] = group.id
  }
  const machine = await registerMachine(admin, platform, "admin-mcp", {
    [manifest.adminResource]: ["platform:read", "platform:write"],
    [toolboxAdmin]: ["toolbox:admin"],
  })

  // The admin MCP's first call is the first token ID signs: ID makes its signing key then, and two first tokens at once make two keys.
  const ids = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...machine, fetch })
  const learned = await readPlatform(ids)
  const adminDb = await createDatabase("answerable_admin_acceptance")
  await migrate(adminDb, [migrations])

  step("Starting the Toolbox with the e2e provider")
  const toolboxDb = await createDatabase("answerable_toolbox_acceptance")
  await migrateToolbox(toolboxDb)
  const hubIds = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...hub })
  const providers = [createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html><title>Records</title>" })]
  const toolbox = await createToolbox({ providers, auth: { issuer: manifest.idOrigin, resource: toolboxResource }, db: toolboxDb, id: hubIds, spans: createMemoryTracer().tracer })
  const poller = startGrantsPoller({ id: hubIds, grants: toolbox.grants })
  onCleanup(() => poller.stop())

  return {
    /** The admin MCP, for a critical operation to need a company sign-in at most `freshSeconds` old. Each call makes a server on the same database and the same machine client. */
    adminMcp: (freshSeconds = 1800) => createAdminMcp({ auth: { issuer: manifest.idOrigin, resource: adminResource }, db: adminDb, id: ids, platform: learned, freshSeconds, toolbox: { resource: toolboxAdmin } }),
    toolbox,
    /** Each role's group in the platform organisation. */
    groups,
    /** The admin MCP's database: its intents and its evidence. */
    database: adminDb,
  }
}
