import type { IdAdmin } from "@answerable/id-admin"
import { z } from "zod"

const me = z.object({
  principal: z.object({ clientId: z.string(), organizationId: z.uuid() }),
  grants: z.array(z.object({ organizationId: z.uuid(), isPlatform: z.boolean() })),
})

/**
 * The platform organisation's id, learned at boot from ID's `GET /me` as the admin MCP's machine client: the client's own organisation, which ID
 * must mark `isPlatform` (it binds that in `system_bindings`, never by slug). Refuses a client of any other organisation, saying what to fix.
 */
export async function readPlatform(id: IdAdmin) {
  const { principal, grants } = me.parse(await id.get("/me"))
  if (!grants.some(grant => grant.isPlatform && grant.organizationId === principal.organizationId)) {
    throw new Error(`The machine client ${principal.clientId} belongs to organisation ${principal.organizationId}, which is not the platform organisation; register ADMIN_ID_CLIENT_ID in the platform organisation`)
  }
  return principal.organizationId
}
