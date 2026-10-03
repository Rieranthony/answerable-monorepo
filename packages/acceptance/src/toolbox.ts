// The Toolbox as the Toolbox journeys and the host lane register and start it, so that what the lane offers by hand is what the journeys prove.
import { createIdAdmin, type IdConfig } from "@answerable/id-admin"
import { createE2eProvider } from "@answerable/mcp-e2e/mcp"
import { createRecordStore } from "@answerable/mcp-e2e/records"
import { toolboxAdminResource } from "@answerable/mcp-toolbox/admin"
import { migrate } from "@answerable/mcp-toolbox/migrate"
import { startGrantsPoller } from "@answerable/mcp-toolbox/poller"
import { createMemoryTracer } from "@answerable/mcp-toolbox/spans"
import { createToolbox } from "@answerable/mcp-toolbox/toolbox"
import { z } from "zod"
import { registerClient, registerMachine, registerResource } from "./admin"
import { onCleanup } from "./cleanup"
import { createDatabase, type Id } from "./id"
import { step } from "./step"

/** The Toolbox's URL, which is the audience of its tokens; it is served on port 47604. */
export const toolboxResource = "http://127.0.0.1:47604/mcp"
const toolboxAdmin = toolboxAdminResource(toolboxResource)

/** A public client a person signs in from, such as Claude Code: its id and the redirect URI it was registered with. */
export type HostClient = { clientId: string; redirectUri: string }

/**
 * Register the Toolbox in a started ID and start it with the e2e provider. Registered in ID: the Toolbox's resource (60-second tokens, allowing only
 * `toolbox` and `offline_access` until an enable call widens it) and its admin resource, each of `hosts` as a public host client, and in the platform
 * organisation the Toolbox's machine client `toolbox-hub` and a staff client `toolbox-staff` with `toolbox:admin`. The Toolbox gets the database
 * `database` on the acceptance's PostgreSQL and its grants poller; `fetch` is the HTTP client of its machine client. No organisation is enabled yet.
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
  const staff = await registerMachine(admin, platform.id, "toolbox-staff", { [toolboxAdmin]: ["toolbox:admin"] })
  /** A token for the Toolbox's admin resource, as the staff client. */
  async function staffToken() {
    const response = await globalThis.fetch(new URL("/auth/oauth2/token", manifest.idOrigin), {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${staff.clientId}:${staff.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: toolboxAdmin, scope: "toolbox:admin" }),
    })
    if (!response.ok) throw new Error(`ID refused the staff client a token for ${toolboxAdmin} (${response.status}): ${await response.text()}`)
    return z.object({ access_token: z.string() }).parse(await response.json()).access_token
  }
  // ID makes its signing key when it signs its first token, and two first tokens at once make two keys: a verifier that read the keys between them
  // refuses the second's token for 30 seconds. The Toolbox's poller and the first enable call would ask together, so one token comes first.
  await staffToken()

  step(`Creating and migrating ${database}, and starting the Toolbox with the e2e provider`)
  const db = await createDatabase(database)
  await migrate(db)
  const providers = [createE2eProvider({ records: createRecordStore(), viewHtml: "<!doctype html><title>Records</title>" })]
  const { tracer, spans } = createMemoryTracer()
  const machine = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...hub, fetch })
  const toolbox = await createToolbox({ providers, auth: { issuer: manifest.idOrigin, resource: toolboxResource }, db, id: machine, spans: tracer })
  const poller = startGrantsPoller({ id: machine, grants: toolbox.grants })
  onCleanup(() => poller.stop())

  return {
    toolbox,
    /** The providers the Toolbox mounts: the e2e provider. */
    providers,
    /** The Toolbox's database: its catalogue, intents and evidence. */
    db,
    /** The Toolbox's spans, in memory. */
    spans,
    /** The Toolbox's admin API as the staff client: the status and the JSON body. */
    async adminApi(method: string, path: string, body?: unknown) {
      const response = await globalThis.fetch(`${new URL(toolboxResource).origin}/admin/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${await staffToken()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
    },
  }
}
