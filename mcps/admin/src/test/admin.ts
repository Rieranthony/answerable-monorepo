import type { SQL } from "bun"
import { createIdAdmin } from "@answerable/id-admin"
import { createFakeId } from "@answerable/id-admin/testing"
import { createTestMcp } from "@answerable/mcp/testing"
import { createAdminMcp } from "../admin"

/** The admin MCP's resource in the tests: the URL `createTestMcp` serves at, and the audience of every token it signs. */
export const resource = "https://mcp.test/mcp"

/** The admin MCP in-process on a fake ID whose machine client belongs to the platform organisation, and staff to sign in as. */
export async function createAdmin(db: SQL) {
  const id = createFakeId({ clientId: "admin-mcp" })
  const platform = id.organizationId
  const mcp = await createTestMcp(auth => createAdminMcp({ auth, db, id: createIdAdmin(id.config), platform }))
  /**
   * A member of the platform organisation whose access view gives the admin MCP's resource `scopes`, as an organisation-wide entitlement and a
   * group's would; `holds` changes them in ID. `connect` signs in with a token of the platform organisation for that member.
   */
  function staff(scopes: string[]) {
    const member = id.member(platform, { email: `${crypto.randomUUID().slice(0, 8)}@answerable.test`, name: "Staff member" })
    const group = id.group(platform, { slug: "support-staff" })
    const holds = (held: string[]) => id.grant(platform, member.id, [{
      kind: "resource", id: resource, scopes: held,
      via: [{ entitlementId: crypto.randomUUID(), principal: "organization", groupId: null }, { entitlementId: crypto.randomUUID(), principal: "group", groupId: group.id }],
    }])
    holds(scopes)
    const connect = () => mcp.connect({ organizationId: platform, membershipId: member.id, userId: String(member.userId) })
    return { member, holds, connect }
  }
  return { id, platform, mcp, staff }
}
