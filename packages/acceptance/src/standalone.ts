// The standalone server as the journeys start it: every MCP of its generated list, each on its own path, with its database on the acceptance's
// PostgreSQL and the shared MCP database's serving login, as the entry point does.
import { createIdAdmin } from "@answerable/id-admin"
import { createMemoryTracer, mcpDatabases, startAuditPoller } from "@answerable/mcp-platform"
import { assertRuntimeRole, configureRuntimeRole, runtimeGrants } from "@answerable/mcp-postgres"
import { migrate } from "@answerable/mcp-standalone/migrate"
import { served } from "@answerable/mcp-standalone/served"
import { createStandalone } from "@answerable/mcp-standalone/standalone"
import { z } from "zod"
import { registerMachine } from "./admin"
import { onCleanup } from "./cleanup"
import { createDatabase, type Id } from "./id"
import { mcpsDatabase } from "./mcps"
import { step } from "./step"

/**
 * Register the standalone server's `platform:read` machine client, `standalone-hub`, in the platform organisation of a started ID, make its
 * database `answerable_standalone_acceptance` (migrated as the owner, served as the runtime login) and check its serving login on the shared MCP
 * database. `start(origin)` builds a server at `origin` on fresh pools, as a process starting does, with its audit-log poller; the caller serves its
 * `fetch`, and its `close()` stops it, as a process stopping does. `db` is the server's database as its owner, to read the evidence it wrote.
 * Each MCP's resource, `<origin>/<name>/mcp`, and its clients are the journey's to register.
 */
export async function startStandaloneStack(id: Id) {
  const { admin, manifest } = id
  step(`Registering the standalone server's machine client, and creating and migrating its database, to serve ${served.map(({ provider }) => provider.id).join(" and ")}`)
  const organisations = z.object({ items: z.array(z.object({ id: z.uuid(), slug: z.string() })) }).parse(await admin("GET", "/organizations?q=answerable"))
  const platform = organisations.items.find(organisation => organisation.slug === "answerable")!
  const client = await registerMachine(admin, platform.id, "standalone-hub", { [manifest.adminResource]: ["platform:read"] })
  const machine = createIdAdmin({ issuer: manifest.idOrigin, adminResource: manifest.adminResource, ...client })
  const { owner, runtime, role } = await createDatabase("answerable_standalone_acceptance")
  await migrate(owner)
  await configureRuntimeRole(owner, role, runtimeGrants)
  await assertRuntimeRole(runtime)
  const shared = (await mcpsDatabase()).standalone
  const checked = mcpDatabases(served, { shared, own: {} })
  try {
    await checked.assert()
  } finally {
    await checked.close()
  }
  const { tracer } = createMemoryTracer()
  function start(origin: string) {
    const mcps = mcpDatabases(served, { shared, own: {} })
    const standalone = createStandalone({ serve: mcps.mount, pools: mcps.pools, origin, auth: { issuer: manifest.idOrigin }, db: runtime, id: machine, spans: tracer })
    const poller = startAuditPoller({ id: machine, caches: [standalone.profiles] })
    let closed: Promise<void> | undefined
    const close = () => (closed ??= (poller.stop(), mcps.close()))
    onCleanup(close)
    return { fetch: standalone.fetch, close }
  }
  return { start, db: owner }
}
